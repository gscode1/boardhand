# 0003: Agent backends behind one small interface, pi-durable-k8s first

Status: accepted, 2026-11-19.

## Context

boardhand exists to run board tasks on more than one kind of coding agent:

- **pi-durable-k8s**: a remote platform. A run is a session created over its HTTP session API (text, profile,
  repository); turns are followed with a long-poll `wait`; each session runs in its own gVisor sandbox; model credentials
  stay in its orchestrator.
- **Local CLI agents** (Claude Code, Codex, ...): a run is a process. It needs isolation (its own container, workspace and
  network limits) and its own credentials.

No surveyed project has such an interface: Symphony hard-wires Codex, `templates/swarm` hard-wires one agent SDK, Vibe
Kanban assumes local worktrees.

## Decision

- **One interface.** A backend implements, in outline:
  - `start(task, options) → runId`: start a run for a claimed task.
  - `find(task) → runId | null`: a run already started for this task, for re-attaching after a restart (see ADR 0004).
  - `wait(runId, signal) → progress | result`: follow the run; returns when there is something to report or it ended.
  - `cancel(runId)`: stop the run.
- **Provisional until two exist.** The interface is shaped by pi-durable-k8s and revised when the first local-CLI backend
  lands. It stays as small as the existing backends need.
- **Backends know nothing of the board.** The worker turns results into replies and settles the task. A backend module
  must not import the board SDK; a test enforces it.
- **Isolation and credentials belong to the backend.** pi-durable-k8s brings its own sandbox and keeps model keys in its
  orchestrator; the worker holds only a session-API token of a non-admin owner. A local-CLI backend runs each run as a
  Kubernetes Job with its own ServiceAccount, Secret and egress limits; the worker never mounts model keys itself.
- **pi-durable-k8s is used as a plain client.** It needs no change for this project.

## Consequences

- Adding a backend is one module plus config.
- A backend that cannot re-attach (`find` returns null) can at worst start a second run after a crash; ADR 0004 bounds
  this.
- Backend-specific features (steering a running agent, artifacts, cost) are exposed only once two backends share them.
