import { afterEach, describe, expect, it } from "vitest";
import { startRig, type ServerRig } from "../helpers/server-rig.js";
import { waitFor } from "../helpers/board-server.js";

const rigs: ServerRig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop();
});

const stale = (rig: ServerRig): Record<string, unknown>[] => rig.logs.filter((line) => line["event"] === "task.stale");

describe("stale-task check", () => {
  it("warns once per check about a ready task older than the threshold", { timeout: 20_000 }, async () => {
    const rig = await startRig(["gs:person", "dev:worker:dev"], { staleCheckMs: 100, staleAfterMs: 400 });
    rigs.push(rig);
    const owner = await rig.client("gs");
    const { task } = await owner.tasks.create("nobody/home", { text: "no route serves me", labels: { kind: "odd" } });

    // Too young at first: nothing is logged before the threshold.
    expect(stale(rig)).toEqual([]);
    await waitFor(() => stale(rig).length >= 2, 10_000, "two stale warnings");
    const line = stale(rig)[0] ?? {};
    expect(line).toMatchObject({
      level: "warn",
      event: "task.stale",
      task: task.id,
      channel: "nobody/home",
      labels: { kind: "odd" },
    });
    expect(line["ageSeconds"]).toBeTypeOf("number");
    expect(JSON.stringify(rig.logs)).not.toContain("no route serves me"); // task text is never logged
  });

  it("does not warn about a task that is claimed or settled", { timeout: 20_000 }, async () => {
    const rig = await startRig(["gs:person", "dev:worker:dev"], { staleCheckMs: 100, staleAfterMs: 300 });
    rigs.push(rig);
    const owner = await rig.client("gs");
    const ownerId = (await owner.me()).principal;
    await owner.tasks.create("dev", { text: "taken" });
    const worker = await rig.client("dev", "boardhand");
    const claim = await worker.tasks.claim({ channel: "dev", from: [ownerId], wait: 1, lease: 60 });
    expect(claim).not.toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 900));
    expect(stale(rig)).toEqual([]);
    await claim?.complete("done");
  });

  it("is off when the check interval is 0", { timeout: 20_000 }, async () => {
    const rig = await startRig(["gs:person"], { staleCheckMs: 0, staleAfterMs: 1 });
    rigs.push(rig);
    await (await rig.client("gs")).tasks.create("dev", { text: "old" });
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(stale(rig)).toEqual([]);
  });
});
