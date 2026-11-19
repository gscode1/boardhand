// Manual end-to-end run against a real pi-durable-k8s: a throwaway board, one task, one Worker with PiBackend, and the
// resulting thread printed. Not part of `pnpm test`. See docs/backends/pi.md ("Live check").
//
//   PI_URL=http://localhost:8080 PI_TOKEN=... PI_PROFILE=coding pnpm live:pi
//
// Optional: PI_REPO=owner/name (task label `repo`), PI_BRANCH, PI_TASK (task text), PI_TIMEOUT_SECONDS (default 900),
// PI_PROGRESS_SECONDS (default 30), PI_DELETE=1 (deleteOnFinish). Exits 0 when the task completed, 1 otherwise.
// Secrets are never printed: only the task thread and the worker's log lines (which carry none).
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiBackend, parsePiOptions } from "../src/backends/pi.js";
import { connectBoard } from "../src/board.js";
import { ClaimStore } from "../src/claims.js";
import type { Route } from "../src/route.js";
import { startWorker } from "../src/worker.js";
import { createTask, startTestBoard } from "../test/helpers/board-server.js";

const env = process.env;
const url = env["PI_URL"];
const token = env["PI_TOKEN"];
if (url === undefined || url === "" || token === undefined || token === "") {
  process.stderr.write("PI_URL and PI_TOKEN are required (PI_PROFILE, PI_REPO, PI_BRANCH, PI_TASK are optional)\n");
  process.exit(2);
}
const piToken = token;
const timeoutMs = Number(env["PI_TIMEOUT_SECONDS"] ?? "900") * 1000;
const text = env["PI_TASK"] ?? "Reply with the single word: pong. Do not use any tools.";
const labels: Record<string, string> = {};
if (env["PI_REPO"] !== undefined && env["PI_REPO"] !== "") labels["repo"] = env["PI_REPO"];
if (env["PI_BRANCH"] !== undefined && env["PI_BRANCH"] !== "") labels["branch"] = env["PI_BRANCH"];

const backendOptions: Record<string, unknown> = {
  url,
  progressSeconds: Number(env["PI_PROGRESS_SECONDS"] ?? "30"),
  deleteOnFinish: env["PI_DELETE"] === "1",
};
if (env["PI_PROFILE"] !== undefined && env["PI_PROFILE"] !== "") backendOptions["profile"] = env["PI_PROFILE"];

const board = await startTestBoard();
const stateDir = await mkdtemp(join(tmpdir(), "boardhand-live-"));
async function main(): Promise<number> {
  try {
    const taskId = await createTask(board, "live", text, labels);
    const route: Route = {
      boardUrl: board.url,
      boardToken: "not-used",
      profile: "boardhand",
      channel: "live",
      labels: {},
      from: [board.ownerId],
      backend: "pi",
      backendOptions,
      concurrency: 1,
      leaseSeconds: 60,
      waitSeconds: 5,
      stateDir,
    };
    const worker = await startWorker({
      route,
      board: await connectBoard({ url: board.url, token: board.tokens.worker, profile: "boardhand" }),
      backend: new PiBackend(parsePiOptions(backendOptions), piToken),
      store: new ClaimStore(stateDir),
      log: (entry) => process.stdout.write(`log ${JSON.stringify(entry)}\n`),
    });

    const owner = await board.client(board.tokens.owner);
    const deadline = Date.now() + timeoutMs;
    let outcome: "completed" | "failed" | "timeout" = "timeout";
    while (Date.now() < deadline) {
      const [done, failed] = await Promise.all([
        owner.tasks.list({ state: "completed" }),
        owner.tasks.list({ state: "failed" }),
      ]);
      if (done.tasks.some((t) => t.message.id === taskId)) outcome = "completed";
      else if (failed.tasks.some((t) => t.message.id === taskId)) outcome = "failed";
      if (outcome !== "timeout") break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await worker.stop();

    const thread = await owner.thread(taskId);
    process.stdout.write(`\n--- task ---\n${thread.message.text}\n`);
    for (const reply of thread.replies) process.stdout.write(`--- reply ---\n${reply.text}\n`);
    process.stdout.write(`\nOUTCOME: ${outcome}\n`);
    return outcome === "completed" ? 0 : 1;
  } finally {
    await board.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

process.exit(await main());
