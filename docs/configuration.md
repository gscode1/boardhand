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
| `BOARDHAND_CHANNEL` | required | a board channel name, or a subtree ending in `/` | The channel the route serves. `dev` is one channel; `agents/` is `agents` and every channel below it, including ones created later ([ADR 0006](decisions/0006-subtree-routes-channel-profiles.md)). The worker's token must be scoped to it (`agents/`). |
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
| `BOARDHAND_TRIGGERS_FILE` | none | a file path | The GitHub triggers file ([below](#github-triggers)). Without it, `POST /hooks/github` answers 404. |
| `GITHUB_WEBHOOK_SECRET` | required with `BOARDHAND_TRIGGERS_FILE` | any text | The secret of the GitHub webhook; the server verifies each delivery's signature with it. **Secret.** Never logged. |

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

### GitHub triggers

With `BOARDHAND_TRIGGERS_FILE` set, the board server accepts GitHub webhooks at `POST /hooks/github` and turns matching
events into tasks ([ADR 0008](decisions/0008-github-triggers.md)). Delivery is the webhook only; the result is not posted
back to GitHub yet.

Each delivery must carry a valid `X-Hub-Signature-256` (HMAC-SHA256 of the raw body with `GITHUB_WEBHOOK_SECRET`):
missing or wrong is 401, and the body is not parsed. The body is capped at 5 MiB (413). A valid signature reaches only
this path; it never authenticates a request to the board API.

The file is JSON, read once at start; every problem is reported at once and the server exits 2. With the Helm chart you
write the triggers as YAML under `board.github.triggers` and the chart renders the file. A change restarts the pod.

```json
{
  "triggers": [
    {
      "name": "renovate",
      "repos": ["acme/*"],
      "event": "pull_request",
      "actions": ["opened", "synchronize"],
      "when": { "pull_request.user.login": ["renovate[bot]"] },
      "channel": "agents/deps",
      "labels": { "kind": "renovate" },
      "text": "Check Renovate's update {{pull_request.html_url}}: {{pull_request.title}}"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `name` | `[a-z][a-z0-9-]{0,31}`, unique. Part of the task's idempotency id and of every log line about it. |
| `repos` | Required, non-empty: `owner/name` or `owner/*`, matched case-insensitively against `repository.full_name`. An event without a repository never matches. |
| `event` | The `X-GitHub-Event` value, for example `pull_request`, `issues`, `issue_comment`. |
| `actions` | Optional list of `action` values. Absent: any action, and events that have none. |
| `when` | Required. Dotted payload path to a list of accepted values (any of them, compared exactly; strings, numbers, booleans, `null`). A segment ending in `[]` means any element of that array (`pull_request.labels[].name`). A missing path does not match. Every condition must hold. Exact match only: no prefix, pattern or regular expression. |
| `channel` | A board channel name (not a subtree). |
| `labels` | Optional static labels, checked against the engine's rules. They may not set the derived keys below. |
| `text` | The task text. `{{dotted.path}}` is replaced by that payload value (a string, number or boolean). A missing or non-scalar value is an error for this trigger, not an empty string. The result is clipped to 10 000 characters. |

**The who-gate is mandatory.** `when` must name at least one path that says who caused or wrote the event: 
`sender.login`, `sender.id`, or a path ending in `.user.login`, `.user.id` or `.author_association`. On a public
repository anyone can open an issue or comment, and the text goes to an agent. Use these paths, and the values that make
them a real gate:

- `sender.login`: the account that caused the event, for example `["alice"]` or `["renovate[bot]"]`.
- `pull_request.user.login`, `issue.user.login`: the author of the PR or issue.
- `comment.author_association` (or `issue.author_association`): `OWNER`, `MEMBER` or `COLLABORATOR`, so only people with
  a role in the repository or organization pass. `CONTRIBUTOR` and `NONE` admit outsiders.

Other paths, such as `sender.type`, do not count as a gate: `sender.type: [User]` admits every human account, so a
trigger gated only on it is a configuration error.

**Derived labels.** The server sets these on every task, and a trigger's `labels` may not use them:

| Label | Value |
|---|---|
| `github.event` | The `X-GitHub-Event` value. |
| `repo` | `repository.full_name`. The pi backend uses it as the session's repository. |
| `branch` | `pull_request.head.ref`, only for a `pull_request` event whose head is in the same repository. A fork's branch is never set. |

Payload text never becomes any other label value, because labels steer routing and backends.

**Who owns the task.** Tasks are created as the principal `boardhand:source:github`, narrowed by the server to post and
label in the channels the triggers name. It cannot claim or settle. A route must list `boardhand:source:github` in its
`BOARDHAND_FROM` (route `from` in the chart) to run these tasks; other routes never see them.

**Idempotency.** Each task is posted with the id `github:<X-GitHub-Delivery>:<trigger name>`. A redelivery returns the
task already made; two triggers that match one delivery make two tasks. A 409 `duplicate_id` is an error: the id was
used for a different post.

**Answers.**

| Answer | When |
|---|---|
| 200 | A `ping`, or an event that matches no trigger. |
| 200 with the task IDs | Every matching trigger created its task, or already had it. |
| 422 | A template error: that trigger is skipped and logged with its name. |
| 502 | The board refused or failed. Answered quickly, so GitHub marks the delivery failed. Redeliver it by hand: GitHub does not retry on its own. Other matching triggers are still tried, and a redelivery makes only the missing tasks. |
| 401, 413, 404 | Bad or missing signature, body over 5 MiB, no triggers file. |

Examples (the `repos`, channels and logins are yours to change):

A Renovate PR, gated on its author:

```json
{
  "name": "renovate",
  "repos": ["acme/*"],
  "event": "pull_request",
  "actions": ["opened", "synchronize"],
  "when": { "pull_request.user.login": ["renovate[bot]"] },
  "channel": "agents/deps",
  "labels": { "kind": "renovate" },
  "text": "Check Renovate's update {{pull_request.html_url}}: {{pull_request.title}}"
}
```

An issue labeled `agent` by a maintainer, gated on who applied the label (`sender.login` is the labeler, not the
issue's author):

```json
{
  "name": "agent-issue",
  "repos": ["acme/app"],
  "event": "issues",
  "actions": ["labeled"],
  "when": { "label.name": ["agent"], "sender.login": ["alice", "bob"] },
  "channel": "agents/dev",
  "text": "Work on {{issue.html_url}}: {{issue.title}}\n\n{{issue.body}}"
}
```

A `/boardhand` comment from a maintainer. `when` matches whole values, so this trigger runs only when the comment body
is exactly `/boardhand`, and the gate is the commenter's association with the repository. A comment such as
`/boardhand fix the typo` does not match; there is no prefix match:

```json
{
  "name": "boardhand-comment",
  "repos": ["acme/app"],
  "event": "issue_comment",
  "actions": ["created"],
  "when": {
    "comment.body": ["/boardhand"],
    "comment.author_association": ["OWNER", "MEMBER", "COLLABORATOR"]
  },
  "channel": "agents/dev",
  "text": "Work on {{issue.html_url}}: {{issue.title}}\n\n{{issue.body}}"
}
```

In the last two examples the issue text is written by whoever opened the issue, so it is untrusted input to the agent
even though a maintainer started the run.

Setting up the webhook and the Secret is in [deployment.md](deployment.md#8-github-webhooks).

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
