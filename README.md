# boardhand

Workers that take tasks from a self-hosted [vercel/board](https://github.com/vercel/board) and run each one on a
coding-agent backend.

Status: phase 3. The worker core, the pi-durable-k8s backend, the board server, the image and the Helm chart are built. See
[plan.md](plan.md) and [docs/decisions](docs/decisions).

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

How one task flows through a worker is in [docs/worker.md](docs/worker.md).

The board server can also start tasks from GitHub: declarative triggers turn webhook events (a Renovate PR, an issue
labeled by a maintainer, a `/boardhand` comment) into tasks ([ADR 0008](docs/decisions/0008-github-triggers.md),
[docs/configuration.md](docs/configuration.md#github-triggers)). Results are not posted back to GitHub yet.

## Run a worker

One worker serves one route, and it is configured from the environment. Set these, then start it:

```
export BOARD_URL=https://board.example.com
export BOARD_TOKEN=...                 # secret
export BOARDHAND_CHANNEL=dev
export BOARDHAND_FROM=<owner id>[,<owner id>]
export BOARDHAND_BACKEND=fake
pnpm build && node dist/main.js
```

Every variable, its range, the fake backend's options, the exit codes and the log format are in
[docs/configuration.md](docs/configuration.md).

## Deploy

One image runs any of three programs (`node dist/main.js`, the worker, `node dist/server/main.js`, the board, or
`node dist/server/inspect.js`, the board's UI), and one Helm chart installs the board (StatefulSet and PVC), a worker
Deployment per route and, optionally, the UI behind a Gateway (no authentication yet, see
[ADR 0007](docs/decisions/0007-inspector-in-cluster.md)), under Pod Security `restricted` and NetworkPolicies:

```
helm upgrade --install boardhand charts/boardhand -n boardhand -f charts/boardhand/examples/c2.yaml
```

Secrets, posting a task, logs, upgrades and backups are in [docs/deployment.md](docs/deployment.md).

## Backends

| Backend | Status | Isolation | Credentials |
|---|---|---|---|
| fake | built (phase 1), for tests | none | none |
| [pi-durable-k8s](https://github.com/gscode1/pi-durable-k8s) ([docs](docs/backends/pi.md)) | implemented, first | gVisor sandbox per session, run by the platform | model keys stay in its orchestrator; the worker holds a session-API token |
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
