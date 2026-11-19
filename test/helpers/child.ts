// Runs the real entrypoint (`node dist/main.js`) as a child process and captures what it prints.
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { waitFor } from "./board-server.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const exec = promisify(execFile);

/** Compiles src/ to dist/ with the project's own build. */
export async function build(): Promise<void> {
  await exec("pnpm", ["build"], { cwd: ROOT, timeout: 120_000 });
}

export type Exit = { code: number | null; signal: NodeJS.Signals | null };

export type Child = {
  /** Everything written to stdout and stderr so far. */
  output(): string;
  /** stdout lines that parse as JSON objects. */
  lines(): Record<string, unknown>[];
  /** Resolves with the first line whose `event` is `event`. */
  untilEvent(event: string, timeoutMs?: number): Promise<Record<string, unknown>>;
  exited: Promise<Exit>;
  signal(signal: NodeJS.Signals): void;
  /** Kills the process if it still runs. */
  dispose(): void;
};

export function spawnMain(env: Record<string, string>): Child {
  // A clean environment: nothing of the test runner's own BOARD_* values may leak in.
  const proc: ChildProcess = spawn(process.execPath, [join(ROOT, "dist", "main.js")], {
    cwd: ROOT,
    env: { PATH: process.env["PATH"] ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  proc.stdout?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  proc.stderr?.setEncoding("utf8").on("data", (chunk: string) => (output += chunk));
  const exited = new Promise<Exit>((resolve) => {
    proc.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const lines = (): Record<string, unknown>[] => {
    const parsed: Record<string, unknown>[] = [];
    for (const line of output.split("\n")) {
      try {
        const value = JSON.parse(line) as Record<string, unknown> | null;
        if (typeof value === "object" && value !== null) parsed.push(value);
      } catch {
        // not a JSON line
      }
    }
    return parsed;
  };
  return {
    output: () => output,
    lines,
    async untilEvent(event, timeoutMs = 10_000) {
      let found: Record<string, unknown> | undefined;
      await waitFor(
        () => {
          found = lines().find((l) => l["event"] === event);
          return found !== undefined;
        },
        timeoutMs,
        `the child to log ${event}`,
      );
      return found ?? {};
    },
    exited,
    signal: (signal) => proc.kill(signal),
    dispose: () => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    },
  };
}
