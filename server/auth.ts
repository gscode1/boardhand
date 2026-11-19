// Who may call the board. Tokens come from a file mounted from a Secret; nothing here is ever logged.
import { createHash, timingSafeEqual } from "node:crypto";
import { HttpError } from "@vercel/board";
import type { Authenticate } from "@vercel/board/access";

export type TokenKind = "person" | "worker";

export type TokenEntry = {
  /** Lowercase name; it is also the handle on the board and the last part of the principal ID. */
  name: string;
  kind: TokenKind;
  /** Secret. */
  token: string;
  /** Channel patterns a worker is limited to (`dev` is one channel, `dev/` a subtree). Empty for a person. */
  channels: readonly string[];
};

export class TokensError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid tokens file:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "TokensError";
    this.problems = problems;
  }
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
// No colon (it separates fields) and no comma; long enough that a guess is hopeless.
const TOKEN = /^[A-Za-z0-9._~+/=-]{24,256}$/;
// A channel is one name, or `name/` for it and everything below. Nothing else (the engine rejects other `*` forms).
const CHANNEL = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*\/?$/;

/** What a worker may do in its channels: claim and settle (label), reply (post) and read. Never manage or sync. */
const WORKER_PERMISSIONS = "read,post,label";

/**
 * Parses `name:kind:token[:channels]` lines. A worker needs `channels` (comma separated); a person takes none. Blank
 * lines and lines starting with `#` are skipped. Every problem is reported, naming the line but never the token.
 */
export function parseTokens(text: string): TokenEntry[] {
  const problems: string[] = [];
  const entries: TokenEntry[] = [];
  const names = new Set<string>();
  const tokens = new Set<string>();
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) return;
    const where = `line ${String(index + 1)}`;
    const parts = line.split(":");
    const [name = "", kind = "", token = "", channelList] = parts;
    if (parts.length < 3 || parts.length > 4) {
      problems.push(`${where}: expected name:kind:token[:channels]`);
      return;
    }
    const before = problems.length;
    const bad = (message: string): void => {
      problems.push(`${where}: ${message}`);
    };
    if (!NAME.test(name))
      bad("name must start with a lowercase letter and use up to 32 lowercase letters, digits and hyphens");
    if (kind !== "person" && kind !== "worker") bad(`kind must be person or worker`);
    if (!TOKEN.test(token)) bad("token must be 24 to 256 characters from A-Z a-z 0-9 . _ ~ + / = -");
    if (names.has(name)) bad(`name "${name}" is used twice`);
    if (tokens.has(token)) bad("token is used twice");
    const channels = (channelList ?? "")
      .split(",")
      .map((c) => c.trim())
      .filter((c) => c !== "");
    if (kind === "worker" && channels.length === 0) bad("a worker needs channels, so it is never unrestricted");
    if (kind === "person" && parts.length === 4) bad("a person takes no channels");
    for (const channel of channels)
      if (!CHANNEL.test(channel)) bad(`channel "${channel}" is not a channel or channel/`);
    names.add(name);
    tokens.add(token);
    if (problems.length === before) entries.push({ name, kind: kind as TokenKind, token, channels });
  });
  if (entries.length === 0 && problems.length === 0) problems.push("no tokens");
  if (problems.length > 0) throw new TokensError(problems);
  return entries;
}

export function principalId(entry: Pick<TokenEntry, "name" | "kind">): string {
  return `boardhand:${entry.kind}:${entry.name}`;
}

const digest = (value: string): Buffer => createHash("sha256").update(value).digest();

export type Auth = {
  /** The entry whose token equals `credential`, in constant time with respect to the stored tokens. */
  lookup(credential: string | null): TokenEntry | undefined;
  /** For `board({ authenticate })`: null without a credential, 401 for one that matches nothing. */
  authenticate: Authenticate;
  /**
   * The `x-board-can` value to force on a request with this credential, or undefined to leave the request alone. The
   * engine intersects it with what the principal may do, so it only narrows (docs 01-board/09-access.md).
   */
  scopeFor(credential: string | null): string | undefined;
};

export function createAuth(entries: readonly TokenEntry[]): Auth {
  const hashed = entries.map((entry) => ({ entry, hash: digest(entry.token) }));
  const lookup = (credential: string | null): TokenEntry | undefined => {
    if (credential === null) return undefined;
    const probe = digest(credential);
    let found: TokenEntry | undefined;
    // No early exit: the time taken does not depend on which entry, if any, matched.
    for (const { entry, hash } of hashed) if (timingSafeEqual(probe, hash)) found = entry;
    return found;
  };
  return {
    lookup,
    authenticate: (request) => {
      if (request.credential === null) return null;
      const entry = lookup(request.credential);
      if (entry === undefined) throw new HttpError(401, "unauthorized", "unknown token");
      return { id: principalId(entry), kind: "person", handle: entry.name };
    },
    scopeFor: (credential) => {
      const entry = lookup(credential);
      if (entry?.kind !== "worker") return undefined;
      return entry.channels.map((channel) => `${channel}=${WORKER_PERMISSIONS}`).join(";");
    },
  };
}

/** The bearer token of an `authorization` header value, or null. */
export function bearerOf(header: string | null | undefined): string | null {
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}
