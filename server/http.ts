// Serves a fetch-style handler (what `board()` returns) over node:http. Streams (SSE) and long-polls reach the client as
// they are produced; a client that goes away aborts the request.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type HttpOptions = {
  port: number;
  host?: string;
  /** The origin the handler sees on requests (it only builds URLs; the board checks tokens against its own `url`). */
  fetch: (request: Request) => Promise<Response>;
  /** Called with the incoming headers before the request is built, to force or strip headers the board trusts. */
  rewriteHeaders?: (headers: Headers) => void;
  /** Answered before the handler, with no authentication: `GET /healthz`. */
  health?: () => boolean;
};

export type RunningHttp = {
  port: number;
  /** Stops accepting, waits `graceMs` for in-flight requests, then cuts the rest. */
  close(graceMs: number): Promise<void>;
};

function toRequest(
  req: IncomingMessage,
  origin: string,
  signal: AbortSignal,
  rewriteHeaders: ((headers: Headers) => void) | undefined,
): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
  }
  rewriteHeaders?.(headers);
  const method = req.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { method, headers, signal };
  if (method !== "GET" && method !== "HEAD") {
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
      if (!res.write(chunk.value)) await new Promise<void>((resolve) => res.once("drain", resolve));
    }
  } catch {
    // The client went away mid-stream; nothing left to tell it.
  }
  res.end();
}

export async function listen(options: HttpOptions): Promise<RunningHttp> {
  const origin = `http://127.0.0.1:${String(options.port)}`;
  const server: Server = createServer((req, res) => {
    if (req.method === "GET" && req.url === "/healthz") {
      const ok = options.health?.() ?? true;
      res.writeHead(ok ? 200 : 503, { "content-type": "text/plain" });
      res.end(ok ? "ok\n" : "unavailable\n");
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    options
      .fetch(toRequest(req, origin, abort.signal, options.rewriteHeaders))
      .then((response) => sendResponse(res, response))
      .catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "0.0.0.0", resolve);
  });
  return {
    port: (server.address() as AddressInfo).port,
    close: (graceMs) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          server.closeAllConnections();
        }, graceMs);
        server.close(() => {
          clearTimeout(timer);
          resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
