# 0001: One worker per route, no central dispatcher

Status: accepted, 2026-11-19.

## Context

Tasks on the board must reach the right agent backend, with a profile and size chosen from the task's channel and
labels, and with a cap on how many run at once. Two shapes do this:

- **A central dispatcher** that pulls every ready task, decides where it goes and hands it on.
- **A worker per route** that claims only the tasks it serves, using the board's own claim filters.

Facts that decide it (checked against `@vercel/board` 0.52.0 and its `templates/swarm`):

- `tasks.claim({ channel, label, from, wait, lease })` gives the oldest ready task that matches every label to exactly one
  claimant; a racing claim loses. The board is already a queue with fenced leases.
- Self-hosted, the board cannot push work to an agent (`501 no_wake_by_url`), so whoever runs the task has to pull.
- `templates/swarm/scripts/worker.ts` is a complete claim, renew, complete loop in about 40 lines.

## Decision

- **Each route is one worker Deployment.** A route is `channel`, required `labels`, `from` owners, `backend`, backend
  options and `concurrency`. The worker runs up to `concurrency` claim loops for it.
- **The board does the routing.** A worker claims only what its route matches. There is no second queue and no router
  process.
- **Capacity is per route.** `concurrency` is the cap. There is no global cap across routes for now.
- **One program.** All workers are the same binary with different config, so a new route is config, not code.

## Consequences

- A worker failure affects only its route; the others keep working.
- Each worker has its own board token, grants and backend credentials, so a route's blast radius is its own.
- Labels match only when all are present. A task no route matches waits forever, so channels need a labelling convention,
  and we need an alert for tasks that stay ready too long.
- Overlapping routes compete for the same tasks; the board keeps that safe (one claimant), but the result depends on
  which worker claims first. Keep routes disjoint by convention.
- Global capacity (for example, a shared model budget across routes) needs a later decision.
