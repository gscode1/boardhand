#!/usr/bin/env node
// Entrypoint: one worker for one route, configured from the environment. Exit 2 on bad config, 0 after a clean stop.
import { connectBoard } from "./board.js";
import { createBackend } from "./backends/index.js";
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
  try {
    route = loadRoute();
  } catch (error) {
    if (error instanceof RouteError) {
      log({ level: "error", event: "config.invalid", problems: error.problems });
      process.exit(2);
    }
    throw error;
  }
  log({ level: "info", event: "route", route: describeRoute(route) });
  const backend = createBackend(route.backend, route.backendOptions);
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
