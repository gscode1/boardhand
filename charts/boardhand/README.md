# boardhand chart

Installs a self-hosted board (the vercel/board engine on SQLite, one replica on a PVC) and one boardhand worker
Deployment per entry in `routes`. The full walk-through, with the Secrets to create, is in
[docs/deployment.md](../../docs/deployment.md). This file lists what the chart does.

```
helm upgrade --install boardhand charts/boardhand -n boardhand --create-namespace -f charts/boardhand/examples/c2.yaml
```

## What it creates

| Object | Count | Notes |
|---|---|---|
| StatefulSet + Service + ServiceAccount | 1 | The board: `node dist/server/main.js`, port 8080, a PVC from `volumeClaimTemplates`, the tokens Secret mounted read-only. |
| Deployment + ServiceAccount | per route | A worker: `node dist/main.js`, `strategy: Recreate`, an emptyDir for `BOARDHAND_STATE_DIR`. |
| NetworkPolicy | 1 + 1 + per route | Default deny for the release's pods; board ingress; worker egress. Off with `networkPolicy.enabled=false`. |

No Secret is created: the chart never holds a token.

## Values

See [values.yaml](values.yaml); it is commented. The route fields are validated when the chart renders (a missing
`from`, a repeated name, `backend: pi` without `backendTokenSecret`, an egress entry without ports all fail
`helm template`).

- `routes[].boardTokenSecret` becomes the worker's `BOARD_TOKEN`; `routes[].backendTokenSecret` becomes the backend's
  token variable (`PI_TOKEN` for `pi`; set `backendTokenEnv` for another).
- `routes[].egress` entries are `{ namespace, podSelector?, ports }` or `{ cidr, ports }`. Ports are numbers (TCP) or
  `{ port, protocol, endPort }`.
- `board.publicUrl` defaults to `http://<release>-board.<namespace>.svc:8080`. Workers use it as `BOARD_URL`, so it must be
  reachable from them.

## Security

- Every pod meets Pod Security `restricted`: `runAsNonRoot` with uid/gid 10001, `seccompProfile: RuntimeDefault`,
  `allowPrivilegeEscalation: false`, all capabilities dropped, `readOnlyRootFilesystem` with emptyDirs for `/tmp`, the
  worker's state and the board's data.
- `automountServiceAccountToken: false` on every ServiceAccount and pod. Nothing here calls the Kubernetes API.
- To have the cluster enforce it, label the namespace:

  ```
  kubectl label namespace boardhand pod-security.kubernetes.io/enforce=restricted
  ```

- NetworkPolicies need a CNI that enforces them. Kubelet probes come from the node, which most CNIs admit. If the backend
  has its own ingress policy (pi-durable-k8s: `networkPolicy.ingest.clients`), it must admit the worker pods.

## Rotating a token

The pods read Secrets at start. After changing one, `kubectl -n boardhand rollout restart deployment/<release>-worker-<route>`
or `statefulset/<release>-board`.
