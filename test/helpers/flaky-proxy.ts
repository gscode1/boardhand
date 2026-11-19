// An HTTP proxy in front of a test board that can be switched "down": every request then gets a 503, as if the board
// were unreachable. OS-assigned port; streams responses so long-polls work.
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Readable } from "node:stream";

export type FlakyProxy = {
  url: string;
  /** While true, answer every request with 503. */
  down: boolean;
  /** How many requests were refused while down. */
  refused: number;
  close(): Promise<void>;
};

const HOP_BY_HOP = new Set(["connection", "content-encoding", "content-length", "transfer-encoding", "keep-alive"]);

export async function startFlakyProxy(target: string): Promise<FlakyProxy> {
  const proxy: FlakyProxy = {
    url: "",
    down: false,
    refused: 0,
    close: async () => {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
        server.closeAllConnections();
      });
    },
  };
  const server: Server = createServer((req, res) => {
    if (proxy.down) {
      proxy.refused += 1;
      req.resume();
      res.writeHead(503, { "content-type": "text/plain" });
      res.end("board down");
      return;
    }
    const abort = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) abort.abort();
    });
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const headers = new Headers();
      for (const [name, value] of Object.entries(req.headers)) {
        if (value === undefined || name === "host" || HOP_BY_HOP.has(name)) continue;
        for (const v of Array.isArray(value) ? value : [value]) headers.append(name, v);
      }
      const method = req.method ?? "GET";
      const init: RequestInit = { method, headers, signal: abort.signal };
      if (method !== "GET" && method !== "HEAD") init.body = Buffer.concat(chunks);
      fetch(new URL(req.url ?? "/", target), init)
        .then((response) => {
          const out: Record<string, string> = {};
          response.headers.forEach((value, name) => {
            if (!HOP_BY_HOP.has(name) && name !== "set-cookie") out[name] = value;
          });
          res.writeHead(response.status, out);
          if (response.body === null) {
            res.end();
            return;
          }
          Readable.fromWeb(response.body as import("node:stream/web").ReadableStream<Uint8Array>)
            .on("error", () => res.end())
            .pipe(res);
        })
        .catch(() => {
          if (!res.headersSent) res.writeHead(502);
          res.end();
        });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  proxy.url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
  return proxy;
}
