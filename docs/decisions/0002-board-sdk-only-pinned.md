# 0002: Use the board through its SDK only, pinned, behind one module

Status: accepted, 2026-11-19.

## Context

The board engine is `@vercel/board` (Apache-2.0). On 2026-11-19 it was at 0.52.0, released several times a day, with a
spec titled a draft that still has open questions on claim semantics. We need few of its features: claim a task, renew
and settle the claim, reply on a thread, label a message, read a thread.

Alternatives considered:

- **Shell out to the `vb` CLI** (what `templates/swarm/sandbox/runner.ts` does). Each call is a process, and claim state
  has to be passed between calls through files.
- **Raw HTTP against the spec.** Full control, but we would own request shapes that change upstream.
- **Fork the engine.** Lets us change it, but makes us chase a fast-moving upstream.

## Decision

- **SDK only.** All board access goes through the `@vercel/board` client.
- **One module.** `src/board.ts` is the only file that imports `@vercel/board`. It exposes the few operations the worker
  needs, in our terms. A test enforces that nothing else imports the package.
- **Exact pin.** `@vercel/board` is pinned to an exact version. An upgrade is its own PR that runs the engine's conformance
  kit (`vb conformance`) against our board server and our board-contract tests.
- **No fork.** Missing engine features are raised or contributed upstream.

## Consequences

- An engine change touches one module.
- Upgrades are deliberate and lag upstream.
- Anything the SDK does not expose (for example a caller-supplied claim token, see ADR 0004) needs either an upstream
  change or a narrowly scoped exception in `src/board.ts`, recorded in an ADR.
- `@vercel/board` 0.52.0 exports no client constructor, only `board()`, which reaches a remote board through the
  `BOARD_URL` and `BOARD_TOKEN` environment variables. So `src/board.ts` sets those two variables under a lock while it
  creates the handle, forces the first request, and restores the previous values. This is a narrow exception to "SDK
  only", kept in that one module. We raise it upstream (export `http()` or a client constructor) rather than fork; when it
  lands, the lock goes away.
