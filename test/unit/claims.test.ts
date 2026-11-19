import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { ClaimStore } from "../../src/claims.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "boardhand-claims-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("stores, lists and removes claims", { timeout: 5000 }, async () => {
  const store = new ClaimStore(join(root, "state"));
  await store.put({ taskId: "1", epoch: 3, token: "t1" });
  await store.put({ taskId: "2", epoch: 1, token: "t2", runId: "run-2" });
  await store.put({ taskId: "1", epoch: 4, token: "t1b", runId: "run-1" });
  const listed = (await store.list()).sort((a, b) => a.taskId.localeCompare(b.taskId));
  expect(listed).toEqual([
    { taskId: "1", epoch: 4, token: "t1b", runId: "run-1" },
    { taskId: "2", epoch: 1, token: "t2", runId: "run-2" },
  ]);
  await store.remove("1");
  await store.remove("1");
  expect((await store.list()).map((c) => c.taskId)).toEqual(["2"]);
});

test("files are private, named by hash, and leave no temp files", { timeout: 5000 }, async () => {
  const dir = join(root, "state");
  await new ClaimStore(dir).put({ taskId: "42", epoch: 1, token: "secret" });
  expect((await stat(dir)).mode & 0o777).toBe(0o700);
  const names = await readdir(dir);
  expect(names).toEqual([`${createHash("sha256").update("42").digest("hex")}.json`]);
  expect((await stat(join(dir, names[0] ?? ""))).mode & 0o777).toBe(0o600);
});

test("ignores corrupt files", { timeout: 5000 }, async () => {
  const dir = join(root, "state");
  const store = new ClaimStore(dir);
  await store.put({ taskId: "1", epoch: 1, token: "t" });
  await writeFile(join(dir, "junk.json"), "{not json");
  await writeFile(join(dir, "wrong.json"), JSON.stringify({ taskId: 1 }));
  expect(await store.list()).toEqual([{ taskId: "1", epoch: 1, token: "t" }]);
});

test("without a dir it does nothing and writes nothing", { timeout: 5000 }, async () => {
  const store = new ClaimStore(null);
  await store.put({ taskId: "1", epoch: 1, token: "t" });
  expect(await store.list()).toEqual([]);
  await store.remove("1");
  expect(await readFile(join(root, ".keep"), "utf8").catch(() => "none")).toBe("none");
});
