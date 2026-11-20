import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, test } from "vitest";
import { BackendUnavailableError, type RunTask } from "../../src/backends/backend.js";
import { createBackend } from "../../src/backends/index.js";
import { BackendOptionsError, PiBackend, PiError, parsePiOptions } from "../../src/backends/pi.js";
import { FakePi, type PiScript } from "../helpers/fake-pi.js";

const open: FakePi[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((pi) => pi.close()));
});

async function fakePi(script: PiScript = {}): Promise<FakePi> {
  const pi = await FakePi.start();
  pi.script = script;
  open.push(pi);
  return pi;
}

function backend(pi: FakePi, options: Record<string, unknown> = {}): PiBackend {
  return new PiBackend(parsePiOptions({ url: pi.url, ...options }), pi.token);
}

const task = (text = "fix the bug", labels: Record<string, string> = {}): RunTask => ({
  id: "task-1",
  channel: "dev/",
  text,
  labels,
});

const live = (): AbortSignal => new AbortController().signal;

describe("parsePiOptions", () => {
  test("applies defaults", { timeout: 5000 }, () => {
    expect(parsePiOptions({ url: "http://pi:8080" })).toEqual({
      url: "http://pi:8080",
      deleteOnFinish: false,
      waitSeconds: 45,
      requestTimeoutMs: 30_000,
      progressSeconds: 0,
    });
  });

  test("reads every option", { timeout: 5000 }, () => {
    const options = parsePiOptions({
      url: "https://pi.example",
      profile: "coding",
      sandboxSize: "l",
      provider: "p",
      model: "m",
      reasoning: "high",
      deleteOnFinish: true,
      waitSeconds: 10,
      requestTimeoutMs: 5000,
      progressSeconds: 60,
    });
    expect(options).toMatchObject({ profile: "coding", sandboxSize: "l", deleteOnFinish: true, progressSeconds: 60 });
  });

  test.each([
    [{}, "url is required"],
    [{ url: "ftp://x" }, "url must be an http or https URL"],
    [{ url: "not a url" }, "url must be an http or https URL"],
    [{ url: "http://u:p@x" }, "url must not carry credentials"],
    [{ url: "http://x", profile: "" }, "profile must be a non-empty string"],
    [{ url: "http://x", deleteOnFinish: "yes" }, "deleteOnFinish must be true or false"],
    [{ url: "http://x", waitSeconds: 0 }, "waitSeconds must be an integer"],
    [{ url: "http://x", requestTimeoutMs: 1.5 }, "requestTimeoutMs must be an integer"],
    [{ url: "http://x", tokne: "x" }, 'unknown option "tokne"'],
    [{ url: "http://x", token: "secret-value" }, 'unknown option "token"'],
  ])("rejects %j", { timeout: 5000 }, (raw, problem) => {
    expect(() => parsePiOptions(raw)).toThrow(BackendOptionsError);
    expect(() => parsePiOptions(raw)).toThrow(problem);
  });

  test("reads profileChannel and profiles", { timeout: 5000 }, () => {
    expect(parsePiOptions({ url: "http://x", profileChannel: "agents/" }, "agents/")).toMatchObject({
      profileChannel: "agents/",
    });
    const listed = parsePiOptions({ url: "http://x", profileChannel: "agents/", profiles: [" a ", "b"] });
    expect(listed.profiles).toEqual(["a", "b"]);
    expect(parsePiOptions({ url: "http://x", profileChannel: "agents/", profiles: "*" }).profiles).toBeUndefined();
  });

  test.each([
    [{ profiles: "*" }, undefined, "profiles is only valid with profileChannel"],
    [{ profileChannel: "agents" }, undefined, "profileChannel must be a channel subtree"],
    [{ profileChannel: "Agents/" }, undefined, "profileChannel must be a channel subtree"],
    [{ profileChannel: 3 }, undefined, "profileChannel must be a channel subtree"],
    [{ profileChannel: "agents/", profiles: [] }, undefined, "profiles must be"],
    [{ profileChannel: "agents/", profiles: [1] }, undefined, "profiles must be"],
    [{ profileChannel: "agents/", profiles: "a" }, undefined, "profiles must be"],
    [{ profileChannel: "other/" }, "agents/", "must be within the route channel"],
    [{ profileChannel: "agents/" }, "agents", "must be within the route channel"],
    [{ profileChannel: "agents/" }, "agents/x/", "must be within the route channel"],
  ])("rejects %j on route %s", { timeout: 5000 }, (raw, routeChannel, problem) => {
    expect(() => parsePiOptions({ url: "http://x", ...raw }, routeChannel)).toThrow(problem);
  });

  test("createBackend passes the route channel to the options check", { timeout: 5000 }, () => {
    const options = { url: "http://x", profileChannel: "agents/" };
    expect(() => createBackend("pi", options, { PI_TOKEN: "t" }, { channel: "dev" })).toThrow(
      /within the route channel/,
    );
    expect(createBackend("pi", options, { PI_TOKEN: "t" }, { channel: "agents/" }).name).toBe("pi");
  });

  test("createBackend needs PI_TOKEN and never reads it from options", { timeout: 5000 }, () => {
    expect(() => createBackend("pi", { url: "http://x" }, {})).toThrow("PI_TOKEN is required");
    expect(createBackend("pi", { url: "http://x" }, { PI_TOKEN: "t" }).name).toBe("pi");
  });
});

describe("start", () => {
  test(
    "creates a session from options and labels, then posts the task as the message",
    { timeout: 10_000 },
    async () => {
      const pi = await fakePi();
      const b = backend(pi, { profile: "coding", sandboxSize: "m", provider: "prov", model: "mod", reasoning: "low" });
      const id = await b.start(task("do it", { repo: "acme/app", branch: "dev", other: "ignored" }), live());
      expect(id).toMatch(/^[0-9a-f-]{36}$/);
      const session = pi.sessions.get(id);
      expect(session?.created).toEqual({
        profile: "coding",
        sandboxSize: "m",
        provider: "prov",
        model: "mod",
        reasoning: "low",
        repo: "acme/app",
        branch: "dev",
      });
      const events = pi.requests.filter((r) => r.path === `/sessions/${id}/events`);
      expect(events.map((r) => r.body)).toEqual([
        { kind: "message", text: "do it", sourceEventId: `boardhand:${id}:task` },
      ]);
    },
  );

  test("sends an empty body when no option or label applies", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const id = await backend(pi).start(task(), live());
    expect(pi.sessions.get(id)?.created).toEqual({});
  });

  test("deletes the session and throws when the message cannot be posted", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    pi.eventsStatus = 400;
    await expect(backend(pi).start(task(), live())).rejects.toBeInstanceOf(PiError);
    const [session] = [...pi.sessions.values()];
    expect(session?.gone).toBe(true);
  });

  test("retries the message post on a 5xx, with the same sourceEventId", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    pi.eventsStatus = 500;
    setTimeout(() => {
      pi.eventsStatus = undefined;
    }, 300);
    const id = await backend(pi).start(task(), live());
    const posts = pi.requests.filter((r) => r.path === `/sessions/${id}/events`);
    expect(posts.length).toBeGreaterThan(1);
    expect(new Set(posts.map((r) => JSON.stringify(r.body))).size).toBe(1);
    expect(pi.sessions.get(id)?.gone).toBe(false);
  });
});

describe("start with a profile from the channel", () => {
  const at = (channel: string): RunTask => ({ ...task(), channel });
  const created = (pi: FakePi, id: string): unknown => pi.sessions.get(id)?.created;

  test("uses the first segment below profileChannel", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi, { profileChannel: "agents/", profile: "root-default", model: "m" });
    expect(created(pi, await b.start(at("agents/research"), live()))).toEqual({ profile: "research", model: "m" });
    expect(created(pi, await b.start(at("agents/research/team-a"), live()))).toEqual({
      profile: "research",
      model: "m",
    });
    expect(created(pi, await b.start(at("agents/coding/"), live()))).toEqual({ profile: "coding", model: "m" });
  });

  test("honours a nested profileChannel", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi, { profileChannel: "org/agents/" });
    expect(created(pi, await b.start(at("org/agents/qa/x"), live()))).toEqual({ profile: "qa" });
  });

  test("the prefix root uses profile if set, else sends none", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const withDefault = backend(pi, { profileChannel: "agents/", profile: "general" });
    expect(created(pi, await withDefault.start(at("agents"), live()))).toEqual({ profile: "general" });
    const without = backend(pi, { profileChannel: "agents/" });
    expect(created(pi, await without.start(at("agents"), live()))).toEqual({});
  });

  test("a channel outside the prefix fails start with a plain error and no request", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi, { profileChannel: "agents/" });
    for (const channel of ["dev", "agentsx/y", "other/agents/y"]) {
      const error: unknown = await b.start(at(channel), live()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(error).not.toBeInstanceOf(BackendUnavailableError);
      expect((error as Error).message).toContain("not under profileChannel");
    }
    expect(pi.requests).toEqual([]);
  });

  test("an allowlist rejects other profiles without calling pi", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi, { profileChannel: "agents/", profiles: ["research", "coding"] });
    expect(created(pi, await b.start(at("agents/coding/x"), live()))).toEqual({ profile: "coding" });
    const before = pi.requests.length;
    const error: unknown = await b.start(at("agents/secret"), live()).catch((caught: unknown) => caught);
    expect((error as Error).message).toBe('profile "secret" is not allowed on this route');
    expect(error).not.toBeInstanceOf(BackendUnavailableError);
    expect(pi.requests).toHaveLength(before);
  });

  test("without profileChannel the task's channel is ignored", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    expect(created(pi, await backend(pi, { profile: "p" }).start(at("agents/x"), live()))).toEqual({ profile: "p" });
  });
});

describe("find", () => {
  test("returns an active session's id", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi);
    const id = await b.start(task(), live());
    expect(await b.find(task(), id)).toBe(id);
  });

  test("returns a failed session's id so its failure is reported", { timeout: 10_000 }, async () => {
    const pi = await fakePi({ sessionFailed: "boom", replyAfterMs: 10 });
    const b = backend(pi);
    const id = await b.start(task(), live());
    await expect(b.wait(id, live())).resolves.toMatchObject({ kind: "failed" });
    expect(await b.find(task(), id)).toBe(id);
  });

  test("returns null without a request for a hint that is not a UUID", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi);
    for (const hint of [null, "", "abc", "../../admin", "00000000-0000-0000-0000-00000000000g"]) {
      expect(await b.find(task(), hint)).toBeNull();
    }
    expect(pi.requests).toEqual([]);
  });

  test("returns null for an unknown, deleted or deleting session", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi);
    expect(await b.find(task(), "11111111-1111-4111-8111-111111111111")).toBeNull();
    const id = await b.start(task(), live());
    const session = pi.sessions.get(id);
    if (session === undefined) throw new Error("no session");
    session.status = "deleting";
    expect(await b.find(task(), id)).toBeNull();
    session.status = "deleted";
    expect(await b.find(task(), id)).toBeNull();
    session.gone = true; // 410
    expect(await b.find(task(), id)).toBeNull();
  });

  test("signals a 5xx as unavailable and lets a bad token propagate", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const id = await backend(pi).start(task(), live());
    pi.unavailableFor(60_000);
    await expect(backend(pi).find(task(), id)).rejects.toMatchObject({
      cause: { status: 503 },
    });
    const wrong = new PiBackend(parsePiOptions({ url: pi.url }), "wrong-token-value");
    pi.unavailableFor(0);
    await expect(wrong.find(task(), id)).rejects.toMatchObject({ status: 401 });
  });
});

describe("wait", () => {
  test("succeeds with the agent's last text, not before the message was picked up", { timeout: 15_000 }, async () => {
    const pi = await fakePi({
      replyText: "final answer",
      replyAfterMs: 400,
      interim: [{ afterMs: 100, text: "thinking" }],
    });
    const b = backend(pi);
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toEqual({ kind: "succeeded", result: "final answer" });
    expect(pi.sessions.get(id)?.gone).toBe(false); // deleteOnFinish defaults to false
  });

  test("a fresh backend replays the stream from the start (a restarted worker)", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ replyText: "replayed", replyAfterMs: 10 });
    const id = await backend(pi).start(task(), live());
    expect(await backend(pi).wait(id, live())).toEqual({ kind: "succeeded", result: "replayed" });
    const streams = pi.requests.filter((r) => r.path.endsWith("/stream"));
    expect(streams[0]?.lastEventId).toBeUndefined();
  });

  test("keeps following when a connection's time is up", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ replyAfterMs: 2500, replyText: "late" });
    const b = backend(pi, { waitSeconds: 1 });
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toEqual({ kind: "succeeded", result: "late" });
    expect(pi.count("GET", /\/stream$/)).toBeGreaterThan(1);
  });

  test("fails on a runFailure", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ runFailure: "model error", replyAfterMs: 50 });
    const b = backend(pi);
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toEqual({ kind: "failed", reason: "the run failed: model error" });
  });

  test("fails when the session failed, with its failure text", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ sessionFailed: "sandbox crashed", replyAfterMs: 50 });
    const b = backend(pi);
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toEqual({ kind: "failed", reason: "sandbox crashed" });
  });

  test("fails when the platform rejects the message", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ rejectMessage: true });
    const b = backend(pi);
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toEqual({
      kind: "failed",
      reason: "the platform could not process the task message",
    });
  });

  test("fails when the session was deleted meanwhile", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ hang: true });
    const b = backend(pi);
    const id = await b.start(task(), live());
    const waiting = b.wait(id, live());
    await new Promise((resolve) => setTimeout(resolve, 200));
    await b.cancel(id);
    expect(await waiting).toEqual({ kind: "failed", reason: "the session was deleted" });
  });

  test("waits out a 503 and then completes", { timeout: 20_000 }, async () => {
    const pi = await fakePi({ replyAfterMs: 100, replyText: "after the outage" });
    const b = backend(pi);
    const id = await b.start(task(), live());
    pi.unavailableFor(1500);
    expect(await b.wait(id, live())).toEqual({ kind: "succeeded", result: "after the outage" });
  });

  test("rejects promptly when aborted", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ hang: true });
    const b = backend(pi);
    const id = await b.start(task(), live());
    const ctl = new AbortController();
    const waiting = b.wait(id, ctl.signal);
    setTimeout(() => {
      ctl.abort();
    }, 200);
    const started = Date.now();
    await expect(waiting).rejects.toBeDefined();
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test("rejects promptly when aborted during a 503", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ hang: true });
    const b = backend(pi);
    const id = await b.start(task(), live());
    pi.unavailableFor(60_000);
    const ctl = new AbortController();
    const waiting = b.wait(id, ctl.signal);
    setTimeout(() => {
      ctl.abort();
    }, 200);
    await expect(waiting).rejects.toBeDefined();
  });

  test(
    "reports progress at most once per interval, only for new text, and resumes from the cursor",
    {
      timeout: 20_000,
    },
    async () => {
      const pi = await fakePi({ hang: true, interim: [{ afterMs: 100, text: "step one" }] });
      const b = backend(pi, { progressSeconds: 1 });
      const id = await b.start(task(), live());
      expect(await b.wait(id, live())).toEqual({ kind: "progress", text: "step one" });
      // Nothing new: the next call must not repeat it. Abort it after a moment.
      const ctl = new AbortController();
      setTimeout(() => {
        ctl.abort();
      }, 2300);
      await expect(b.wait(id, ctl.signal)).rejects.toBeDefined();
      const last = pi.requests.filter((r) => r.path.endsWith("/stream")).at(-1);
      expect(last?.lastEventId).toBeDefined();
    },
  );

  test("never reports progress by default", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ interim: [{ afterMs: 50, text: "chatter" }], replyAfterMs: 1500, replyText: "end" });
    const b = backend(pi);
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toEqual({ kind: "succeeded", result: "end" });
  });

  test("clips a long result", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ replyText: "x".repeat(50_000), replyAfterMs: 20 });
    const b = backend(pi);
    const id = await b.start(task(), live());
    const update = await b.wait(id, live());
    expect(update.kind).toBe("succeeded");
    if (update.kind === "succeeded") expect(update.result.length).toBeLessThanOrEqual(9000);
  });

  test("deletes the session at the end when deleteOnFinish is set", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ replyAfterMs: 20 });
    const b = backend(pi, { deleteOnFinish: true });
    const id = await b.start(task(), live());
    expect(await b.wait(id, live())).toMatchObject({ kind: "succeeded" });
    expect(pi.sessions.get(id)?.gone).toBe(true);
  });
});

describe("cancel", () => {
  test("posts a cancel event, deletes the session, and is idempotent", { timeout: 15_000 }, async () => {
    const pi = await fakePi({ hang: true });
    const b = backend(pi);
    const id = await b.start(task(), live());
    await b.cancel(id);
    await b.cancel(id);
    const session = pi.sessions.get(id);
    expect(session?.canceled).toBe(true);
    expect(session?.gone).toBe(true);
    expect(pi.count("DELETE", /^\/sessions\//)).toBe(2);
  });

  test("ignores an unknown run and a malformed id", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const b = backend(pi);
    await b.cancel("11111111-1111-4111-8111-111111111111");
    await b.cancel("not-an-id");
  });

  test(
    "still deletes when the cancel event is refused, and surfaces a delete that fails",
    { timeout: 10_000 },
    async () => {
      const pi = await fakePi({ hang: true });
      const b = backend(pi);
      const id = await b.start(task(), live());
      const other = await b.start(task(), live());
      pi.eventsStatus = 409;
      await b.cancel(id);
      expect(pi.sessions.get(id)?.gone).toBe(true);
      pi.eventsStatus = undefined;
      pi.unavailableFor(60_000);
      await expect(b.cancel(other)).rejects.toMatchObject({ status: 503 });
    },
  );
});

describe("token handling", () => {
  test("is sent as a bearer token and never appears in a thrown error", { timeout: 10_000 }, async () => {
    const token = "super-secret-token-value-123";
    const server = createServer((_req, res) => {
      // A careless server that echoes the credential in its error text.
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: `bad request from ${token}` }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
      const b = new PiBackend(parsePiOptions({ url }), token);
      const error: unknown = await b.start(task(), live()).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PiError);
      expect(JSON.stringify([(error as Error).message, (error as Error).stack])).not.toContain(token);
      expect((error as Error).message).toContain("[redacted]");
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  test("a wrong token gives 401 without echoing either token", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const wrong = "wrong-token-abcdefghijkl";
    const b = new PiBackend(parsePiOptions({ url: pi.url }), wrong);
    const error = (await b.start(task(), live()).catch((e: unknown) => e)) as PiError;
    expect(error.status).toBe(401);
    expect(error.message).not.toContain(wrong);
    expect(error.message).not.toContain(pi.token);
  });

  test("a connection failure names no URL", { timeout: 10_000 }, async () => {
    const b = new PiBackend(parsePiOptions({ url: "http://127.0.0.1:1/secret-path" }), "tok");
    const error = (await b.start(task(), live()).catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(BackendUnavailableError);
    expect(error.message).not.toContain("secret-path");
    expect((error.cause as Error).message).not.toContain("secret-path");
  });
});

/** A raw server for answers FakePi does not give: a fixed status, or no answer at all. Returns its URL. */
async function rawServer(respond: (res: import("node:http").ServerResponse) => void): Promise<string> {
  const server = createServer((_req, res) => {
    respond(res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
      server.closeAllConnections();
    });
  });
  return `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
}
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});

describe("transient errors", () => {
  const at = (url: string, requestTimeoutMs = 5000): PiBackend =>
    new PiBackend(parsePiOptions({ url, requestTimeoutMs }), "token-value");

  test.each([429, 500, 502, 503])(
    "start maps a %i on create to BackendUnavailableError",
    { timeout: 10_000 },
    async (status) => {
      const url = await rawServer((res) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "later" }));
      });
      const error: unknown = await at(url)
        .start(task(), live())
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackendUnavailableError);
      expect((error as Error).cause).toBeInstanceOf(PiError);
    },
  );

  test("start maps a network error to BackendUnavailableError", { timeout: 10_000 }, async () => {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
    await expect(at(url).start(task(), live())).rejects.toBeInstanceOf(BackendUnavailableError);
  });

  test("start maps a timeout to BackendUnavailableError", { timeout: 10_000 }, async () => {
    const url = await rawServer(() => undefined); // never answers
    await expect(at(url, 1000).start(task(), live())).rejects.toThrow(BackendUnavailableError);
  });

  test(
    "start maps a 429 on the message post to BackendUnavailableError and deletes the session",
    { timeout: 10_000 },
    async () => {
      const pi = await fakePi();
      pi.eventsStatus = 429;
      await expect(backend(pi).start(task(), live())).rejects.toBeInstanceOf(BackendUnavailableError);
      expect([...pi.sessions.values()][0]?.gone).toBe(true);
    },
  );

  test(
    "start maps a 5xx on the message post, after its retries, to BackendUnavailableError",
    { timeout: 10_000 },
    async () => {
      const pi = await fakePi();
      pi.eventsStatus = 503;
      await expect(backend(pi).start(task(), live())).rejects.toBeInstanceOf(BackendUnavailableError);
    },
  );

  test.each([400, 401, 403, 404, 409])("start keeps a %i a plain PiError", { timeout: 10_000 }, async (status) => {
    const url = await rawServer((res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no" }));
    });
    const error: unknown = await at(url)
      .start(task(), live())
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiError);
    expect(error).not.toBeInstanceOf(BackendUnavailableError);
  });

  test("find maps a 5xx to BackendUnavailableError but keeps a bad token a PiError", { timeout: 10_000 }, async () => {
    const pi = await fakePi();
    const id = await backend(pi).start(task(), live());
    pi.unavailableFor(60_000);
    await expect(backend(pi).find(task(), id)).rejects.toBeInstanceOf(BackendUnavailableError);
    pi.unavailableFor(0);
    const wrong = new PiBackend(parsePiOptions({ url: pi.url }), "wrong-token-value");
    const error: unknown = await wrong.find(task(), id).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PiError);
    expect(error).not.toBeInstanceOf(BackendUnavailableError);
  });

  test("the error message never carries the token", { timeout: 10_000 }, async () => {
    const url = await rawServer((res) => {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "token-value leaked" }));
    });
    const error = await at(url)
      .start(task(), live())
      .catch((e: unknown) => e as Error);
    expect((error as Error).message).not.toContain("token-value");
  });
});
