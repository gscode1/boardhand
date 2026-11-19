// Scenarios for the worker loop against a real throwaway board and the fake backend (plan.md §4-5, ADR 0004).
import { afterEach, describe, expect, it } from "vitest";
import { FakeBackend } from "../src/backends/fake.js";
import type { Backend, RunTask, RunUpdate } from "../src/backends/backend.js";
import { RUN_LABEL } from "../src/worker.js";
import { CHANNEL, Rig, SettleCounter } from "./helpers/scenario.js";
import { createTask, waitFor } from "./helpers/board-server.js";
import { startFlakyProxy } from "./helpers/flaky-proxy.js";

const rig = new Rig();
afterEach(async () => {
  await rig.dispose();
});

const runIdOf = (text: string): string => text.replace(/^.* run /, "");

/** Wraps a backend so `start` blocks until `open()`, for tests that stop a worker mid-start. */
class GatedBackend implements Backend {
  readonly name = "fake";
  readonly entered: Promise<void>;
  readonly #inner: FakeBackend;
  readonly #ignoreAbort: boolean;
  #open: () => void = () => undefined;
  #enter: () => void = () => undefined;
  readonly #gate: Promise<void>;

  constructor(inner: FakeBackend, ignoreAbort: boolean) {
    this.#inner = inner;
    this.#ignoreAbort = ignoreAbort;
    this.#gate = new Promise<void>((resolve) => {
      this.#open = resolve;
    });
    this.entered = new Promise<void>((resolve) => {
      this.#enter = resolve;
    });
  }

  open(): void {
    this.#open();
  }

  async start(task: RunTask, signal: AbortSignal): Promise<string> {
    this.#enter();
    if (this.#ignoreAbort) {
      // A backend that finishes creating the run although the worker has given up on the task.
      await this.#gate;
      return this.#inner.start(task, new AbortController().signal);
    }
    await new Promise<void>((resolve, reject) => {
      void this.#gate.then(resolve);
      signal.addEventListener(
        "abort",
        () => {
          reject(signal.reason as Error);
        },
        { once: true },
      );
    });
    return this.#inner.start(task, signal);
  }

  find(task: RunTask, hint: string | null): Promise<string | null> {
    return this.#inner.find(task, hint);
  }
  wait(runId: string, signal: AbortSignal): Promise<RunUpdate> {
    return this.#inner.wait(runId, signal);
  }
  cancel(runId: string): Promise<void> {
    return this.#inner.cancel(runId);
  }
  get cancels(): string[] {
    return this.#inner.cancels;
  }
  get starts(): string[] {
    return this.#inner.starts;
  }
}

describe("worker scenarios", () => {
  it(
    "completes a task: run recorded on the thread first, then the result, then a final reply",
    {
      timeout: 20_000,
    },
    async () => {
      const board = await rig.board();
      const w = await rig.launch(board);
      const id = await createTask(board, CHANNEL, "do it");
      const info = await rig.untilReply(board, id, "Completed:");
      expect(info.state).toBe("completed");
      expect(info.result).toBe(`fake result for task ${id}`);
      expect(info.replies).toHaveLength(2);
      const [started, completed] = info.replies;
      expect(started?.text).toMatch(/^Started fake run fake-/);
      expect(started?.labels[RUN_LABEL]).toBe(runIdOf(started?.text ?? ""));
      expect(completed?.text).toBe(`Completed: fake result for task ${id}`);
      expect(w.fake.starts).toEqual([id]);
      expect(await w.store.list()).toEqual([]);
    },
  );

  it("fails a task with the backend's reason and says so", { timeout: 20_000 }, async () => {
    const board = await rig.board();
    const counter = new SettleCounter();
    const w = await rig.launch(board, { counter });
    const id = await createTask(board, CHANNEL, "break it", { fake: "fail" });
    const info = await rig.untilReply(board, id, "Failed:");
    expect(info.state).toBe("failed");
    expect(info.reason).toBe(`fake failure for task ${id}`);
    expect(info.replies.at(-1)?.text).toBe(`Failed: fake failure for task ${id}`);
    expect(w.logs.events("task.failed")).toHaveLength(1);
    expect(counter.count(id)).toBe(1);
  });

  it("relays progress updates before completing", { timeout: 20_000 }, async () => {
    const board = await rig.board();
    await rig.launch(board, { fake: { slowMs: 1200 } });
    const id = await createTask(board, CHANNEL, "take your time", { fake: "slow" });
    const info = await rig.untilReply(board, id, "Completed:");
    const texts = info.replies.map((r) => r.text);
    expect(texts.filter((t) => t.startsWith("fake progress"))).toEqual([
      "fake progress 1 of 3",
      "fake progress 2 of 3",
      "fake progress 3 of 3",
    ]);
    expect(texts[0]).toMatch(/^Started /);
    expect(texts.at(-1)).toMatch(/^Completed:/);
    expect(info.state).toBe("completed");
  });

  it("cancels the run when the claim is lost, and settles nothing", { timeout: 30_000 }, async () => {
    const board = await rig.board();
    const counter = new SettleCounter();
    const dir = await rig.tmp();
    const stateDir = await rig.tmp();
    const w = await rig.launch(board, { counter, stateDir, fake: { dir } });
    const id = await createTask(board, CHANNEL, "never ends", { fake: "hang" });
    const started = await rig.untilReply(board, id, "Started");
    const runId = runIdOf(started.replies[0]?.text ?? "");
    const owner = await rig.owner(board);
    await owner.tasks.cancel(id, "owner changed their mind");
    // The renew timer fires every third of the 30 s lease; the board then answers claim_lost.
    await waitFor(() => w.fake.cancels.includes(runId), 15_000, "the run to be canceled");
    const info = await rig.task(board, id);
    expect(info.state).toBe("canceled");
    expect(info.replies.map((r) => r.text).filter((t) => /^(Completed|Failed)/.test(t))).toEqual([]);
    expect(counter.count(id)).toBe(0);
    expect(w.logs.events("claim.lost")).toHaveLength(1);
    await waitFor(async () => (await w.store.list()).length === 0, 5000, "the stored claim to be dropped");
    await waitFor(() => w.worker.activeTaskIds.length === 0, 5000, "the worker to let go of the task");
  });

  it("lets exactly one of two racing workers start a task, and completes it once", { timeout: 20_000 }, async () => {
    const board = await rig.board();
    const dir = await rig.tmp();
    const counter = new SettleCounter();
    const a = await rig.launch(board, { counter, fake: { dir } });
    const b = await rig.launch(board, { counter, fake: { dir } });
    const id = await createTask(board, CHANNEL, "contested");
    const info = await rig.untilReply(board, id, "Completed:");
    expect(info.state).toBe("completed");
    expect(a.fake.starts.length + b.fake.starts.length).toBe(1);
    expect(await FakeBackend.readRuns(dir)).toHaveLength(1);
    expect(counter.count(id)).toBe(1);
    expect(info.replies.filter((r) => r.text.startsWith("Started"))).toHaveLength(1);
  });

  it("runs as many tasks at once as the route's concurrency", { timeout: 20_000 }, async () => {
    const board = await rig.board();
    const w = await rig.launch(board, { route: { concurrency: 3 } });
    const ids = await Promise.all(
      [1, 2, 3, 4].map((n) => createTask(board, CHANNEL, `job ${String(n)}`, { fake: "hang" })),
    );
    await waitFor(() => w.fake.starts.length === 3, 10_000, "three runs to start");
    await waitFor(() => w.worker.activeTaskIds.length === 3, 5000, "three held tasks");
    // The fourth waits for a free slot.
    await new Promise((resolve) => setTimeout(resolve, 1500));
    expect(w.fake.starts).toHaveLength(3);
    const states = await Promise.all(ids.map(async (id) => (await rig.task(board, id)).state));
    expect(states.filter((s) => s === "ready")).toHaveLength(1);
  });

  it("resumes after a crash through the claim store, without waiting for the lease", { timeout: 40_000 }, async () => {
    const board = await rig.board();
    const dir = await rig.tmp();
    const stateDir = await rig.tmp();
    const counter = new SettleCounter();
    const fake = { dir, stepMs: 3000 };
    const a = await rig.launch(board, { counter, stateDir, fake });
    const id = await createTask(board, CHANNEL, "survive me");
    const started = await rig.untilReply(board, id, "Started");
    const runId = runIdOf(started.replies[0]?.text ?? "");
    a.worker.kill();
    await a.worker.finished;
    expect(await a.store.list()).toMatchObject([{ taskId: id, runId }]);

    const killedAt = Date.now();
    const b = await rig.launch(board, { counter, stateDir, fake });
    const info = await rig.untilReply(board, id, "Completed:", 15_000);
    expect(Date.now() - killedAt).toBeLessThan(15_000); // the lease is 30 s: this was not a lease wait
    expect(b.logs.events("claim.resumed")).toHaveLength(1);
    expect(b.logs.events("run.reattached")).toMatchObject([{ runId }]);
    expect(info.replies.map((r) => r.text)).toContain(`Re-attached to fake run ${runId}`);
    expect(info.state).toBe("completed");
    expect(a.fake.starts.length + b.fake.starts.length).toBe(1);
    expect(await FakeBackend.readRuns(dir)).toHaveLength(1);
    expect(counter.count(id)).toBe(1);
    expect(await b.store.list()).toEqual([]);
  });

  it(
    "re-attaches through the thread label after a crash with no store, once the lease runs out",
    {
      timeout: 75_000,
    },
    async () => {
      const board = await rig.board();
      const dir = await rig.tmp();
      const counter = new SettleCounter();
      const fake = { dir, stepMs: 2000 };
      const a = await rig.launch(board, { counter, fake });
      const id = await createTask(board, CHANNEL, "survive me too");
      const started = await rig.untilReply(board, id, "Started");
      const runId = runIdOf(started.replies[0]?.text ?? "");
      a.worker.kill();
      await a.worker.finished;

      const b = await rig.launch(board, { counter, fake });
      // The lease (30 s) has to end before the board lets anyone claim the task again.
      const info = await rig.untilReply(board, id, "Completed:", 55_000);
      expect(b.logs.events("claim.resumed")).toHaveLength(0);
      expect(b.logs.events("run.reattached")).toMatchObject([{ runId }]);
      expect(info.replies.map((r) => r.text)).toContain(`Re-attached to fake run ${runId}`);
      expect(a.fake.starts.length + b.fake.starts.length).toBe(1);
      expect(await FakeBackend.readRuns(dir)).toHaveLength(1);
      expect(counter.count(id)).toBe(1);
    },
  );

  describe("stop (SIGTERM)", () => {
    it("releases a task whose run has not started", { timeout: 20_000 }, async () => {
      const board = await rig.board();
      const stateDir = await rig.tmp();
      const backend = new GatedBackend(new FakeBackend(), false);
      const w = await rig.launch(board, { backend, stateDir });
      const id = await createTask(board, CHANNEL, "slow to start");
      await backend.entered;
      await w.worker.stop();
      const info = await rig.task(board, id);
      expect(info.state).toBe("ready");
      expect(backend.starts).toEqual([]);
      expect(w.logs.events("task.released")).toHaveLength(1);
      expect(await w.store.list()).toEqual([]);
    });

    it(
      "cancels a run that finished starting after the stop began, then releases the task",
      {
        timeout: 20_000,
      },
      async () => {
        const board = await rig.board();
        const backend = new GatedBackend(new FakeBackend(), true);
        const w = await rig.launch(board, { backend });
        const id = await createTask(board, CHANNEL, "starts too late");
        await backend.entered;
        const stopping = w.worker.stop();
        backend.open();
        await stopping;
        expect(backend.starts).toEqual([id]);
        expect(backend.cancels).toHaveLength(1);
        expect((await rig.task(board, id)).state).toBe("ready");
      },
    );

    it("neither cancels nor releases a started run, and keeps its stored claim", { timeout: 20_000 }, async () => {
      const board = await rig.board();
      const stateDir = await rig.tmp();
      const w = await rig.launch(board, { stateDir });
      const id = await createTask(board, CHANNEL, "keeps running", { fake: "hang" });
      const started = await rig.untilReply(board, id, "Started");
      const runId = runIdOf(started.replies[0]?.text ?? "");
      await w.worker.stop();
      expect(w.fake.cancels).toEqual([]);
      const info = await rig.task(board, id);
      expect(info.state).not.toBe("ready");
      expect(["completed", "failed", "canceled"]).not.toContain(info.state);
      expect(info.replies.map((r) => r.text).filter((t) => /^(Completed|Failed)/.test(t))).toEqual([]);
      expect(await w.store.list()).toMatchObject([{ taskId: id, runId }]);
      expect(w.logs.events("task.released")).toEqual([]);
    });
  });

  it("backs off while the board is down, then claims and completes a task", { timeout: 30_000 }, async () => {
    const board = await rig.board();
    const proxy = await startFlakyProxy(board.url);
    rig.onDispose(() => proxy.close());
    const w = await rig.launch(board, {
      route: { boardUrl: proxy.url },
      backoff: { baseMs: 50, maxMs: 300 },
      random: () => 0.5,
    });
    proxy.down = true;
    await waitFor(() => w.logs.events("claim.error").length >= 4, 15_000, "four claim errors");
    const delays = w.logs.events("claim.error").map((e) => e["retryInMs"] as number);
    // Base 50 ms doubling, jitter fixed at the middle: 38, 75, 150, then 225 (three quarters of the 300 ms cap).
    expect(delays.slice(0, 4)).toEqual([38, 75, 150, 225]);
    expect(proxy.refused).toBeGreaterThanOrEqual(4);

    const id = await createTask(board, CHANNEL, "after the outage");
    proxy.down = false;
    const info = await rig.untilReply(board, id, "Completed:", 15_000);
    expect(info.state).toBe("completed");
    expect(w.fake.starts).toEqual([id]);
  });

  it("settles every task exactly once with two workers over many tasks", { timeout: 30_000 }, async () => {
    const board = await rig.board();
    const dir = await rig.tmp();
    const counter = new SettleCounter();
    const route = { concurrency: 2 };
    const a = await rig.launch(board, { counter, route, fake: { dir, stepMs: 30 } });
    const b = await rig.launch(board, { counter, route, fake: { dir, stepMs: 30 } });
    const ids = await Promise.all(
      Array.from({ length: 8 }, (_, n) =>
        createTask(board, CHANNEL, `task ${String(n)}`, n % 4 === 3 ? { fake: "fail" } : {}),
      ),
    );
    for (const id of ids) {
      await waitFor(
        async () => ["completed", "failed"].includes((await rig.task(board, id)).state),
        15_000,
        `${id} to settle`,
      );
    }
    expect(a.fake.starts.length + b.fake.starts.length).toBe(ids.length);
    expect(await FakeBackend.readRuns(dir)).toHaveLength(ids.length);
    for (const id of ids) expect(counter.count(id)).toBe(1);
    expect(counter.max).toBe(1);
  });

  describe("an unavailable backend", () => {
    it(
      "releases the task, backs off, and completes it once the backend recovers, with one run and no Failed reply",
      { timeout: 20_000 },
      async () => {
        const board = await rig.board();
        const counter = new SettleCounter();
        const stateDir = await rig.tmp();
        const w = await rig.launch(board, {
          counter,
          stateDir,
          fake: { unavailableStarts: 3 },
          backoff: { baseMs: 50, maxMs: 400 },
          random: () => 0.5,
        });
        const id = await createTask(board, CHANNEL, "while the platform is down");
        const info = await rig.untilReply(board, id, "Completed:");
        expect(info.state).toBe("completed");
        expect(w.fake.starts).toEqual([id]);
        expect(info.replies.map((r) => r.text)).toEqual([
          expect.stringMatching(/^Started fake run /),
          `Completed: fake result for task ${id}`,
        ]);
        // Base 50 ms doubling, jitter in the middle: 38, 75, 150.
        expect(w.logs.events("run.start_unavailable").map((e) => e["retryInMs"])).toEqual([38, 75, 150]);
        expect(w.logs.events("run.start_unavailable").every((e) => e.level === "warn")).toBe(true);
        expect(w.logs.events("task.error")).toEqual([]);
        expect(counter.count(id)).toBe(1);
        expect(await w.store.list()).toEqual([]);
      },
    );

    it("resets the back-off after a successful start", { timeout: 20_000 }, async () => {
      const board = await rig.board();
      const w = await rig.launch(board, {
        fake: { unavailableStarts: 1 },
        backoff: { baseMs: 50, maxMs: 400 },
        random: () => 0.5,
      });
      const first = await createTask(board, CHANNEL, "first");
      await rig.untilReply(board, first, "Completed:");
      w.fake.unavailableStarts = 1;
      const second = await createTask(board, CHANNEL, "second");
      await rig.untilReply(board, second, "Completed:");
      expect(w.logs.events("run.start_unavailable").map((e) => e["retryInMs"])).toEqual([38, 38]);
    });

    it("treats an unavailable find the same way, without starting a run", { timeout: 20_000 }, async () => {
      const board = await rig.board();
      const w = await rig.launch(board, { fake: { unavailableFinds: 1 }, backoff: { baseMs: 50, maxMs: 400 } });
      const id = await createTask(board, CHANNEL, "find is down");
      const info = await rig.untilReply(board, id, "Completed:");
      expect(info.state).toBe("completed");
      expect(w.logs.events("run.start_unavailable")).toHaveLength(1);
      expect(w.fake.starts).toEqual([id]);
      expect(info.replies.some((r) => r.text.startsWith("Failed"))).toBe(false);
    });

    it("still fails the task on any other start error", { timeout: 20_000 }, async () => {
      const board = await rig.board();
      const fake = new FakeBackend();
      const backend: Backend = {
        name: "fake",
        start: () => Promise.reject(new Error("quota exceeded")),
        find: (task, hint) => fake.find(task, hint),
        wait: (runId, signal) => fake.wait(runId, signal),
        cancel: (runId) => fake.cancel(runId),
      };
      const w = await rig.launch(board, { backend });
      const id = await createTask(board, CHANNEL, "cannot start");
      const info = await rig.untilReply(board, id, "Failed:");
      expect(info.state).toBe("failed");
      expect(info.reason).toBe("worker error: quota exceeded");
      expect(w.logs.events("run.start_unavailable")).toEqual([]);
    });
  });
});
