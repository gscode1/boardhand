import type { Backend } from "./backend.js";
import { FakeBackend, parseFakeOptions } from "./fake.js";
import { PiBackend, parsePiOptions, piTokenFrom } from "./pi.js";

/**
 * Builds the backend a route names. Options are the route's untyped JSON; each backend validates its own. Secrets come
 * from `env` only (`PI_TOKEN` for pi), never from the options.
 */
export function createBackend(
  name: string,
  options: Record<string, unknown>,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Backend {
  switch (name) {
    case "fake":
      return new FakeBackend(parseFakeOptions(options));
    case "pi": {
      const parsed = parsePiOptions(options);
      const token = piTokenFrom(env);
      if (token === undefined) throw new Error("PI_TOKEN is required for the pi backend");
      return new PiBackend(parsed, token);
    }
    default:
      throw new Error(`unknown backend "${name}"`);
  }
}
