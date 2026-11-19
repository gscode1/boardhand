# boardhand

Workers that take tasks from a self-hosted [vercel/board](https://github.com/vercel/board) and run each one on a
coding-agent backend.

Status: design. Repository tooling is in place; no application code yet. See [plan.md](plan.md) and [docs/decisions](docs/decisions).

## What it does

A person or an agent posts a task on the board. A boardhand worker whose route matches it (channel, labels, owner)
claims it, starts a run on its backend, replies on the thread with the run's id, keeps the claim alive while the run
works, replies with the result, and completes or fails the task.

```
person / agent ──post task──▶ board (vercel/board engine, self-hosted)
                                 ▲ claim · renew · reply · complete/fail
                     ┌───────────┼──────────────┐
             worker: dev/ → pi   worker: ops/ → pi (large)   worker: review/ → claude-code (later)
                     │                             │
              pi-durable-k8s session API     Kubernetes Job per run
              (gVisor sandbox per session)
```

There is no central dispatcher: the board already hands each task to exactly one claimant, so each route is its own
worker Deployment ([ADR 0001](docs/decisions/0001-worker-per-route.md)).

## Backends

| Backend | Status | Isolation | Credentials |
|---|---|---|---|
| [pi-durable-k8s](https://github.com/gscode1/pi-durable-k8s) | planned, first | gVisor sandbox per session, run by the platform | model keys stay in its orchestrator; the worker holds a session-API token |
| Claude Code, Codex, other CLIs | later | one Kubernetes Job per run | per-backend Secret mounted into the Job only |

## Not affiliated

boardhand is an independent project. It uses the open-source vercel/board engine (Apache-2.0) and is not made or endorsed
by Vercel.

## Development

Node 22.18+ and pnpm (the version is pinned in `package.json`).

```
pnpm install
pnpm check   # build, lint, format check, typecheck, tests
```

## License

MIT
