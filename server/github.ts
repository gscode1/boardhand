// POST /hooks/github (ADR 0008): verifies GitHub's signature over the raw body, then makes a task per matching trigger.
import { createHmac, timingSafeEqual } from "node:crypto";
import { matches, render, type Trigger } from "./triggers.js";
import type { Log } from "./stale.js";

export const GITHUB_HOOK_PATH = "/hooks/github";
export const BODY_MAX = 5 * 1024 * 1024;
const DELIVERY = /^[A-Za-z0-9-]{1,64}$/;
const SIGNATURE = /^sha256=([0-9a-f]{64})$/i;

export type GithubHookOptions = {
  secret: string;
  triggers: readonly Trigger[];
  /** Sends `POST /tasks` to the engine as the source principal, with its forced scope. */
  postTask: (body: string) => Promise<Response>;
  log: Log;
};

const reply = (status: number, body: Record<string, unknown>, headers?: Record<string, string>): Response =>
  Response.json(body, { status, ...(headers ? { headers } : {}) });

/** The body, or null past the cap. Past it the rest is read and dropped (up to a limit), so the client sees the 413. */
async function readCapped(request: Request): Promise<Buffer | null> {
  if (request.body === null) return Buffer.alloc(0);
  const reader: ReadableStreamDefaultReader<Uint8Array> = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    size += chunk.value.length;
    if (size > BODY_MAX) {
      over = true;
      chunks.length = 0;
    } else if (!over) chunks.push(chunk.value);
    if (size > 2 * BODY_MAX) {
      await reader.cancel().catch(() => undefined);
      break;
    }
  }
  return over ? null : Buffer.concat(chunks);
}

function signedBy(secret: string, body: Buffer, header: string | null): boolean {
  const given = SIGNATURE.exec(header ?? "")?.[1];
  if (given === undefined) return false;
  const expected = createHmac("sha256", secret).update(body).digest();
  const actual = Buffer.from(given, "hex");
  // timingSafeEqual throws on unequal lengths; the regex guarantees 32 bytes, this keeps the guard explicit.
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

async function errorCode(response: Response): Promise<string> {
  try {
    const parsed = (await response.json()) as { error?: { code?: unknown } };
    return typeof parsed.error?.code === "string" ? parsed.error.code : `http_${String(response.status)}`;
  } catch {
    return `http_${String(response.status)}`;
  }
}

export function githubHook(options: GithubHookOptions): (request: Request) => Promise<Response> {
  const { secret, triggers, postTask, log } = options;
  return async (request) => {
    if (request.method !== "POST") return reply(405, { error: "method not allowed" }, { allow: "POST" });
    const body = await readCapped(request);
    if (body === null) return reply(413, { error: "body too large" });
    // Nothing in the body is parsed or logged before the signature checks out.
    if (!signedBy(secret, body, request.headers.get("x-hub-signature-256")))
      return reply(401, { error: "bad signature" });
    const event = request.headers.get("x-github-event");
    const delivery = request.headers.get("x-github-delivery");
    if (event === null || event === "" || delivery === null || !DELIVERY.test(delivery))
      return reply(400, { error: "missing or malformed X-GitHub-Event or X-GitHub-Delivery" });
    if (event === "ping") return reply(200, { ok: true });
    let payload: unknown;
    try {
      payload = JSON.parse(body.toString("utf8"));
    } catch {
      return reply(400, { error: "body is not JSON" });
    }
    if (typeof payload !== "object" || payload === null || Array.isArray(payload))
      return reply(400, { error: "body is not a JSON object" });

    const repo = (payload as { repository?: { full_name?: unknown } }).repository?.full_name;
    const where = { delivery, githubEvent: event, repo: typeof repo === "string" ? repo : null };
    const tasks: { trigger: string; id: string }[] = [];
    const rejected: { trigger: string; error: string }[] = [];
    let boardFailed = false;
    for (const trigger of triggers) {
      if (!matches(trigger, event, payload)) continue;
      const task = render(trigger, event, payload);
      if (!task.ok) {
        rejected.push({ trigger: trigger.name, error: "template" });
        log({ level: "warn", event: "github.trigger.failed", trigger: trigger.name, ...where, error: task.error });
        continue;
      }
      try {
        const response = await postTask(
          JSON.stringify({
            channel: task.channel,
            text: task.text,
            labels: task.labels,
            id: `github:${delivery}:${trigger.name}`,
          }),
        );
        if (!response.ok) {
          const code = await errorCode(response);
          boardFailed = true;
          rejected.push({ trigger: trigger.name, error: code });
          log({ level: "error", event: "github.trigger.failed", trigger: trigger.name, ...where, error: code });
          continue;
        }
        const id = ((await response.json()) as { task?: { id?: unknown } }).task?.id;
        if (typeof id !== "string") throw new Error("no task in the board's answer");
        tasks.push({ trigger: trigger.name, id });
        log({ level: "info", event: "github.trigger.created", trigger: trigger.name, ...where, task: id });
      } catch (error) {
        boardFailed = true;
        rejected.push({ trigger: trigger.name, error: "board_unreachable" });
        log({
          level: "error",
          event: "github.trigger.failed",
          trigger: trigger.name,
          ...where,
          error: error instanceof Error ? error.message : "board request failed",
        });
      }
    }
    // The board failing outranks a template error: only it is worth a manual redelivery.
    if (boardFailed) return reply(502, { tasks, failed: rejected });
    if (rejected.length > 0) return reply(422, { tasks, failed: rejected });
    return reply(200, { tasks });
  };
}
