# AGENT.md

## Project

boardhand: workers that take tasks from a self-hosted [vercel/board](https://github.com/vercel/board) and run each one on
a coding-agent backend, then report the result on the task's thread. The first backend is
[pi-durable-k8s](https://github.com/gscode1/pi-durable-k8s) (remote sessions in gVisor sandboxes); local CLI agents
(Claude Code, Codex, ...) follow. Stack: TypeScript (Node), Kubernetes, Helm. License: MIT.

Read `plan.md` first. It holds the goal, decisions, architecture, phases and repo layout. Then read `README.md` and
`docs/`. Use the terms in `plan.md` (board, worker, route, backend, run, claim, lease) in code. Do not invent synonyms.

## Toolchain

- Pin exact versions of `@vercel/board` and every backend client. Upgrade only on purpose; an upgrade of `@vercel/board`
  runs its conformance kit and our board-contract tests in the same PR ([ADR 0002](docs/decisions/0002-board-sdk-only-pinned.md)).
- Checks (must pass before any PR): `pnpm check` (build, lint, format, typecheck, unit tests).
- Tests must not depend on run order, fixed ports, paths outside a temp dir, or global state that is left unreset. Give
  every test a timeout so a hang fails the test. Tests run against a throwaway board (the local backend in a temp dir) and
  fake backends, never against a shared board or a real agent platform.

## Git workflow (mandatory)

- Start every change from a GitHub issue. Reuse an existing one if there is one: `gh issue list --state all --search "<words>"`.
  Otherwise create one: `gh issue create -t "<title>" -b "<problem, expected outcome>"`. Name the branch `<issue-number>-<slug>`.
- Use one worktree per change, cut from a fresh `origin/main`:
  `git fetch && git worktree add ../worktrees/boardhand-<topic> -b <topic> origin/main`. The main checkout stays on `main`
  and gets no commits.
- Make small commits, one logical change each, with imperative subjects. No WIP or fixup commits in a PR.
- Push explicitly: `git push -u origin <topic>`.
- Open the PR with `gh pr create --fill`. The body has `Closes #<n>.`, what changed, why, and which checks ran.
- Merge only after all checks pass: `gh pr merge --squash --delete-branch <n>`.
- Clean up afterwards: `git -C <main checkout> pull --ff-only`, remove the worktree, delete the local branch, and confirm
  the issue is closed.
- Never force-push to `main`, rewrite shared history, or bypass checks.

## Coding rules

- Keep modules small, typed and deep. Use strict TypeScript and no `any`.
- Do not add an abstraction with only one implementation. The exception is the `Backend` interface, which exists because
  backends are the point of the project ([ADR 0003](docs/decisions/0003-backend-interface.md)); keep it as small as the
  backends that exist need.
- Talk to the board only through the `@vercel/board` SDK, behind one module (`src/board.ts`). No raw board HTTP elsewhere.
- Match the existing style. Comments explain why, not what.
- Respect layer boundaries: the worker loop knows the board and the `Backend` interface, never a concrete backend; a
  backend never touches the board. A new dependency across layers is a design change.
- Docs are the contract. If code and docs disagree, fix one of them in the same PR. Record new decisions in
  `docs/decisions/` in the same PR.
- Enforce invariants with tests, for example: a settled task is never settled twice, a lost claim cancels the run, a
  backend module does not import the board SDK.
- Never delete or skip a failing test to get green.

## Secrets and data

- Never commit `.env` files, keys, tokens or credentials. Never print or log secret values, including board tokens, claim
  tokens and backend tokens.
- Secrets come from the environment only.
- A worker holds only its board token and its backend's own token. Model credentials stay with the backend (the
  pi-durable-k8s orchestrator, or a local-CLI backend's Job secret) and never enter a task's workspace or the task thread.
- Task text is untrusted input to an agent. Workers claim only from owners listed in their route, and each worker's board
  grants are limited to its channels.
- Tests use temp data dirs and throwaway boards and namespaces. Never touch production boards or clusters.

## Working as an AI agent

- Plan, implement, then verify. Run the checks and read the diff before you report done.
- A subagent's report is not proof. Verify it yourself.
- Give each worker a self-contained brief: the goal, the docs and files involved, the acceptance checks, and what not to
  touch.
- Stop and ask before any irreversible action, or when a request contradicts `plan.md` or the docs.
