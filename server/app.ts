// The board server: the engine on its local SQLite backend, with our authentication, behind node:http.
// This is a separate program from the worker (ADR 0005), so it may import @vercel/board directly.
import { readFile } from "node:fs/promises";
import { board, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { bearerOf, createAuth, parseTokens } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { listen } from "./http.js";
import { startStaleCheck, type Log } from "./stale.js";

export type RunningServer = {
  port: number;
  /** Stops the stale check, drains requests for `graceMs`, then closes the backend. */
  stop(graceMs?: number): Promise<void>;
};

/** Overrides in milliseconds, for tests that cannot wait seconds. */
export type ServerTuning = {
  staleCheckMs?: number;
  staleAfterMs?: number;
  now?: () => number;
  /** The public URL as a function of the bound port, for a server on port 0, whose port is not known up front. */
  publicUrl?: (port: number) => string;
};

export async function startServer(config: ServerConfig, log: Log, tuning: ServerTuning = {}): Promise<RunningServer> {
  const entries = parseTokens(await readFile(config.tokensFile, "utf8"));
  const auth = createAuth(entries);
  const backend = local({ dir: config.dataDir });
  const engine: { team?: Board } = {};
  let accepting = true;
  const http = await listen({
    port: config.port,
    fetch: (request) =>
      engine.team ? engine.team.fetch(request) : Promise.resolve(new Response("starting", { status: 503 })),
    // A worker's limits come from its token, never from what it sends.
    rewriteHeaders: (headers) => {
      const scope = auth.scopeFor(bearerOf(headers.get("authorization")));
      if (scope !== undefined) headers.set("x-board-can", scope);
    },
    health: () => accepting,
  });
  const publicUrl = tuning.publicUrl?.(http.port) ?? config.publicUrl;
  // The engine checks every token's audience against this URL, so it is the one clients use.
  const handle = board({ backend, url: publicUrl, authenticate: auth.authenticate });
  engine.team = handle;
  const checkMs = tuning.staleCheckMs ?? config.staleCheckSeconds * 1000;
  const stale =
    checkMs > 0
      ? startStaleCheck(
          handle,
          {
            checkMs,
            afterMs: tuning.staleAfterMs ?? config.staleAfterSeconds * 1000,
            ...(tuning.now ? { now: tuning.now } : {}),
          },
          log,
        )
      : null;
  log({
    level: "info",
    event: "server.start",
    port: http.port,
    url: publicUrl,
    tokens: entries.map((entry) => ({ name: entry.name, kind: entry.kind, channels: entry.channels })),
  });
  let stopped: Promise<void> | undefined;
  return {
    port: http.port,
    stop: (graceMs = 5000) =>
      (stopped ??= (async () => {
        accepting = false;
        stale?.stop();
        await http.close(graceMs);
        await backend.close();
      })()),
  };
}
