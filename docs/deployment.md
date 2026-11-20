# Deployment

One Helm chart ([charts/boardhand](../charts/boardhand)) installs the board and a worker per route. Decisions are in
[ADR 0005](decisions/0005-board-server.md). Commands below use the namespace `boardhand` and the release name
`boardhand`; the example values are [charts/boardhand/examples/c2.yaml](../charts/boardhand/examples/c2.yaml).

## 1. Build and publish the image

The workflow `.github/workflows/image.yml` builds `linux/amd64` and `linux/arm64` and pushes
`ghcr.io/<owner>/boardhand` on every push to `main` (tags `main` and the 7-character commit sha) and for pull requests
from this repository (the sha of the PR's head commit). Pull requests from forks are skipped, since they get no write
token. The image carries `org.opencontainers.image.source`, so GitHub links the package to the repository; make the
package public (Package settings, Change visibility) if the cluster pulls without a pull secret.

Locally:

```
docker build -t boardhand:dev .
docker buildx build --platform linux/amd64,linux/arm64 -t ghcr.io/<owner>/boardhand:<tag> --push .
```

One image, three programs: `node dist/main.js` (the worker, the default), `node dist/server/main.js` (the board) and
`node dist/server/inspect.js` (the board's UI, optional).
It runs as uid 10001 and writes nowhere itself, so a read-only root filesystem works.

## 2. Create the Secrets

The chart holds no token. Make them with random values and keep the owner token for posting tasks:

```
kubectl create namespace boardhand
kubectl label namespace boardhand pod-security.kubernetes.io/enforce=restricted

OWNER_TOKEN=$(openssl rand -hex 32)
WORKER_TOKEN=$(openssl rand -hex 32)

# The board's tokens file, one name:kind:token[:channels] per line (see configuration.md).
kubectl -n boardhand create secret generic boardhand-board-tokens \
  --from-literal=tokens="$(printf 'gs:person:%s\ndev:worker:%s:dev\n' "$OWNER_TOKEN" "$WORKER_TOKEN")"

# The worker's own board token (the same value as its line above).
kubectl -n boardhand create secret generic boardhand-worker-dev --from-literal=token="$WORKER_TOKEN"

# The pi-durable-k8s session-API token of the worker's owner (a non-admin owner).
kubectl -n boardhand create secret generic boardhand-pi --from-literal=token='<PI_TOKEN>'
```

The person's name is the route's owner: its principal ID is `boardhand:person:gs`, which goes in the route's `from`. A
worker's channel list in the tokens file (`dev`, or `dev/` for a subtree) is what the board lets it touch.

If the backend runs its own NetworkPolicy (pi-durable-k8s: `networkPolicy.ingest.clients`), add the worker pods to
it, for example `podSelector: { matchLabels: { app.kubernetes.io/name: boardhand, app.kubernetes.io/component: worker } }`
in the `boardhand` namespace.

## 3. Install

```
helm upgrade --install boardhand charts/boardhand -n boardhand -f charts/boardhand/examples/c2.yaml
kubectl -n boardhand get pods
```

Set `image.tag` to the sha you pushed. Check `kubectl -n boardhand logs statefulset/boardhand-board` shows
`server.start`, and `kubectl -n boardhand logs deploy/boardhand-worker-dev` shows `worker.start`.

## 4. Post a task as an owner

Use the `vb` CLI of the pinned SDK through a port-forward; the explicit token is used as is. Pick a free local port
(8080 is often taken on a workstation; a busy port answers for something else, typically with a 401):

```
kubectl -n boardhand port-forward svc/boardhand-board 18080:8080 &
export BOARD_URL=http://127.0.0.1:18080 BOARD_TOKEN="$OWNER_TOKEN"
npx @vercel/board@0.52.0 whoami
npx @vercel/board@0.52.0 tasks create dev "add a LICENSE file" --label repo=<owner>/<name>
npx @vercel/board@0.52.0 read <task id>
```

The worker claims the task (only if its owner is in the route's `from` and the labels match), replies
`Started pi run <id>` and later `Completed: ...` or `Failed: ...` on the thread.

### The board's UI

The SDK ships the board's own UI, the inspector. It runs on your machine, reads and writes as the token in
`BOARD_TOKEN`, and proxies through the same port-forward:

```
npx @vercel/board@0.52.0 inspect
```

It opens `http://127.0.0.1:4747` (`--port N`, `--no-open`). Its first line names the board by the URL the board
advertises (`http://boardhand-board.boardhand.svc:8080`); requests still go to `BOARD_URL`.

#### In the cluster

The same UI can run in the cluster behind the Gateway, with no port-forward ([ADR 0007](decisions/0007-inspector-in-cluster.md)).
It is off by default.

> **WARNING: there is no authentication.** The inspector acts as the owner whose token you give it, and anyone who can
> reach its hostname acts as that owner: they can read every channel, create tasks that your workers will run, and
> cancel tasks. Use an internal hostname that only you can reach, and do not expose it to the internet, until an auth
> policy is added in front of it.

1. Make a Secret with an owner token, the `person` entry of the tokens file whose name your routes list in `from`
   (tasks created in the UI are owned by that principal, so its workers claim them):

   ```
   kubectl -n boardhand create secret generic boardhand-inspector --from-literal=token="$OWNER_TOKEN"
   ```

2. Enable it with a hostname and the Gateway to attach to, as in `charts/boardhand/examples/c2.yaml`:

   ```yaml
   inspector:
     enabled: true
     tokenSecret: { name: boardhand-inspector, key: token }
     httpRoute:
       enabled: true
       hostnames: [board.gskode.com]
       parentRefs: [{ name: main, namespace: envoy-gateway-system, sectionName: https-gskode }]
     allowFrom: # who may reach the inspector's port: the gateway's proxy pods
       - { namespace: envoy-gateway-system, podSelector: { app.kubernetes.io/name: envoy } }
   ```

3. `helm upgrade` as in step 3, then open `https://board.gskode.com`. The page asks which profile to post
   as; a write without one is refused. Check `kubectl -n boardhand logs deploy/boardhand-inspector` shows
   `inspector.start`.

The gateway must pass the `Host` header through unchanged (Envoy Gateway does): the inspector accepts a write only when
the browser's `Origin` host equals the request's `Host`. `http://` and `https://` both work. With `networkPolicy.enabled`
the chart admits `allowFrom` to the inspector, the inspector to the board, and nothing else.

Workers claim tasks only. A plain post in a channel is a message, and no worker picks it up: in the composer, start the
thread as a task (or make an existing thread a task from its pane), leave it unassigned, and do not claim it yourself.

## 5. Logs and the stale-task warning

Both programs log one JSON object per line.

```
kubectl -n boardhand logs -f deploy/boardhand-worker-dev
kubectl -n boardhand logs statefulset/boardhand-board | grep task.stale
```

A task that is ready longer than `board.stale.afterSeconds` (default 900) gets a `task.stale` warning on every check
(`board.stale.checkSeconds`, default 60), with `task`, `channel`, `labels` and `ageSeconds`. It means nobody claims it:
no route matches its channel, labels or owner, or the route's workers are down or full. Task text is never logged.

## 6. Upgrade

Change `image.tag` (or values) and run the `helm upgrade` again. The board pod restarts first (a brief outage; workers
retry with backoff); workers restart with `Recreate`, so a route never exceeds its concurrency. A run that was started
is found again through the thread's run label once its lease lapses (up to `lease` seconds). Upgrading
`@vercel/board` is its own change (ADR 0002). After rotating a Secret, `kubectl -n boardhand rollout restart` the
affected workload: pods read Secrets at start.

## 7. Back up the board

The board is SQLite files on the `data-boardhand-board-0` PVC (mounted at `/data`). Back it up with your storage's
snapshots (Longhorn: a RecurringJob or `kubectl` VolumeSnapshot), or copy it while the pod is stopped:

```
kubectl -n boardhand scale statefulset/boardhand-board --replicas=0
# copy the volume with your storage tooling, or mount it in a throwaway pod and tar it
kubectl -n boardhand scale statefulset/boardhand-board --replicas=1
```

Do not copy the live files of a running board: SQLite needs a consistent snapshot. Deleting the release keeps the PVC;
delete it by hand to remove the data.

## 8. GitHub webhooks

The board server can turn GitHub events into tasks ([ADR 0008](decisions/0008-github-triggers.md); the trigger file is in
[configuration.md](configuration.md#github-triggers)). It is off until you set `board.github.triggers`.

1. Make the webhook's secret and store it in a Secret:

   ```
   WEBHOOK_SECRET=$(openssl rand -hex 32)
   kubectl -n boardhand create secret generic boardhand-github --from-literal=secret="$WEBHOOK_SECRET"
   ```

2. Set the triggers and the Secret in your values (see the commented example in `charts/boardhand/values.yaml`), and
   list `boardhand:source:github` in the `from` of each route that should run these tasks:

   ```yaml
   board:
     github:
       webhookSecret: { name: boardhand-github, key: secret }
       triggers:
         - name: renovate
           repos: ["acme/*"]
           event: pull_request
           actions: [opened, synchronize]
           when: { pull_request.user.login: ["renovate[bot]"] }
           channel: agents/deps
           labels: { kind: renovate }
           text: "Check Renovate's update {{pull_request.html_url}}: {{pull_request.title}}"
   ```

   Run `helm upgrade` as in step 3. The chart mounts the triggers as a ConfigMap and restarts the board pod when they
   change; a missing `webhookSecret.name` fails the render. Check `kubectl -n boardhand logs statefulset/boardhand-board`
   shows `server.start`.

3. In GitHub (a repository's or an organization's Settings, Webhooks), add a webhook: payload URL
   `https://<board host>/hooks/github`, content type `application/json`, the secret from step 1, and only the events your
   triggers use (for example Pull requests, Issues, Issue comments). One secret serves the whole board: use an
   organization webhook, or the same secret on each repository. GitHub's `ping` should answer 200.

The hook must be reachable from GitHub, so route `/hooks/github` to the board Service (`<release>-board`, port 8080) at
your gateway. The chart's HTTPRoute serves only the inspector; the gateway reaches the board through `board.ingress.from`
as any other client, and the NetworkPolicy needs no change. Expose only that path, not the board API. Restrict it to
GitHub's webhook source ranges (the `hooks` list at <https://api.github.com/meta>) at the gateway; the signature check is
the authentication, and the ranges only cut noise and attack surface.

If the board is down or refuses a task, the delivery gets a 502 and GitHub does not retry. Open the webhook's Recent
Deliveries in GitHub and redeliver it: tasks already made are not made twice. To rotate the secret, change it in GitHub
and in the Secret, then `kubectl -n boardhand rollout restart statefulset/boardhand-board`.

Results are not posted back to GitHub yet: the outcome is on the board task's thread.
