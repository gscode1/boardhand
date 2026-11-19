// A fake pi-durable-k8s session API on node:http (port 0), scriptable per session. It reproduces the parts of the real
// API a client can trip on: a message sits in `events.pending` before the agent picks it up (and the session looks
// idle meanwhile), `sourceEventId` deduplicates, the stream replays after Last-Event-ID, and the platform can be 503.
import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export type PiScript = {
  /** What the agent answers. Default "done". */
  replyText?: string;
  /** How long after pickup the answer arrives. Default 60. */
  replyAfterMs?: number;
  /** Assistant entries sent before the answer. */
  interim?: { afterMs: number; text: string }[];
  /** The run ends idle with this runFailure instead of an answer. */
  runFailure?: string;
  /** The session turns `failed` with this text instead of answering. */
  sessionFailed?: string;
  /** The agent never finishes. */
  hang?: boolean;
  /** The platform counts the message as failed. */
  rejectMessage?: boolean;
};

type Entry = { id: number; kind: string; messages: { role: string; text: string }[] };

export type FakeSession = {
  id: string;
  status: "active" | "failed" | "deleting" | "deleted";
  failure: string | undefined;
  created: Record<string, unknown>;
  script: PiScript;
  pending: number;
  submitted: number;
  failed: number;
  running: boolean;
  runFailure: string | undefined;
  entries: Entry[];
  sourceEventIds: Set<string>;
  streams: Set<ServerResponse>;
  timers: NodeJS.Timeout[];
  /** After DELETE the session answers 410. */
  gone: boolean;
  canceled: boolean;
};

export type Recorded = { method: string; path: string; body: unknown; lastEventId?: string };

export class FakePi {
  readonly url: string;
  readonly token: string;
  readonly requests: Recorded[] = [];
  readonly sessions = new Map<string, FakeSession>();
  /** The script new sessions get. */
  script: PiScript = {};
  /** Answer this status to POST /sessions/:id/events (for a failing message post). */
  eventsStatus: number | undefined;
  #unavailableUntil = 0;
  readonly #server: Server;

  private constructor(server: Server, url: string, token: string) {
    this.#server = server;
    this.url = url;
    this.token = token;
  }

  static async start(token = `pi-${randomUUID()}`): Promise<FakePi> {
    const ref: { fake?: FakePi } = {};
    const server = createServer((req, res) => {
      ref.fake?.handle(req, res);
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
    ref.fake = new FakePi(server, url, token);
    return ref.fake;
  }

  /** The platform answers 503 with Retry-After: 1 for the next `ms`. */
  unavailableFor(ms: number): void {
    this.#unavailableUntil = Date.now() + ms;
  }

  count(method: string, pathPattern: RegExp): number {
    return this.requests.filter((r) => r.method === method && pathPattern.test(r.path)).length;
  }

  async close(): Promise<void> {
    for (const session of this.sessions.values()) this.#stop(session);
    await new Promise<void>((resolve) => {
      this.#server.close(() => {
        resolve();
      });
      this.#server.closeAllConnections();
    });
  }

  /** The server's request handler; public only so `start` can wire it. */
  handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = raw === "" ? undefined : JSON.parse(raw);
      } catch {
        body = raw;
      }
      const method = req.method ?? "GET";
      const path = new URL(req.url ?? "/", this.url).pathname;
      const lastEventId = req.headers["last-event-id"];
      this.requests.push({ method, path, body, ...(typeof lastEventId === "string" ? { lastEventId } : {}) });
      if (req.headers.authorization !== `Bearer ${this.token}`) {
        json(res, 401, { error: "unauthorized" });
        return;
      }
      if (Date.now() < this.#unavailableUntil) {
        res.setHeader("retry-after", "1");
        {
          json(res, 503, { error: "orchestrator unavailable" });
          return;
        }
      }
      this.#route(method, path, body, lastEventId, res);
    });
  }

  #route(method: string, path: string, body: unknown, lastEventId: string | string[] | undefined, res: ServerResponse) {
    if (method === "POST" && path === "/sessions") {
      const session = this.#create(isRecord(body) ? body : {});
      {
        json(res, 201, { sessionId: session.id, profile: { name: "coding", version: 1 } });
        return;
      }
    }
    const match = /^\/sessions\/([^/]+)(?:\/(events|stream))?$/.exec(path);
    const session = match?.[1] === undefined ? undefined : this.sessions.get(match[1]);
    if (match === null || session === undefined) {
      json(res, 404, { error: "session not found" });
      return;
    }
    if (session.gone) {
      json(res, 410, { error: "session deleted" });
      return;
    }
    const sub = match[2];
    if (method === "GET" && sub === undefined) {
      {
        json(res, 200, {
          sessionId: session.id,
          status: session.status,
          ...(session.failure === undefined ? {} : { failure: session.failure }),
          events: { pending: session.pending, submitted: session.submitted, failed: session.failed },
        });
        return;
      }
    }
    if (method === "DELETE" && sub === undefined) {
      this.#stop(session);
      session.status = "deleted";
      session.gone = true;
      {
        json(res, 202, {});
        return;
      }
    }
    if (method === "POST" && sub === "events") {
      this.#event(session, body, res);
      return;
    }
    if (method === "GET" && sub === "stream") {
      this.#stream(session, lastEventId, res);
      return;
    }
    {
      json(res, 404, { error: "not found" });
      return;
    }
  }

  #create(body: Record<string, unknown>): FakeSession {
    const session: FakeSession = {
      id: randomUUID(),
      status: "active",
      failure: undefined,
      created: body,
      script: this.script,
      pending: 0,
      submitted: 0,
      failed: 0,
      running: false,
      runFailure: undefined,
      entries: [],
      sourceEventIds: new Set(),
      streams: new Set(),
      timers: [],
      gone: false,
      canceled: false,
    };
    this.sessions.set(session.id, session);
    return session;
  }

  #event(session: FakeSession, body: unknown, res: ServerResponse): void {
    if (this.eventsStatus !== undefined) {
      json(res, this.eventsStatus, { error: "boom" });
      return;
    }
    if (session.status !== "active") {
      json(res, 409, { error: `session is ${session.status}` });
      return;
    }
    const kind = isRecord(body) ? body["kind"] : undefined;
    if (kind === "cancel") {
      session.canceled = true;
      session.running = false;
      for (const timer of session.timers.splice(0)) clearTimeout(timer);
      this.#live(session);
      {
        json(res, 202, { eventId: randomUUID(), duplicate: false });
        return;
      }
    }
    if (kind !== "message" || !isRecord(body) || typeof body["text"] !== "string") {
      {
        json(res, 400, { error: "bad event" });
        return;
      }
    }
    const sourceEventId = body["sourceEventId"];
    if (typeof sourceEventId === "string") {
      if (session.sourceEventIds.has(sourceEventId)) {
        json(res, 202, { eventId: randomUUID(), duplicate: true });
        return;
      }
      session.sourceEventIds.add(sourceEventId);
    }
    this.#submit(session, body["text"]);
    json(res, 202, { eventId: randomUUID(), duplicate: false });
  }

  /** pending now; picked up shortly after; then the script plays. */
  #submit(session: FakeSession, text: string): void {
    const { script } = session;
    session.pending += 1;
    const later = (ms: number, fn: () => void): void => {
      session.timers.push(setTimeout(fn, ms));
    };
    later(25, () => {
      session.pending -= 1;
      if (script.rejectMessage === true) {
        session.failed += 1;
        return;
      }
      session.submitted += 1;
      session.running = true;
      this.#entry(session, "message", "user", text);
      this.#live(session);
      for (const part of script.interim ?? [])
        later(part.afterMs, () => {
          this.#entry(session, "turn", "assistant", part.text);
        });
      if (script.hang === true) return;
      later(script.replyAfterMs ?? 60, () => {
        session.running = false;
        if (script.sessionFailed !== undefined) {
          session.status = "failed";
          session.failure = script.sessionFailed;
        } else if (script.runFailure !== undefined) {
          session.runFailure = script.runFailure;
        } else {
          this.#entry(session, "turn", "assistant", script.replyText ?? "done");
        }
        this.#live(session);
      });
    });
  }

  #entry(session: FakeSession, kind: string, role: string, text: string): void {
    const entry: Entry = { id: session.entries.length + 1, kind, messages: [{ role, text }] };
    session.entries.push(entry);
    for (const stream of session.streams) sse(stream, "entry", entry, entry.id);
  }

  #live(session: FakeSession): void {
    for (const stream of session.streams) this.#sendLive(session, stream);
  }

  #sendLive(session: FakeSession, stream: ServerResponse): void {
    sse(stream, "live", {
      running: session.running,
      queued: 0,
      ...(session.runFailure === undefined || session.running ? {} : { runFailure: session.runFailure }),
    });
  }

  #stream(session: FakeSession, lastEventId: string | string[] | undefined, res: ServerResponse): void {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const after = typeof lastEventId === "string" ? Number(lastEventId) : 0;
    for (const entry of session.entries) if (entry.id > after) sse(res, "entry", entry, entry.id);
    this.#sendLive(session, res);
    session.streams.add(res);
    res.on("close", () => session.streams.delete(res));
  }

  #stop(session: FakeSession): void {
    for (const timer of session.timers.splice(0)) clearTimeout(timer);
    for (const stream of session.streams) {
      stream.write("event: deleted\ndata: {}\n\n");
      stream.end();
    }
    session.streams.clear();
  }
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function sse(res: ServerResponse, event: string, data: unknown, id?: number): void {
  res.write(`${id === undefined ? "" : `id: ${String(id)}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
