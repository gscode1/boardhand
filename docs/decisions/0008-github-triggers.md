# 0008: The board server turns GitHub webhooks into tasks, by declarative triggers

Status: accepted, 2026-11-20.

## Context

Tasks reach the board only when a person or an agent posts them. Users want GitHub events to start agents: a PR that
Renovate opens, an issue labeled for triage, a maintainer's `/boardhand` comment. Which events, labels and repositories
differ per user, so nothing about them may be in code. Delivery is GitHub's webhook only; reporting the result back to
GitHub is left for later.

Constraints:

- AGENT.md: task text is untrusted input to an agent; workers claim only from owners in their route; secrets come from
  the environment and are never logged.
- [ADR 0005](0005-board-server.md): the board server is the engine's host and authenticates every caller itself; a
  restricted caller is a principal narrowed by an `x-board-can` the server forces.
- The engine (`@vercel/board` 0.52.0, `docs/04-reference/03-http.md`): `POST /tasks` with `channel` needs `post` there
  and `label` for `labels`, and `label` implies `read`. A post's `id` is an idempotency key: the same `id` from the same
  principal returns the post that landed; the same `id` in another channel or thread is 409 `duplicate_id`. Label keys
  are `[a-z0-9][a-z0-9_.-]*` up to 64 characters, values up to 256 characters with no control characters. Task text is
  at most 10 000 characters. The engine already serves `/webhooks` and `/sync`.

## Decision

**In the board server, not a new program.** `server/` serves `POST /hooks/github`. A separate receiver would need its
own Deployment, Service, NetworkPolicy and a token at least as strong as a worker's (`post,label`, so `read` too), and
it could not create a task while the board is down anyway. The board's NetworkPolicy already admits the gateway
(`board.ingress.from`); the HTTP route from the public hostname to the board Service is the deployer's, as the board API
already is, and should expose only `/hooks/github` if the rest of the board stays internal. The path is outside the
engine's routes, and the handler runs before the engine sees the request.

**Authentication is GitHub's signature.** GitHub sends `X-Hub-Signature-256: sha256=<hex>`, an HMAC-SHA256 of the raw
body with the webhook's secret. The server holds that secret in `GITHUB_WEBHOOK_SECRET`, computes the HMAC over the raw
bytes before parsing anything, and compares in constant time. Missing or wrong: 401, nothing parsed or logged from the
body. The body is capped at 5 MiB (413). A valid signature reaches only this handler; it never authenticates a request
to the board API.

**Triggers are a JSON file** at `BOARDHAND_TRIGGERS_FILE`, read once at start; every problem is reported at once and the
server exits on a bad file, like the tokens file. Without the variable, `/hooks/github` answers 404. With it, the secret
is required. JSON, not YAML, so the server takes no new dependency; the chart renders it from Helm values with
`toJson`, so users of the chart still write YAML. A change restarts the pod (a checksum annotation).

```json
{
  "triggers": [
    {
      "name": "renovate",
      "repos": ["acme/*"],
      "event": "pull_request",
      "actions": ["opened", "synchronize"],
      "when": { "pull_request.user.login": ["renovate[bot]"] },
      "channel": "agents/deps",
      "labels": { "kind": "renovate" },
      "text": "Check Renovate's update {{pull_request.html_url}}: {{pull_request.title}}"
    }
  ]
}
```

| Field | Rule |
|---|---|
| `name` | `[a-z][a-z0-9-]{0,31}`, unique. Part of the task's idempotency id and of every log line about it. |
| `repos` | Required, non-empty: `owner/name` or `owner/*`, matched case-insensitively against `repository.full_name`. An event without a repository never matches. |
| `event` | The `X-GitHub-Event` value, for example `pull_request`, `issues`, `issue_comment`. |
| `actions` | Optional list of `action` values. Absent: any action, and events that have none. |
| `when` | Required. Dotted payload path to a list of accepted values (any of them, compared exactly; strings, numbers, booleans, `null`). A segment ending in `[]` means any element of that array (`pull_request.labels[].name`). A missing path does not match. Every condition must hold. |
| `channel` | A board channel name (not a subtree). |
| `labels` | Optional static labels, checked against the engine's rules. They may not set the derived keys below. |
| `text` | The task text. `{{dotted.path}}` is replaced by that payload value (a string, number or boolean). A missing or non-scalar value is an error for this trigger, not an empty string. The result is clipped to 10 000 characters. |

**A gate on who is mandatory.** `when` must name at least one path that says who caused or wrote the event:
`sender.login`, `sender.id`, or one ending in `.user.login`, `.user.id` or `.author_association`. On a public repository
anyone can open an issue or comment, and that text goes to an agent; a trigger that does not say whose events it accepts
is a configuration error. Paths such as `sender.type` do not count: `sender.type: [User]` admits everyone.

**Derived labels.** The server sets `github.event` and `repo` (`repository.full_name`, what the pi backend uses as the
session's repository) on every task. For an event with `pull_request` whose head is in the same repository, it also
sets `branch` to `pull_request.head.ref`; a fork's branch is never set. Payload text never becomes a label value
otherwise, because labels steer routing and backends.

**Who owns the task.** Tasks are created as the fixed principal `boardhand:source:github`. At start the server makes
an in-memory credential of kind `source` (random, never written or logged; the tokens file still accepts only `person`
and `worker`) and sends each create through the engine as a request with that credential and a forced
`x-board-can` of `<channel>=post,label` for each channel the triggers name. So the engine, not only our code, keeps the
webhook to those channels and to posting and labeling; it cannot claim or settle. A route that should run GitHub tasks
lists `boardhand:source:github` in `BOARDHAND_FROM`; other routes never see them.

**Idempotency.** Each task is posted with `id` = `github:<X-GitHub-Delivery>:<trigger name>`, so a redelivery returns
the task already made and two triggers matching one delivery make two tasks. A 409 `duplicate_id` is an error, not a
success: it means the id was used for a different post.

**Answers.** `ping` and events that match no trigger: 200. All matching triggers created (or already had) their task:
200 with the task IDs. A template error: that trigger is skipped and logged with its name, and the answer is 422. The
board refusing or failing: 502, quickly, so GitHub marks the delivery failed and it can be redelivered by hand (GitHub
does not retry on its own). Other matching triggers are still tried; a redelivery makes only the missing ones.

## Consequences

- `X-GitHub-Event` and `X-GitHub-Delivery` are not covered by the signature. Someone who captured a signed body could
  resend it under another event name or delivery ID. Over TLS this needs a captured body; the event name must still
  match a trigger that accepts that body's shape. We accept it.
- One secret per board. Use an organization webhook, or the same secret on each repository. Rotation is: set the new
  secret in GitHub and the Secret, then restart.
- GitHub publishes its webhook source ranges (`api.github.com/meta`); restricting `/hooks/github` to them at the gateway
  is recommended in the docs, not done in code.
- The board pod now parses requests from GitHub. The handler is small, reads at most 5 MiB, and parses JSON only after
  the signature checks out.
- Reporting back to GitHub (a PR comment with the result) is not part of this. A later change can read settled tasks
  that carry `github.event` and `repo`.
