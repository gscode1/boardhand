import type { Backend } from "./backend.js";
import { FakeBackend, parseFakeOptions } from "./fake.js";

/** Builds the backend a route names. Options are the route's untyped JSON; each backend validates its own. */
export function createBackend(name: string, options: Record<string, unknown>): Backend {
  switch (name) {
    case "fake":
      return new FakeBackend(parseFakeOptions(options));
    default:
      throw new Error(`unknown backend "${name}"`);
  }
}
