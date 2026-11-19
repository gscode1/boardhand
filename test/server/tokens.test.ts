import { describe, expect, it } from "vitest";
import { createAuth, parseTokens, principalId, TokensError } from "../../server/auth.js";

const A = "a".repeat(32);
const B = "b".repeat(32);

describe("parseTokens", () => {
  it("reads people and workers, skipping comments and blank lines", { timeout: 5_000 }, () => {
    const entries = parseTokens(`# who\n\ngs:person:${A}\ndev:worker:${B}:dev,review/\n`);
    expect(entries).toEqual([
      { name: "gs", kind: "person", token: A, channels: [] },
      { name: "dev", kind: "worker", token: B, channels: ["dev", "review/"] },
    ]);
    expect(entries.map(principalId)).toEqual(["boardhand:person:gs", "boardhand:worker:dev"]);
  });

  const cases: [string, string, string][] = [
    ["a worker with no channels", `dev:worker:${A}`, "needs channels"],
    ["a person with channels", `gs:person:${A}:dev`, "takes no channels"],
    ["an unknown kind", `gs:admin:${A}`, "kind must be"],
    ["a short token", "gs:person:short", "token must be"],
    ["a bad name", `Gs:person:${A}`, "name must"],
    ["a wildcard channel", `dev:worker:${A}:dev/*`, "not a channel"],
    ["a missing field", "gs:person", "expected name:kind:token"],
    ["a repeated name", `gs:person:${A}\ngs:person:${B}`, "used twice"],
    ["a repeated token", `gs:person:${A}\nme:person:${A}`, "token is used twice"],
    ["an empty file", "# nothing\n", "no tokens"],
  ];
  for (const [name, text, message] of cases) {
    it(`rejects ${name} without echoing the token`, { timeout: 5_000 }, () => {
      let error: unknown;
      try {
        parseTokens(text);
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TokensError);
      const shown = (error as TokensError).message;
      expect(shown).toContain(message);
      expect(shown).not.toContain(A);
      expect(shown).not.toContain(B);
    });
  }
});

describe("createAuth", () => {
  const auth = createAuth(parseTokens(`gs:person:${A}\ndev:worker:${B}:dev,review/`));

  it("finds an entry by token and nothing for others", { timeout: 5_000 }, () => {
    expect(auth.lookup(A)?.name).toBe("gs");
    expect(auth.lookup(B)?.name).toBe("dev");
    expect(auth.lookup(`${A}x`)).toBeUndefined();
    expect(auth.lookup("")).toBeUndefined();
    expect(auth.lookup(null)).toBeUndefined();
  });

  it("scopes a worker to its channels and leaves a person alone", { timeout: 5_000 }, () => {
    expect(auth.scopeFor(B)).toBe("dev=read,post,label;review/=read,post,label");
    expect(auth.scopeFor(A)).toBeUndefined();
    expect(auth.scopeFor(null)).toBeUndefined();
  });

  it("refuses a worker whose request lacks the scope forced for its own token", { timeout: 5_000 }, async () => {
    const ask = (credential: string, can: string | null): unknown => {
      const headers = new Headers(can === null ? {} : { "x-board-can": can });
      return auth.authenticate({ credential, headers, claims: {}, audience: "x" } as never);
    };
    const scope = "dev=read,post,label;review/=read,post,label";
    await expect(Promise.resolve().then(() => ask(B, null))).rejects.toMatchObject({ status: 403 });
    await expect(Promise.resolve().then(() => ask(B, "all"))).rejects.toMatchObject({ status: 403 });
    expect(ask(B, scope)).toMatchObject({ id: "boardhand:worker:dev" });
    expect(ask(A, null)).toMatchObject({ id: "boardhand:person:gs" });
  });
});
