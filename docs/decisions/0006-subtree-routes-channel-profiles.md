# 0006: A route may be a channel subtree, and the pi profile may come from the channel

Status: accepted, 2026-11-20.

## Context

With a route that is one channel and a fixed pi profile, every new channel or profile means a new route, a new
Deployment, a new board token scope and a redeploy. We want to add a channel, or a pi profile, without redeploying the
worker.

Facts (checked against `@vercel/board` 0.52.0):

- `tasks.claim({ channel: "agents/" })`, with a trailing `/`, claims the oldest ready task in `agents` or any channel
  below it that the caller may `label`. The long-poll re-reads the channels at least once a second, so channels created
  later are picked up.
- A channel exists once a task is posted to it. The task's `channel` is its real channel, also on resume.
- The board server already accepts worker tokens scoped to a subtree (`agents/`, [ADR 0005](0005-board-server.md)).

## Decision

- **A route is a channel or a subtree.** `BOARDHAND_CHANNEL` is a channel name (`dev`) or a subtree ending in `/`
  (`agents/`). It is checked against the board's channel grammar when the route loads.
- **The pi profile may come from the channel.** The pi backend option `profileChannel` (a subtree such as `agents/`,
  within the route's channel) makes the profile of a task the first channel segment below it: `agents/research` and
  `agents/research/team-a` use profile `research`. A task in the prefix channel itself uses `profile` if set, else pi's
  default. A task outside the prefix fails to start with a clear reason.
- **An optional allowlist.** `profiles` is `"*"` (default: any profile; pi validates, and an unknown profile is a 400 that
  fails the task) or a non-empty list. A profile outside the list fails the task without a call to pi.
- **The profile is resolved in `PiBackend.start` from `task.channel`.** The `Backend` interface does not change
  ([ADR 0003](0003-backend-interface.md)); the backend still does not import the board.
- **Rejected: a label picks the profile.** Anyone with `label` on a thread can relabel a task root, so a label would let a
  principal that cannot post to a channel steer a task into another profile. A channel is fixed when the task is
  created, by an owner the route already trusts (`from`).

## Consequences

- One concurrency cap and one oldest-first queue cover the whole subtree, so a busy channel can starve the others. Use a
  separate route when a channel needs its own capacity.
- One `PI_TOKEN` and one `BOARDHAND_FROM` serve every channel in the subtree. A route is a trust boundary: put channels
  with different owners or different session-API owners in different routes.
- Private channels are not supported: the board server gives a subtree worker read, post and label on every channel below
  its prefix ([ADR 0005](0005-board-server.md)), so a channel the worker must not see cannot live under it.
- The `repo` and `branch` labels stay relabelable, as before.
- Route-level `model`, `sandboxSize`, `provider` and `reasoning` override the chosen profile's own defaults. Omit them on a
  multi-profile route.
- Still a redeploy: tokens and owners, concurrency, the pi URL and token, and any channel outside the subtree. Adding a
  channel or a profile below the prefix is not.
