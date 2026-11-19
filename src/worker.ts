// The worker: `concurrency` claim loops for one route. Each claimed task gets one run, a lease renewer that is
// independent of the backend, and exactly one settle (ADR 0004). Control flow leaves a task by throwing `Unwind`;
// every board and backend call goes through `#call`, so `kill()` can stop a worker the way a crash would.
import { isClaimOver, isUnreachable } from "./board.js";
import type { Board, Claim } from "./board.js";
import type { Backend, RunTask } from "./backends/backend.js";
import type { ClaimStore, StoredClaim } from "./claims.js";
import type { Route } from "./route.js";

/** The label that records a task's run on its thread, so a new claimant can re-attach. */
export const RUN_LABEL = "boardhand.run";

export type LogEntry = { level: "info" | "warn" | "error"; event: string; [field: string]: unknown };
export type Logger = (entry: LogEntry) => void;
export type BackoffOptions = { baseMs: number; maxMs: number };

export type WorkerOptions = {
  route: Route;
  board: Board;
  backend: Backend;
  store: ClaimStore;
  log: Logger;
  /** For claim retries while the board is unreachable. Default 250 ms doubling to 30 s. */
  backoff?: BackoffOptions;
  /** Jitter source in [0, 1). */
  random?: () => number;
};

// Replies are capped by the board (10 000 characters); a long result must not turn a finished run into an error.
const TEXT_MAX = 9000;
const WAIT_ERRORS_MAX = 5;
const FINAL_REPLY_ATTEMPTS = 3;

class Unwind extends Error {}
class Killed extends Error {}

type TaskState = {
  claim: Claim;
  task: RunTask;
  ctl: AbortController;
  runId: string | null;
  started: boolean;
  settling: boolean;
  settled: boolean;
  lost: boolean;
};

export class Worker {
  readonly #route: Route;
  readonly #board: Board;
  readonly #backend: Backend;
  readonly #store: ClaimStore;
  readonly #log: Logger;
  readonly #backoff: BackoffOptions;
  readonly #random: () => number;
  readonly #claiming = new AbortController();
  readonly #tasks = new Set<TaskState>();
  #stopping = false;
  #killed = false;
  #finished: Promise<void> = Promise.resolve();

  constructor(options: WorkerOptions) {
    this.#route = options.route;
    this.#board = options.board;
    this.#backend = options.backend;
    this.#store = options.store;
    this.#log = options.log;
    this.#backoff = options.backoff ?? { baseMs: 250, maxMs: 30_000 };
    this.#random = options.random ?? Math.random;
  }

  /** Resolves when every claim loop has ended (after `stop()` or `kill()`). */
  get finished(): Promise<void> {
    return this.#finished;
  }

  /** Task ids this worker currently holds, for tests and logs. */
  get activeTaskIds(): string[] {
    return [...this.#tasks].map((t) => t.task.id);
  }

  /** Resumes stored claims, then starts the claim loops. */
  async start(): Promise<void> {
    const stored = await this.#store.list();
    this.#log({ level: "info", event: "worker.start", resumable: stored.length, concurrency: this.#route.concurrency });
    const loops: Promise<void>[] = [];
    // A route whose concurrency was lowered since the last run still resumes every stored claim: their leases are ticking.
    for (let i = 0; i < Math.max(this.#route.concurrency, stored.length); i += 1) {
      loops.push(this.#loop(stored[i] ?? null, i < this.#route.concurrency));
    }
    this.#finished = Promise.all(loops).then(() => undefined);
  }

  /**
   * Graceful shutdown (SIGTERM): stop claiming, release tasks whose run has not started, and stop following started
   * runs without cancelling or releasing them, keeping their stored claims for a restart.
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    this.#claiming.abort();
    for (const t of this.#tasks) t.ctl.abort();
    await this.#finished;
  }

  /** Test hook: drop everything abruptly, as a crash would. No release, no cancel, no store changes. */
  kill(): void {
    this.#killed = true;
    this.#claiming.abort();
    for (const t of this.#tasks) t.ctl.abort();
  }

  async #loop(resume: StoredClaim | null, repeat: boolean): Promise<void> {
    try {
      if (resume !== null) await this.#resume(resume);
      const backoff = new Backoff(this.#backoff, this.#random);
      while (repeat && !this.#stopped() && !this.#dead()) {
        let claim: Claim | null;
        try {
          claim = await this.#board.claim(
            {
              channel: this.#route.channel,
              labels: this.#route.labels,
              from: this.#route.from,
              waitSeconds: this.#route.waitSeconds,
              leaseSeconds: this.#route.leaseSeconds,
            },
            this.#claiming.signal,
          );
          backoff.reset();
        } catch (error) {
          const delay = backoff.next();
          this.#log({ level: "warn", event: "claim.error", error: describe(error), retryInMs: Math.round(delay) });
          await sleep(delay, this.#claiming.signal);
          continue;
        }
        if (claim === null) continue;
        if (this.#stopped() || this.#dead()) {
          // The claim answered just as shutdown began: hand the task straight back.
          if (!this.#dead()) await claim.release().catch(() => undefined);
          break;
        }
        await this.#handle(claim, null);
      }
    } catch (error) {
      if (!(error instanceof Killed)) this.#log({ level: "error", event: "loop.crashed", error: describe(error) });
    }
  }

  /** Re-acquires a stored claim through `held` + `renew`. Claim over means someone else owns the task now: drop it. */
  async #resume(stored: StoredClaim): Promise<void> {
    const backoff = new Backoff(this.#backoff, this.#random);
    for (;;) {
      if (this.#stopped() || this.#dead()) return;
      try {
        const claim = await this.#board.held(stored.taskId, { epoch: stored.epoch, token: stored.token });
        await claim.renew(this.#route.leaseSeconds);
        this.#log({ level: "info", event: "claim.resumed", taskId: stored.taskId, epoch: stored.epoch });
        await this.#handle(claim, stored.runId ?? null);
        return;
      } catch (error) {
        if (!isUnreachable(error)) {
          // Claim over, or the task is gone: nothing to resume. A new claimant re-attaches through the thread's label.
          this.#log({ level: "info", event: "claim.dropped", taskId: stored.taskId, reason: describe(error) });
          if (!this.#dead()) await this.#store.remove(stored.taskId);
          return;
        }
        const delay = backoff.next();
        this.#log({ level: "warn", event: "resume.error", taskId: stored.taskId, error: describe(error) });
        await sleep(delay, this.#claiming.signal);
      }
    }
  }

  async #handle(claim: Claim, storedRunId: string | null): Promise<void> {
    const t: TaskState = {
      claim,
      task: { id: claim.task.id, channel: claim.task.channel, text: claim.task.text, labels: claim.task.labels },
      ctl: new AbortController(),
      runId: storedRunId,
      started: false,
      settling: false,
      settled: false,
      lost: false,
    };
    this.#tasks.add(t);
    this.#log({ level: "info", event: "task.claimed", taskId: t.task.id, epoch: claim.epoch });
    try {
      await this.#call(() => this.#store.put(this.#stored(t)));
      void this.#renewLoop(t);
      await this.#drive(t, storedRunId);
    } catch (error) {
      if (error instanceof Killed) return;
      // An abort (lost claim or shutdown) can surface as the backend's own error; it is not a failure of the task.
      if (!(error instanceof Unwind) && !t.ctl.signal.aborted) await this.#failUnexpected(t, error);
      else if (this.#stopped() && !t.lost && !t.settled && !t.started) await this.#releaseUnstarted(t);
    } finally {
      t.ctl.abort();
      this.#tasks.delete(t);
    }
  }

  async #drive(t: TaskState, storedRunId: string | null): Promise<void> {
    const hint = storedRunId ?? (await this.#retry(t, () => this.#board.findLabel(t.task.id, RUN_LABEL)));
    const found = await this.#call(() => this.#backend.find(t.task, hint));
    if (found === null) {
      const runId = await this.#call(() => this.#backend.start(t.task, t.ctl.signal));
      if (t.ctl.signal.aborted) {
        // The claim was lost, or shutdown began, while the run was being created: nobody will follow this run, so stop
        // it rather than leave it running unrecorded. A stop then releases the task as one whose run never started.
        await this.#backend.cancel(runId).catch(() => undefined);
        throw new Unwind();
      }
      t.runId = runId;
      // From here a stop must not release: a run exists.
      t.started = true;
      await this.#call(() => this.#store.put(this.#stored(t)));
      this.#log({ level: "info", event: "run.started", taskId: t.task.id, runId: t.runId });
      // Recorded on the thread before the first wait, so a crash from here on re-attaches instead of starting again.
      await this.#retry(t, () =>
        this.#board.reply(t.task.id, `Started ${this.#backend.name} run ${t.runId ?? ""}`, {
          [RUN_LABEL]: t.runId ?? "",
        }),
      );
    } else {
      t.runId = found;
      t.started = true;
      await this.#call(() => this.#store.put(this.#stored(t)));
      this.#log({ level: "info", event: "run.reattached", taskId: t.task.id, runId: found });
      await this.#retry(t, () =>
        this.#board.reply(t.task.id, `Re-attached to ${this.#backend.name} run ${found}`, { [RUN_LABEL]: found }),
      );
    }
    await this.#follow(t, t.runId);
  }

  async #follow(t: TaskState, runId: string): Promise<void> {
    const backoff = new Backoff(this.#backoff, this.#random);
    let errors = 0;
    for (;;) {
      let update;
      try {
        update = await this.#call(() => this.#backend.wait(runId, t.ctl.signal));
        errors = 0;
        backoff.reset();
      } catch (error) {
        if (error instanceof Killed || t.ctl.signal.aborted) throw error instanceof Killed ? error : new Unwind();
        errors += 1;
        this.#log({ level: "warn", event: "run.wait_error", taskId: t.task.id, runId, error: describe(error) });
        if (errors >= WAIT_ERRORS_MAX) {
          await this.#settle(t, "fail", `lost contact with the run: ${describe(error)}`);
          return;
        }
        await sleep(backoff.next(), t.ctl.signal);
        continue;
      }
      if (update.kind === "progress") {
        await this.#progress(t, update.text);
      } else if (update.kind === "succeeded") {
        await this.#settle(t, "complete", update.result);
        return;
      } else {
        await this.#settle(t, "fail", update.reason);
        return;
      }
    }
  }

  /** Progress is best-effort: a failed reply must not fail the run. A claim-over answer still ends the task. */
  async #progress(t: TaskState, text: string): Promise<void> {
    try {
      await this.#call(() => this.#board.reply(t.task.id, clip(text)));
    } catch (error) {
      if (error instanceof Killed) throw error;
      if (isClaimOver(error)) return await this.#unwindLost(t, "reply: claim over");
      this.#log({ level: "warn", event: "reply.error", taskId: t.task.id, error: describe(error) });
    }
  }

  /** Settles once: complete or fail, then says so on the thread. Claim over means cancel the run and stop. */
  async #settle(t: TaskState, how: "complete" | "fail", text: string): Promise<void> {
    if (t.settled || t.settling) return;
    t.settling = true;
    try {
      await this.#retry(t, () => (how === "complete" ? t.claim.complete(clip(text)) : t.claim.fail(clip(text))));
    } catch (error) {
      t.settling = false;
      throw error;
    }
    t.settled = true;
    t.settling = false;
    this.#log({
      level: "info",
      event: how === "complete" ? "task.completed" : "task.failed",
      taskId: t.task.id,
      runId: t.runId,
    });
    await this.#call(() => this.#store.remove(t.task.id));
    await this.#finalReply(t, `${how === "complete" ? "Completed" : "Failed"}: ${clip(text)}`);
  }

  async #finalReply(t: TaskState, text: string): Promise<void> {
    const backoff = new Backoff(this.#backoff, this.#random);
    for (let attempt = 1; attempt <= FINAL_REPLY_ATTEMPTS; attempt += 1) {
      try {
        await this.#call(() => this.#board.reply(t.task.id, text));
        return;
      } catch (error) {
        if (error instanceof Killed) throw error;
        this.#log({ level: "warn", event: "reply.error", taskId: t.task.id, error: describe(error), attempt });
        if (attempt < FINAL_REPLY_ATTEMPTS) await sleep(backoff.next(), undefined);
      }
    }
  }

  /**
   * Renews every third of the lease on its own timer, so a long backend call never lets the lease lapse. Claim over, or
   * no success before `until`, means the task is lost.
   */
  async #renewLoop(t: TaskState): Promise<void> {
    const interval = (this.#route.leaseSeconds * 1000) / 3;
    const backoff = new Backoff(this.#backoff, this.#random);
    try {
      while (await sleep(interval, t.ctl.signal)) {
        for (;;) {
          try {
            await this.#call(() => t.claim.renew(this.#route.leaseSeconds));
            backoff.reset();
            break;
          } catch (error) {
            if (error instanceof Killed || t.ctl.signal.aborted) return;
            if (isClaimOver(error)) {
              await this.#lost(t, "renew: claim over");
              return;
            }
            const remaining = t.claim.until.getTime() - Date.now();
            if (remaining <= 0) {
              await this.#lost(t, "lease ran out while the board was unreachable");
              return;
            }
            this.#log({ level: "warn", event: "renew.error", taskId: t.task.id, error: describe(error) });
            if (!(await sleep(Math.min(backoff.next(), remaining), t.ctl.signal))) return;
          }
        }
      }
    } catch (error) {
      if (!(error instanceof Killed))
        this.#log({ level: "error", event: "renew.crashed", taskId: t.task.id, error: describe(error) });
    }
  }

  /** The claim is over: stop the run and settle nothing. The next claimant re-attaches or starts fresh. */
  async #lost(t: TaskState, reason: string): Promise<void> {
    if (t.lost || t.settled || t.settling) return;
    t.lost = true;
    this.#log({ level: "warn", event: "claim.lost", taskId: t.task.id, runId: t.runId, reason });
    t.ctl.abort();
    if (this.#dead()) return;
    if (t.runId !== null) {
      await this.#backend.cancel(t.runId).catch((error: unknown) => {
        this.#log({
          level: "error",
          event: "run.cancel_error",
          taskId: t.task.id,
          runId: t.runId,
          error: describe(error),
        });
      });
    }
    await this.#store.remove(t.task.id).catch(() => undefined);
  }

  async #unwindLost(t: TaskState, reason: string): Promise<never> {
    await this.#lost(t, reason);
    throw new Unwind();
  }

  /** A worker-side error (a backend that cannot start, a board refusal that is not retryable): end the task visibly. */
  async #failUnexpected(t: TaskState, error: unknown): Promise<void> {
    this.#log({ level: "error", event: "task.error", taskId: t.task.id, runId: t.runId, error: describe(error) });
    if (t.settled || t.settling || t.lost) return;
    try {
      if (t.runId !== null) await this.#backend.cancel(t.runId);
      await this.#settle(t, "fail", `worker error: ${describe(error)}`);
    } catch (second) {
      if (!(second instanceof Unwind) && !(second instanceof Killed)) {
        this.#log({ level: "error", event: "task.fail_error", taskId: t.task.id, error: describe(second) });
      }
    }
  }

  async #releaseUnstarted(t: TaskState): Promise<void> {
    try {
      await t.claim.release();
      await this.#store.remove(t.task.id);
      this.#log({ level: "info", event: "task.released", taskId: t.task.id });
    } catch (error) {
      this.#log({ level: "warn", event: "release.error", taskId: t.task.id, error: describe(error) });
    }
  }

  /**
   * Retries a board call while the board is unreachable, until the lease ends. Claim over (or lease end) cancels the
   * run and unwinds; anything else is not ours to retry and propagates.
   */
  async #retry<T>(t: TaskState, fn: () => Promise<T>): Promise<T> {
    const backoff = new Backoff(this.#backoff, this.#random);
    for (;;) {
      try {
        return await this.#call(fn);
      } catch (error) {
        if (error instanceof Killed) throw error;
        if (t.ctl.signal.aborted) throw new Unwind();
        if (isClaimOver(error)) return this.#unwindLost(t, "board says the claim is over");
        if (!isUnreachable(error)) throw error;
        const remaining = t.claim.until.getTime() - Date.now();
        if (remaining <= 0) return this.#unwindLost(t, "lease ran out while the board was unreachable");
        this.#log({ level: "warn", event: "board.unreachable", taskId: t.task.id, error: describe(error) });
        await sleep(Math.min(backoff.next(), remaining), t.ctl.signal);
      }
    }
  }

  // Methods, not field reads: TypeScript narrows a flag after an await and flags the rechecks, but another task can
  // flip it meanwhile.
  #stopped(): boolean {
    return this.#stopping;
  }

  #dead(): boolean {
    return this.#killed;
  }

  /** Every outside call goes through here, so a killed worker does nothing more, before or after the call. */
  async #call<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#dead()) throw new Killed();
    const result = await fn();
    if (this.#dead()) throw new Killed();
    return result;
  }

  #stored(t: TaskState): StoredClaim {
    const stored: StoredClaim = { taskId: t.task.id, epoch: t.claim.epoch, token: t.claim.token };
    if (t.runId !== null && t.started) stored.runId = t.runId;
    return stored;
  }
}

export function startWorker(options: WorkerOptions): Promise<Worker> {
  const worker = new Worker(options);
  return worker.start().then(() => worker);
}

class Backoff {
  readonly #options: BackoffOptions;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions, random: () => number) {
    this.#options = options;
    this.#random = random;
  }

  /** Exponential, with jitter between half and all of the step so workers do not retry in lockstep. */
  next(): number {
    const step = Math.min(this.#options.maxMs, this.#options.baseMs * 2 ** Math.min(this.#attempt, 30));
    this.#attempt += 1;
    return step / 2 + (this.#random() * step) / 2;
  }

  reset(): void {
    this.#attempt = 0;
  }
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function clip(text: string): string {
  return text.length <= TEXT_MAX ? text : `${text.slice(0, TEXT_MAX)}…`;
}

/** An error as a short string for logs. Messages come from the board or the backend, never from our secrets. */
function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= 300 ? text : `${text.slice(0, 300)}…`;
}
