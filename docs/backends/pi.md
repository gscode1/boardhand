# Backend: pi-durable-k8s

The `pi` backend runs each task as one session of the [pi-durable-k8s](https://github.com/gscode1/pi-durable-k8s)
session API. It is a plain client: the platform needs no change. A run is a session; the run id is the session id.

## Configuration

Set `BOARDHAND_BACKEND=pi`. Options are the JSON object in `BOARDHAND_BACKEND_OPTIONS`; the token comes from the
environment only.

| Name | Where | Default | Meaning |
|---|---|---|---|
| `PI_TOKEN` | env, required | | Bearer token of the worker's session-API owner (a non-admin owner). Never put it in the options. |
| `url` | option, required | | Root of the session API (`http` or `https`, no credentials), e.g. `http://pi-ingest:8080`. |
| `profile` | option | the platform's default | Session profile (for example `coding`). |
| `profileChannel` | option | none | A channel subtree ending in `/` (for example `agents/`), within the route's channel. The profile of a task is the first channel segment below it. See [Profile from the channel](#profile-from-the-channel). |
| `profiles` | option, only with `profileChannel` | `"*"` | `"*"` (any profile; the platform validates) or a non-empty list of allowed profile names. |
| `sandboxSize` | option | the platform's default | Sandbox size (`s`, `m`, `l`, `xl`). |
| `provider`, `model`, `reasoning` | option | the platform's defaults | Passed to session create as given. |
| `deleteOnFinish` | option | `false` | Delete the session when its run has ended (success or failure). |
| `progressSeconds` | option | `0` (never) | At most one progress update per this many seconds, carrying the agent's latest assistant text if it changed. |
| `waitSeconds` | option | `45` | How long one connection to the platform lasts before `wait` reconnects. It does not make `wait` return. |
| `requestTimeoutMs` | option | `30000` | Timeout of each request except the event stream. |

`profileChannel` must lie within the route channel, which must then be a subtree. Unknown option keys are errors, so a typo fails at start. The route loader reports a missing `PI_TOKEN` and bad options
together with the other route problems (exit code 2), before the worker connects to anything.

Example route:

```
BOARDHAND_BACKEND=pi
BOARDHAND_BACKEND_OPTIONS={"url":"http://pi-ingest:8080","profile":"coding","sandboxSize":"m","progressSeconds":120}
PI_TOKEN=<from a Secret>
```

## Profile from the channel

With `profileChannel: "agents/"` on a route whose `BOARDHAND_CHANNEL` is `agents/`, one worker serves every channel
below `agents`, and the session's `profile` is the first segment below the prefix:

| Task channel | Profile |
|---|---|
| `agents/research`, `agents/research/team-a` | `research` |
| `agents` (the prefix itself) | `profile` if set, else none (the platform's default) |
| anything not under `agents/` | the task fails to start: `task channel "<x>" is not under profileChannel "agents/"` |

With `profiles` as a list, a profile that is not in it fails the task with `profile "<x>" is not allowed on this route`
and no request to the platform. With `"*"` or no `profiles`, an unknown profile is the platform's 400 and fails the task
as any 4xx does. The channel, not a label, picks the profile: a label can be changed by anyone who may label the task
([ADR 0006](../decisions/0006-subtree-routes-channel-profiles.md)). Route-level `model`, `sandboxSize`, `provider` and
`reasoning` override the chosen profile's defaults, so leave them out on a multi-profile route.

Example:

```
BOARDHAND_CHANNEL=agents/
BOARDHAND_BACKEND_OPTIONS={"url":"http://pi-ingest:8080","profileChannel":"agents/","profiles":["research","coding"]}
```

## Task labels

| Label | Becomes |
|---|---|
| `repo` | the session's `repo` (`owner/name`; the platform checks its allowlist) |
| `branch` | the session's `branch` |

The task text is untrusted. It is sent only as the session's first message (`kind: message`), never as an option, a
repository or a command.

## Life of a run

1. `start`: `POST /sessions` with the options and labels above, then `POST /sessions/{id}/events` with
   `{ kind: "message", text: <task text>, sourceEventId: "boardhand:<sessionId>:task" }`. The `sourceEventId` makes the
   post safe to retry (it is retried up to three times on a network error or 5xx). If the message cannot be posted the
   session is deleted (best effort) and `start` fails. A network error, timeout, 429 or 5xx (on the create, or on the post
after its retries) is thrown as `BackendUnavailableError`, so the worker hands the task back and tries again later; a 4xx
stays a `PiError` and fails the task. The session id is returned as the run id, and the worker records it on
   the thread as `boardhand.run`.
2. `wait`: follows the session's event stream (`GET /sessions/{id}/stream`, resuming with `Last-Event-ID`) and re-reads
   the session about once a second. The agent counts as finished when the stream says idle, held for 500 ms, and a fresh
   read shows no pending message. A stream opened while a message is still pending is not believed: until the platform
   picks the message up, the session looks idle. Outcomes:
   - idle, session `active`, no run failure: **succeeded**, with the agent's last assistant text (clipped to 9000
     characters);
   - idle with a run failure, session `failed` (its failure text), a message the platform failed to process, or a
     session that was deleted: **failed**;
   - `progressSeconds` elapsed with new assistant text: **progress**.

   While the platform answers 503 (orchestrator down), `wait` waits out `Retry-After` and retries; it returns only for
   the outcomes above, or rejects when aborted. Network errors and other statuses reject, and the worker retries a few
   times before failing the task.
3. End: with `deleteOnFinish`, `wait` deletes the session right before it returns a final outcome (best effort). The
   worker calls nothing after settling.

## Re-attach after a crash

The worker puts `boardhand.run=<session id>` on the thread right after `start` and keeps the id in its claim store. A new
claimant calls `find(task, hint)` with that id:

- not a UUID: no run (nothing is sent to the platform);
- `404`/`410`, or status `deleted`/`deleting`: no run, so the worker starts a new session;
- `active` or `failed`: that session is followed. A restarted worker has no stream cursor, so it replays the whole
  stream (the sessions are small) and still ends with the agent's last text.

Network errors, timeouts, 429 and 5xx from `find` are thrown as `BackendUnavailableError`; the worker releases the task and
backs off. Other errors (a bad token) propagate as `PiError`.

The label is a hint anyone with write access to the thread can set. The platform scopes sessions to the token's owner, so
a foreign session is a 404, but it cannot tie a session to a task. Do not share one owner token between routes that
should not see each other's sessions.

## Lost claim and cancel

When the worker loses a claim (the lease runs out, the task is canceled, a reply is refused) it calls `cancel(runId)`:
a `cancel` event (its failure, such as 404, 409 or 410, is ignored) and then `DELETE /sessions/{id}` (idempotent; a gone session is fine). The
next claimant starts a fresh session or re-attaches if the label still points at a live one. A task whose worker is
stopped with SIGTERM is not canceled: its session keeps running and is re-attached.

## Credentials

- `PI_TOKEN` is the only secret the backend holds. It is read from the environment once, sent as `Authorization: Bearer`,
  and never logged. Errors carry the server's `{error}` text with the token scrubbed, or a fixed phrase for network
  failures (no URL, which can carry a path).
- Requests use `redirect: "error"`, so a redirect cannot carry the token elsewhere.
- Model credentials stay in the platform's orchestrator; nothing of them reaches the worker, the task thread or the
  sandbox through this backend.

## Limits

- Session create has no idempotency key. A crash between the create call and the `Started ... run <id>` reply (or an
  abort of the create request itself) leaves a session nobody follows. The orphan window is small; it ends when the
  platform's own session lifecycle cleans it up. We would use an idempotency key upstream if it gets one.
- There is no list endpoint, so re-attach works only through the thread label (or the claim store).
- A turn that needs input from a person is not supported: the run ends when the agent is idle.
- Only assistant text is reported; tool calls and usage are not.

## Live check

`scripts/live-pi.ts` starts a throwaway board, posts one task and runs a real worker with this backend against a live
platform, then prints the thread. It is not part of `pnpm test`.

```
PI_URL=http://localhost:8080 PI_TOKEN=... PI_PROFILE=coding pnpm live:pi
```

Optional: `PI_REPO`, `PI_BRANCH` (task labels), `PI_TASK` (task text), `PI_TIMEOUT_SECONDS` (default 900),
`PI_PROGRESS_SECONDS` (default 30), `PI_DELETE=1`. It exits 0 when the task completed and 1 otherwise. For a cluster
without ingress, port-forward the `pi-ingest` Service first.

## Live check (historical observation)

2026-11-19, lab cluster `c2`, namespace `pi-durable-poc`, through a port-forward to `svc/pi-ingest`, with the lab's
admin owner token (no non-admin owner exists there yet): `pnpm live:pi` with profile `coding` and `PI_DELETE=1`. The
worker claimed the task, started session `5528c216-…`, replied `Started pi run <id>` with the run label, followed the
turn, completed the task with `pong` and replied `Completed: pong`. The session was `deleted` afterwards.
