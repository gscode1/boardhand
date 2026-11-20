// The real board server program, in process, on a throwaway data dir.
import { BoardError } from "@vercel/board";
import { afterEach, describe, expect, it } from "vitest";
import { startRig, type ServerRig } from "../helpers/server-rig.js";

const rigs: ServerRig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop();
});
async function rig(lines: readonly string[]): Promise<ServerRig> {
  const started = await startRig(lines);
  rigs.push(started);
  return started;
}

const refusal = async (call: () => Promise<unknown>): Promise<BoardError> => {
  try {
    await call();
  } catch (error) {
    if (error instanceof BoardError) return error;
    throw error;
  }
  throw new Error("expected the board to refuse");
};

describe("authentication", () => {
  it("answers /healthz without a token", { timeout: 10_000 }, async () => {
    const r = await rig(["gs:person"]);
    const response = await fetch(`${r.url}/healthz`);
    expect(response.status).toBe(200);
  });

  it("refuses a request with no token or a wrong one", { timeout: 10_000 }, async () => {
    const r = await rig(["gs:person"]);
    expect((await fetch(`${r.url}/messages`)).status).toBe(401);
    const wrong = await fetch(`${r.url}/messages`, {
      headers: { authorization: "Bearer not-a-known-token-at-all-0000" },
    });
    expect(wrong.status).toBe(401);
  });

  it("knows a person by name, with full access", { timeout: 10_000 }, async () => {
    const r = await rig(["gs:person"]);
    const me = await (await r.client("gs")).me();
    expect(me.principal).toBe("boardhand:person:gs");
    expect(me.handle).toBe("gs");
    expect(me.can).toEqual({ "*": ["read", "post", "react", "label", "sync", "manage"] });
  });
});

describe("worker grants", () => {
  it(
    "lets a worker claim, reply and settle in its channel and refuses it in another",
    { timeout: 20_000 },
    async () => {
      const r = await rig(["gs:person", "dev:worker:dev", "ops:worker:ops/"]);
      const owner = await r.client("gs");
      const ownerId = (await owner.me()).principal;
      const { task: mine } = await owner.tasks.create("dev", { text: "in dev" });
      const { task: theirs } = await owner.tasks.create("ops", { text: "in ops" });
      const worker = await r.client("dev", "boardhand");

      // In its channel: the whole claim, reply, settle path.
      const claim = await worker.tasks.claim({ channel: "dev", from: [ownerId], wait: 1, lease: 60 });
      expect(claim?.task.id).toBe(mine.id);
      await worker.reply(mine.id, "working on it");
      await claim?.complete("done");
      const settled = await owner.tasks.list({ state: "completed" });
      expect(settled.tasks.map((t) => t.message.id)).toEqual([mine.id]);

      // Elsewhere: refused, and invisible.
      expect((await refusal(() => worker.tasks.claim({ channel: "ops", from: [ownerId], wait: 1 }))).status).toBe(403);
      expect((await refusal(() => worker.tasks.claim(theirs.id))).status).toBe(404);
      expect((await refusal(() => worker.reply(theirs.id, "hi"))).status).toBe(404);
      expect((await refusal(() => worker.post("ops", "new"))).status).toBe(403);
      // And the ops task is untouched.
      expect((await owner.tasks.list({ channel: "ops", state: "ready" })).tasks).toHaveLength(1);
    },
  );

  it("holds a worker to its token even when it sends its own x-board-can", { timeout: 20_000 }, async () => {
    const r = await rig(["gs:person", "dev:worker:dev"]);
    const owner = await r.client("gs");
    const { task } = await owner.tasks.create("ops", { text: "in ops" });
    const response = await fetch(`${r.url}/messages/${task.id}`, {
      headers: { authorization: `Bearer ${r.tokens["dev"] ?? ""}`, "x-board-can": "all" },
    });
    expect(response.status).toBe(404);
    const me = await fetch(`${r.url}/me`, {
      headers: { authorization: `Bearer ${r.tokens["dev"] ?? ""}`, "x-board-can": "ops/=all" },
    });
    const body = (await me.json()) as { can: Record<string, string[]> };
    expect(Object.keys(body.can)).toEqual(["dev"]);
  });

  it("gives a worker a subtree when its channel ends in /", { timeout: 20_000 }, async () => {
    const r = await rig(["gs:person", "rev:worker:review/"]);
    const owner = await r.client("gs");
    const ownerId = (await owner.me()).principal;
    const { task } = await owner.tasks.create("review/web", { text: "pr 1" });
    const worker = await r.client("rev", "boardhand");
    const claim = await worker.tasks.claim({ channel: "review/", from: [ownerId], wait: 1 });
    expect(claim?.task.id).toBe(task.id);
    await claim?.release();
  });

  it("lets a worker scoped to agents/ claim in agents/research and refuses dev", { timeout: 20_000 }, async () => {
    const r = await rig(["gs:person", "agents:worker:agents/"]);
    const owner = await r.client("gs");
    const ownerId = (await owner.me()).principal;
    const { task } = await owner.tasks.create("agents/research", { text: "look it up" });
    await owner.tasks.create("dev", { text: "elsewhere" });
    const worker = await r.client("agents", "boardhand");
    expect((await refusal(() => worker.tasks.claim({ channel: "dev", from: [ownerId], wait: 1 }))).status).toBe(403);
    const claim = await worker.tasks.claim({ channel: "agents/", from: [ownerId], wait: 1, lease: 60 });
    expect(claim?.task.id).toBe(task.id);
    expect(claim?.task.channel).toBe("agents/research");
    await worker.reply(task.id, "working");
    await claim?.complete("done");
  });

  it(
    "never gives a worker unrestricted access, whatever the Authorization header looks like",
    { timeout: 30_000 },
    async () => {
      const r = await rig(["gs:person", "dev:worker:dev"]);
      const owner = await r.client("gs");
      const { task } = await owner.tasks.create("ops", { text: "in ops" });
      const t = r.tokens["dev"] ?? "";
      const variants = [
        `Bearer ${t}`,
        `bearer ${t}`,
        `BEARER ${t}`,
        `Bearer  ${t}`,
        `Bearer   ${t}`,
        `Bearer\t${t}`,
        ` Bearer ${t}`,
        `Bearer ${t} `,
        `Bearer Bearer ${t}`,
        `Bearer ${t} Bearer ${t}`,
        `Basic ${t}`,
        t,
      ];
      for (const authorization of variants) {
        for (const extra of [{}, { "x-board-can": "all" }, { "X-Board-Can": "ops/=all" }]) {
          const headers = { authorization, ...extra };
          const me = await fetch(`${r.url}/me`, { headers });
          if (me.ok) {
            const body = (await me.json()) as { can?: Record<string, string[]> };
            expect(Object.keys(body.can ?? {}), JSON.stringify(headers)).toEqual(["dev"]);
          }
          const read = await fetch(`${r.url}/messages/${task.id}`, { headers });
          expect(read.ok, JSON.stringify(headers)).toBe(false);
        }
      }
    },
  );

  it("strips a client-sent x-board-can on a person too, so only the token decides", { timeout: 20_000 }, async () => {
    const r = await rig(["gs:person"]);
    const response = await fetch(`${r.url}/me`, {
      headers: { authorization: `Bearer ${r.tokens["gs"] ?? ""}`, "x-board-can": "dev/=read" },
    });
    const body = (await response.json()) as { can: Record<string, string[]> };
    expect(Object.keys(body.can)).toEqual(["*"]);
  });

  it("refuses a malformed Authorization header with 401", { timeout: 20_000 }, async () => {
    const r = await rig(["gs:person"]);
    const response = await fetch(`${r.url}/me`, { headers: { authorization: `Token ${r.tokens["gs"] ?? ""}` } });
    expect(response.status).toBe(401);
  });
});
