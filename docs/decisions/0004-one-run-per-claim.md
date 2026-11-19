# 0004: One run per claim: stable claim token, run id on the thread, cancel on lost claim

Status: accepted, 2026-11-19. One part is open (see Open).

## Context

Agent runs are slow and cost money. A worker can crash, be rescheduled or lose its lease while a run is working. Without
care this starts a second run for the same task, or lets two runs report on one thread.

What the board gives (`@vercel/board` 0.52.0 and its spec):

- Every claim raises the task's epoch. A write that carries a claim that is over (released, settled, taken over, past its
  lease) gets `409 claim_lost` and changes nothing.
- The spec lets a caller bring the claim's token (`claim` takes `token`), so a restarted process can claim the same task
  again with the same token and get the same claim back.
- The SDK's `tasks.held(id, { epoch, token })` acts on a claim from another process.

What pi-durable-k8s gives: `POST /sessions` has no idempotency key; follow-up events deduplicate by `sourceEventId`.

## Decision

- **Run id on the thread first.** Right after `backend.start` returns, the worker replies `Started <backend> run <id>` with
  the label `boardhand.run=<id>`, before it waits on the run.
- **Re-attach before starting.** After a claim, the worker looks for a `boardhand.run` label on the thread (and asks
  `backend.find`). If a run exists, it follows that run instead of starting one.
- **Lost claim means cancel.** On `409 claim_lost` the worker cancels its run and settles nothing; the new claimant
  re-attaches or starts fresh.
- **Renew independently.** The lease is renewed every third of its length on a timer, not between backend calls, so a long
  `wait` never lets it lapse.
- **Shutdown releases.** On SIGTERM the worker stops claiming, releases tasks whose run has not started, and leaves
  started runs to be re-attached by the next claimant.

## Open

The SDK's `tasks.claim` in 0.52.0 does not take a caller-supplied `token`. Phase 1 decides between:

1. Derive the token from the task id (an HMAC with a worker secret) and send this one claim over HTTP from `src/board.ts`
   (an exception to ADR 0002), or ask upstream to expose it.
2. Keep each claim's `epoch` and `token` where a restarted worker finds them, and use `tasks.held()`.

## Consequences

- There is a short window between `backend.start` and the reply in which a crash orphans a run. pi-durable-k8s would close
  it with an idempotency key on session create; we propose one upstream rather than depend on it.
- Replies and labels on the thread are the run's record; anyone who can label the thread can change it, so the worker
  treats the label as a hint and checks it with the backend before following it.
