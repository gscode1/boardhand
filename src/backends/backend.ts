// The interface between the worker and an agent platform (ADR 0003). A backend knows nothing of the board: it must not
// import `src/board.ts` or `@vercel/board`; the worker turns updates into replies and settles the task.

export type RunTask = {
  id: string;
  channel: string;
  text: string;
  labels: Record<string, string>;
};

export type RunUpdate =
  { kind: "progress"; text: string } | { kind: "succeeded"; result: string } | { kind: "failed"; reason: string };

/**
 * `start` or `find` could not reach the platform, or the platform said to try again later (a network error, a timeout,
 * 429, 5xx). Nothing was started, so the worker hands the task back and backs off instead of failing it (ADR 0003).
 */
export class BackendUnavailableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "BackendUnavailableError";
  }
}

export interface Backend {
  readonly name: string;
  /** Starts a run for a claimed task and returns its run id. Throws `BackendUnavailableError` when it may be retried. */
  start(task: RunTask, signal: AbortSignal): Promise<string>;
  /**
   * A run already started for this task, for re-attaching after a restart. `hint` is the run id found on the thread; it
   * is untrusted, so verify it belongs to this task. Null when there is none. Throws
   * `BackendUnavailableError` when the platform cannot be asked, since starting blindly could create a second run.
   */
  find(task: RunTask, hint: string | null): Promise<string | null>;
  /** Follows a run. Returns on progress or when it ended; rejects when `signal` aborts. */
  wait(runId: string, signal: AbortSignal): Promise<RunUpdate>;
  /** Stops a run. Idempotent. */
  cancel(runId: string): Promise<void>;
}
