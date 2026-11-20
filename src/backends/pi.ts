// The pi-durable-k8s backend: a run is one session of its session API. `start` creates the session and posts the task
// as its first message, `wait` follows the session's event stream until the agent is idle (or a failure), and `cancel`
// stops and deletes it. It knows nothing of the board (ADR 0003); docs/backends/pi.md describes the protocol.
import { BackendUnavailableError } from "./backend.js";
import type { Backend, RunTask, RunUpdate } from "./backend.js";
import { PiApi, PiError, isSessionId } from "./pi-api.js";
import type { CreateSessionBody, SessionSummary } from "./pi-api.js";
import { readSse } from "./sse.js";

export { PiError } from "./pi-api.js";

export type PiOptions = {
  url: string;
  profile?: string;
  /** A subtree pattern ending in `/`: the profile of a task is the first channel segment below it. */
  profileChannel?: string;
  /** With `profileChannel`: the profiles a task may use. Absent means any (the platform validates). */
  profiles?: readonly string[];
  sandboxSize?: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  /** Delete the session once its run has ended. Default false: the session stays for inspection. */
  deleteOnFinish: boolean;
  /** How long one connection to the platform lasts before `wait` reconnects. It never returns for this alone. */
  waitSeconds: number;
  requestTimeoutMs: number;
  /** At most one progress update per this many seconds while a run works; 0 (default) means never. */
  progressSeconds: number;
};

export class BackendOptionsError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid pi backend options: ${problems.join("; ")}`);
    this.name = "BackendOptionsError";
    this.problems = problems;
  }
}

const STRING_OPTIONS = ["profile", "sandboxSize", "provider", "model", "reasoning"] as const;
const KNOWN_KEYS: readonly string[] = [
  "url",
  ...STRING_OPTIONS,
  "profileChannel",
  "profiles",
  "deleteOnFinish",
  "waitSeconds",
  "requestTimeoutMs",
  "progressSeconds",
];

// The board's channel-name grammar (a trailing `/` makes a subtree), duplicated here because a backend must not import
// the board.
const CHANNEL_SEGMENTS = "[a-z0-9][a-z0-9._-]*(?:\\/[a-z0-9][a-z0-9._-]*)*";
const SUBTREE = new RegExp(`^${CHANNEL_SEGMENTS}/$`);

/**
 * Validates BOARDHAND_BACKEND_OPTIONS for `pi` (untyped JSON), listing every problem. Unknown keys are errors.
 * `routeChannel` is the route's `BOARDHAND_CHANNEL`; when given, `profileChannel` must lie within it.
 */
export function parsePiOptions(raw: Record<string, unknown>, routeChannel?: string): PiOptions {
  const problems: string[] = [];
  const integer = (key: string, fallback: number, min: number, max: number): number => {
    const value = raw[key];
    if (value === undefined) return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      problems.push(`${key} must be an integer from ${String(min)} to ${String(max)}`);
      return fallback;
    }
    return value;
  };

  for (const key of Object.keys(raw)) if (!KNOWN_KEYS.includes(key)) problems.push(`unknown option "${key}"`);
  const url = raw["url"];
  let validUrl = "";
  if (typeof url !== "string") problems.push("url is required");
  else {
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:")
        problems.push("url must be an http or https URL");
      else if (parsed.username !== "" || parsed.password !== "") problems.push("url must not carry credentials");
      else validUrl = url;
    } catch {
      problems.push("url must be an http or https URL");
    }
  }
  const options: PiOptions = {
    url: validUrl,
    deleteOnFinish: false,
    waitSeconds: integer("waitSeconds", 45, 1, 3600),
    requestTimeoutMs: integer("requestTimeoutMs", 30_000, 1000, 300_000),
    progressSeconds: integer("progressSeconds", 0, 0, 3600),
  };
  for (const key of STRING_OPTIONS) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim() === "") problems.push(`${key} must be a non-empty string`);
    else options[key] = value.trim();
  }
  const profileChannel = raw["profileChannel"];
  if (profileChannel !== undefined) {
    if (typeof profileChannel !== "string" || !SUBTREE.test(profileChannel)) {
      problems.push('profileChannel must be a channel subtree ending in "/", such as "agents/"');
    } else if (routeChannel !== undefined && !(routeChannel.endsWith("/") && profileChannel.startsWith(routeChannel))) {
      // A task outside the route's subtree is never claimed, so a pattern outside it could never match.
      problems.push(`profileChannel "${profileChannel}" must be within the route channel "${routeChannel}", a subtree`);
    } else options.profileChannel = profileChannel;
  }
  const profiles = raw["profiles"];
  if (profiles !== undefined) {
    if (profileChannel === undefined) problems.push("profiles is only valid with profileChannel");
    else if (profiles === "*") {
      // any profile: the platform validates
    } else if (
      Array.isArray(profiles) &&
      profiles.length > 0 &&
      profiles.every((p) => typeof p === "string" && p.trim() !== "")
    ) {
      options.profiles = (profiles as string[]).map((p) => p.trim());
    } else problems.push('profiles must be "*" or a non-empty array of profile names');
  }
  const del = raw["deleteOnFinish"];
  if (del !== undefined) {
    if (typeof del === "boolean") options.deleteOnFinish = del;
    else problems.push("deleteOnFinish must be true or false");
  }
  if (problems.length > 0) throw new BackendOptionsError(problems);
  return options;
}

/** The session API token, from the environment only. Never part of the options, so never logged with them. */
export function piTokenFrom(env: Readonly<Record<string, string | undefined>>): string | undefined {
  const token = env["PI_TOKEN"]?.trim();
  return token === undefined || token === "" ? undefined : token;
}

/** The longest result handed to the worker; the board caps replies at 10 000 characters. */
const RESULT_MAX = 9000;
const TRUNCATED = " [truncated]";
const POLL_MS = 1000;
const IDLE_MS = 500;
const DEFAULT_RETRY_MS = 2000;
const MESSAGE_ATTEMPTS = 3;

type RunState = {
  /** Id of the last stream entry seen: the `Last-Event-ID` of the next connection. */
  cursor: number | undefined;
  /** The latest assistant text; at the end of a turn it is the result. */
  lastText: string;
  reportedText: string;
  lastProgressAt: number;
};

type Connection = {
  abort: AbortController;
  /** Opened after a GET that showed no pending message, so its `idle` can be believed. */
  trusted: boolean;
};

export class PiBackend implements Backend {
  readonly name = "pi";
  readonly #options: PiOptions;
  readonly #api: PiApi;
  readonly #runs = new Map<string, RunState>();

  constructor(options: PiOptions, token: string) {
    this.#options = options;
    this.#api = new PiApi({ url: options.url, token, requestTimeoutMs: options.requestTimeoutMs });
  }

  async start(task: RunTask, signal: AbortSignal): Promise<string> {
    const body: CreateSessionBody = {};
    for (const key of STRING_OPTIONS) {
      const value = this.#options[key];
      if (value !== undefined) body[key] = value;
    }
    const profile = this.#profileFor(task.channel);
    if (profile !== undefined) body.profile = profile;
    const repo = task.labels["repo"];
    if (repo !== undefined && repo !== "") body.repo = repo;
    const branch = task.labels["branch"];
    if (branch !== undefined && branch !== "") body.branch = branch;

    try {
      const sessionId = await this.#api.createSession(body, signal);
      try {
        // Task text is untrusted input: it goes in as the message and nowhere else.
        await this.#postMessage(sessionId, task.text, signal);
      } catch (error) {
        await this.#api.deleteSession(sessionId).catch(() => undefined);
        throw error;
      }
      return sessionId;
    } catch (error) {
      throw unavailableOrSame(error);
    }
  }

  /**
   * The profile of a task from its channel (the channel is fixed at creation by an owner the route trusts, unlike
   * labels). Undefined means pi's default. A plain Error: retrying cannot fix a task in the wrong channel.
   */
  #profileFor(channel: string): string | undefined {
    const prefix = this.#options.profileChannel;
    if (prefix === undefined) return undefined;
    const root = prefix.slice(0, -1);
    const name = channel.replace(/\/+$/, "");
    if (name === root) return this.#options.profile;
    if (!name.startsWith(prefix)) {
      throw new Error(`task channel "${channel}" is not under profileChannel "${prefix}"`);
    }
    const profile = name.slice(prefix.length).split("/")[0] ?? "";
    const allowed = this.#options.profiles;
    if (allowed !== undefined && !allowed.includes(profile)) {
      throw new Error(`profile "${profile}" is not allowed on this route`);
    }
    return profile;
  }

  async find(_task: RunTask, hint: string | null): Promise<string | null> {
    // The hint is a label anyone with write access to the thread can set. The session API scopes sessions to the token's
    // owner, so a 404 covers someone else's session; beyond that the platform keeps nothing to tie a session to a task.
    if (hint === null || !isSessionId(hint)) return null;
    try {
      const session = await this.#api.getSession(hint);
      return session.status === "active" || session.status === "failed" ? hint : null;
    } catch (error) {
      if (error instanceof PiError && (error.status === 404 || error.status === 410)) return null;
      throw unavailableOrSame(error);
    }
  }

  async wait(runId: string, signal: AbortSignal): Promise<RunUpdate> {
    let state = this.#runs.get(runId);
    if (state === undefined) {
      state = { cursor: undefined, lastText: "", reportedText: "", lastProgressAt: Date.now() };
      this.#runs.set(runId, state);
    }
    for (;;) {
      signal.throwIfAborted();
      const update = await this.#follow(runId, state, signal);
      if (update === null) continue; // the connection's time was up with nothing to report
      if (update.kind !== "progress") {
        this.#runs.delete(runId);
        if (this.#options.deleteOnFinish) await this.#api.deleteSession(runId).catch(() => undefined);
      }
      return update;
    }
  }

  async cancel(runId: string): Promise<void> {
    this.#runs.delete(runId);
    if (!isSessionId(runId)) return;
    try {
      await this.#api.postEvent(runId, { kind: "cancel" });
    } catch {
      // Nothing to stop (gone, finished) or the platform is unreachable; the delete below is what must happen.
    }
    await this.#api.deleteSession(runId);
  }

  /** The message carries a `sourceEventId`, so a retry after a lost answer is a no-op for the platform. */
  async #postMessage(sessionId: string, text: string, signal: AbortSignal): Promise<void> {
    const body = { kind: "message", text, sourceEventId: `boardhand:${sessionId}:task` } as const;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.#api.postEvent(sessionId, body, signal);
        return;
      } catch (error) {
        const retryable = error instanceof PiError && (error.status === 0 || error.status >= 500);
        if (!retryable || attempt >= MESSAGE_ATTEMPTS) throw error;
        await sleep(error.retryAfterMs ?? 500 * attempt, signal);
      }
    }
  }

  /** GET the session, waiting out a platform that answers 503. A session that is gone reads as deleted. */
  async #get(runId: string, signal: AbortSignal): Promise<SessionSummary> {
    for (;;) {
      try {
        return await this.#api.getSession(runId, signal);
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        if (!(error instanceof PiError)) throw error;
        if (error.status === 404 || error.status === 410) {
          return {
            sessionId: runId,
            status: "deleted",
            failure: undefined,
            events: { pending: 0, submitted: 0, failed: 0 },
          };
        }
        if (error.status !== 503) throw error;
        await sleep(clamp(error.retryAfterMs ?? DEFAULT_RETRY_MS, 500, 30_000), signal);
      }
    }
  }

  /**
   * Follows the run for one connection's time. Idle counts only when it comes from a stream opened after a GET that
   * showed no pending message: until the platform picks a message up, the session looks idle. Returns null when the time
   * is up with nothing to report.
   */
  async #follow(runId: string, state: RunState, signal: AbortSignal): Promise<RunUpdate | null> {
    const deadline = Date.now() + this.#options.waitSeconds * 1000;
    const progressMs = this.#options.progressSeconds * 1000;
    const flags = {
      conn: undefined as Connection | undefined,
      idle: false,
      idleSince: 0,
      /** Bumped by every entry and live event, so the final check sees anything that arrived meanwhile. */
      activity: 0,
      gone: false,
      fatal: undefined as PiError | undefined,
      reopenAt: 0,
      runFailure: undefined as string | undefined,
    };
    let woken = false;
    let wake: (() => void) | undefined;
    const poke = (): void => {
      woken = true;
      wake?.();
    };
    const nap = (ms: number): Promise<void> => {
      if (woken || ms <= 0) {
        woken = false;
        return Promise.resolve();
      }
      return new Promise((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          signal.removeEventListener("abort", done);
          wake = undefined;
          woken = false;
          resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener("abort", done, { once: true });
        wake = done;
      });
    };

    const onEntry = (data: Record<string, unknown>): void => {
      const id = data["id"];
      if (typeof id !== "number" || (state.cursor !== undefined && id <= state.cursor)) return;
      state.cursor = id;
      const messages = Array.isArray(data["messages"]) ? (data["messages"] as unknown[]) : [];
      for (const message of messages) {
        if (!isRecord(message) || message["role"] !== "assistant") continue;
        const text = message["text"];
        if (typeof text === "string" && text !== "") state.lastText = text;
      }
    };
    const onLive = (data: Record<string, unknown>): void => {
      const queued = data["queued"];
      if (data["running"] === true || (typeof queued === "number" && queued > 0)) {
        flags.idle = false;
        flags.runFailure = undefined;
      } else if (flags.conn?.trusted === true) {
        flags.idle = true;
        if (typeof data["runFailure"] === "string") flags.runFailure = data["runFailure"];
      }
    };
    const pump = async (conn: Connection): Promise<void> => {
      try {
        const opened = await this.#api.openStream(runId, state.cursor, conn.abort.signal);
        if (opened.body === null) {
          const status = opened.status;
          if (status === 410) flags.gone = true;
          else if (status === 401 || status === 404) flags.fatal = opened.error;
          else flags.reopenAt = Date.now() + (opened.error?.retryAfterMs ?? POLL_MS);
          return;
        }
        for await (const event of readSse(opened.body, conn.abort.signal)) {
          if (event.event === "deleted") {
            flags.gone = true;
            return;
          }
          const data: unknown = parseJson(event.data);
          if (!isRecord(data)) continue;
          if (event.event === "entry") onEntry(data);
          else if (event.event === "live") onLive(data);
          else continue;
          flags.activity += 1;
          flags.idleSince = Date.now();
          poke();
        }
        flags.reopenAt = Date.now() + POLL_MS;
      } catch {
        // A broken stream is not the run's failure: reconnect from the cursor shortly.
        flags.reopenAt = Date.now() + POLL_MS;
      } finally {
        if (flags.conn === conn) {
          flags.conn = undefined;
          flags.idle = false;
        }
        poke();
      }
    };
    const dropConnection = (): void => {
      flags.conn?.abort.abort();
      flags.conn = undefined;
      flags.idle = false;
    };
    let summary: SessionSummary;
    const apply = (next: SessionSummary): void => {
      summary = next;
      if (next.events.pending > 0) {
        if (flags.conn !== undefined) flags.conn.trusted = false;
        flags.idle = false;
      } else if (flags.conn?.trusted === false) {
        dropConnection(); // reopened below, now trusted
      }
    };
    const terminal = (): RunUpdate | undefined => {
      if (flags.fatal !== undefined) throw flags.fatal;
      if (flags.gone || summary.status === "deleted" || summary.status === "deleting") {
        return { kind: "failed", reason: "the session was deleted" };
      }
      if (summary.status === "failed") return { kind: "failed", reason: summary.failure ?? "the session failed" };
      if (summary.events.failed > 0) {
        return { kind: "failed", reason: "the platform could not process the task message" };
      }
      return undefined;
    };
    // A function, so the compiler does not keep the flag narrowed across the awaits that change it.
    const isIdle = (): boolean => flags.idle;

    try {
      summary = await this.#get(runId, signal);
      apply(summary);
      let nextPoll = Date.now() + POLL_MS;
      for (;;) {
        signal.throwIfAborted();
        const ended = terminal();
        if (ended !== undefined) return ended;
        const now = Date.now();
        if (now >= deadline) return null;

        if (progressMs > 0 && !flags.idle && now - state.lastProgressAt >= progressMs) {
          state.lastProgressAt = now;
          if (state.lastText !== "" && state.lastText !== state.reportedText) {
            state.reportedText = state.lastText;
            return { kind: "progress", text: clip(state.lastText) };
          }
        }
        if (now >= nextPoll) {
          apply(await this.#get(runId, signal));
          nextPoll = Date.now() + POLL_MS;
          continue;
        }
        if (flags.idle && now - flags.idleSince >= IDLE_MS) {
          // Confirm with the platform, and that nothing arrived while we asked.
          const seen = flags.activity;
          apply(await this.#get(runId, signal));
          if (terminal() !== undefined) continue;
          if (isIdle() && flags.activity === seen && summary.events.pending === 0) {
            return flags.runFailure === undefined
              ? { kind: "succeeded", result: clip(state.lastText === "" ? "(the agent sent no text)" : state.lastText) }
              : { kind: "failed", reason: `the run failed: ${flags.runFailure}` };
          }
          continue;
        }
        if (flags.conn === undefined && now >= flags.reopenAt) {
          const conn: Connection = { abort: new AbortController(), trusted: summary.events.pending === 0 };
          flags.conn = conn;
          void pump(conn);
        }
        const nextProgress = progressMs > 0 && !flags.idle ? state.lastProgressAt + progressMs : Infinity;
        const idleAt = flags.idle ? flags.idleSince + IDLE_MS : Infinity;
        const reopenAt = flags.conn === undefined ? flags.reopenAt : Infinity;
        await nap(Math.min(deadline, nextPoll, nextProgress, idleAt, reopenAt) - Date.now());
      }
    } finally {
      dropConnection();
    }
  }
}

function clip(text: string): string {
  return text.length <= RESULT_MAX ? text : `${text.slice(0, RESULT_MAX - TRUNCATED.length)}${TRUNCATED}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Resolves after `ms`; rejects with the abort reason as soon as `signal` aborts. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A transient session API failure becomes `BackendUnavailableError`, so the worker retries the task; the rest stays. */
function unavailableOrSame(error: unknown): unknown {
  return error instanceof PiError && error.transient
    ? new BackendUnavailableError(error.message, { cause: error })
    : error;
}
