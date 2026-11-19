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

export interface Backend {
  readonly name: string;
  /** Starts a run for a claimed task and returns its run id. */
  start(task: RunTask, signal: AbortSignal): Promise<string>;
  /**
   * A run already started for this task, for re-attaching after a restart. `hint` is the run id found on the thread; it
   * is untrusted, so verify it belongs to this task. Null when there is none.
   */
  find(task: RunTask, hint: string | null): Promise<string | null>;
  /** Follows a run. Returns on progress or when it ended; rejects when `signal` aborts. */
  wait(runId: string, signal: AbortSignal): Promise<RunUpdate>;
  /** Stops a run. Idempotent. */
  cancel(runId: string): Promise<void>;
}
