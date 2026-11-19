# 0004: One run per claim: kept claim proof, run id on the thread, cancel on lost claim

Status: accepted, 2026-11-19. The open point on the claim token was settled in phase 1 (see Claim token).

## Context

Agent runs are slow and cost money. A worker can crash, be rescheduled or lose its lease while a run is working. Without
care this starts a second run for the same task, or lets two runs report on one thread.

What the board gives (`@vercel/board` 0.52.0 and its spec):

- Every claim raises the task's epoch. A write that carries a claim that is over (released, settled, taken over, past its
  lease) gets `409 claim_lost` and changes nothing. A write on a task that was canceled gets `task_finished`.
- The spec lets a caller bring the claim's token (`claim` takes `token`), so a restarted process could claim the same task
  again with the same token and get the same claim back.
- The SDK's `tasks.held(id, { epoch, token })` acts on a claim from another process.

What pi-durable-k8s gives: `POST /sessions` has no idempotency key; follow-up events deduplicate by `sourceEventId`.

## Decision

- **Run id on the thread first.** Right after `backend.start` returns, the worker replies `Started <backend> run <id>` with
  the label `boardhand.run=<id>`, before it waits on the run.
- **Re-attach before starting.** After a claim, the worker reads the latest `boardhand.run` label on the thread and passes
  it to `backend.find(task, hint)`. If the backend confirms a run, the worker follows that run instead of starting one.
- **Lost claim means cancel.** On `claim_lost` or `task_finished` the worker cancels its run and settles nothing; the next
  claimant re-attaches or starts fresh. A renew that cannot reach the board is retried until the lease's end; past it the
  claim counts as lost.
- **Renew independently.** The lease is renewed every third of its length on a timer, not between backend calls, so a long
  `wait` never lets it lapse.
- **Shutdown releases.** On SIGTERM the worker stops claiming, releases tasks whose run has not started, and stops
  following started runs without cancelling or releasing them. They are picked up again as below.

## Claim token

The SDK's `tasks.claim` in 0.52.0 takes no caller-supplied `token`, and neither does the engine: the HTTP body of
`POST /tasks/:id/claim` is `{ lease? }` only (its schema strips anything else), although SPEC.md describes a `token`.
Option (a), an HMAC-derived token sent over HTTP from `src/board.ts`, therefore cannot work against 0.52.0.

We chose option (b): **keep each claim's proof and use `tasks.held()` after a restart.**

- The worker writes `{ taskId, epoch, token }` for each claim it holds to a claim store in `BOARDHAND_STATE_DIR`: one file
  per task, named by a hash of the task id, mode 0600 in a 0700 directory, written atomically, removed when the claim
  ends. The token is never logged.
- On start, each claim loop first renews one stored claim with `tasks.held()`. A claim that is over is
  dropped. A live one continues on the re-attach path above, so a restarted process resumes its runs at once without a
  second `backend.start`.
- In Kubernetes the store is an `emptyDir`: it survives a container restart (a crash) in the same pod, not a reschedule.
- Without the store, or when the pod is gone, the claim lapses at the end of its lease, another claim takes the task, and
  the run label re-attaches. The cost is a delay of up to one lease, not a second run.

If upstream starts accepting a caller token, option (a) removes the store; we would raise it upstream rather than fork.

## Consequences

- There is a short window between `backend.start` and the reply in which a crash orphans a run. pi-durable-k8s would close
  it with an idempotency key on session create; we propose one upstream rather than depend on it.
- Replies and labels on the thread are the run's record; anyone who can label the thread can change it, so the worker
  treats the label as a hint and checks it with the backend before following it.
- The claim store holds secrets (claim tokens) on the worker's disk; it lives only as long as the pod.
