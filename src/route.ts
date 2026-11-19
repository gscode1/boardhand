// A route is what one worker serves (ADR 0001). It is read once from the environment and validated up front, so a bad
// deployment fails at start with every problem listed, not on the first task.

export type Route = {
  boardUrl: string;
  /** Secret. Never log it; use `describeRoute`. */
  boardToken: string;
  profile: string;
  channel: string;
  labels: Record<string, string>;
  /** Owner principal IDs this route claims from. Task text is untrusted, so this is never empty. */
  from: string[];
  backend: string;
  backendOptions: Record<string, unknown>;
  concurrency: number;
  leaseSeconds: number;
  waitSeconds: number;
  stateDir: string | null;
};

export class RouteError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid route configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "RouteError";
    this.problems = problems;
  }
}

/** Backends `createBackend` knows; checked here so a typo fails at start. */
export const KNOWN_BACKENDS: readonly string[] = ["fake"];

type Env = Readonly<Record<string, string | undefined>>;

// The intersection of what the board's HTTP and local backends accept for a profile.
const PROFILE = /^[a-z][a-z0-9-]{0,31}$/;

export function loadRoute(env: Env = process.env): Route {
  const problems: string[] = [];
  const fail = (message: string): undefined => {
    problems.push(message);
    return undefined;
  };
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const required = (name: string): string | undefined => {
    const value = text(name);
    if (value === undefined) fail(`${name} is required`);
    return value;
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      fail(`${name} must be an integer from ${String(min)} to ${String(max)}`);
      return fallback;
    }
    return Number(raw);
  };

  const boardUrl = required("BOARD_URL");
  if (boardUrl !== undefined && !isHttpUrl(boardUrl)) fail("BOARD_URL must be an http or https URL");
  const boardToken = required("BOARD_TOKEN");
  const profile = text("BOARD_PROFILE") ?? "boardhand";
  if (!PROFILE.test(profile)) {
    fail("BOARD_PROFILE must start with a lowercase letter and use up to 32 lowercase letters, digits and hyphens");
  }
  const channel = required("BOARDHAND_CHANNEL");
  const labels = parseLabels(text("BOARDHAND_LABELS"), fail);
  const from = (text("BOARDHAND_FROM") ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id !== "");
  if (from.length === 0) fail("BOARDHAND_FROM is required: name at least one owner ID, since task text is untrusted");
  const backend = required("BOARDHAND_BACKEND");
  if (backend !== undefined && !KNOWN_BACKENDS.includes(backend)) {
    fail(`BOARDHAND_BACKEND "${backend}" is unknown; known: ${KNOWN_BACKENDS.join(", ")}`);
  }
  const backendOptions = parseOptions(text("BOARDHAND_BACKEND_OPTIONS"), fail);
  const concurrency = integer("BOARDHAND_CONCURRENCY", 1, 1, 64);
  const leaseSeconds = integer("BOARDHAND_LEASE", 300, 30, 3600);
  const waitSeconds = integer("BOARDHAND_WAIT", 30, 1, 3600);

  if (
    problems.length > 0 ||
    boardUrl === undefined ||
    boardToken === undefined ||
    channel === undefined ||
    backend === undefined
  ) {
    throw new RouteError(problems);
  }
  return {
    boardUrl: boardUrl.replace(/\/+$/, ""),
    boardToken,
    profile,
    channel,
    labels,
    from,
    backend,
    backendOptions,
    concurrency,
    leaseSeconds,
    waitSeconds,
    stateDir: text("BOARDHAND_STATE_DIR") ?? null,
  };
}

/** A loggable view of the route. Secrets are redacted; backend options may hold secrets, so only their keys show. */
export function describeRoute(route: Route): Record<string, unknown> {
  return {
    boardUrl: route.boardUrl,
    boardToken: "[redacted]",
    profile: route.profile,
    channel: route.channel,
    labels: route.labels,
    from: route.from,
    backend: route.backend,
    backendOptions: Object.keys(route.backendOptions),
    concurrency: route.concurrency,
    leaseSeconds: route.leaseSeconds,
    waitSeconds: route.waitSeconds,
    stateDir: route.stateDir,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function parseLabels(raw: string | undefined, fail: (message: string) => undefined): Record<string, string> {
  const labels: Record<string, string> = {};
  if (raw === undefined) return labels;
  for (const pair of raw.split(",")) {
    const at = pair.indexOf("=");
    const key = at < 0 ? "" : pair.slice(0, at).trim();
    const value = at < 0 ? "" : pair.slice(at + 1).trim();
    if (key === "" || value === "") fail(`BOARDHAND_LABELS entry "${pair.trim()}" must be key=value`);
    else labels[key] = value;
  }
  return labels;
}

function parseOptions(raw: string | undefined, fail: (message: string) => undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed))
      return parsed as Record<string, unknown>;
  } catch {
    // reported below, without the text: options may hold secrets
  }
  fail("BOARDHAND_BACKEND_OPTIONS must be a JSON object");
  return {};
}
