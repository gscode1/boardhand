// A small client of the pi-durable-k8s session API (docs/backends/pi.md). It holds the bearer token and keeps it out of
// every error: messages come from the server's `{error}` body or from a fixed phrase, with the token scrubbed.

export class PiError extends Error {
  readonly status: number;
  /** From a `Retry-After` header, in milliseconds, when the server sent one. */
  readonly retryAfterMs: number | undefined;

  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.name = "PiError";
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

export type SessionStatus = "active" | "failed" | "deleting" | "deleted";

export type SessionSummary = {
  sessionId: string;
  status: SessionStatus;
  failure: string | undefined;
  events: { pending: number; submitted: number; failed: number };
};

export type CreateSessionBody = {
  profile?: string;
  sandboxSize?: string;
  provider?: string;
  model?: string;
  reasoning?: string;
  repo?: string;
  branch?: string;
};

export type EventBody = { kind: "message"; text: string; sourceEventId: string } | { kind: "cancel" };

export type PiApiOptions = { url: string; token: string; requestTimeoutMs: number };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_ERROR_CHARS = 300;
const STATUSES: readonly string[] = ["active", "failed", "deleting", "deleted"];

export const isSessionId = (value: string): boolean => UUID.test(value);

export class PiApi {
  readonly #base: string;
  readonly #token: string;
  readonly #timeoutMs: number;

  constructor(options: PiApiOptions) {
    this.#base = options.url.replace(/\/+$/, "");
    this.#token = options.token;
    this.#timeoutMs = options.requestTimeoutMs;
  }

  async createSession(body: CreateSessionBody, signal?: AbortSignal): Promise<string> {
    const json = await this.#json("POST", "/sessions", 201, body, signal);
    const id = isRecord(json) ? json["sessionId"] : undefined;
    if (typeof id !== "string" || !isSessionId(id)) throw new PiError(0, "session API returned no valid session id");
    return id;
  }

  async getSession(sessionId: string, signal?: AbortSignal): Promise<SessionSummary> {
    const json = await this.#json("GET", sessionPath(sessionId), 200, undefined, signal);
    if (!isRecord(json) || typeof json["status"] !== "string" || !STATUSES.includes(json["status"])) {
      throw new PiError(0, "session API returned an unreadable session");
    }
    const events = isRecord(json["events"]) ? json["events"] : {};
    return {
      sessionId,
      status: json["status"] as SessionStatus,
      failure: typeof json["failure"] === "string" ? json["failure"] : undefined,
      events: {
        pending: count(events["pending"]),
        submitted: count(events["submitted"]),
        failed: count(events["failed"]),
      },
    };
  }

  /** Posts an event. A message carries `sourceEventId`, so a retry is a no-op for the server. */
  async postEvent(sessionId: string, body: EventBody, signal?: AbortSignal): Promise<void> {
    await this.#json("POST", `${sessionPath(sessionId)}/events`, 202, body, signal);
  }

  /** Idempotent: deleting a session that is gone is not an error. */
  async deleteSession(sessionId: string, signal?: AbortSignal): Promise<void> {
    try {
      await this.#json("DELETE", sessionPath(sessionId), 202, undefined, signal);
    } catch (error) {
      if (error instanceof PiError && (error.status === 404 || error.status === 410)) return;
      throw error;
    }
  }

  /**
   * Opens the event stream, resuming after `cursor`. The response is returned whatever its status, so the caller can
   * tell 410 (gone) from 503 (platform down); a non-200 body is already consumed. `signal` ends the stream.
   */
  async openStream(
    sessionId: string,
    cursor: number | undefined,
    signal: AbortSignal,
  ): Promise<{ status: number; error?: PiError; body: ReadableStream<Uint8Array> | null }> {
    // The timeout covers getting the response head only; the stream itself runs until `signal` aborts it.
    const head = new AbortController();
    const timer = setTimeout(() => {
      head.abort();
    }, this.#timeoutMs);
    try {
      const res = await this.#fetch(
        "GET",
        `${sessionPath(sessionId)}/stream`,
        {
          accept: "text/event-stream",
          ...(cursor === undefined ? {} : { "last-event-id": String(cursor) }),
        },
        undefined,
        AbortSignal.any([signal, head.signal]),
        head.signal,
      );
      if (res.status === 200 && res.body !== null) return { status: 200, body: res.body };
      return { status: res.status, error: await this.#errorFrom(res), body: null };
    } finally {
      clearTimeout(timer);
    }
  }

  async #json(
    method: string,
    path: string,
    expected: number,
    payload: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.#timeoutMs);
    const res = await this.#fetch(
      method,
      path,
      payload === undefined ? {} : { "content-type": "application/json" },
      payload === undefined ? undefined : JSON.stringify(payload),
      signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
      timeout,
    );
    if (res.status !== expected) throw await this.#errorFrom(res);
    const text = await res.text();
    if (text === "") return undefined; // a 202 may carry no body
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new PiError(0, "session API returned a body that is not JSON");
    }
  }

  async #fetch(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: string | undefined,
    signal: AbortSignal,
    ownTimeout: AbortSignal,
  ): Promise<Response> {
    try {
      return await fetch(`${this.#base}${path}`, {
        method,
        headers: { ...headers, authorization: `Bearer ${this.#token}` },
        ...(body === undefined ? {} : { body }),
        // A redirect would resend the bearer token somewhere else.
        redirect: "error",
        signal,
      });
    } catch (error) {
      // The caller's abort is not a failure of the API; our own timeout is.
      if (signal.aborted && !ownTimeout.aborted) throw error;
      // A fetch failure's cause can name the URL; keep only its code.
      const cause = (error as { cause?: { code?: unknown } }).cause;
      const detail = typeof cause?.code === "string" ? ` (${cause.code})` : "";
      throw new PiError(
        0,
        ownTimeout.aborted ? "session API request timed out" : `session API request failed${detail}`,
      );
    }
  }

  async #errorFrom(res: Response): Promise<PiError> {
    let message = `session API answered ${String(res.status)}`;
    try {
      const body: unknown = JSON.parse(await res.text());
      if (isRecord(body) && typeof body["error"] === "string" && body["error"] !== "") message = body["error"];
    } catch {
      // not JSON: keep the generic message
    }
    const retry = Number(res.headers.get("retry-after"));
    const retryAfterMs = Number.isFinite(retry) && retry > 0 ? retry * 1000 : undefined;
    return new PiError(res.status, this.#scrub(message.slice(0, MAX_ERROR_CHARS)), retryAfterMs);
  }

  #scrub(text: string): string {
    return text.split(this.#token).join("[redacted]");
  }
}

/** A session id goes into a URL only after it is known to be a UUID. */
function sessionPath(sessionId: string): string {
  if (!isSessionId(sessionId)) throw new PiError(0, "not a valid session id");
  return `/sessions/${sessionId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
