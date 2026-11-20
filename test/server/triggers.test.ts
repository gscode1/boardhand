import { describe, expect, it } from "vitest";
import { matches, parseTriggers, render, TEXT_MAX, TriggersError, type Trigger } from "../../server/triggers.js";

const base = {
  name: "renovate",
  repos: ["acme/*"],
  event: "pull_request",
  actions: ["opened"],
  when: { "pull_request.user.login": ["renovate[bot]"] },
  channel: "agents/deps".replace("/", "-"),
  labels: { kind: "renovate" },
  text: "Check {{pull_request.html_url}}",
};
const file = (...triggers: Record<string, unknown>[]): string => JSON.stringify({ triggers });
const trig = (over: Record<string, unknown> = {}): Trigger => {
  const [t] = parseTriggers(file({ ...base, ...over }));
  if (!t) throw new Error("no trigger");
  return t;
};
const problemsOf = (text: string): readonly string[] => {
  try {
    parseTriggers(text);
  } catch (error) {
    if (error instanceof TriggersError) return error.problems;
    throw error;
  }
  throw new Error("expected a TriggersError");
};

const pr = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  action: "opened",
  repository: { full_name: "Acme/Web" },
  pull_request: {
    user: { login: "renovate[bot]" },
    html_url: "https://github.com/acme/web/pull/1",
    title: "Bump x",
    head: { ref: "renovate/x", repo: { full_name: "acme/web" } },
    labels: [{ name: "a" }, { name: "deps" }],
  },
  ...over,
});

describe("parseTriggers", () => {
  it("reads a valid file", { timeout: 5_000 }, () => {
    expect(trig()).toMatchObject({ name: "renovate", repos: ["acme/*"], channel: "agents-deps" });
  });

  it("reports every problem at once", { timeout: 5_000 }, () => {
    const problems = problemsOf(
      file(
        { ...base, name: "Bad Name", repos: ["nope"], labels: { "Bad Key": "x" } },
        { ...base, name: "ok", when: { "pull_request.title": ["x"] }, channel: "a/" },
      ),
    );
    expect(problems.length).toBeGreaterThanOrEqual(4);
    const shown = problems.join("\n");
    expect(shown).toContain("name must");
    expect(shown).toContain("not owner/name");
    expect(shown).toContain("label key");
    expect(shown).toContain("who caused");
    expect(shown).toContain("not a subtree");
  });

  it("accepts a nested channel name and refuses a subtree", { timeout: 5_000 }, () => {
    expect(parseTriggers(JSON.stringify({ triggers: [{ ...base, channel: "agents/renovate" }] }))[0]?.channel).toBe(
      "agents/renovate",
    );
    expect(problemsOf(file({ ...base, channel: "agents/" })).join("\n")).toContain("not a subtree");
    expect(problemsOf(file({ ...base, channel: "agents//x" })).join("\n")).toContain("not a subtree");
  });

  it("rejects duplicate names", { timeout: 5_000 }, () => {
    expect(problemsOf(file(base, base)).join()).toContain("used twice");
  });

  it("requires a who-gate, and sender.type is not one", { timeout: 5_000 }, () => {
    expect(problemsOf(file({ ...base, when: { "pull_request.title": ["x"] } })).join()).toContain("who caused");
    expect(problemsOf(file({ ...base, when: { "sender.type": ["User"] } })).join()).toContain("who caused");
    for (const path of [
      "sender.login",
      "sender.id",
      "issue.user.login",
      "comment.user.id",
      "comment.author_association",
    ])
      expect(() => parseTriggers(file({ ...base, when: { [path]: ["x"] } }))).not.toThrow();
  });

  it("rejects bad repos, labels and derived-key labels", { timeout: 5_000 }, () => {
    expect(problemsOf(file({ ...base, repos: [] })).join()).toContain("repos must");
    expect(problemsOf(file({ ...base, repos: ["a/b/c"] })).join()).toContain("not owner/name");
    expect(problemsOf(file({ ...base, labels: { k: "a\nb" } })).join()).toContain("control");
    expect(problemsOf(file({ ...base, labels: { k: "x".repeat(257) } })).join()).toContain("256");
    for (const key of ["repo", "branch", "github.event"])
      expect(problemsOf(file({ ...base, labels: { [key]: "x" } })).join()).toContain("set by the server");
  });

  it("rejects bad JSON, empty lists and bad templates", { timeout: 5_000 }, () => {
    expect(problemsOf("{")).toEqual(["not valid JSON"]);
    expect(problemsOf(file())).toEqual(["no triggers"]);
    expect(problemsOf(file({ ...base, text: "{{a b}}" })).join()).toContain("placeholder");
  });
});

describe("matches", () => {
  it("matches event, action, repo and when", { timeout: 5_000 }, () => {
    expect(matches(trig(), "pull_request", pr())).toBe(true);
    expect(matches(trig(), "issues", pr())).toBe(false);
    expect(matches(trig(), "pull_request", pr({ action: "closed" }))).toBe(false);
    expect(matches(trig(), "pull_request", pr({ repository: { full_name: "other/web" } }))).toBe(false);
  });

  it("takes any action when actions is absent, even none", { timeout: 5_000 }, () => {
    const t = trig({ actions: undefined });
    const noAction = pr({ action: undefined });
    expect(matches(t, "pull_request", noAction)).toBe(true);
    expect(matches(trig(), "pull_request", noAction)).toBe(false);
  });

  it("matches repos exactly or by owner glob, ignoring case", { timeout: 5_000 }, () => {
    expect(matches(trig({ repos: ["ACME/web"] }), "pull_request", pr())).toBe(true);
    expect(matches(trig({ repos: ["acme/api"] }), "pull_request", pr())).toBe(false);
    expect(matches(trig({ repos: ["acme/*"] }), "pull_request", pr({ repository: { full_name: "acmex/web" } }))).toBe(
      false,
    );
    expect(matches(trig(), "pull_request", pr({ repository: undefined }))).toBe(false);
  });

  it("matches any element of an array segment, and a missing path never", { timeout: 5_000 }, () => {
    const t = trig({ when: { "sender.login": ["u"], "pull_request.labels[].name": ["deps"] } });
    expect(matches(t, "pull_request", pr({ sender: { login: "u" } }))).toBe(true);
    expect(matches(t, "pull_request", pr({ sender: { login: "v" } }))).toBe(false);
    expect(matches(t, "pull_request", pr())).toBe(false);
    expect(
      matches(
        trig({ when: { "sender.login": ["u"], "pull_request.labels[].name": ["zzz"] } }),
        "pull_request",
        pr({ sender: { login: "u" } }),
      ),
    ).toBe(false);
  });

  it("compares exactly across types, including null", { timeout: 5_000 }, () => {
    const t = trig({ when: { "sender.id": [7], "pull_request.merged": [null] } });
    expect(matches(t, "pull_request", pr({ sender: { id: 7 }, pull_request: { merged: null } }))).toBe(true);
    expect(matches(t, "pull_request", pr({ sender: { id: "7" }, pull_request: { merged: null } }))).toBe(false);
  });
});

describe("render", () => {
  it("fills placeholders and derives labels", { timeout: 5_000 }, () => {
    const out = render(trig({ text: "{{pull_request.title}} / {{ pull_request.html_url }}" }), "pull_request", pr());
    expect(out).toEqual({
      ok: true,
      channel: "agents-deps",
      text: "Bump x / https://github.com/acme/web/pull/1",
      labels: { kind: "renovate", "github.event": "pull_request", repo: "Acme/Web", branch: "renovate/x" },
    });
  });

  it("sets branch only for a head in the same repository", { timeout: 5_000 }, () => {
    const fork = pr({
      pull_request: { head: { ref: "evil", repo: { full_name: "mallory/web" } }, html_url: "u" },
    });
    const out = render(trig(), "pull_request", fork);
    expect(out.ok && out.labels).not.toHaveProperty("branch");
    expect(out.ok && out.labels["repo"]).toBe("Acme/Web");
  });

  it("errors on a missing or non-scalar placeholder", { timeout: 5_000 }, () => {
    expect(render(trig({ text: "{{pull_request.nope}}" }), "pull_request", pr()).ok).toBe(false);
    const object = render(trig({ text: "{{pull_request.head}}" }), "pull_request", pr());
    expect(object.ok).toBe(false);
  });

  it("clips long text to 10 000 characters ending in an ellipsis", { timeout: 5_000 }, () => {
    const out = render(
      trig({ text: "{{pull_request.title}}" }),
      "pull_request",
      pr({ pull_request: { title: "x".repeat(20_000) } }),
    );
    expect(out.ok && out.text).toHaveLength(TEXT_MAX);
    expect(out.ok && out.text.endsWith("…")).toBe(true);
  });
});
