# 0005: The board server is a separate program, with token authentication and per-worker scopes

Status: accepted, 2026-11-19.

## Context

Self-hosted, `@vercel/board` is a library, not a server: `board({ backend, url, authenticate })` returns a handler, and
the host serves it and says who each caller is (the engine docs, "Callers of your own"). Phase 3 must
run one. Constraints from earlier decisions:

- [ADR 0002](0002-board-sdk-only-pinned.md): in the worker, only `src/board.ts` imports `@vercel/board`.
- AGENT.md: each worker's board grants are limited to its channels; secrets come from the environment or mounted
  Secrets and are never logged.
- plan.md: the board is the engine's local SQLite backend, one replica on a PVC.

## Decision

**A separate program in `server/`.** It builds to `dist/server/` (`tsconfig.server.json`) and runs as
`node dist/server/main.js`, from the same image as the worker. The worker never imports it and it never imports the
worker (a test checks both directions). It imports `@vercel/board` and `@vercel/board/backend-local` directly: it
*is* the engine's host, so hiding the engine behind a wrapper would add a layer with one user. ADR 0002 and its test
cover `src/` only, which is where the worker's layers are. The version pin covers both programs.

**Token authentication.** A tokens file, mounted read-only from a Kubernetes Secret (`BOARD_TOKENS_FILE`), has one
entry per line: `name:kind:token[:channels]`. Kinds:

- `person`: a human or an owner. It writes as the principal `boardhand:person:<name>` and gets what the engine gives
  a person (everything). These IDs are what a route's `BOARDHAND_FROM` names.
- `worker`: a boardhand worker. It writes as `boardhand:worker:<name>`, and needs a channel list.

Tokens are compared in constant time: each is hashed with SHA-256 and compared with `timingSafeEqual`, against every
entry with no early exit. A token that matches nothing gets 401. Tokens and the file's text are never logged, and a
parse error names the line, never the value. The board has no token minting or rotation: change the Secret and restart
the pod. Tokens must be long random strings (`openssl rand -hex 32`).

**Worker scopes: `x-board-can`, set by the server.** The engine can narrow any caller with an `x-board-can` header
(`dev/=read,post,label`), which "only narrows" what the principal may do and is meant for a proxy that holds the
credential. The server is that proxy: for a `worker` token it overwrites the header with the worker's channels and
`read,post,label` (claim and settle count as `label`; reply is `post`). Whatever the client sends is replaced, so a
worker cannot widen itself. A test shows a worker claiming, replying and settling in its channel and being refused (403,
or 404 for what it may not read) in another, with and without a hand-sent `x-board-can: all`.

What the engine offers, and why this one (checked in `@vercel/board` 0.52.0, docs and `dist/`):

| Option | Verdict |
|---|---|
| **Grants** (`createGrant`) for a host principal | Not possible for ours. A host-verified principal that is not `kind: 'person'` gets only what grants give its ID, and grants match only `user`, `project`, `github`, `oidc` and `app` principals; of a host's, only `vercel:project:<id>:<env>` ever matches. We would be faking a Vercel project ID. Grants also live in the database, so they are one more thing to bootstrap and back up. |
| **`x-board-can` on a `person` principal** | Chosen. Stateless, set from the tokens file, so access follows the Secret. The engine intersects it with the principal's access. |
| Workers as unrestricted persons | Rejected: a worker whose task text steers its agent could read and write every channel. |

Consequences of the chosen way: the engine calls a worker a `person` internally (its `me` shows `kind: agent` once it
writes as a profile). A narrowed caller cannot register watchers or use sync records; workers need neither. All workers
write as a principal plus the profile `boardhand` (`BOARD_PROFILE`), so each worker's messages show
`boardhand:worker:dev+boardhand`.

**Storage and replicas.** The engine's local backend keeps SQLite files in `BOARD_DATA_DIR`, on a PVC. One replica,
never two: SQLite has one writer, and the local backend is a single-process store (it holds timers and its file open). The chart uses a
StatefulSet with one replica, so a rollout stops the pod before starting the next. Back up the PVC (see
[deployment.md](../deployment.md)). A Postgres backend remains in plan.md "Later".

**Stale-task alert.** Every `BOARD_STALE_CHECK_SECONDS` the server lists ready tasks and logs one
`task.stale` JSON warning for each that has been ready longer than `BOARD_STALE_AFTER_SECONDS`, with task ID, channel,
labels and age. The server does not know the routes, so a stale task is one that nobody claims, whatever the reason: no
route matches, or the route's workers are down or full. Task text is never logged. Age is time since the task was
created; a task that was `waiting` on dependencies counts from creation too.

**Health and shutdown.** `GET /healthz` answers 200 with no authentication, and 503 once shutdown began. On SIGTERM the
server stops accepting, drains requests for up to 5 seconds, cuts the rest (long-polls), closes the backend and exits 0.

## Consequences

- Two programs ship in one image; the image picks one by command.
- A change of the engine touches `src/board.ts` and `server/`; the pin and the conformance step of ADR 0002 apply to
  both.
- The scope model is the weakest point to re-check on each engine upgrade: the `x-board-can` semantics are part of the
  board-contract tests in `test/server/server.test.ts`.
- Later (plan.md): a board identity per run, and grants or a Postgres backend if the board ever serves several teams.
