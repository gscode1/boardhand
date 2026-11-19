// End to end: the real entrypoint as a child process against a throwaway board and the fake backend.
import { createServer } from "node:net";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FakeBackend } from "../src/backends/fake.js";
import { ClaimStore } from "../src/claims.js";
import { RUN_LABEL } from "../src/worker.js";
import { build, spawnMain, type Child } from "./helpers/child.js";
import { createTask, waitFor, type TestBoard } from "./helpers/board-server.js";
import { startFlakyProxy } from "./helpers/flaky-proxy.js";
import { CHANNEL, Rig } from "./helpers/scenario.js";

const rig = new Rig();
const children: Child[] = [];

beforeAll(async () => {
  await build();
}, 150_000);

afterEach(async () => {
  for (const child of children.splice(0)) child.dispose();
  await rig.dispose();
});
afterAll(() => {
  for (const child of children.splice(0)) child.dispose();
});

type Dirs = { dir: string; stateDir: string };

function env(board: TestBoard, dirs: Dirs, extra: Record<string, string> = {}): Record<string, string> {
  return {
    BOARD_URL: board.url,
    BOARD_TOKEN: board.tokens.worker,
    BOARDHAND_CHANNEL: CHANNEL,
    BOARDHAND_FROM: board.ownerId,
    BOARDHAND_BACKEND: "fake",
    BOARDHAND_BACKEND_OPTIONS: JSON.stringify({ dir: dirs.dir, stepMs: 3000 }),
    BOARDHAND_LEASE: "30",
    BOARDHAND_WAIT: "1",
    BOARDHAND_STATE_DIR: dirs.stateDir,
    ...extra,
  };
}

function start(board: TestBoard, dirs: Dirs, extra: Record<string, string> = {}): Child {
  const child = spawnMain(env(board, dirs, extra));
  children.push(child);
  return child;
}

async function setup(): Promise<{ board: TestBoard; dirs: Dirs }> {
  const board = await rig.board();
  return { board, dirs: { dir: await rig.tmp(), stateDir: await rig.tmp() } };
}

/** A URL nothing listens on: an OS-assigned port that was free a moment ago. */
async function closedUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) =>
    server.close(() => {
      resolve();
    }),
  );
  return `http://127.0.0.1:${String(port)}`;
}

describe("boardhand entrypoint", () => {
  it("completes a task, logs JSON lines, and never prints a token", { timeout: 40_000 }, async () => {
    const { board, dirs } = await setup();
    const child = start(board, dirs);
    await child.untilEvent("worker.start");
    const id = await createTask(board, CHANNEL, "end to end");
    // While the run takes its time, its claim token sits in the state dir: that is the secret to look for.
    const store = new ClaimStore(dirs.stateDir);
    await waitFor(async () => (await store.list()).length === 1, 15_000, "a stored claim");
    const claimToken = (await store.list())[0]?.token ?? "";
    expect(claimToken).not.toBe("");

    const info = await rig.untilReply(board, id, "Completed:", 20_000);
    expect(info.state).toBe("completed");
    await child.untilEvent("task.completed");

    const output = child.output();
    expect(output).not.toContain(board.tokens.worker);
    expect(output).not.toContain(claimToken);
    for (const line of output.split("\n").filter((l) => l !== "")) {
      expect(() => JSON.parse(line) as unknown, `not JSON: ${line}`).not.toThrow();
    }
    const route = (child.lines().find((l) => l["event"] === "route")?.["route"] ?? {}) as Record<string, unknown>;
    expect(route["boardToken"]).toBe("[redacted]");
    expect((await FakeBackend.readRuns(dirs.dir)).map((r) => r.taskId)).toEqual([id]);
  });

  describe("SIGTERM", () => {
    it("exits 0 promptly when idle and leaves later tasks untouched", { timeout: 30_000 }, async () => {
      const { board, dirs } = await setup();
      const child = start(board, dirs);
      await child.untilEvent("worker.start");
      const stopped = Date.now();
      child.signal("SIGTERM");
      expect(await child.exited).toEqual({ code: 0, signal: null });
      expect(Date.now() - stopped).toBeLessThan(5000);
      expect(child.lines().some((l) => l["event"] === "worker.stopping")).toBe(true);
      const id = await createTask(board, CHANNEL, "nobody is home");
      expect((await rig.task(board, id)).state).toBe("ready");
    });

    it("exits 0 and leaves a started run running, claim kept", { timeout: 30_000 }, async () => {
      const { board, dirs } = await setup();
      const child = start(board, dirs, { BOARDHAND_BACKEND_OPTIONS: JSON.stringify({ dir: dirs.dir }) });
      const id = await createTask(board, CHANNEL, "keeps running", { fake: "hang" });
      await rig.untilReply(board, id, "Started");
      child.signal("SIGTERM");
      expect(await child.exited).toEqual({ code: 0, signal: null });
      const info = await rig.task(board, id);
      expect(info.state).not.toBe("ready");
      expect(info.replies.some((r) => /^(Completed|Failed)/.test(r.text))).toBe(false);
      const runs = await FakeBackend.readRuns(dirs.dir);
      expect(runs).toHaveLength(1);
      expect(runs[0]?.canceledAt).toBeUndefined();
      expect(await new ClaimStore(dirs.stateDir).list()).toMatchObject([{ taskId: id }]);
    });
  });

  it("re-attaches after SIGKILL through the stored claim and starts the run once", { timeout: 60_000 }, async () => {
    const { board, dirs } = await setup();
    const first = start(board, dirs);
    const id = await createTask(board, CHANNEL, "survive a kill");
    const started = await rig.untilReply(board, id, "Started");
    const runId = started.replies[0]?.labels[RUN_LABEL] ?? "";
    expect(runId).toMatch(/^fake-/);
    first.signal("SIGKILL");
    expect((await first.exited).signal).toBe("SIGKILL");
    const stored = await new ClaimStore(dirs.stateDir).list();
    expect(stored).toMatchObject([{ taskId: id, runId }]);

    const second = start(board, dirs);
    const info = await rig.untilReply(board, id, "Completed:", 25_000);
    expect(info.state).toBe("completed");
    expect(info.replies.map((r) => r.text)).toContain(`Re-attached to fake run ${runId}`);
    await second.untilEvent("claim.resumed");
    expect(await FakeBackend.readRuns(dirs.dir)).toHaveLength(1);
    const token = stored[0]?.token ?? "";
    for (const child of [first, second]) {
      expect(child.output()).not.toContain(token);
      expect(child.output()).not.toContain(board.tokens.worker);
    }
  });

  it("exits 2 at once on a bad configuration, naming the problem and no secret", { timeout: 20_000 }, async () => {
    const { board, dirs } = await setup();
    const rest = env(board, dirs);
    Reflect.deleteProperty(rest, "BOARDHAND_FROM");
    const child = spawnMain(rest);
    children.push(child);
    const started = Date.now();
    expect(await child.exited).toEqual({ code: 2, signal: null });
    expect(Date.now() - started).toBeLessThan(5000);
    const line = child.lines().find((l) => l["event"] === "config.invalid");
    expect(JSON.stringify(line?.["problems"])).toContain("BOARDHAND_FROM");
    expect(child.output()).not.toContain(board.tokens.worker);
  });

  describe("board not up yet", () => {
    it(
      "retries the first request until the board answers, then claims and completes",
      { timeout: 40_000 },
      async () => {
        const { board, dirs } = await setup();
        const proxy = await startFlakyProxy(board.url);
        rig.onDispose(() => proxy.close());
        proxy.down = true;
        const child = start(board, dirs, {
          BOARD_URL: proxy.url,
          BOARDHAND_BACKEND_OPTIONS: JSON.stringify({ dir: dirs.dir }),
        });
        await waitFor(
          () => child.lines().filter((l) => l["event"] === "board.unreachable").length >= 2,
          15_000,
          "two unreachable retries",
        );
        for (const line of child.lines().filter((l) => l["event"] === "board.unreachable")) {
          expect(line["retryInMs"]).toEqual(expect.any(Number));
          expect(line["retryInMs"]).toBeLessThanOrEqual(30_000);
        }
        expect(child.lines().some((l) => l["event"] === "fatal")).toBe(false);

        proxy.down = false;
        const id = await createTask(board, CHANNEL, "after the board came up");
        const info = await rig.untilReply(board, id, "Completed:", 25_000);
        expect(info.state).toBe("completed");
        expect(child.lines().some((l) => l["event"] === "fatal")).toBe(false);
      },
    );

    it("exits 0 promptly on SIGTERM while waiting", { timeout: 30_000 }, async () => {
      const { board, dirs } = await setup();
      const child = start(board, dirs, { BOARD_URL: await closedUrl() });
      await child.untilEvent("board.unreachable", 15_000);
      const stopped = Date.now();
      child.signal("SIGTERM");
      expect(await child.exited).toEqual({ code: 0, signal: null });
      expect(Date.now() - stopped).toBeLessThan(5000);
      expect(child.lines().some((l) => l["event"] === "worker.stopping")).toBe(true);
    });

    it("exits 1 at once on a token the board refuses", { timeout: 30_000 }, async () => {
      const { board, dirs } = await setup();
      const child = start(board, dirs, { BOARD_TOKEN: "tok-not-a-real-token" });
      const started = Date.now();
      expect(await child.exited).toEqual({ code: 1, signal: null });
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(child.lines().some((l) => l["event"] === "fatal")).toBe(true);
      expect(child.lines().some((l) => l["event"] === "board.unreachable")).toBe(false);
    });
  });
});
