// Retry timing shared by the worker loops and the entrypoint: exponential delays with jitter, and an abortable sleep.

export type BackoffOptions = { baseMs: number; maxMs: number };

export class Backoff {
  readonly #options: BackoffOptions;
  readonly #random: () => number;
  #attempt = 0;

  constructor(options: BackoffOptions, random: () => number) {
    this.#options = options;
    this.#random = random;
  }

  /** Exponential, with jitter between half and all of the step so workers do not retry in lockstep. */
  next(): number {
    const step = Math.min(this.#options.maxMs, this.#options.baseMs * 2 ** Math.min(this.#attempt, 30));
    this.#attempt += 1;
    return step / 2 + (this.#random() * step) / 2;
  }

  reset(): void {
    this.#attempt = 0;
  }
}

/** Resolves true after `ms`, or false as soon as `signal` aborts. */
export function sleep(ms: number, signal: AbortSignal | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    if (signal?.aborted === true) {
      resolve(false);
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve(true);
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
