# How a worker handles a task

This describes `src/worker.ts` as built in phase 1. A worker serves one route with `concurrency` claim loops. Each loop
takes one task at a time. Terms are those of [plan.md](../plan.md); the reasons are in
[ADR 0004](decisions/0004-one-run-per-claim.md). For settings see [configuration.md](configuration.md).

## Start

1. The worker reads the claim store (`BOARDHAND_STATE_DIR`) and logs `worker.start` with how many claims it can resume.
2. It starts `concurrency` loops. If more claims are stored than `concurrency`, it starts extra loops that only resume
   the stored claims, because their leases are ticking.
3. A loop that has a stored claim resumes it first (see Restart), then claims new tasks.

## One task

1. **Claim.** The loop calls `board.claim` with the route's channel (a subtree claims from every channel below it; the task's own channel is `task.channel`), labels, owners, `BOARDHAND_WAIT` and
   `BOARDHAND_LEASE`. A call that returns no task simply runs again.
2. **Store the proof.** It writes the claim's `taskId`, `epoch` and `token` to the claim store.
3. **Renew.** A timer renews the lease every `lease / 3`, independent of what the backend is doing. The first renew is
   one interval after the claim.
4. **Find.** It takes a hint: the run id from the claim store if it has one, otherwise the latest `boardhand.run`
   label on the thread (replies win over the root post, later over earlier). It calls `backend.find(task, hint)`.
   - If the backend returns a run, the worker re-attaches: it stores the run id and replies
     `Re-attached to <backend> run <id>` with the label `boardhand.run=<id>`.
   - If it throws `BackendUnavailableError`, see Backend unavailable below.
   - If it returns null, the worker calls `backend.start`. The run id is stored, then the worker replies
     `Started <backend> run <id>` with the label `boardhand.run=<id>`. The reply comes before the first wait, so a
     crash after it re-attaches instead of starting a second run.
5. **Follow.** The worker calls `backend.wait` in a loop. A progress update becomes a reply (best effort: a failed
   reply is logged and the run goes on). A `succeeded` or `failed` update ends the loop.
6. **Settle.** It settles the task once: `complete(result)` on success, `fail(reason)` on failure. Only then does it
   remove the stored claim and reply `Completed: <result>` or `Failed: <reason>` on the thread. The final reply is tried
   up to 3 times; if it still fails, the task stays settled and the failure is logged.

Text sent to the board is clipped, with the last character `…` when cut. Replies (progress and the final
`Completed:` / `Failed:` reply) keep up to 9000 characters, because the board caps a message at 10 000. The result or
reason passed to `complete` / `fail` is clipped to 1000 characters, the board's cap on a task's result and reason, so a
long answer still settles the task; the final reply on the thread carries the longer text.

## Lost claim

If a renew, a reply or a settle gets `claim_lost` or `task_finished`, the claim is over. The worker logs `claim.lost`,
aborts the task, cancels the run (if it has one), removes the stored claim and settles nothing. The next claimant
re-attaches or starts fresh.

If the board cannot be reached, board calls are retried with backoff until the lease's end. Past it, the claim counts
as lost. A renew that fails because the board is unreachable is retried the same way.

## Shutdown (SIGTERM, SIGINT)

`main.ts` logs `worker.stopping` and calls `stop()`, then exits 0.

- The worker stops claiming. A claim that answers just as shutdown begins is released at once.
- A task whose run has **not started** is released.
- A task whose run **has started** is left alone: the worker stops following it, does not cancel it, does not release
  it, and keeps its stored claim. A run that was being created when shutdown began is canceled, and its task is released.

## Restart (kill, crash)

On start the worker takes each stored claim and calls `board.held` with its proof, then renews it.

- If that works, it logs `claim.resumed` and handles the task like a fresh claim, with the stored run id as the hint, so
  it re-attaches without a second `backend.start`.
- If the board says the claim is over, or the task is gone, it logs `claim.dropped` and removes the file. A later
  claimant re-attaches through the thread's label.
- If the board is unreachable, it retries with backoff.

Without a state dir, nothing is stored. The claim lapses at the end of its lease, another claim takes the task, and the
run label on the thread re-attaches it. The cost is a delay of up to one lease, not a second run.

## Backend unavailable

A backend signals that it cannot be reached, or says to try later (network error, timeout, 429, 5xx), by throwing
`BackendUnavailableError` from `start` or `find` ([ADR 0003](decisions/0003-backend-interface.md)). When that happens
before any run exists, the task is not failed. The worker:

1. logs `run.start_unavailable` (warn) with `retryInMs`;
2. releases the task, so it is ready again for any worker, and removes the stored claim;
3. does not settle it and does not reply on the thread, so an outage does not fill threads with messages;
4. makes that claim loop wait before its next claim, with the usual backoff growing on each consecutive failure. A
   successful start resets it.

A `find` that cannot be answered gets the same treatment, because starting blindly could create a second run. Any other
error from `start` is a worker error and fails the task (see Errors). `BackendUnavailableError` from `wait` is not
special: the wait-error rule below applies.

## Backoff

Retries use exponential backoff: 250 ms doubling to 30 s, with jitter between half and all of each step. It applies to
failed claim calls (`claim.error`), an unavailable backend (`run.start_unavailable`), resume (`resume.error`), board calls during a task (`board.unreachable`), renew
(`renew.error`), `backend.wait` errors, and the final reply. A success resets it.

## Entrypoint: the board is not up yet

`main.ts` makes the first board request before it starts the worker. While that fails as unreachable (no connection,
429, 5xx), it logs `board.unreachable` with `retryInMs` and retries with the same backoff (250 ms doubling to 30 s,
jitter), so a pod that starts before the board does not crash-loop. SIGTERM or SIGINT during the wait exits 0 at once.
Any other error, such as a refused token (401), logs `fatal` and exits 1. Bad configuration still exits 2.

## Errors

- **A worker error fails the task.** If something on a task throws that is not a lost claim or a shutdown (for example
  `backend.start` rejects), the worker logs `task.error`, cancels the run if there is one, and fails the task with
  `worker error: <message>`, then replies `Failed: ...`. Messages are cut to 300 characters in logs and in this text.
- **Five wait errors fail the task.** If `backend.wait` throws 5 times in a row, the worker fails the task with
  `lost contact with the run: <message>`. A successful wait resets the count.
- **Board errors that are not retryable** (anything but claim over or unreachable) are worker errors, as above.
- **A claim loop that crashes** logs `loop.crashed` and ends; the other loops go on.
