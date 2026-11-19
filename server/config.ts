// The board server's configuration, read once from the environment. Like the worker's route, every problem is reported
// at once so a bad deployment fails at start.
export type ServerConfig = {
  port: number;
  dataDir: string;
  publicUrl: string;
  tokensFile: string;
  /** 0 turns the stale-task check off. */
  staleCheckSeconds: number;
  staleAfterSeconds: number;
};

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid configuration:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "ConfigError";
    this.problems = problems;
  }
}

type Env = Readonly<Record<string, string | undefined>>;

export function loadConfig(env: Env = process.env): ServerConfig {
  const problems: string[] = [];
  const text = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === undefined || value === "" ? undefined : value;
  };
  const required = (name: string): string => {
    const value = text(name);
    if (value === undefined) problems.push(`${name} is required`);
    return value ?? "";
  };
  const integer = (name: string, fallback: number, min: number, max: number): number => {
    const raw = text(name);
    if (raw === undefined) return fallback;
    if (!/^\d+$/.test(raw) || Number(raw) < min || Number(raw) > max) {
      problems.push(`${name} must be an integer from ${String(min)} to ${String(max)}`);
      return fallback;
    }
    return Number(raw);
  };
  const dataDir = required("BOARD_DATA_DIR");
  const tokensFile = required("BOARD_TOKENS_FILE");
  const publicUrl = required("BOARD_PUBLIC_URL").replace(/\/+$/, "");
  if (publicUrl !== "" && !isHttpUrl(publicUrl)) problems.push("BOARD_PUBLIC_URL must be an http or https URL");
  const port = integer("PORT", 8080, 0, 65535);
  const staleCheckSeconds = integer("BOARD_STALE_CHECK_SECONDS", 60, 0, 86_400);
  const staleAfterSeconds = integer("BOARD_STALE_AFTER_SECONDS", 900, 1, 31_536_000);
  if (problems.length > 0) throw new ConfigError(problems);
  return { port, dataDir, publicUrl, tokensFile, staleCheckSeconds, staleAfterSeconds };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}
