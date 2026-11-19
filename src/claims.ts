// The claim store (ADR 0004, option b): where a restarted worker finds the proof of claims it still holds, so it can
// act on them with `board.held` and re-attach to the run instead of starting a second one. It holds claim tokens, so
// files are private (0600 in a 0700 directory) and the token is never logged.
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { writeFileAtomic } from "./atomic.js";

export type StoredClaim = {
  taskId: string;
  epoch: number;
  token: string;
  /** Set once the run is known; a claim without one has no run to re-attach to yet. */
  runId?: string;
};

/** With no state dir (`null`) the store does nothing: a restart relies on the thread's run label instead. */
export class ClaimStore {
  readonly #dir: string | null;

  constructor(dir: string | null) {
    this.#dir = dir;
  }

  async put(claim: StoredClaim): Promise<void> {
    if (this.#dir === null) return;
    await mkdir(this.#dir, { recursive: true, mode: 0o700 });
    await writeFileAtomic(this.#path(this.#dir, claim.taskId), JSON.stringify(claim), 0o600);
  }

  async remove(taskId: string): Promise<void> {
    if (this.#dir === null) return;
    await rm(this.#path(this.#dir, taskId), { force: true });
  }

  async list(): Promise<StoredClaim[]> {
    if (this.#dir === null) return [];
    let names: string[];
    try {
      names = await readdir(this.#dir);
    } catch {
      return [];
    }
    const dir = this.#dir;
    const claims: StoredClaim[] = [];
    for (const name of names.filter((n) => n.endsWith(".json"))) {
      const claim = parseStoredClaim(await readFile(join(dir, name), "utf8").catch(() => ""));
      if (claim !== null) claims.push(claim);
    }
    return claims;
  }

  // The task id is untrusted text from the board; hashing keeps it out of the file system's namespace.
  #path(dir: string, taskId: string): string {
    return join(dir, `${createHash("sha256").update(taskId).digest("hex")}.json`);
  }
}

function parseStoredClaim(text: string): StoredClaim | null {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== "object" || value === null) return null;
    const { taskId, epoch, token, runId } = value as Record<string, unknown>;
    if (typeof taskId !== "string" || typeof epoch !== "number" || typeof token !== "string") return null;
    return typeof runId === "string" ? { taskId, epoch, token, runId } : { taskId, epoch, token };
  } catch {
    // a corrupt file is the same as no file: the worker falls back to the thread's label
    return null;
  }
}
