// The real board server program (server/app.ts) on an OS-assigned port, with a temp data dir and tokens file.
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Board } from "@vercel/board";
import { startServer, type RunningServer, type ServerTuning } from "../../server/app.js";
import type { ServerConfig } from "../../server/config.js";
import { makeClient } from "./board-server.js";

export type LogLine = Record<string, unknown>;

export type ServerRig = {
  url: string;
  dir: string;
  tokensFile: string;
  /** Tokens by entry name. */
  tokens: Record<string, string>;
  logs: LogLine[];
  client(name: string, profile?: string): Promise<Board>;
  stop(): Promise<void>;
};

export const secret = (): string => `tok-${randomBytes(16).toString("hex")}`;

/** `names` are `name:kind[:channels]`; each gets a random token. */
export async function startRig(lines: readonly string[], tuning: ServerTuning = {}): Promise<ServerRig> {
  const dir = await mkdtemp(join(tmpdir(), "boardhand-server-"));
  const tokens: Record<string, string> = {};
  const file = lines.map((line) => {
    const [name = "", kind = "", channels] = line.split(":");
    tokens[name] = secret();
    return [name, kind, tokens[name], channels].filter((part) => part !== undefined).join(":");
  });
  const tokensFile = join(dir, "tokens");
  await writeFile(tokensFile, `${file.join("\n")}\n`, { mode: 0o600 });
  const config: ServerConfig = {
    port: 0,
    dataDir: join(dir, "data"),
    publicUrl: "http://unused",
    tokensFile,
    staleCheckSeconds: 0,
    staleAfterSeconds: 900,
  };
  const logs: LogLine[] = [];
  let server: RunningServer;
  try {
    server = await startServer(config, (entry) => logs.push(entry), {
      publicUrl: (port) => `http://127.0.0.1:${String(port)}`,
      ...tuning,
    });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  const url = `http://127.0.0.1:${String(server.port)}`;
  return {
    url,
    dir,
    tokensFile,
    tokens,
    logs,
    client: (name, profile) => makeClient(url, tokens[name] ?? "", profile),
    stop: async () => {
      await server.stop(500);
      await rm(dir, { recursive: true, force: true });
    },
  };
}
