// Building blocks for the worker scenarios: a rig that owns everything a test opens (boards, workers, temp dirs) and
// tears it down, a captured logger, a counter of settle calls, and views of a task as the board shows it.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board as SdkBoard } from "@vercel/board";
import { connectBoard } from "../../src/board.js";
import type { Board, Claim } from "../../src/board.js";
import { FakeBackend } from "../../src/backends/fake.js";
import type { FakeOptions } from "../../src/backends/fake.js";
import type { Backend } from "../../src/backends/backend.js";
import { ClaimStore } from "../../src/claims.js";
import type { Route } from "../../src/route.js";
import { Worker } from "../../src/worker.js";
import type { BackoffOptions, LogEntry } from "../../src/worker.js";
import { startTestBoard, waitFor, type TestBoard } from "./board-server.js";

export const CHANNEL = "dev";

export type Captured = {
  entries: LogEntry[];
  log: (entry: LogEntry) => void;
  /** Entries with this event name, oldest first. */
  events(event: string): LogEntry[];
};

export function captureLog(): Captured {
  const entries: LogEntry[] = [];
  return {
    entries,
    log: (entry) => {
      entries.push(entry);
    },
    events: (event) => entries.filter((e) => e.event === event),
  };
}

/** Counts complete and fail calls per task across every worker that shares it (invariant: a task settles once). */
export class SettleCounter {
  readonly calls = new Map<string, number>();

  count(taskId: string): number {
    return this.calls.get(taskId) ?? 0;
  }

  get max(): number {
    return Math.max(0, ...this.calls.values());
  }

  /** Wraps a board so that every claim it hands out reports its settle attempts here. */
  wrap(board: Board): Board {
    const instrument = (claim: Claim): Claim => {
      for (const how of ["complete", "fail"] as const) {
        const original = claim[how].bind(claim);
        claim[how] = async (text: string): Promise<void> => {
          this.calls.set(claim.taskId, this.count(claim.taskId) + 1);
          await original(text);
        };
      }
      return claim;
    };
    return {
      claim: async (request, signal) => {
        const claim = await board.claim(request, signal);
        return claim === null ? null : instrument(claim);
      },
      held: async (taskId, proof) => instrument(await board.held(taskId, proof)),
      reply: (taskId, text, labels) => board.reply(taskId, text, labels),
      label: (messageId, labels) => board.label(messageId, labels),
      threadLabels: (taskId) => board.threadLabels(taskId),
      findLabel: (taskId, key) => board.findLabel(taskId, key),
    };
  }
}

export type TaskInfo = {
  state: string;
  result: string | null;
  reason: string | null;
  /** Replies, oldest first. */
  replies: { text: string; labels: Record<string, string> }[];
};

export type LaunchOptions = {
  route?: Partial<Route>;
  /** Use this backend instead of a FakeBackend. */
  backend?: Backend;
  fake?: FakeOptions;
  /** A directory for the claim store; null (the default) means no store. */
  stateDir?: string | null;
  counter?: SettleCounter;
  backoff?: BackoffOptions;
  /** Jitter source for backoff, to make delays deterministic. */
  random?: () => number;
};

export type Launched = {
  worker: Worker;
  backend: Backend;
  /** The FakeBackend, when `backend` was not given. */
  fake: FakeBackend;
  logs: Captured;
  store: ClaimStore;
  route: Route;
};

const FAST_BACKOFF: BackoffOptions = { baseMs: 50, maxMs: 400 };

/** Owns what a test opens. Call `dispose()` in afterEach. */
export class Rig {
  readonly #boards: TestBoard[] = [];
  readonly #workers: Worker[] = [];
  readonly #dirs: string[] = [];
  readonly #owners = new Map<TestBoard, Promise<SdkBoard>>();
  readonly #cleanups: (() => Promise<void>)[] = [];

  async board(): Promise<TestBoard> {
    const board = await startTestBoard();
    this.#boards.push(board);
    return board;
  }

  async tmp(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "boardhand-test-"));
    this.#dirs.push(dir);
    return dir;
  }

  onDispose(fn: () => Promise<void>): void {
    this.#cleanups.push(fn);
  }

  route(testBoard: TestBoard, overrides: Partial<Route> = {}): Route {
    return {
      boardUrl: testBoard.url,
      boardToken: testBoard.tokens.worker,
      profile: "boardhand",
      channel: CHANNEL,
      labels: {},
      from: [testBoard.ownerId],
      backend: "fake",
      backendOptions: {},
      concurrency: 1,
      leaseSeconds: 30,
      waitSeconds: 1,
      stateDir: null,
      ...overrides,
    };
  }

  /** Builds and starts a worker for `testBoard`. */
  async launch(testBoard: TestBoard, options: LaunchOptions = {}): Promise<Launched> {
    const route = this.route(testBoard, options.route);
    const fake = new FakeBackend(options.fake);
    const backend = options.backend ?? fake;
    const logs = captureLog();
    let board = await connectBoard({ url: route.boardUrl, token: route.boardToken, profile: route.profile });
    if (options.counter !== undefined) board = options.counter.wrap(board);
    const store = new ClaimStore(options.stateDir ?? null);
    const worker = new Worker({
      route,
      board,
      backend,
      store,
      log: logs.log,
      backoff: options.backoff ?? FAST_BACKOFF,
      ...(options.random === undefined ? {} : { random: options.random }),
    });
    this.#workers.push(worker);
    await worker.start();
    return { worker, backend, fake, logs, store, route };
  }

  owner(testBoard: TestBoard): Promise<SdkBoard> {
    let owner = this.#owners.get(testBoard);
    if (owner === undefined) {
      owner = testBoard.client(testBoard.tokens.owner);
      this.#owners.set(testBoard, owner);
    }
    return owner;
  }

  async task(testBoard: TestBoard, id: string): Promise<TaskInfo> {
    const owner = await this.owner(testBoard);
    const thread = await owner.thread(id, { limit: 500 });
    // `after` pages forward in order; without it the board answers the newest replies, which for a short thread is all.
    const task = thread.message.task;
    return {
      state: task?.state ?? "none",
      result: task?.result ?? null,
      reason: task?.reason ?? null,
      replies: thread.replies.map((r) => ({ text: r.text, labels: { ...r.labels } })),
    };
  }

  /** Waits until the task is in `state`, then returns it. */
  async untilState(testBoard: TestBoard, id: string, state: string, timeoutMs = 10_000): Promise<TaskInfo> {
    let last = "";
    await waitFor(
      async () => {
        last = (await this.task(testBoard, id)).state;
        return last === state;
      },
      timeoutMs,
      `task ${id} to be ${state} (last seen ${last})`,
    );
    return this.task(testBoard, id);
  }

  /** Waits for a reply whose text starts with `prefix`. */
  async untilReply(testBoard: TestBoard, id: string, prefix: string, timeoutMs = 10_000): Promise<TaskInfo> {
    await waitFor(
      async () => (await this.task(testBoard, id)).replies.some((r) => r.text.startsWith(prefix)),
      timeoutMs,
      `a reply starting with "${prefix}" on task ${id}`,
    );
    return this.task(testBoard, id);
  }

  async dispose(): Promise<void> {
    for (const worker of this.#workers.splice(0)) {
      worker.kill();
      await worker.finished.catch(() => undefined);
    }
    for (const cleanup of this.#cleanups.splice(0)) await cleanup().catch(() => undefined);
    await Promise.all(this.#boards.splice(0).map((b) => b.close()));
    await Promise.all(this.#dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
    this.#owners.clear();
  }
}
