// The real Worker and the real (throwaway) board with PiBackend against a fake session API.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { PiBackend, parsePiOptions } from "../src/backends/pi.js";
import { connectBoard } from "../src/board.js";
import { ClaimStore } from "../src/claims.js";
import type { Route } from "../src/route.js";
import { startWorker, type LogEntry, type Worker } from "../src/worker.js";
import { startTestBoard, waitFor, createTask, type TestBoard } from "./helpers/board-server.js";
import { FakePi, type PiScript } from "./helpers/fake-pi.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

type Rig = { board: TestBoard; pi: FakePi; stateDir: string; logs: LogEntry[] };

async function rig(script: PiScript): Promise<Rig> {
  const board = await startTestBoard();
  cleanups.push(() => board.close());
  const pi = await FakePi.start();
  pi.script = script;
  cleanups.push(() => pi.close());
  const stateDir = await mkdtemp(join(tmpdir(), "boardhand-pi-state-"));
  cleanups.push(() => rm(stateDir, { recursive: true, force: true }));
  return { board, pi, stateDir, logs: [] };
}

async function runWorker(r: Rig, backendOptions: Record<string, unknown> = {}): Promise<Worker> {
  const route: Route = {
    boardUrl: r.board.url,
    boardToken: "not-used",
    profile: "boardhand",
    channel: "dev",
    labels: {},
    from: [r.board.ownerId],
    backend: "pi",
    backendOptions,
    concurrency: 1,
    leaseSeconds: 30,
    waitSeconds: 1,
    stateDir: r.stateDir,
  };
  const board = await connectBoard({ url: r.board.url, token: r.board.tokens.worker, profile: "boardhand" });
  const backend = new PiBackend(parsePiOptions({ url: r.pi.url, ...backendOptions }), r.pi.token);
  const worker = await startWorker({
    route,
    board,
    backend,
    store: new ClaimStore(r.stateDir),
    log: (entry) => r.logs.push(entry),
    backoff: { baseMs: 20, maxMs: 200 },
  });
  cleanups.push(async () => {
    worker.kill();
    await worker.finished;
  });
  return worker;
}

async function threadTexts(r: Rig, taskId: string): Promise<string[]> {
  const owner = await r.board.client(r.board.tokens.owner);
  return (await owner.thread(taskId)).replies.map((m) => m.text);
}

async function taskState(r: Rig, state: "completed" | "failed" | "canceled", taskId: string): Promise<boolean> {
  const owner = await r.board.client(r.board.tokens.owner);
  return (await owner.tasks.list({ state })).tasks.some((t) => t.message.id === taskId);
}

describe("worker with the pi backend", () => {
  test("a task completes with the agent's text", { timeout: 30_000 }, async () => {
    const r = await rig({ replyText: "I fixed it", replyAfterMs: 200 });
    const id = await createTask(r.board, "dev", "please fix the bug", { repo: "acme/app" });
    await runWorker(r);
    await waitFor(() => taskState(r, "completed", id), 20_000, "task completed");
    const texts = await threadTexts(r, id);
    expect(texts[0]).toMatch(/^Started pi run [0-9a-f-]{36}$/);
    expect(texts.at(-1)).toBe("Completed: I fixed it");
    const [session] = [...r.pi.sessions.values()];
    expect(session?.created).toEqual({ repo: "acme/app" });
    expect(r.pi.count("POST", /^\/sessions$/)).toBe(1);
    // The task text reached the agent as the message, and nowhere in the session's creation.
    expect(session?.entries[0]?.messages[0]?.text).toBe("please fix the bug");
  });

  test("a failing run fails the task", { timeout: 30_000 }, async () => {
    const r = await rig({ runFailure: "model overloaded", replyAfterMs: 100 });
    const id = await createTask(r.board, "dev", "t");
    await runWorker(r);
    await waitFor(() => taskState(r, "failed", id), 20_000, "task failed");
  });

  test("a killed worker's replacement re-attaches to the same session", { timeout: 40_000 }, async () => {
    const r = await rig({ replyText: "survived", replyAfterMs: 2500 });
    const id = await createTask(r.board, "dev", "long job");
    const first = await runWorker(r);
    await waitFor(() => r.logs.some((l) => l.event === "run.started"), 10_000, "run started");
    await waitFor(async () => (await threadTexts(r, id)).length > 0, 10_000, "run label on the thread");
    first.kill();
    await first.finished;

    await runWorker(r);
    await waitFor(() => taskState(r, "completed", id), 30_000, "task completed after restart");
    expect(r.pi.count("POST", /^\/sessions$/)).toBe(1);
    expect(r.logs.some((l) => l.event === "run.reattached")).toBe(true);
    expect((await threadTexts(r, id)).at(-1)).toBe("Completed: survived");
  });

  test("a lost claim cancels the session: cancel event, then delete", { timeout: 40_000 }, async () => {
    const r = await rig({ hang: true, interim: [{ afterMs: 100, text: "working on it" }] });
    const id = await createTask(r.board, "dev", "to be canceled");
    await runWorker(r, { progressSeconds: 1 });
    await waitFor(() => r.logs.some((l) => l.event === "run.started"), 10_000, "run started");
    const owner = await r.board.client(r.board.tokens.owner);
    await owner.tasks.cancel(id, "no longer needed");

    await waitFor(() => r.logs.some((l) => l.event === "claim.lost"), 30_000, "claim lost");
    const [session] = [...r.pi.sessions.values()];
    await waitFor(() => session?.gone === true, 10_000, "session deleted");
    expect(session?.canceled).toBe(true);
    const sequence = r.pi.requests
      .filter((q) => q.method === "DELETE" || (q.method === "POST" && JSON.stringify(q.body) === '{"kind":"cancel"}'))
      .map((q) => q.method);
    expect(sequence).toEqual(["POST", "DELETE"]);
    expect(await taskState(r, "completed", id)).toBe(false);
  });
});
