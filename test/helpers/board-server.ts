// A throwaway @vercel/board for tests: the local backend in a temp dir, served over node:http on an OS-assigned port.
// Test helper only: the "only src/board.ts imports @vercel/board" invariant covers src/, not test/.
import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { board, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";

export type TestBoardTokens = { owner: string; worker: string; other: string };

export type TestBoard = {
  /** The board's URL, which is also its token audience (no trailing slash, no base path). */
  url: string;
  /** The owner's principal ID, the value `tasks.claim({ from })` takes. */
  ownerId: string;
  workerId: string;
  tokens: TestBoardTokens;
  /** An SDK handle that sends `token` (and writes as `profile`, if given). */
  client(token: string, profile?: string): Promise<Board>;
  close(): Promise<void>;
};

const PRINCIPALS = {
  owner: { id: "local:user:owner", handle: "owner" },
  worker: { id: "local:user:worker", handle: "worker" },
  other: { id: "local:user:other", handle: "other" },
} as const;

function toRequest(req: IncomingMessage, origin: string, signal: AbortSignal): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  const method = req.method ?? "GET";
  const hasBody = method !== "GET" && method !== "HEAD";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
  if (hasBody) {
    init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
    init.duplex = "half";
  }
  return new Request(new URL(req.url ?? "/", origin), init);
}

async function sendResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") headers[name] = [value];
  });
  for (const cookie of response.headers.getSetCookie()) (headers["set-cookie"] ??= []).push(cookie);
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  res.on("close", () => {
    reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const chunk: Awaited<ReturnType<typeof reader.read>> = await reader.read();
      if (chunk.done) break;
      // SSE and long-polls must reach the client as they are produced.
      if (!res.write(chunk.value)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } catch {
    // The client went away mid-stream; nothing left to tell it.
  }
  res.end();
}

// The SDK reads BOARD_URL / BOARD_TOKEN / BOARD_PROFILE from the environment when it makes a client and on its first
// request. Env is process-global, so client creation is serialized and the env restored once the client has made its
// first (token-minting) request.
let clientLock: Promise<unknown> = Promise.resolve();

export async function makeClient(url: string, token: string, profile: string | undefined): Promise<Board> {
  const run = async (): Promise<Board> => {
    const saved = {
      BOARD_URL: process.env.BOARD_URL,
      BOARD_TOKEN: process.env.BOARD_TOKEN,
      BOARD_PROFILE: process.env.BOARD_PROFILE,
    };
    const restore = (key: keyof typeof saved): void => {
      const value = saved[key];
      if (value === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = value;
    };
    Reflect.deleteProperty(process.env, "BOARD_PROFILE"); // a profile comes from as(), never from the ambient env
    process.env.BOARD_URL = url;
    process.env.BOARD_TOKEN = token;
    try {
      const handle = board();
      await handle.me(); // first request: the SDK caches the token it read from the env
      return profile === undefined ? handle : handle.as(profile);
    } finally {
      restore("BOARD_URL");
      restore("BOARD_TOKEN");
      restore("BOARD_PROFILE");
    }
  };
  const next = clientLock.then(run, run);
  clientLock = next.catch(() => undefined);
  return next;
}

export async function startTestBoard(): Promise<TestBoard> {
  const dir = await mkdtemp(join(tmpdir(), "boardhand-board-"));
  const tokens: TestBoardTokens = {
    owner: `tok-${randomBytes(16).toString("hex")}`,
    worker: `tok-${randomBytes(16).toString("hex")}`,
    other: `tok-${randomBytes(16).toString("hex")}`,
  };
  const byToken = new Map<string, (typeof PRINCIPALS)[keyof typeof PRINCIPALS]>([
    [tokens.owner, PRINCIPALS.owner],
    [tokens.worker, PRINCIPALS.worker],
    [tokens.other, PRINCIPALS.other],
  ]);
  const backend = local({ dir });

  let handler: (request: Request) => Promise<Response> = () =>
    Promise.resolve(new Response("starting", { status: 503 }));
  let origin = "";
  const server: Server = createServer((req, res) => {
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    handler(toRequest(req, origin, abort.signal))
      .then((response) => sendResponse(res, response))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  const team = board({
    backend,
    // The board checks every token's audience against this, so it must be the URL clients use.
    url: origin,
    authenticate: (req) => {
      const found = req.credential === null ? undefined : byToken.get(req.credential);
      return found ? { id: found.id, kind: "person", handle: found.handle } : null;
    },
  });
  handler = (request) => team.fetch(request);

  let closed = false;
  return {
    url: origin,
    ownerId: PRINCIPALS.owner.id,
    workerId: PRINCIPALS.worker.id,
    tokens,
    client: (token, profile) => makeClient(origin, token, profile),
    async close() {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
      await backend.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/** Polls until `predicate` is truthy, failing with `what` after `timeoutMs`. */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 5000,
  what = "condition",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out after ${String(timeoutMs)} ms waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Creates a task as the owner and returns its ID. */
export async function createTask(
  testBoard: TestBoard,
  channel: string,
  text: string,
  labels: Record<string, string> = {},
): Promise<string> {
  const owner = await testBoard.client(testBoard.tokens.owner);
  const { task } = await owner.tasks.create(channel, { text, labels });
  return task.id;
}
