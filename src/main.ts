#!/usr/bin/env node
// Entrypoint: one worker for one route, configured from the environment. Exit 2 on bad config, 0 after a clean stop.
import { connectBoard } from "./board.js";
import { createBackend } from "./backends/index.js";
import type { Backend } from "./backends/backend.js";
import { ClaimStore } from "./claims.js";
import { RouteError, describeRoute, loadRoute } from "./route.js";
import type { Route } from "./route.js";
import { startWorker } from "./worker.js";
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
  const board = await connectBoard({ url: route.boardUrl, token: route.boardToken, profile: route.profile });
  const worker = await startWorker({ route, board, backend, store: new ClaimStore(route.stateDir), log });
  const shutdown = (signal: string): void => {
    log({ level: "info", event: "worker.stopping", signal });
    void worker.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  await worker.finished;
}

main().catch((error: unknown) => {
  log({ level: "error", event: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
