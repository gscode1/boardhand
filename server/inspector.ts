// The board's own UI (the SDK's inspector) as a program of its own, for the cluster. It acts as one owner token, so
// everything that can reach its port acts as that owner: ADR 0007 says why that is acceptable for now and what replaces
// it. Another program from the board server, but like it this one may import @vercel/board directly.
import { board, type Board } from "@vercel/board";
import { inspector } from "@vercel/board/inspect";
import { listen, type RunningHttp } from "./http.js";
import type { Log } from "./stale.js";

export type InspectorConfig = {
  boardUrl: string;
  /** An owner's token. Never logged. */
  boardToken: string;
  port: number;
};

export class InspectorConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "InspectorConfigError";
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadInspectorConfig(env: Env = process.env): InspectorConfig {
  const problems: string[] = [];
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const boardUrl = (text("BOARD_URL") ?? "").replace(/\/+$/, "");
  if (boardUrl === "") problems.push("BOARD_URL is required");
  else if (!/^https?:\/\/[^/\s]+/.test(boardUrl)) problems.push("BOARD_URL must be an http or https URL");
  const boardToken = text("BOARD_TOKEN") ?? "";
  if (boardToken === "") problems.push("BOARD_TOKEN is required");
  let port = 4747;
  const rawPort = text("INSPECT_PORT");
  if (rawPort !== undefined) {
    if (!/^\d+$/.test(rawPort) || Number(rawPort) > 65535)
      problems.push("INSPECT_PORT must be an integer from 0 to 65535");
    else port = Number(rawPort);
  }
  if (problems.length > 0) throw new InspectorConfigError(problems);
  return { boardUrl, boardToken, port };
}

// The SDK reads BOARD_URL and BOARD_TOKEN from the environment when it makes a client and on its first request, so
// both are set only for that moment and restored, and the first request is made inside it.
export async function connectInspectorBoard(config: Pick<InspectorConfig, "boardUrl" | "boardToken">): Promise<Board> {
  const saved = {
    url: process.env["BOARD_URL"],
    token: process.env["BOARD_TOKEN"],
    profile: process.env["BOARD_PROFILE"],
  };
  const restore = (key: string, value: string | undefined): void => {
    if (value === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = value;
  };
  // The inspector's pages pick their own profile; an ambient one would make every write look like the app's own.
  Reflect.deleteProperty(process.env, "BOARD_PROFILE");
  process.env["BOARD_URL"] = config.boardUrl;
  process.env["BOARD_TOKEN"] = config.boardToken;
  try {
    const handle = board();
    await handle.me();
    return handle;
  } finally {
    restore("BOARD_URL", saved.url);
    restore("BOARD_TOKEN", saved.token);
    restore("BOARD_PROFILE", saved.profile);
  }
}

export type RunningInspector = {
  port: number;
  stop(graceMs?: number): Promise<void>;
};

export type InspectorTuning = {
  /** Backoff bounds while the board is unreachable. */
  retryBaseMs?: number;
  retryMaxMs?: number;
  signal?: AbortSignal;
};

function isRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && status >= 400 && status < 500 && status !== 429;
}

/** Connects once the board answers; a refusal (a bad token) is a configuration error and ends the wait. Null on abort. */
async function connectWhenReachable(config: InspectorConfig, log: Log, tuning: InspectorTuning): Promise<Board | null> {
  let delay = tuning.retryBaseMs ?? 250;
  const max = tuning.retryMaxMs ?? 30_000;
  while (tuning.signal?.aborted !== true) {
    try {
      return await connectInspectorBoard(config);
    } catch (error) {
      if (isRefusal(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      log({ level: "warn", event: "board.unreachable", error: message.slice(0, 300), retryInMs: delay });
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        tuning.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
      delay = Math.min(delay * 2, max);
    }
  }
  return null;
}

export async function startInspector(
  config: InspectorConfig,
  log: Log,
  tuning: InspectorTuning = {},
): Promise<RunningInspector | null> {
  const client = await connectWhenReachable(config, log, tuning);
  if (client === null) return null;
  // Mounted at the root: the gateway routes a whole hostname to it. The inspector itself decides what "this origin" is
  // for a write: the Origin's host must equal the request's Host header, which the gateway passes through unchanged.
  const handle = inspector({ board: client, basePath: "" });
  let accepting = true;
  const http: RunningHttp = await listen({ port: config.port, fetch: handle, health: () => accepting });
  log({ level: "info", event: "inspector.start", port: http.port });
  return {
    port: http.port,
    async stop(graceMs = 5000) {
      accepting = false;
      await http.close(graceMs);
    },
  };
}
