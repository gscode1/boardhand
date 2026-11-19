import { describe, expect, test } from "vitest";
import { RouteError, describeRoute, loadRoute } from "../../src/route.js";

const valid = {
  BOARD_URL: "http://127.0.0.1:4100/",
  BOARD_TOKEN: "s3cret-board-token",
  BOARDHAND_CHANNEL: "dev/",
  BOARDHAND_FROM: "local:user:owner",
  BOARDHAND_BACKEND: "fake",
};

describe("loadRoute", () => {
  test("applies defaults", { timeout: 5000 }, () => {
    const route = loadRoute(valid);
    expect(route).toMatchObject({
      boardUrl: "http://127.0.0.1:4100",
      profile: "boardhand",
      channel: "dev/",
      labels: {},
      from: ["local:user:owner"],
      backend: "fake",
      backendOptions: {},
      concurrency: 1,
      leaseSeconds: 300,
      waitSeconds: 30,
      stateDir: null,
    });
  });

  test("parses labels, owners, options and numbers", { timeout: 5000 }, () => {
    const route = loadRoute({
      ...valid,
      BOARDHAND_LABELS: "repo=a, kind=fix",
      BOARDHAND_FROM: "a, b",
      BOARDHAND_BACKEND_OPTIONS: '{"stepMs":5}',
      BOARDHAND_CONCURRENCY: "4",
      BOARDHAND_LEASE: "60",
      BOARDHAND_WAIT: "2",
      BOARDHAND_STATE_DIR: "/tmp/x",
    });
    expect(route.labels).toEqual({ repo: "a", kind: "fix" });
    expect(route.from).toEqual(["a", "b"]);
    expect(route.backendOptions).toEqual({ stepMs: 5 });
    expect([route.concurrency, route.leaseSeconds, route.waitSeconds, route.stateDir]).toEqual([4, 60, 2, "/tmp/x"]);
  });

  test("fails fast listing every problem", { timeout: 5000 }, () => {
    let error: unknown;
    try {
      loadRoute({
        BOARD_URL: "ftp://x",
        BOARDHAND_BACKEND: "nope",
        BOARDHAND_LABELS: "novalue",
        BOARDHAND_BACKEND_OPTIONS: "[1]",
        BOARDHAND_CONCURRENCY: "0",
        BOARDHAND_LEASE: "10",
        BOARD_PROFILE: "Bad Profile",
      });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(RouteError);
    const problems = (error as RouteError).problems.join("\n");
    for (const name of [
      "BOARD_URL",
      "BOARD_TOKEN",
      "BOARD_PROFILE",
      "BOARDHAND_CHANNEL",
      "BOARDHAND_FROM",
      "BOARDHAND_BACKEND ",
      "BOARDHAND_LABELS",
      "BOARDHAND_BACKEND_OPTIONS",
      "BOARDHAND_CONCURRENCY",
      "BOARDHAND_LEASE",
    ]) {
      expect(problems).toContain(name);
    }
  });

  test("requires at least one owner", { timeout: 5000 }, () => {
    expect(() => loadRoute({ ...valid, BOARDHAND_FROM: " , " })).toThrow(/BOARDHAND_FROM/);
  });

  test("never echoes secrets in errors or descriptions", { timeout: 5000 }, () => {
    const options = '{"apiKey":"sk-very-secret"';
    expect(() => loadRoute({ ...valid, BOARDHAND_BACKEND_OPTIONS: options })).toThrow(RouteError);
    try {
      loadRoute({ ...valid, BOARDHAND_BACKEND_OPTIONS: options });
    } catch (error) {
      expect(String(error)).not.toContain("sk-very-secret");
    }
    const described = JSON.stringify(
      describeRoute(loadRoute({ ...valid, BOARDHAND_BACKEND_OPTIONS: '{"apiKey":"sk-very-secret"}' })),
    );
    expect(described).not.toContain("s3cret-board-token");
    expect(described).not.toContain("sk-very-secret");
    expect(described).toContain("apiKey");
  });
});
