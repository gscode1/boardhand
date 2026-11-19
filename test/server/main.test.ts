// The built server entrypoint (`node dist/server/main.js`) as a child process.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { build, spawnMain, type Child } from "../helpers/child.js";
import { waitFor } from "../helpers/board-server.js";
import { secret } from "../helpers/server-rig.js";

const SERVER = ["dist", "server", "main.js"];
const children: Child[] = [];
const dirs: string[] = [];

beforeAll(async () => {
  await build();
}, 150_000);

afterEach(async () => {
  for (const child of children.splice(0)) child.dispose();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "boardhand-main-"));
  dirs.push(dir);
  return dir;
}

describe("board server entrypoint", () => {
  it("serves /healthz, logs JSON without tokens, and exits 0 on SIGTERM", { timeout: 40_000 }, async () => {
    const dir = await tmp();
    const token = secret();
    await writeFile(join(dir, "tokens"), `gs:person:${token}\n`);
    // Port 0 is OS-assigned; the child logs the port it bound.
    const child = spawnMain(
      {
        PORT: "0",
        BOARD_DATA_DIR: join(dir, "data"),
        BOARD_PUBLIC_URL: "http://127.0.0.1:1",
        BOARD_TOKENS_FILE: join(dir, "tokens"),
        BOARD_STALE_CHECK_SECONDS: "1",
      },
      SERVER,
    );
    children.push(child);
    const started = await child.untilEvent("server.start");
    const port = started["port"] as number;
    await waitFor(async () => (await fetch(`http://127.0.0.1:${String(port)}/healthz`)).status === 200, 10_000);
    child.signal("SIGTERM");
    expect((await child.exited).code).toBe(0);
    expect(child.output()).not.toContain(token);
    for (const line of child
      .output()
      .split("\n")
      .filter((l) => l !== "")) {
      expect(() => JSON.parse(line) as unknown, `not JSON: ${line}`).not.toThrow();
    }
  });

  it("exits 2 with every problem listed when configuration is bad", { timeout: 40_000 }, async () => {
    const child = spawnMain({ PORT: "abc" }, SERVER);
    children.push(child);
    expect((await child.exited).code).toBe(2);
    const line = child.lines().find((l) => l["event"] === "config.invalid");
    expect(line?.["problems"]).toEqual(
      expect.arrayContaining([
        "BOARD_DATA_DIR is required",
        "BOARD_TOKENS_FILE is required",
        "BOARD_PUBLIC_URL is required",
        "PORT must be an integer from 0 to 65535",
      ]),
    );
  });

  it("exits 2 on a bad tokens file without printing its secrets", { timeout: 40_000 }, async () => {
    const dir = await tmp();
    const token = secret();
    await writeFile(join(dir, "tokens"), `dev:worker:${token}\n`); // a worker with no channels
    const child = spawnMain(
      {
        BOARD_DATA_DIR: join(dir, "data"),
        BOARD_PUBLIC_URL: "http://127.0.0.1:1",
        BOARD_TOKENS_FILE: join(dir, "tokens"),
      },
      SERVER,
    );
    children.push(child);
    expect((await child.exited).code).toBe(2);
    expect(child.output()).toContain("needs channels");
    expect(child.output()).not.toContain(token);
  });
});
