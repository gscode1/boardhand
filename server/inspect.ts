#!/usr/bin/env node
// Entrypoint of the inspector program. Exit 2 on bad configuration, 0 after a clean stop.
import { InspectorConfigError, loadInspectorConfig, startInspector } from "./inspector.js";
import type { Log } from "./stale.js";

const log: Log = (entry) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
};

async function main(): Promise<void> {
  let config;
  try {
    config = loadInspectorConfig();
  } catch (error) {
    if (error instanceof InspectorConfigError) {
      log({ level: "error", event: "config.invalid", problems: error.problems });
      process.exit(2);
    }
    throw error;
  }
  const stopping = new AbortController();
  let running: Awaited<ReturnType<typeof startInspector>> = null;
  const shutdown = (signal: string): void => {
    log({ level: "info", event: "inspector.stopping", signal });
    stopping.abort();
    void (running?.stop() ?? Promise.resolve()).then(() => process.exit(0));
  };
  // Installed before the first board request, so a stop signal ends the wait for a board that is not up yet.
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
  running = await startInspector(config, log, { signal: stopping.signal });
}

main().catch((error: unknown) => {
  log({ level: "error", event: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
