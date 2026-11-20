// The GitHub webhook (ADR 0008) against the real board server on an OS-assigned port, a temp data dir and tokens file.
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { afterEach, describe, expect, it } from "vitest";
import { createAuth, type SourceEntry } from "../../server/auth.js";
import { startServer, type RunningServer } from "../../server/app.js";
import { ConfigError, loadConfig, type ServerConfig } from "../../server/config.js";
import { makeClient } from "../helpers/board-server.js";
import { secret } from "../helpers/server-rig.js";

const SECRET = `whsec-${secret()}`;
const SOURCE = "boardhand:source:github";

const trigger = (name: string, over: Record<string, unknown> = {}): Record<string, unknown> => ({
  name,
  repos: ["acme/*"],
  event: "pull_request",
  actions: ["opened"],
  when: { "pull_request.user.login": ["renovate[bot]"] },
  channel: "deps",
  labels: { kind: "renovate" },
  text: "Check {{pull_request.html_url}}",
  ...over,
});

const payload = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    action: "opened",
    repository: { full_name: "acme/web" },
    pull_request: {
      user: { login: "renovate[bot]" },
      html_url: "https://github.com/acme/web/pull/1",
      head: { ref: "renovate/x", repo: { full_name: "acme/web" } },
    },
    ...over,
  });

type Rig = {
  url: string;
  workerToken: string;
  logs: Record<string, unknown>[];
  deliver(body: string, options?: { delivery?: string; event?: string; signature?: string | null }): Promise<Response>;
  stop(): Promise<void>;
};

const rigs: Rig[] = [];
afterEach(async () => {
  for (const rig of rigs.splice(0)) await rig.stop();
});

async function rig(triggers: Record<string, unknown>[]): Promise<Rig> {
  const dir = await mkdtemp(join(tmpdir(), "boardhand-github-"));
  const workerToken = secret();
  await writeFile(join(dir, "tokens"), `gs:person:${secret()}\nbot:worker:${workerToken}:deps,other\n`, {
    mode: 0o600,
  });
  await writeFile(join(dir, "triggers.json"), JSON.stringify({ triggers }));
  const config: ServerConfig = {
    port: 0,
    dataDir: join(dir, "data"),
    publicUrl: "http://unused",
    tokensFile: join(dir, "tokens"),
    staleCheckSeconds: 0,
    staleAfterSeconds: 900,
    triggersFile: join(dir, "triggers.json"),
    githubWebhookSecret: SECRET,
  };
  const logs: Record<string, unknown>[] = [];
  let server: RunningServer;
  try {
    server = await startServer(config, (entry) => logs.push(entry), {
      publicUrl: (port) => `http://127.0.0.1:${String(port)}`,
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const url = `http://127.0.0.1:${String(server.port)}`;
  const started: Rig = {
    url,
    workerToken,
    logs,
    deliver: (body, options = {}) => {
      const headers: Record<string, string> = {
        "x-github-event": options.event ?? "pull_request",
        "x-github-delivery": options.delivery ?? "d-1",
        "content-type": "application/json",
      };
      const signature =
        options.signature === undefined
          ? `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`
          : options.signature;
      if (signature !== null) headers["x-hub-signature-256"] = signature;
      return fetch(`${url}/hooks/github`, { method: "POST", headers, body });
    },
    stop: async () => {
      await server.stop(500);
      await rm(dir, { recursive: true, force: true });
    },
  };
  rigs.push(started);
  return started;
}

const readyTasks = async (r: Rig, channel = "deps") =>
  (await (await makeClient(r.url, r.workerToken, "boardhand")).tasks.list({ channel, state: "ready" })).tasks;

describe("POST /hooks/github", () => {
  it("makes a task owned by the source principal, with derived labels", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    const response = await r.deliver(payload());
    expect(response.status).toBe(200);
    const tasks = await readyTasks(r);
    expect(tasks).toHaveLength(1);
    const message = tasks[0]?.message;
    expect(message?.text).toBe("Check https://github.com/acme/web/pull/1");
    expect(message?.task?.owner).toBe(SOURCE);
    expect(message?.by.principal).toBe(SOURCE);
    expect(message?.labels).toMatchObject({
      kind: "renovate",
      "github.event": "pull_request",
      repo: "acme/web",
      branch: "renovate/x",
    });
    const line = r.logs.find((l) => l["event"] === "github.trigger.created");
    expect(line).toMatchObject({ trigger: "renovate", delivery: "d-1", githubEvent: "pull_request", repo: "acme/web" });
    expect(JSON.stringify(r.logs)).not.toContain(SECRET);
    const start = r.logs.find((l) => l["event"] === "server.start");
    expect(start?.["triggers"]).toEqual([{ name: "renovate", channel: "deps" }]);
  });

  it("makes no second task for a redelivery", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    const first = (await (await r.deliver(payload())).json()) as { tasks: { id: string }[] };
    const second = await r.deliver(payload());
    expect(second.status).toBe(200);
    expect(((await second.json()) as { tasks: { id: string }[] }).tasks).toEqual(first.tasks);
    expect(await readyTasks(r)).toHaveLength(1);
  });

  it("makes one task per matching trigger", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("one"), trigger("two", { channel: "other" })]);
    const response = await r.deliver(payload());
    expect(((await response.json()) as { tasks: unknown[] }).tasks).toHaveLength(2);
    expect(await readyTasks(r, "deps")).toHaveLength(1);
    expect(await readyTasks(r, "other")).toHaveLength(1);
  });

  it("refuses a missing or wrong signature and makes no task", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    expect((await r.deliver(payload(), { signature: null })).status).toBe(401);
    expect((await r.deliver(payload(), { signature: `sha256=${"0".repeat(64)}` })).status).toBe(401);
    expect((await r.deliver(payload(), { signature: "sha256=abc" })).status).toBe(401);
    expect(await readyTasks(r)).toHaveLength(0);
  });

  it("refuses wrong methods and bad headers", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    expect((await fetch(`${r.url}/hooks/github`)).status).toBe(405);
    expect((await r.deliver(payload(), { delivery: "bad delivery!" })).status).toBe(400);
    expect((await r.deliver("not json")).status).toBe(400);
  });

  it("refuses a body over 5 MiB", { timeout: 30_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    const response = await r.deliver("x".repeat(5 * 1024 * 1024 + 1));
    expect(response.status).toBe(413);
  });

  it("answers ping and unmatched events with 200 and no task", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    expect((await r.deliver("{}", { event: "ping" })).status).toBe(200);
    expect((await r.deliver(payload({ action: "closed" }), { delivery: "d-2" })).status).toBe(200);
    expect(await readyTasks(r)).toHaveLength(0);
  });

  it("answers 422 for a template error, still making the other triggers' tasks", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("broken", { text: "{{pull_request.nope}}" }), trigger("fine")]);
    const response = await r.deliver(payload());
    expect(response.status).toBe(422);
    expect(await readyTasks(r)).toHaveLength(1);
    expect(r.logs.some((l) => l["event"] === "github.trigger.failed" && l["trigger"] === "broken")).toBe(true);
  });

  it("lets a worker route that lists the source principal claim the task", { timeout: 20_000 }, async () => {
    const r = await rig([trigger("renovate")]);
    await r.deliver(payload());
    const worker = await makeClient(r.url, r.workerToken, "boardhand");
    const claim = await worker.tasks.claim({ channel: "deps", from: [SOURCE], wait: 1, lease: 60 });
    expect(claim?.task.text).toContain("Check");
    await claim?.complete("done");
  });

  it(
    "does not take the hook from the tokens file's credentials or serve the board API with a signature",
    {
      timeout: 20_000,
    },
    async () => {
      const r = await rig([trigger("renovate")]);
      const sig = `sha256=${createHmac("sha256", SECRET).update("").digest("hex")}`;
      const response = await fetch(`${r.url}/messages`, { headers: { "x-hub-signature-256": sig } });
      expect(response.status).toBe(401);
    },
  );
});

describe("source scope", () => {
  it(
    "is enforced by the engine: the source can post to its channel and nowhere else",
    { timeout: 20_000 },
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "boardhand-source-"));
      const backend = local({ dir });
      try {
        const source: SourceEntry = { name: "github", kind: "source", token: secret(), channels: ["deps"] };
        const auth = createAuth([], source);
        const url = "http://board.test";
        const handle = board({ backend, url, authenticate: auth.authenticate });
        const post = (channel: string, scope: string | undefined): Promise<Response> =>
          handle.fetch(
            new Request(`${url}/tasks`, {
              method: "POST",
              headers: {
                authorization: `Bearer ${source.token}`,
                "content-type": "application/json",
                ...(scope === undefined ? {} : { "x-board-can": scope }),
              },
              body: JSON.stringify({ channel, text: "t", labels: { a: "b" } }),
            }),
          );
        const scope = auth.scopeFor(source.token);
        expect(scope).toBe("deps=post,label");
        expect((await post("deps", scope)).status).toBe(201);
        expect((await post("other", scope)).status).toBe(403);
        // Without the forced scope the credential is refused outright.
        expect((await post("deps", undefined)).status).toBe(403);
      } finally {
        await backend.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});

describe("configuration", () => {
  const env = {
    BOARD_DATA_DIR: "/d",
    BOARD_TOKENS_FILE: "/t",
    BOARD_PUBLIC_URL: "http://x",
  };

  it(
    "fails without the secret when triggers are configured, without echoing anything secret",
    { timeout: 5_000 },
    () => {
      let error: unknown;
      try {
        loadConfig({ ...env, BOARDHAND_TRIGGERS_FILE: "/triggers.json" });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).problems.join()).toContain("GITHUB_WEBHOOK_SECRET");
    },
  );

  it("reads both, and neither", { timeout: 5_000 }, () => {
    const both = loadConfig({ ...env, BOARDHAND_TRIGGERS_FILE: "/t.json", GITHUB_WEBHOOK_SECRET: "s" });
    expect(both.triggersFile).toBe("/t.json");
    expect(loadConfig(env).triggersFile).toBeUndefined();
  });

  it("answers 404 on the hook path when not configured", { timeout: 20_000 }, async () => {
    const dir = await mkdtemp(join(tmpdir(), "boardhand-nohook-"));
    await writeFile(join(dir, "tokens"), `gs:person:${secret()}\n`);
    const server = await startServer(
      {
        port: 0,
        dataDir: join(dir, "data"),
        publicUrl: "http://unused",
        tokensFile: join(dir, "tokens"),
        staleCheckSeconds: 0,
        staleAfterSeconds: 900,
      },
      () => undefined,
    );
    try {
      const response = await fetch(`http://127.0.0.1:${String(server.port)}/hooks/github`, {
        method: "POST",
        body: "{}",
      });
      expect(response.status).toBe(404);
    } finally {
      await server.stop(500);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
