// The only module that imports `@vercel/board` (ADR 0002). It speaks in the plan's terms (claim, run label) and keeps
// the SDK's shapes, and its handling of secrets, in one place.
import { board as createSdkBoard } from "@vercel/board";
import type { Board as SdkBoard, ClaimedTask, HeldTask, MessageView } from "@vercel/board";

export type Task = {
  id: string;
  channel: string;
  text: string;
  labels: Record<string, string>;
  /** Principal ID of the task's owner. */
  owner: string;
};

export type ClaimProof = { epoch: number; token: string };

/**
 * A fenced hold on a task. Every write fails with a claim-over error (see `isClaimOver`) once the lease has run out or
 * the task moved on. The token is a getter on the prototype, so logging or serialising a Claim never shows it.
 */
export class Claim {
  readonly taskId: string;
  readonly epoch: number;
  readonly task: Task;
  until: Date;
  readonly #token: string;
  readonly #held: HeldTask;

  constructor(task: Task, proof: ClaimProof, until: Date, held: HeldTask) {
    this.taskId = task.id;
    this.task = task;
    this.epoch = proof.epoch;
    this.#token = proof.token;
    this.until = until;
    this.#held = held;
  }

  get token(): string {
    return this.#token;
  }

  /** Extends the lease from now; `until` follows the board's answer. */
  async renew(leaseSeconds: number): Promise<void> {
    const renewed = await this.#held.renew(leaseSeconds);
    this.until = new Date(renewed.until);
  }

  async release(): Promise<void> {
    await this.#held.release();
  }

  async complete(result: string): Promise<void> {
    await this.#held.complete(result);
  }

  async fail(reason: string): Promise<void> {
    await this.#held.fail(reason);
  }

  toJSON(): { taskId: string; epoch: number; until: string } {
    return { taskId: this.taskId, epoch: this.epoch, until: this.until.toISOString() };
  }
}

export type ClaimRequest = {
  channel: string;
  labels: Record<string, string>;
  /** Owner principal IDs (not handles). */
  from: readonly string[];
  waitSeconds: number;
  leaseSeconds: number;
};

export type Board = {
  /** Long-polls for the oldest ready task the route matches; null when none came, or when `signal` aborted. */
  claim(request: ClaimRequest, signal: AbortSignal): Promise<Claim | null>;
  /** Re-creates a claim from stored proof, as a restarted worker does. Its `until` is unknown until the first renew. */
  held(taskId: string, proof: ClaimProof): Promise<Claim>;
  /** Replies on the task's thread and returns the new message's id. */
  reply(taskId: string, text: string, labels?: Record<string, string>): Promise<string>;
  label(messageId: string, labels: Record<string, string>): Promise<void>;
  /** Labels of every message in the thread, root first. */
  threadLabels(taskId: string): Promise<Record<string, string>[]>;
  /** Latest value of a label in the thread (replies win over the root), or null. */
  findLabel(taskId: string, key: string): Promise<string | null>;
};

export type BoardConnection = { url: string; token: string; profile: string };

/** The page size for reading a thread: the most the board allows, so a long thread costs few round trips. */
const THREAD_PAGE = 500;

// @vercel/board 0.52.0 exports no client constructor and no http() backend (ADR 0002). The only public way to reach a
// remote board is `board()`, which reads BOARD_URL when it is created and BOARD_TOKEN at its first request (then caches
// the token for about five minutes). So, under a mutex, we set both from the validated route, create the handle, force
// that first request, and put the previous values back; two handles for different boards can then live in one process
// (tests). In production the values equal the real environment, so nothing changes. The profile goes through `as()`,
// because BOARD_PROFILE at creation does not take effect.
let envLock: Promise<unknown> = Promise.resolve();

export function connectBoard(connection: BoardConnection): Promise<Board> {
  const result = envLock.then(() => connectLocked(connection));
  envLock = result.catch(() => undefined);
  return result;
}

async function connectLocked(connection: BoardConnection): Promise<Board> {
  const previous = { url: process.env["BOARD_URL"], token: process.env["BOARD_TOKEN"] };
  process.env["BOARD_URL"] = connection.url;
  process.env["BOARD_TOKEN"] = connection.token;
  try {
    const sdk: SdkBoard = createSdkBoard().as(connection.profile);
    await sdk.me();
    return new SdkBoardAdapter(sdk);
  } finally {
    restore("BOARD_URL", previous.url);
    restore("BOARD_TOKEN", previous.token);
  }
}

function restore(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function toTask(message: MessageView): Task {
  return {
    id: message.id,
    channel: message.channel,
    text: message.text,
    labels: { ...message.labels },
    owner: message.task?.owner ?? "",
  };
}

function toClaim(claimed: ClaimedTask): Claim {
  return new Claim(
    toTask(claimed.task),
    { epoch: claimed.epoch, token: claimed.token },
    new Date(claimed.until),
    claimed,
  );
}

class SdkBoardAdapter implements Board {
  readonly #sdk: SdkBoard;

  constructor(sdk: SdkBoard) {
    this.#sdk = sdk;
  }

  async claim(request: ClaimRequest, signal: AbortSignal): Promise<Claim | null> {
    try {
      const claimed = await this.#sdk.tasks.claim(
        {
          channel: request.channel,
          label: request.labels,
          from: [...request.from],
          wait: request.waitSeconds,
          lease: request.leaseSeconds,
        },
        { signal },
      );
      return claimed === null ? null : toClaim(claimed);
    } catch (error) {
      // An aborted long-poll is a normal end of the loop, not a failure.
      if (signal.aborted) return null;
      throw error;
    }
  }

  async held(taskId: string, proof: ClaimProof): Promise<Claim> {
    const held = this.#sdk.tasks.held(taskId, proof);
    const thread = await this.#sdk.thread(taskId, { limit: 1 });
    return new Claim(toTask(thread.message), proof, new Date(0), held);
  }

  async reply(taskId: string, text: string, labels?: Record<string, string>): Promise<string> {
    const written = await this.#sdk.reply(taskId, labels === undefined ? { text } : { text, labels });
    return written.id;
  }

  async label(messageId: string, labels: Record<string, string>): Promise<void> {
    await this.#sdk.label(messageId, { set: labels });
  }

  async threadLabels(taskId: string): Promise<Record<string, string>[]> {
    // Without `after` the board answers the newest replies, so page forward from the root to see them all, oldest first.
    const root = (await this.#sdk.thread(taskId, { limit: 1 })).message;
    const all: Record<string, string>[] = [{ ...root.labels }];
    let after = root.id;
    for (;;) {
      const page = await this.#sdk.thread(taskId, { after, limit: THREAD_PAGE });
      for (const reply of page.replies) all.push({ ...reply.labels });
      const last = page.replies.at(-1);
      if (page.replies.length < THREAD_PAGE || last === undefined) return all;
      after = last.id;
    }
  }

  async findLabel(taskId: string, key: string): Promise<string | null> {
    const all = await this.threadLabels(taskId);
    // Replies win over the root, and later replies over earlier ones.
    for (const labels of [...all.slice(1).reverse(), all[0] ?? {}]) {
      const value = labels[key];
      if (value !== undefined) return value;
    }
    return null;
  }
}

type ErrorFacts = { code: string | undefined; status: number | undefined; name: string | undefined };

function facts(error: unknown): ErrorFacts {
  if (typeof error !== "object" || error === null) return { code: undefined, status: undefined, name: undefined };
  const record = error as { code?: unknown; status?: unknown; name?: unknown };
  return {
    code: typeof record.code === "string" ? record.code : undefined,
    status: typeof record.status === "number" ? record.status : undefined,
    name: typeof record.name === "string" ? record.name : undefined,
  };
}

/** The board says the claim is over: its lease ran out, or the task was released, canceled or settled. */
export function isClaimOver(error: unknown): boolean {
  const { code } = facts(error);
  return code === "claim_lost" || code === "task_finished";
}

/** The board did not answer usefully: no connection, a 5xx, or a 429. Safe to retry. */
export function isUnreachable(error: unknown): boolean {
  if (isClaimOver(error)) return false;
  const { code, status, name } = facts(error);
  if (name === "AbortError") return false;
  if (code === "unreachable") return true;
  if (status !== undefined) return status === 0 || status === 429 || status >= 500;
  // fetch itself failed (connection refused, reset, DNS): a TypeError with no status.
  return error instanceof Error;
}
