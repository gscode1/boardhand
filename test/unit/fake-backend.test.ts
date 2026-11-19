import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import type { RunTask } from "../../src/backends/backend.js";
import { FakeBackend } from "../../src/backends/fake.js";

const task = (id: string, labels: Record<string, string> = {}): RunTask => ({ id, channel: "dev/", text: "t", labels });
const signal = (): AbortSignal => new AbortController().signal;

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "boardhand-fake-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("FakeBackend", () => {
  test("succeeds by default and counts starts", { timeout: 5000 }, async () => {
    const backend = new FakeBackend({ stepMs: 5 });
    const run = await backend.start(task("1"), signal());
    expect(await backend.wait(run, signal())).toEqual({ kind: "succeeded", result: "fake result for task 1" });
    expect(backend.starts).toEqual(["1"]);
  });

  test("the task label overrides the option", { timeout: 5000 }, async () => {
    const backend = new FakeBackend({ stepMs: 5, behavior: "succeed" });
    const run = await backend.start(task("1", { fake: "fail" }), signal());
    expect((await backend.wait(run, signal())).kind).toBe("failed");
    await expect(backend.start(task("2", { fake: "bogus" }), signal())).rejects.toThrow(/unknown behavior/);
  });

  test("slow reports progress, then succeeds", { timeout: 5000 }, async () => {
    const backend = new FakeBackend({ behavior: "slow", slowMs: 200 });
    const run = await backend.start(task("1"), signal());
    const kinds: string[] = [];
    for (;;) {
      const update = await backend.wait(run, signal());
      kinds.push(update.kind);
      if (update.kind !== "progress") break;
    }
    expect(kinds).toEqual(["progress", "progress", "progress", "succeeded"]);
  });

  test("hang waits until aborted; cancel ends it and is idempotent", { timeout: 5000 }, async () => {
    const backend = new FakeBackend({ behavior: "hang" });
    const run = await backend.start(task("1"), signal());
    const ctl = new AbortController();
    const waiting = backend.wait(run, ctl.signal);
    setTimeout(() => {
      ctl.abort(new Error("stop"));
    }, 30);
    await expect(waiting).rejects.toThrow("stop");
    const again = backend.wait(run, signal());
    await backend.cancel(run);
    await backend.cancel(run);
    expect(await again).toEqual({ kind: "failed", reason: "canceled" });
    expect(backend.cancels).toEqual([run]);
  });

  test("start refuses an aborted signal", { timeout: 5000 }, async () => {
    const ctl = new AbortController();
    ctl.abort();
    await expect(new FakeBackend().start(task("1"), ctl.signal)).rejects.toThrow();
  });

  test("find verifies the hint belongs to the task and skips canceled runs", { timeout: 5000 }, async () => {
    const backend = new FakeBackend({ behavior: "hang" });
    const a = await backend.start(task("A"), signal());
    const b = await backend.start(task("B"), signal());
    expect(await backend.find(task("A"), a)).toBe(a);
    expect(await backend.find(task("A"), b)).toBe(a);
    expect(await backend.find(task("A"), null)).toBe(a);
    expect(await backend.find(task("C"), a)).toBeNull();
    await backend.cancel(a);
    expect(await backend.find(task("A"), a)).toBeNull();
  });

  test("dir mode: another instance finds, follows and cancels a run", { timeout: 5000 }, async () => {
    const first = new FakeBackend({ dir, stepMs: 20 });
    const run = await first.start(task("1"), signal());
    const second = new FakeBackend({ dir, stepMs: 20 });
    expect(await second.find(task("1"), null)).toBe(run);
    expect(await second.wait(run, signal())).toEqual({ kind: "succeeded", result: "fake result for task 1" });
    const runs = await FakeBackend.readRuns(dir);
    expect(runs.map((r) => [r.id, r.taskId])).toEqual([[run, "1"]]);

    const hung = new FakeBackend({ dir, behavior: "hang" });
    const hungRun = await hung.start(task("2"), signal());
    const waiting = first.wait(hungRun, signal());
    await second.cancel(hungRun);
    expect(await waiting).toEqual({ kind: "failed", reason: "canceled" });
    expect((await FakeBackend.readRuns(dir)).find((r) => r.id === hungRun)?.canceledAt).toBeTypeOf("number");
  });
});
