# 0007: The board's UI runs in the cluster as its own program, without authentication for now

Status: accepted, 2026-11-20.

## Context

The SDK ships the board's UI, the inspector (`vb inspect`). The CLI binds 127.0.0.1 only, so using it means a
port-forward and a laptop ([deployment.md](../deployment.md)). We want it at a lab hostname behind the cluster's
gateway. The library export, `inspector({ board, basePath })` from `@vercel/board/inspect` (0.52.0), is a fetch-style
handler for exactly that.

What it checks, from its source: a proxied request must carry the page's token (a fixed value, no secret), a browser's
`Sec-Fetch-Site` must say `same-origin`, and a write must carry an `Origin` whose host equals the request URL's host or
its `Host` header. Every request acts as the board client's principal, under the profile the page names
(`x-board-profile`); a write naming none, or the client's own profile, is refused. The handler has no notion of who the
visitor is.

## Decision

- A third entrypoint of the one image, `node dist/server/inspect.js` (`server/inspect.ts`, `server/inspector.ts`), with
  the board server's `http.ts` for node:http. It mounts the handler at the root, serves `/healthz`, retries while the
  board is unreachable, exits 2 on bad configuration and 0 on SIGTERM. It reads `BOARD_URL`, `BOARD_TOKEN` and
  `INSPECT_PORT` (default 4747).
- It holds one owner (`person`) token. Tasks created in the UI are owned by that principal, so workers with it in
  `from` claim them. This is also the only thing the token gives: it is a human's token, not a worker's.
- The chart adds it as an opt-in Deployment, Service and a Gateway API HTTPRoute (`inspector.httpRoute`), under the same
  Pod Security as the other pods. NetworkPolicies admit only `inspector.allowFrom` (the gateway's proxy pods) to it, the
  inspector to the board and DNS, and the inspector pods to the board.
- "This origin" is the `Host` header. Envoy Gateway passes it unchanged, and a browser's `Origin` for `http://` and
  `https://` has the same host, so writes work on both schemes without `X-Forwarded-*` handling. We do not rewrite
  `Host` or trust forwarded headers.

## Consequences

- **No authentication.** Whoever can reach the hostname acts as the owner: they read every channel and create or cancel
  tasks that workers then run. The page token and origin checks defend against other websites in a visitor's browser,
  not against a visitor. This was chosen for testing only; the hostname must stay internal.
- All visitors are one principal. The profile they pick is a label, not an identity, and anyone can pick any.
- Later: an Envoy Gateway `SecurityPolicy` with Authentik (OIDC) on the HTTPRoute, so the gateway authenticates before
  the request reaches the inspector. Then the token Secret can stay, or a per-user mapping can replace it if the
  inspector gains a `visitor` hook (the SDK's `vb inspect --allow-host` machinery has one; the library handler does not).
- An upgrade of `@vercel/board` re-checks the origin rules above: `test/server/inspector.test.ts` pins them.
