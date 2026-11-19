#!/usr/bin/env node
// Entrypoint of the board server. Exit 2 on bad configuration or tokens, 0 after a clean stop.
import { startServer } from "./app.js";
import { TokensError } from "./auth.js";
import { ConfigError, loadConfig } from "./config.js";
import type { Log } from "./stale.js";

const log: Log = (entry) => {
  process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
};

async function main(): Promise<void> {
  let server;
  try {
    server = await startServer(loadConfig(), log);
  } catch (error) {
    if (error instanceof ConfigError || error instanceof TokensError) {
      log({ level: "error", event: "config.invalid", problems: error.problems });
      process.exit(2);
    }
    throw error;
  }
  const running = server;
  const shutdown = (signal: string): void => {
    log({ level: "info", event: "server.stopping", signal });
    void running.stop().then(() => process.exit(0));
  };
  process.once("SIGTERM", () => {
    shutdown("SIGTERM");
  });
  process.once("SIGINT", () => {
    shutdown("SIGINT");
  });
}

main().catch((error: unknown) => {
  log({ level: "error", event: "fatal", error: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
