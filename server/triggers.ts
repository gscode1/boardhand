// GitHub triggers (ADR 0008): a JSON file says which webhook events become tasks. Everything here is pure, so the
// webhook handler stays small and the rules can be tested without a server.
import { readFile } from "node:fs/promises";

export type Scalar = string | number | boolean | null;

export type Trigger = {
  name: string;
  /** `owner/name` or `owner/*`, lowercase. */
  repos: readonly string[];
  event: string;
  /** Undefined: any action, and events that have none. */
  actions: readonly string[] | undefined;
  /** Dotted payload path to the values it may have. Every entry must hold. */
  when: Readonly<Record<string, readonly Scalar[]>>;
  channel: string;
  labels: Readonly<Record<string, string>>;
  text: string;
};

export class TriggersError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`invalid triggers file:\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
    this.name = "TriggersError";
    this.problems = problems;
  }
}

const NAME = /^[a-z][a-z0-9-]{0,31}$/;
const REPO = /^[A-Za-z0-9._-]+\/(?:[A-Za-z0-9._-]+|\*)$/;
const EVENT = /^[a-z][a-z_]*$/;
// One channel, not a subtree: the forced scope names exactly the channels triggers post to.
const CHANNEL = /^[a-z0-9][a-z0-9._-]*$/;
// The engine's label rules (docs 04-reference/03-http.md).
const LABEL_KEY = /^[a-z0-9][a-z0-9_.-]*$/;
const LABEL_VALUE_MAX = 256;
// A dotted path; a segment ending in `[]` is any element of an array.
const PATH = /^[A-Za-z0-9_-]+(?:\[\])?(?:\.[A-Za-z0-9_-]+(?:\[\])?)*$/;
const TEMPLATE_PATH = /^[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/;
const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;

/** Labels that only the server sets, from the event, so payload text cannot steer routing. */
export const DERIVED_LABELS = ["repo", "branch", "github.event"] as const;
export const TEXT_MAX = 10_000;

// eslint-disable-next-line no-control-regex -- control characters are exactly what is being refused
const CONTROL = /[\u0000-\u001f\u007f]/;
const hasControl = (value: string): boolean => CONTROL.test(value);
const validLabelValue = (value: string): boolean => value.length <= LABEL_VALUE_MAX && !hasControl(value);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

/** Whether a `when` path says who caused or wrote the event (the mandatory gate). */
const isWhoPath = (path: string): boolean =>
  path === "sender.login" ||
  path === "sender.id" ||
  path.endsWith(".user.login") ||
  path.endsWith(".user.id") ||
  path.endsWith(".author_association");

const FIELDS = new Set(["name", "repos", "event", "actions", "when", "channel", "labels", "text"]);

/** Parses and validates the triggers file. Every problem is reported at once. */
export function parseTriggers(text: string): Trigger[] {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    throw new TriggersError(["not valid JSON"]);
  }
  if (!isRecord(root) || !Array.isArray(root["triggers"]))
    throw new TriggersError(['expected an object with a "triggers" list']);
  const problems: string[] = [];
  const triggers: Trigger[] = [];
  const names = new Set<string>();
  root["triggers"].forEach((raw: unknown, index) => {
    const here = `triggers[${String(index)}]`;
    if (!isRecord(raw)) {
      problems.push(`${here}: must be an object`);
      return;
    }
    const label = typeof raw["name"] === "string" && NAME.test(raw["name"]) ? `trigger "${raw["name"]}"` : here;
    const bad = (message: string): void => {
      problems.push(`${label}: ${message}`);
    };
    for (const key of Object.keys(raw)) if (!FIELDS.has(key)) bad(`unknown field "${key}"`);

    const name = raw["name"];
    if (typeof name !== "string" || !NAME.test(name))
      bad("name must start with a lowercase letter and use up to 32 lowercase letters, digits and hyphens");
    else if (names.has(name)) bad(`name "${name}" is used twice`);
    else names.add(name);

    const repos = raw["repos"];
    const repoList: string[] = [];
    if (!Array.isArray(repos) || repos.length === 0) bad("repos must be a non-empty list");
    else
      for (const repo of repos as unknown[]) {
        if (typeof repo !== "string" || !REPO.test(repo))
          bad(`repo ${JSON.stringify(repo)} is not owner/name or owner/*`);
        else repoList.push(repo.toLowerCase());
      }

    const event = raw["event"];
    if (typeof event !== "string" || !EVENT.test(event)) bad("event must be a GitHub event name such as pull_request");

    let actions: string[] | undefined;
    if (raw["actions"] !== undefined) {
      const list = raw["actions"];
      if (!Array.isArray(list) || list.length === 0 || !list.every((a) => typeof a === "string" && a !== ""))
        bad("actions must be a non-empty list of action names, or left out");
      else actions = list as string[];
    }

    const when: Record<string, Scalar[]> = {};
    const rawWhen = raw["when"];
    if (!isRecord(rawWhen) || Object.keys(rawWhen).length === 0) bad("when is required and must name a payload path");
    else {
      for (const [path, accepted] of Object.entries(rawWhen)) {
        if (!PATH.test(path)) bad(`when path "${path}" is not a dotted payload path`);
        else if (!Array.isArray(accepted) || accepted.length === 0 || !accepted.every(isScalar))
          bad(`when "${path}" must be a non-empty list of strings, numbers, booleans or null`);
        else when[path] = accepted;
      }
      if (!Object.keys(rawWhen).some(isWhoPath))
        bad(
          "when must name who caused the event: sender.login, sender.id, or a path ending in .user.login, .user.id or .author_association",
        );
    }

    const channel = raw["channel"];
    if (typeof channel !== "string" || !CHANNEL.test(channel))
      bad("channel must be one board channel name, not a subtree");

    const labels: Record<string, string> = {};
    if (raw["labels"] !== undefined) {
      if (!isRecord(raw["labels"])) bad("labels must be an object of strings");
      else
        for (const [key, value] of Object.entries(raw["labels"])) {
          if (!LABEL_KEY.test(key) || key.length > 64)
            bad(`label key "${key}" must be up to 64 characters of a-z 0-9 _ . - starting with a letter or digit`);
          else if ((DERIVED_LABELS as readonly string[]).includes(key))
            bad(`label "${key}" is set by the server and cannot be a static label`);
          else if (typeof value !== "string" || !validLabelValue(value))
            bad(
              `label "${key}" must be a string of up to ${String(LABEL_VALUE_MAX)} characters with no control characters`,
            );
          else labels[key] = value;
        }
    }

    const body = raw["text"];
    if (typeof body !== "string" || body === "") bad("text is required");
    else
      for (const match of body.matchAll(PLACEHOLDER))
        if (!TEMPLATE_PATH.test((match[1] ?? "").trim()))
          bad(`text placeholder {{${match[1] ?? ""}}} is not a dotted payload path`);
    if (typeof body === "string" && body.replaceAll(PLACEHOLDER, "").includes("{{")) bad("text has an unclosed {{");

    if (
      typeof name === "string" &&
      typeof event === "string" &&
      typeof channel === "string" &&
      typeof body === "string" &&
      problems.every((p) => !p.startsWith(`${label}:`))
    )
      triggers.push({ name, repos: repoList, event, actions, when, channel, labels, text: body });
  });
  if (triggers.length === 0 && problems.length === 0) problems.push("no triggers");
  if (problems.length > 0) throw new TriggersError(problems);
  return triggers;
}

export async function loadTriggers(path: string): Promise<Trigger[]> {
  return parseTriggers(await readFile(path, "utf8"));
}

/** The distinct channels the triggers post to. */
export const channelsOf = (triggers: readonly Trigger[]): string[] => [...new Set(triggers.map((t) => t.channel))];

/** The values at a dotted path; `[]` fans out over an array. Missing anywhere along the way gives none. */
function valuesAt(payload: unknown, path: string): unknown[] {
  let current: unknown[] = [payload];
  for (const raw of path.split(".")) {
    const each = raw.endsWith("[]");
    const key = each ? raw.slice(0, -2) : raw;
    const next: unknown[] = [];
    for (const item of current) {
      if (!isRecord(item) || !Object.hasOwn(item, key)) continue;
      const value = item[key];
      if (!each) next.push(value);
      else if (Array.isArray(value)) next.push(...(value as unknown[]));
    }
    current = next;
  }
  return current;
}

const textAt = (payload: unknown, path: string): string | undefined => {
  const [value] = valuesAt(payload, path);
  return typeof value === "string" ? value : undefined;
};

function repoMatches(patterns: readonly string[], fullName: string | undefined): boolean {
  if (fullName === undefined) return false;
  const name = fullName.toLowerCase();
  return patterns.some((pattern) =>
    pattern.endsWith("/*")
      ? name.startsWith(pattern.slice(0, -1)) && name.length > pattern.length - 1
      : name === pattern,
  );
}

/** Whether the trigger takes this event: name, repository, action and every `when` condition. */
export function matches(trigger: Trigger, event: string, payload: unknown): boolean {
  if (trigger.event !== event) return false;
  if (!repoMatches(trigger.repos, textAt(payload, "repository.full_name"))) return false;
  if (trigger.actions !== undefined) {
    const action = textAt(payload, "action");
    if (action === undefined || !trigger.actions.includes(action)) return false;
  }
  return Object.entries(trigger.when).every(([path, accepted]) =>
    valuesAt(payload, path).some((value) => isScalar(value) && accepted.includes(value)),
  );
}

export type Rendered =
  { ok: true; channel: string; text: string; labels: Record<string, string> } | { ok: false; error: string };

/** The task a matched trigger makes: its text with the payload filled in, and its labels with the derived ones. */
export function render(trigger: Trigger, event: string, payload: unknown): Rendered {
  let failure: string | undefined;
  const filled = trigger.text.replaceAll(PLACEHOLDER, (_whole, raw: string) => {
    const path = raw.trim();
    const [value] = valuesAt(payload, path);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
    failure ??= `text placeholder {{${path}}} is missing or not a string, number or boolean in the payload`;
    return "";
  });
  if (failure !== undefined) return { ok: false, error: failure };
  const text = filled.length > TEXT_MAX ? `${filled.slice(0, TEXT_MAX - 1)}…` : filled;

  const repo = textAt(payload, "repository.full_name");
  if (repo === undefined || !validLabelValue(repo))
    return { ok: false, error: "repository.full_name is not usable as a label" };
  const labels: Record<string, string> = { ...trigger.labels, "github.event": event, repo };
  // A fork's branch is attacker-chosen text that a backend would check out, so only a same-repository head is trusted.
  const head = textAt(payload, "pull_request.head.repo.full_name");
  const ref = textAt(payload, "pull_request.head.ref");
  if (
    head !== undefined &&
    head.toLowerCase() === repo.toLowerCase() &&
    ref !== undefined &&
    ref !== "" &&
    validLabelValue(ref)
  )
    labels["branch"] = ref;
  return { ok: true, channel: trigger.channel, text, labels };
}
