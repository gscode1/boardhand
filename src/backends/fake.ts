// A scriptable backend for tests. Behaviour comes from the task's `fake` label (succeed | fail | hang | slow), else the
// `behavior` option. With a `dir` runs are files, so another process (a restarted worker) can `find` them; what a run
// reports is computed from its timestamps, so no process has to stay alive for it to "run".
import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "../atomic.js";
import { BackendUnavailableError } from "./backend.js";
import type { Backend, RunTask, RunUpdate } from "./backend.js";

export type FakeBehavior = "succeed" | "fail" | "hang" | "slow";
const BEHAVIORS: readonly string[] = ["succeed", "fail", "hang", "slow"];

export type FakeOptions = {
  behavior?: FakeBehavior;
  /** How long a succeed or fail run takes. Default 50. */
  stepMs?: number;
  /** How long a slow run takes; it reports three progress updates on the way. Default 2000. */
  slowMs?: number;
  /** The first this many `start` calls throw `BackendUnavailableError`, as a platform that is down does. */
  unavailableStarts?: number;
  /** The first this many `find` calls throw `BackendUnavailableError`. */
  unavailableFinds?: number;
  /** Persist runs as `<dir>/runs/<id>.json`. */
  dir?: string;
};

export type FakeRun = {
  id: string;
  taskId: string;
  behavior: FakeBehavior;
  stepMs: number;
  slowMs: number;
  startedAt: number;
  canceledAt?: number;
};

const PROGRESS_UPDATES = 3;
// How often a waiting run re-reads its record, to notice a cancel made by another process.
const POLL_MS = 25;

function isBehavior(value: string): value is FakeBehavior {
  return BEHAVIORS.includes(value);
}

function numberOption(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Reads `options` as given by BOARDHAND_BACKEND_OPTIONS (untyped JSON). */
export function parseFakeOptions(raw: Record<string, unknown>): FakeOptions {
  const options: FakeOptions = {
    stepMs: numberOption(raw["stepMs"], 50),
    slowMs: numberOption(raw["slowMs"], 2000),
  };
  const behavior = raw["behavior"];
  if (behavior !== undefined) {
    if (typeof behavior !== "string" || !isBehavior(behavior))
      throw new Error("fake: behavior must be succeed, fail, hang or slow");
    options.behavior = behavior;
  }
  for (const key of ["unavailableStarts", "unavailableFinds"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0)
      throw new Error(`fake: ${key} must be a non-negative integer`);
    options[key] = value;
  }
  const dir = raw["dir"];
  if (dir !== undefined) {
    if (typeof dir !== "string" || dir === "") throw new Error("fake: dir must be a non-empty string");
    options.dir = dir;
  }
  return options;
}

export class FakeBackend implements Backend {
  readonly name = "fake";
  /** Task ids this instance started, in order. With `dir`, `FakeBackend.readRuns(dir)` counts across processes. */
  readonly starts: string[] = [];
  /** Run ids this instance canceled, in order. */
  readonly cancels: string[] = [];
  readonly #options: FakeOptions;
  readonly #memory = new Map<string, FakeRun>();
  /** How many progress updates a run has already handed out, per run id, for this instance. */
  readonly #delivered = new Map<string, number>();
  /** Test hook: the next this many `start` calls throw `BackendUnavailableError`. */
  unavailableStarts: number;
  /** Test hook: the next this many `find` calls throw `BackendUnavailableError`. */
  unavailableFinds: number;

  constructor(options: FakeOptions = {}) {
    this.#options = options;
    this.unavailableStarts = options.unavailableStarts ?? 0;
    this.unavailableFinds = options.unavailableFinds ?? 0;
  }

  /** Every run recorded under `dir`, oldest first. */
  static async readRuns(dir: string): Promise<FakeRun[]> {
    const runsDir = join(dir, "runs");
    let names: string[];
    try {
      names = await readdir(runsDir);
    } catch {
      return [];
    }
    const runs: FakeRun[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      try {
        runs.push(JSON.parse(await readFile(join(runsDir, name), "utf8")) as FakeRun);
      } catch {
        // a file being replaced, or not ours: skip it
      }
    }
    return runs.sort((a, b) => a.startedAt - b.startedAt);
  }

  async start(task: RunTask, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    if (this.unavailableStarts > 0) {
      this.unavailableStarts -= 1;
      throw new BackendUnavailableError("fake: platform unavailable");
    }
    const label = task.labels["fake"] ?? this.#options.behavior ?? "succeed";
    if (!isBehavior(label)) throw new Error(`fake: unknown behavior "${label}"`);
    const run: FakeRun = {
      id: `fake-${randomUUID()}`,
      taskId: task.id,
      behavior: label,
      stepMs: this.#options.stepMs ?? 50,
      slowMs: this.#options.slowMs ?? 2000,
      startedAt: Date.now(),
    };
    await this.#save(run);
    this.starts.push(task.id);
    return run.id;
  }

  async find(task: RunTask, hint: string | null): Promise<string | null> {
    if (this.unavailableFinds > 0) {
      this.unavailableFinds -= 1;
      throw new BackendUnavailableError("fake: platform unavailable");
    }
    // A canceled run is over; a new claimant starts fresh rather than re-attach to it.
    const live = (await this.#all()).filter((run) => run.taskId === task.id && run.canceledAt === undefined);
    if (hint !== null && live.some((run) => run.id === hint)) return hint;
    return live.at(-1)?.id ?? null;
  }

  async wait(runId: string, signal: AbortSignal): Promise<RunUpdate> {
    for (;;) {
      signal.throwIfAborted();
      const run = await this.#load(runId);
      if (run === null) return { kind: "failed", reason: "run not found" };
      if (run.canceledAt !== undefined) return { kind: "failed", reason: "canceled" };
      const now = Date.now();
      const update = this.#due(run, now);
      if (update !== null) return update;
      await sleep(Math.min(POLL_MS, Math.max(1, this.#nextAt(run) - now)), signal);
    }
  }

  async cancel(runId: string): Promise<void> {
    const run = await this.#load(runId);
    if (run === null || run.canceledAt !== undefined) return;
    await this.#save({ ...run, canceledAt: Date.now() });
    this.cancels.push(runId);
  }

  #endAt(run: FakeRun): number {
    return run.startedAt + (run.behavior === "slow" ? run.slowMs : run.stepMs);
  }

  #milestoneAt(run: FakeRun, index: number): number {
    return run.startedAt + (run.slowMs * index) / (PROGRESS_UPDATES + 1);
  }

  #nextAt(run: FakeRun): number {
    return run.behavior === "hang" ? Number.POSITIVE_INFINITY : this.#endAt(run);
  }

  #due(run: FakeRun, now: number): RunUpdate | null {
    if (run.behavior === "hang") return null;
    if (run.behavior === "slow") {
      // Per instance: after a restart the new instance reports progress from the start again, which is harmless.
      const delivered = this.#delivered.get(run.id) ?? 0;
      if (delivered < PROGRESS_UPDATES && this.#milestoneAt(run, delivered + 1) <= now) {
        this.#delivered.set(run.id, delivered + 1);
        return { kind: "progress", text: `fake progress ${String(delivered + 1)} of ${String(PROGRESS_UPDATES)}` };
      }
      if (delivered < PROGRESS_UPDATES) return null;
    }
    if (now < this.#endAt(run)) return null;
    return run.behavior === "fail"
      ? { kind: "failed", reason: `fake failure for task ${run.taskId}` }
      : { kind: "succeeded", result: `fake result for task ${run.taskId}` };
  }

  async #all(): Promise<FakeRun[]> {
    return this.#options.dir === undefined ? [...this.#memory.values()] : FakeBackend.readRuns(this.#options.dir);
  }

  async #load(runId: string): Promise<FakeRun | null> {
    if (this.#options.dir === undefined) return this.#memory.get(runId) ?? null;
    try {
      return JSON.parse(await readFile(join(this.#options.dir, "runs", `${runId}.json`), "utf8")) as FakeRun;
    } catch {
      return null;
    }
  }

  async #save(run: FakeRun): Promise<void> {
    if (this.#options.dir === undefined) {
      this.#memory.set(run.id, run);
      return;
    }
    await mkdir(join(this.#options.dir, "runs"), { recursive: true });
    await writeFileAtomic(join(this.#options.dir, "runs", `${run.id}.json`), JSON.stringify(run), 0o644);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
