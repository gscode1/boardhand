# Configuration

This page covers the worker first, then the [board server](#board-server) (`server/`, ADR 0005).

A worker serves one route (see [plan.md](../plan.md)). It reads the route from environment variables once, at start, in
`src/route.ts`. It checks all of them and reports every problem at once, so a bad deployment fails at start and not on
the first task. Empty values count as unset; surrounding spaces are trimmed.

## Variables

| Name | Required / default | Valid values | Meaning |
|---|---|---|---|
| `BOARD_URL` | required | an `http` or `https` URL | The board to serve. Trailing slashes are removed. |
| `BOARD_TOKEN` | required | any text | The worker's board token. **Secret.** |
| `BOARD_PROFILE` | `boardhand` | lowercase letter first, then up to 31 lowercase letters, digits or `-` | The profile the worker acts as on the board. |
| `BOARDHAND_CHANNEL` | required | any text | The channel the route serves. |
| `BOARDHAND_LABELS` | none | `key=value` pairs, comma separated | Labels a task must have to be claimed. Both key and value must be non-empty. |
| `BOARDHAND_FROM` | required | owner IDs, comma separated; at least one | The owners the route claims from. These are principal IDs, not handles. It is never empty, because task text is untrusted input. |
| `BOARDHAND_BACKEND` | required | `fake` | The backend that runs tasks. Only `fake` exists in phase 1. |
| `BOARDHAND_BACKEND_OPTIONS` | `{}` | a JSON object | Options for the backend. Each backend checks its own. |
| `BOARDHAND_CONCURRENCY` | `1` | integer, 1 to 64 | How many claim loops run, so how many tasks run at once. |
| `BOARDHAND_LEASE` | `300` | integer seconds, 30 to 3600 | The lease length asked for on each claim. The worker renews it every third of this. |
| `BOARDHAND_WAIT` | `30` | integer seconds, 1 to 3600 | How long one claim call long-polls for a ready task. |
| `BOARDHAND_STATE_DIR` | none | a directory path | Where the claim store keeps proof of held claims. Without it, a restart cannot resume a claim from disk. |

Integers must be plain digits. A value out of range is a configuration error, not clamped.

## Secrets

`BOARD_TOKEN` is the only secret in the route. It is never logged: the `route` event shows `"[redacted]"` in its place.
Backend options may hold secrets, so the log shows only their keys, never their values. An invalid
`BOARDHAND_BACKEND_OPTIONS` is reported without the text. Claim tokens are secrets too: they are kept only in the claim
store (mode 0600 in a 0700 directory) and are never logged.

## Fake backend

The `fake` backend is for tests. It runs nothing; it computes what a run reports from time stamps. Set it with
`BOARDHAND_BACKEND=fake` and these options in `BOARDHAND_BACKEND_OPTIONS`:

| Option | Default | Meaning |
|---|---|---|
| `behavior` | `succeed` | What a run does when the task has no `fake` label: `succeed`, `fail`, `hang` or `slow`. |
| `stepMs` | `50` | How long a `succeed` or `fail` run takes, in milliseconds. |
| `slowMs` | `2000` | How long a `slow` run takes. It reports three progress updates on the way. |
| `dir` | none | A directory. Runs are then files in `<dir>/runs/`, so a restarted worker can find them. Without it, runs live in memory. |

A task's `fake` label overrides `behavior`. Behaviors:

- `succeed`: ends with result `fake result for task <id>`.
- `fail`: ends with reason `fake failure for task <id>`.
- `slow`: reports `fake progress 1 of 3`, `2 of 3`, `3 of 3`, then succeeds.
- `hang`: never ends, until it is canceled.

An unknown label or option value makes the run (or the start of the worker) fail with a message that names it. A
numeric option that is not a non-negative number falls back to its default.

## Exit codes

| Code | When |
|---|---|
| `0` | A clean stop after SIGTERM or SIGINT. |
| `1` | A fatal error after the route was valid (for example the board is unreachable at start, or the backend options are invalid). Logged as `fatal`. |
| `2` | Bad configuration. Logged as `config.invalid` with the list of problems. |

## Log format

The worker writes one JSON object per line to stdout. Each has `ts` (ISO time), `level` (`info`, `warn` or `error`) and
`event`, plus fields for that event. Task text and results are not logged.

Main events:

| Event | Level | Meaning |
|---|---|---|
| `route` | info | The route at start, with secrets redacted. |
| `config.invalid` | error | Bad configuration; has `problems`. The process then exits with 2. |
| `worker.start` | info | The claim loops start; has `resumable` (stored claims) and `concurrency`. |
| `claim.resumed` / `claim.dropped` | info | A stored claim was taken up again, or was over and dropped. |
| `task.claimed` | info | A task was claimed. |
| `run.started` / `run.reattached` | info | A run was started, or an existing run was found for the task. |
| `task.completed` / `task.failed` | info | The task was settled. |
| `task.released` | info | A task whose run had not started was handed back on shutdown. |
| `claim.lost` | warn | The claim is over; the run is canceled and nothing is settled. |
| `claim.error`, `resume.error`, `renew.error`, `board.unreachable` | warn | The board did not answer; the call is retried with backoff. At start, before the worker runs, it has `retryInMs` and no `taskId`. |
| `run.start_unavailable` | warn | The backend was unavailable at `start` or `find`; the task was released and the loop backs off. Has `retryInMs`. |
| `run.wait_error`, `reply.error`, `release.error` | warn | A backend wait, a reply or a release failed. |
| `task.error` | error | A worker error on a task; the task is failed. |
| `run.cancel_error`, `renew.crashed`, `loop.crashed`, `task.fail_error` | error | An unexpected failure inside the worker. |
| `worker.stopping` | info | A signal arrived; has `signal`. |
| `fatal` | error | An error that ends the process with code 1. |

See [worker.md](worker.md) for when each happens.

## Board server

`node dist/server/main.js`. It reads the environment once at start (`server/config.ts`) and reports every problem at
once, exiting 2.

| Name | Required / default | Valid values | Meaning |
|---|---|---|---|
| `BOARD_DATA_DIR` | required | a directory path | Where the engine's SQLite files live (a PVC). |
| `BOARD_PUBLIC_URL` | required | an `http` or `https` URL | The URL clients use; the engine checks it as the token audience. |
| `BOARD_TOKENS_FILE` | required | a file path | The tokens file (below). Mount it from a Secret. |
| `PORT` | `8080` | integer, 0 to 65535 | Listening port (0: the OS picks one; logged in `server.start`). |
| `BOARD_STALE_CHECK_SECONDS` | `60` | integer, 0 to 86400 | How often to look for stale tasks; 0 turns the check off. |
| `BOARD_STALE_AFTER_SECONDS` | `900` | integer, 1 and up | A ready task older than this is stale. |

### Tokens file

One entry per line, `name:kind:token[:channels]`. Blank lines and lines starting with `#` are skipped.

| Field | Rules |
|---|---|
| `name` | Lowercase letter first, then up to 31 lowercase letters, digits or `-`. Unique. It is the handle and the last part of the principal ID. |
| `kind` | `person` (a human or an owner; full access) or `worker` (a boardhand worker). |
| `token` | 24 to 256 characters from `A-Z a-z 0-9 . _ ~ + / = -` (no colon). Unique. Use `openssl rand -hex 32`. **Secret.** |
| `channels` | Workers only, required: comma-separated channels the worker may use. `dev` is one channel, `dev/` is `dev` and everything below. A person takes none. |

Principal IDs are `boardhand:person:<name>` and `boardhand:worker:<name>`. A route's `BOARDHAND_FROM` names `person` IDs.
A worker may read, post (reply) and label (claim, settle) in its channels, and does nothing elsewhere. Example:

```
gs:person:<64 hex chars>
dev:worker:<64 hex chars>:dev
review:worker:<64 hex chars>:review/,dev
```

Tokens are compared in constant time and never logged; an invalid file is reported by line number without values. A
changed file takes effect at the next start.

### Server log events

| Event | Level | Meaning |
|---|---|---|
| `server.start` | info | Listening; has `port`, `url` and the token names, kinds and channels (never the tokens). |
| `task.stale` | warn | A ready task older than `BOARD_STALE_AFTER_SECONDS`: `task`, `channel`, `labels`, `ageSeconds`. Repeats on every check. |
| `stale.check_error` | error | A check failed (it is retried at the next tick). |
| `config.invalid` | error | Bad configuration or tokens file; has `problems`. Exit 2. |
| `server.stopping` | info | SIGTERM or SIGINT; the server drains for up to 5 seconds, then exits 0. |
| `fatal` | error | Any other error at start. Exit 1. |

`GET /healthz` answers 200 without a token (503 while stopping).
