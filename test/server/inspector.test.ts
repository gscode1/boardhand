// The inspector program (server/inspector.ts) in front of a throwaway board.
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { startTestBoard, type TestBoard } from "../helpers/board-server.js";
import { build, spawnMain, type Child } from "../helpers/child.js";
import {
  InspectorConfigError,
  loadInspectorConfig,
  startInspector,
  type RunningInspector,
} from "../../server/inspector.js";

type Reply = { status: number; body: string };

// node:fetch cannot set Host, and the inspector's origin check is about Host, so go through node:http.
function send(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string> = {},
  body?: string,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.setEncoding("utf8").on("data", (chunk: string) => (text += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: text });
      });
    });
    req.on("error", reject);
    req.end(body);
  });
}

let board: TestBoard;
let inspector: RunningInspector;
let logs: Record<string, unknown>[];

beforeEach(async () => {
  board = await startTestBoard();
  logs = [];
  const started = await startInspector({ boardUrl: board.url, boardToken: board.tokens.owner, port: 0 }, (entry) =>
    logs.push(entry),
  );
  if (started === null) throw new Error("inspector did not start");
  inspector = started;
});

afterEach(async () => {
  await inspector.stop(200);
  await board.close();
});

const page = { "x-inspect-token": "page", "sec-fetch-site": "same-origin" };

describe("inspector", () => {
  it("serves /healthz, the page and its bundle at the root", { timeout: 20_000 }, async () => {
    expect((await send(inspector.port, "GET", "/healthz")).status).toBe(200);
    const html = await send(inspector.port, "GET", "/", { host: "board.c2.lab" });
    expect(html.status).toBe(200);
    expect(html.body).toContain("<script");
    const bundle = await send(inspector.port, "GET", "/app.js", { host: "board.c2.lab" });
    expect(bundle.status).toBe(200);
    expect(bundle.body.length).toBeGreaterThan(1000);
    expect(JSON.stringify(logs)).not.toContain(board.tokens.owner);
  });

  it("proxies a read for the page and refuses one without the page token", { timeout: 20_000 }, async () => {
    await board.client(board.tokens.owner).then((owner) => owner.tasks.create("dev", { text: "hello", labels: {} }));
    const read = await send(inspector.port, "GET", "/board/channels", { ...page, host: "board.c2.lab" });
    expect(read.status).toBe(200);
    expect(read.body).toContain("dev");
    const bare = await send(inspector.port, "GET", "/board/channels", { host: "board.c2.lab" });
    expect(bare.status).toBe(403);
    const cross = await send(inspector.port, "GET", "/board/channels", {
      ...page,
      "sec-fetch-site": "cross-site",
      host: "board.c2.lab",
    });
    expect(cross.status).toBe(403);
  });

  // The gateway terminates TLS and passes the Host through, so the browser's Origin is http:// or https:// with that
  // host while the pod sees plain HTTP.
  it.each(["http://board.c2.lab", "https://board.c2.lab"])(
    "creates a task as the token's owner from the page at %s",
    { timeout: 20_000 },
    async (origin) => {
      const write = (headers: Record<string, string>): Promise<Reply> =>
        send(
          inspector.port,
          "POST",
          "/board/tasks",
          {
            ...page,
            host: "board.c2.lab",
            "x-forwarded-proto": origin.startsWith("https") ? "https" : "http",
            "content-type": "application/json",
            ...headers,
          },
          JSON.stringify({ channel: "dev", text: `from ${origin}`, labels: {} }),
        );
      expect((await write({ origin: "https://evil.example", "x-board-profile": "gs" })).status).toBe(403);
      expect((await write({ origin })).status).toBe(401); // no profile named
      const created = await write({ origin, "x-board-profile": "gs" });
      expect(created.status, created.body).toBeLessThan(300);
      const owner = await board.client(board.tokens.owner);
      const { tasks } = await owner.tasks.list({ channel: "dev" });
      const task = tasks.find((t) => t.message.text === `from ${origin}`);
      expect(task?.message.task?.owner).toBe(board.ownerId);
    },
  );
});

describe("inspector configuration", () => {
  it("reports every problem at once", () => {
    expect(() => loadInspectorConfig({})).toThrow(InspectorConfigError);
    try {
      loadInspectorConfig({ BOARD_URL: "ftp://x", INSPECT_PORT: "abc" });
    } catch (error) {
      expect((error as InspectorConfigError).problems).toHaveLength(3);
    }
  });

  it("defaults the port and trims the URL", () => {
    expect(loadInspectorConfig({ BOARD_URL: "http://b:8080/", BOARD_TOKEN: "t" })).toEqual({
      boardUrl: "http://b:8080",
      boardToken: "t",
      port: 4747,
    });
  });
});

describe("inspector entrypoint", () => {
  const children: Child[] = [];
  afterEach(() => {
    for (const child of children.splice(0)) child.dispose();
  });

  it("exits 2 on bad configuration, without printing the token", { timeout: 160_000 }, async () => {
    await build();
    const child = spawnMain({ BOARD_TOKEN: "secret-value-xyz", INSPECT_PORT: "x" }, ["dist", "server", "inspect.js"]);
    children.push(child);
    expect((await child.exited).code).toBe(2);
    expect(child.output()).toContain("config.invalid");
    expect(child.output()).not.toContain("secret-value-xyz");
  });

  it("waits for an unreachable board and exits 0 on SIGTERM", { timeout: 60_000 }, async () => {
    const child = spawnMain({ BOARD_URL: "http://127.0.0.1:1", BOARD_TOKEN: "tok", INSPECT_PORT: "0" }, [
      "dist",
      "server",
      "inspect.js",
    ]);
    children.push(child);
    await child.untilEvent("board.unreachable");
    child.signal("SIGTERM");
    expect((await child.exited).code).toBe(0);
  });
});
