#!/usr/bin/env node
// Entrypoint: one worker for one route, configured from the environment. Exit 2 on bad config, 0 after a clean stop.
import { Backoff, sleep } from "./backoff.js";
import { connectBoard, isUnreachable } from "./board.js";
import type { Board } from "./board.js";
import { createBackend } from "./backends/index.js";
import type { Backend } from "./backends/backend.js";
import { ClaimStore } from "./claims.js";
import { RouteError, describeRoute, loadRoute } from "./route.js";
import type { Route } from "./route.js";
import { startWorker } from "./worker.js";
import type { Worker } from "./worker.js";
import type { LogEntry } from "./worker.js";

function log(entry: LogEntry): void {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
}

async function main(): Promise<void> {
  let route: Route;
  let backend: Backend;
  try {
    route = loadRoute();
    // Backend options are config too: a bad one must fail fast with the same exit code as a bad route.
    backend = createBackend(route.backend, route.backendOptions);
  } catch (error) {
    const problems =
      error instanceof RouteError ? error.problems : [error instanceof Error ? error.message : String(error)];
    log({ level: "error", event: "config.invalid", problems });
    process.exit(2);
  }
  log({ level: "info", event: "route", route: describeRoute(route) });
  let worker: Worker | null = null;
  const stopping = new AbortController();
  const shutdown = (signal: string): void => {
    log({ level: "info", event: "worker.stopping", signal });
    stopping.abort();
    void (worker?.stop() ?? Promise.resolve()).then(() => process.exit(0));
  };
  // Installed before the first board request, so a stop signal ends the wait for a board that is not up yet.
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  const board = await connectWhenReachable(route, stopping.signal);
  if (board === null) return; // a signal arrived while waiting: `shutdown` exits 0
  worker = await startWorker({ route, board, backend, store: new ClaimStore(route.stateDir), log });
  if (stopping.signal.aborted) return;
  await worker.finished;
}

/**
 * The first board request, retried with the worker's backoff while the board is unreachable (it may still be starting,
 * and a crash loop would only slow the pod down). Any other error, such as a bad token, ends the process. Null when
 * `signal` aborted.
 */
async function connectWhenReachable(route: Route, signal: AbortSignal): Promise<Board | null> {
  const backoff = new Backoff({ baseMs: 250, maxMs: 30_000 }, Math.random);
  while (!signal.aborted) {
    try {
      return await connectBoard({ url: route.boardUrl, token: route.boardToken, profile: route.profile });
    } catch (error) {
      if (!isUnreachable(error)) throw error;
      const delay = backoff.next();
      const text = error instanceof Error ? error.message : String(error);
      log({ level: "warn", event: "board.unreachable", error: text.slice(0, 300), retryInMs: Math.round(delay) });
      await sleep(delay, signal);
    }
  }
  return null;
}

main().catch((error: unknown) => {
  log({ level: "error", event: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
