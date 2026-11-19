import { BoardError } from "@vercel/board";
import { afterEach, describe, expect, it } from "vitest";
import { createTask, startTestBoard, waitFor, type TestBoard } from "./board-server.js";

const open: TestBoard[] = [];
async function board(): Promise<TestBoard> {
  const b = await startTestBoard();
  open.push(b);
  return b;
}
afterEach(async () => {
  await Promise.all(open.splice(0).map((b) => b.close()));
});

async function boardError(promise: Promise<unknown>): Promise<BoardError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(BoardError);
    return err as BoardError;
  }
  throw new Error("expected a BoardError, the call succeeded");
}

describe("test board harness", () => {
  it("serves two boards in parallel on different ports with separate data", { timeout: 20_000 }, async () => {
    const [a, b] = await Promise.all([board(), board()]);
    expect(a.url).not.toBe(b.url);
    expect(new URL(a.url).port).not.toBe(new URL(b.url).port);
    await createTask(a, "work", "only on a");
    const onB = await b.client(b.tokens.owner);
    expect((await onB.tasks.list({ state: "all" })).tasks).toHaveLength(0);
  });

  it("identifies the three principals and rejects unknown tokens", { timeout: 20_000 }, async () => {
    const b = await board();
    const owner = await b.client(b.tokens.owner);
    expect((await owner.me()).principal).toBe(b.ownerId);
    const worker = await b.client(b.tokens.worker, "boardhand");
    const me = await worker.me();
    expect(me.principal).toBe(b.workerId);
    expect(me.profile).toBe("boardhand");
    const stranger = b.client("not-a-token");
    await expect(stranger).rejects.toBeInstanceOf(BoardError);
  });

  it("runs create, claim with a label filter, renew, reply, thread and complete", { timeout: 20_000 }, async () => {
    const b = await board();
    const id = await createTask(b, "work", "do the thing", { kind: "fix" });
    await createTask(b, "work", "wrong label", { kind: "other" });
    const worker = await b.client(b.tokens.worker, "boardhand");

    const claim = await worker.tasks.claim(
      { channel: "work", label: { kind: "fix" }, from: [b.ownerId], wait: 0, lease: 30 },
      { signal: AbortSignal.timeout(10_000) },
    );
    expect(claim?.task.id).toBe(id);
    expect(claim?.task.labels).toMatchObject({ kind: "fix" });
    const renewed = await claim?.renew(60);
    expect(renewed?.epoch).toBe(claim?.epoch);

    await worker.reply(id, { text: "Started run r1", labels: { "boardhand.run": "r1" } });
    const thread = await worker.thread(id);
    expect(thread.replies.map((m) => m.labels)).toContainEqual({ "boardhand.run": "r1" });

    await claim?.complete("done");
    const owner = await b.client(b.tokens.owner);
    const done = await owner.tasks.list({ state: "completed" });
    expect(done.tasks.map((t) => t.message.id)).toContain(id);
  });

  it("refuses a worker that names no owner it may take from", { timeout: 20_000 }, async () => {
    const b = await board();
    await createTask(b, "work", "t");
    const worker = await b.client(b.tokens.worker);
    const claim = await worker.tasks.claim(
      { channel: "work", from: [b.workerId], wait: 0 },
      { signal: AbortSignal.timeout(10_000) },
    );
    expect(claim).toBeNull();
  });

  it("lets exactly one of two racing claims win", { timeout: 20_000 }, async () => {
    const b = await board();
    await createTask(b, "work", "contested");
    const w1 = await b.client(b.tokens.worker, "one");
    const w2 = await b.client(b.tokens.worker, "two");
    const signal = AbortSignal.timeout(10_000);
    const results = await Promise.all(
      [w1, w2].map((w) => w.tasks.claim({ channel: "work", from: [b.ownerId], wait: 0 }, { signal })),
    );
    expect(results.filter((r) => r !== null)).toHaveLength(1);
  });

  it("makes renew throw after the owner cancels the task", { timeout: 20_000 }, async () => {
    const b = await board();
    const id = await createTask(b, "work", "to cancel");
    const worker = await b.client(b.tokens.worker);
    const claim = await worker.tasks.claim({ channel: "work", from: [b.ownerId], wait: 0 });
    expect(claim).not.toBeNull();
    const owner = await b.client(b.tokens.owner);
    await owner.tasks.cancel(id, "superseded");
    const err = await boardError(claim?.renew() ?? Promise.reject(new Error("no claim")));
    // Recorded from a real run; see the report. Pinned so a change in the SDK shows up here.
    expect(["claim_lost", "task_finished"]).toContain(err.code);
    expect(err.code).toBe("claim_lost");
  });

  it("accepts the minimum lease of 30 seconds and rejects 29", { timeout: 20_000 }, async () => {
    const b = await board();
    await createTask(b, "work", "a");
    await createTask(b, "work", "b");
    const worker = await b.client(b.tokens.worker);
    const ok = await worker.tasks.claim({ channel: "work", from: [b.ownerId], wait: 0, lease: 30 });
    expect(ok).not.toBeNull();
    const until = ok ? new Date(ok.until).getTime() : 0;
    expect(until - Date.now()).toBeLessThanOrEqual(31_000);
    const err = await boardError(worker.tasks.claim({ channel: "work", from: [b.ownerId], wait: 0, lease: 29 }));
    expect(err.status).toBe(400);
  });

  it("wakes a long-poll when a task appears, and aborts it on signal", { timeout: 20_000 }, async () => {
    const b = await board();
    const worker = await b.client(b.tokens.worker);
    const pending = worker.tasks.claim({ channel: "work", from: [b.ownerId], wait: 10 });
    await new Promise((r) => setTimeout(r, 200));
    const id = await createTask(b, "work", "late");
    expect((await pending)?.task.id).toBe(id);

    const abort = new AbortController();
    const idle = worker.tasks.claim({ channel: "work", from: [b.ownerId], wait: 10 }, { signal: abort.signal });
    setTimeout(() => {
      abort.abort();
    }, 200);
    await expect(idle).rejects.toBeDefined();
  });

  it("waitFor polls until the predicate holds and fails after the timeout", { timeout: 10_000 }, async () => {
    let n = 0;
    await waitFor(() => ++n >= 3, 2000);
    await expect(waitFor(() => false, 100, "never")).rejects.toThrow(/never/);
  });
});
