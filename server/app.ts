// The board server: the engine on its local SQLite backend, with our authentication, behind node:http.
// This is a separate program from the worker (ADR 0005), so it may import @vercel/board directly.
import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { board, type Board } from "@vercel/board";
import { local } from "@vercel/board/backend-local";
import { bearerOf, createAuth, parseTokens, type SourceEntry } from "./auth.js";
import type { ServerConfig } from "./config.js";
import { GITHUB_HOOK_PATH, githubHook } from "./github.js";
import { listen } from "./http.js";
import { startStaleCheck, type Log } from "./stale.js";
import { channelsOf, loadTriggers } from "./triggers.js";

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
  const triggers = config.triggersFile === undefined ? undefined : await loadTriggers(config.triggersFile);
  // The webhook creates tasks as an in-memory principal, scoped by the engine to the triggers' channels (ADR 0008).
  const source: SourceEntry | undefined = triggers && {
    name: "github",
    kind: "source",
    token: randomBytes(32).toString("base64url"),
    channels: channelsOf(triggers),
  };
  const auth = createAuth(entries, source);
  const backend = local({ dir: config.dataDir });
  const engine: { team?: Board } = {};
  let accepting = true;
  let publicUrl = config.publicUrl;
  const hook =
    triggers && source && config.githubWebhookSecret !== undefined
      ? githubHook({
          secret: config.githubWebhookSecret,
          triggers,
          log,
          postTask: (body) => {
            const scope = auth.scopeFor(source.token);
            if (!engine.team || scope === undefined) return Promise.resolve(new Response("starting", { status: 503 }));
            return engine.team.fetch(
              new Request(`${publicUrl}/tasks`, {
                method: "POST",
                headers: {
                  authorization: `Bearer ${source.token}`,
                  "x-board-can": scope,
                  "content-type": "application/json",
                },
                body,
              }),
            );
          },
        })
      : undefined;
  const http = await listen({
    port: config.port,
    fetch: (request) => {
      if (new URL(request.url).pathname === GITHUB_HOOK_PATH)
        return hook ? hook(request) : Promise.resolve(new Response("not found", { status: 404 }));
      return engine.team ? engine.team.fetch(request) : Promise.resolve(new Response("starting", { status: 503 }));
    },
    // A worker's limits come from its token, never from what it sends. Fail closed: whatever x-board-can the client
    // sent is dropped, and an Authorization header we cannot parse is refused rather than passed on, so the engine
    // never sees a credential that this function did not scope. `authenticate` checks the binding again.
    rewriteHeaders: (headers) => {
      headers.delete("x-board-can");
      const authorization = headers.get("authorization");
      if (authorization === null) return undefined;
      const credential = bearerOf(authorization);
      if (credential === null)
        return Response.json({ error: { code: "unauthorized", message: "malformed authorization" } }, { status: 401 });
      const scope = auth.scopeFor(credential);
      if (scope !== undefined) headers.set("x-board-can", scope);
      return undefined;
    },
    health: () => accepting,
  });
  publicUrl = tuning.publicUrl?.(http.port) ?? config.publicUrl;
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
    ...(triggers ? { triggers: triggers.map((t) => ({ name: t.name, channel: t.channel })) } : {}),
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
