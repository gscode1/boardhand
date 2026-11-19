// The alert for a task no route matches: ready for too long. It logs one warning line per stale task on every check, so
// a log alert or `kubectl logs | grep task.stale` finds it. The board itself does not know which routes exist.
import type { Board } from "@vercel/board";

export type Log = (entry: { level: "info" | "warn" | "error"; event: string } & Record<string, unknown>) => void;

export type StaleOptions = {
  checkMs: number;
  afterMs: number;
  now?: () => number;
};

const PAGE = 50;
/** More than this many pages (2500 ready tasks) is already a different problem; the check stops there. */
const MAX_PAGES = 50;

/** Logs `task.stale` for every ready task older than `afterMs`; returns how many it found. */
export async function checkStale(
  team: Board,
  afterMs: number,
  log: Log,
  now: () => number = Date.now,
): Promise<number> {
  let stale = 0;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await team.tasks.list({ state: "ready", limit: PAGE, ...(after === undefined ? {} : { after }) });
    for (const { message } of result.tasks) {
      const ageMs = now() - Date.parse(message.createdAt);
      if (ageMs < afterMs) continue;
      stale++;
      log({
        level: "warn",
        event: "task.stale",
        task: message.id,
        channel: message.channel,
        labels: message.labels,
        ageSeconds: Math.round(ageMs / 1000),
      });
    }
    if (result.tasks.length < PAGE) break;
    after = result.cursor;
  }
  return stale;
}

/** Runs `checkStale` every `checkMs` until stopped. A failed check is logged and does not stop the timer. */
export function startStaleCheck(team: Board, options: StaleOptions, log: Log): { stop(): void } {
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    checkStale(team, options.afterMs, log, options.now)
      .catch((error: unknown) => {
        log({
          level: "error",
          event: "stale.check_error",
          error: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        running = false;
      });
  }, options.checkMs);
  timer.unref();
  return {
    stop: () => {
      clearInterval(timer);
    },
  };
}
