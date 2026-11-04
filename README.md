# Spec-driven Harness demo app

A small Node.js full-stack app built to show **spec -> commit -> Harness CI -> Harness CD -> GKE** with a
change that is visible on screen. The whole UI is rendered from one file, `spec/app.spec.yaml`.

```
 browser ──► frontend (nginx :8080) ──/api/*──► backend (Express :3000)
              static HTML/JS/CSS                  REST API + validated app spec
```

| Part | Tech | Image |
|---|---|---|
| `backend/` | Node 22, Express 5 + `yaml` (two dependencies), `node:test` tests | `backend/Dockerfile` (context = repo root, bakes in the spec) |
| `frontend/` | Vanilla JS, no build step, unprivileged nginx proxying `/api` | `frontend/Dockerfile` (context = `frontend/`) |
| `spec/` | App spec + schema docs + example variants | |
| `k8s/` | Kustomize base + `dev` / `prod` overlays for GKE, plus the Harness image patch | |
| `harness/` | Reference copy of the Harness pipeline | |

## Run it locally

```bash
npm run install:all
npm run dev                # http://localhost:3000  (backend serves the frontend, spec live-reloads)
npm test                   # API + spec tests
npm run validate-spec      # CI gate for spec files
```

Edit `spec/app.spec.yaml` while `npm run dev` runs and the page updates within ~4 seconds.
Try a bigger change: `npm run spec:use dark-ocean` (and `git checkout spec/app.spec.yaml` to revert).

Full stack in containers, same wiring and hardening as the cluster: `docker compose up --build` -> http://localhost:8080

## REST API

| Method & path | Description |
|---|---|
| `GET /api/spec` | The validated spec plus its `hash` (frontend polls this to live-update) |
| `GET /api/version` | Backend version, commit, environment, **pod name** (set at build / deploy time) |
| `GET /api/stats` | Uptime, request count, item count |
| `GET /api/items` `GET /api/items/:id` | Catalog |
| `GET /api/items/:id/badge` | One-line share label for a catalog item |
| `POST /api/items` `PUT /api/items/:id` `DELETE /api/items/:id` | Catalog writes. **Rejected with 403 unless `catalog.allowEdit: true` in the spec.** In-memory, per pod |
| `GET /api/health` | Health via the frontend proxy |
| `GET /healthz` `GET /readyz` | Kubernetes liveness / readiness (backend); frontend serves its own `/healthz` |

## The spec-driven demo loop

1. Change `spec/app.spec.yaml` (banner text, hero title, colours, section order, layout, ...). The
   [spec reference](spec/README.md) lists every option. Ask Cursor to do it from a written spec:
   `.cursor/rules/spec-driven-development.mdc` tells it to change the spec first and only touch code
   when a new kind of block is needed.
2. Merge to `main` -> the Harness pipeline validates the spec, tests, scans, builds and pushes both images.
3. Harness CD rolls out to **dev** on GKE, waits for approval, then rolls out to **prod** (rolling update, zero downtime).
4. An already-open browser tab picks up the new spec on its own. The footer badge shows
   `web <version> | api <version> | pod <name> | spec <hash>` so you can point at exactly what is running.

## Production notes

| Area | What is in place |
|---|---|
| Containers | Non-root, read-only root FS (nginx gets tmpfs for `/tmp` and `/etc/nginx/conf.d`), all capabilities dropped, no privilege escalation, `npm ci --ignore-scripts`, V8 heap capped below the pod memory limit, OCI labels, health checks |
| Kubernetes | Dedicated ServiceAccounts with no API token mounted, NetworkPolicies (backend reachable only from the frontend), zone + node topology spread, requests/limits sized for GKE Autopilot, startup/liveness/readiness probes, `maxUnavailable: 0` rolling updates, preStop drain + graceful SIGTERM, `restricted` Pod Security on the namespaces, PodDisruptionBudgets + HPA (2-6) in prod |
| Edge | nginx: CSP and other security headers, request-rate limit (30 r/s per client, burst 60), body-size and timeout limits, gzip, strips client-supplied forwarding headers. `externalTrafficPolicy: Local` keeps the real client IP for nginx's per-client limit |
| Backend | Per-peer rate-limit backstop (6000/min general, 60/min writes; per-client limiting is nginx's job), spec-gated writes, 10 KB body limit, structured JSON logs (no query strings), crash-on-uncaught-error, never reads forwarded-IP headers (identity = TCP peer, so nothing to spoof), no runtime internals in `/api/version` |
| Supply chain | Secret scan + dependency scan in the pipeline, lockfile-pinned installs, no `latest` tag deployed |

Tunables (env on the backend, via `backend-config` in `k8s/base/kustomization.yaml`): `APP_ENVIRONMENT`,
`RATE_LIMIT_PER_MIN`, `WRITE_RATE_LIMIT_PER_MIN`, `PORT`, `SPEC_PATH`, `SPEC_WATCH`.

Unhandled 500s can also be posted to a Jira Automation incoming webhook. Set `INCIDENT_REPORTING=true`
and `JIRA_INCIDENT_WEBHOOK_URL`. The dev overlay turns reporting on and reads the URL from the optional
Secret `jira-incident-webhook` (key `url`). With either value missing, the backend only logs the error.
The URL is never written to logs or to the ticket body.

## Build the images by hand

```bash
VERSION=$(git rev-parse --short HEAD)
docker build -f backend/Dockerfile -t dutabhis/spec-demo-backend:$VERSION \
  --build-arg APP_VERSION=$VERSION --build-arg GIT_SHA=$VERSION .
docker build -t dutabhis/spec-demo-frontend:$VERSION \
  --build-arg APP_VERSION=$VERSION --build-arg GIT_SHA=$VERSION frontend
```

## Deploy to GKE by hand (the pipeline does this for you)

```bash
gcloud container clusters get-credentials CLUSTER --region REGION
cd k8s/overlays/dev
kustomize edit set image \
  spec-demo-backend=docker.io/dutabhis/spec-demo-backend:$VERSION \
  spec-demo-frontend=docker.io/dutabhis/spec-demo-frontend:$VERSION
kubectl apply -k .
kubectl -n spec-demo-dev get svc frontend      # EXTERNAL-IP is your app URL (port 80)
```

| Overlay | Namespace | Replicas | Extras |
|---|---|---|---|
| `dev` | `spec-demo-dev` | 1 + 1 | |
| `prod` | `spec-demo-prod` | HPA 2-6 each | PodDisruptionBudgets |

`k8s/optional/ingress.yaml` shows the Ingress alternative to the `LoadBalancer` Service.
Images are public Docker Hub repos (`dutabhis/spec-demo-*`); for private registries add an `imagePullSecret`.

## Harness

Everything lives in org `partner`, project `demo`.

| Resource | Identifier | Notes |
|---|---|---|
| Pipeline | `spec_demo_build_and_deploy` | Reference copy: `harness/pipeline.yaml` |
| Service | `spec_demo` | Kustomize manifest from this repo (Harness Code), backend = primary artifact, frontend = sidecar artifact |
| Environments | `spec_demo_dev`, `spec_demo_prod` | Variable `overlay` (= `dev` / `prod`) picks `k8s/overlays/<overlay>` |
| Infrastructure | `gke_dev`, `gke_prod` | Namespaces `spec-demo-dev` / `spec-demo-prod` on the cluster behind connector `gkecluster` |
| Connectors (existing) | `abhidocker` (Docker Hub), `gkecluster` | Both `gkecluster` and `gcpconnector` run on delegates tagged **`ad-kubernetes-delegate`** |

Pipeline stages: **Build** (secret scan + dependency scan, `npm run validate-spec` + `npm test` in `node:22-alpine`,
build & push backend and frontend on Harness Cloud) -> **Deploy Dev** -> **Approve Production** -> **Deploy Prod**
(rolling deploys, automatic rollback on failure). Images are tagged `1.0.<pipeline sequence>` and `<short commit>`.

How the images get into the cluster: `k8s/harness/patch-images.yaml` is applied by Harness as a Kustomize patch and
resolves to the exact images the Build stage just pushed. It is not referenced by any `kustomization.yaml`.

### Delegate requirements

The CD stages run on a delegate matching selector `ad-kubernetes-delegate` (from connector `gkecluster`). It must be:
connected and healthy, running **inside the target GKE cluster** (the connector inherits its credentials), and allowed
by RBAC to create/patch Namespaces, Deployments, Services, ServiceAccounts, ConfigMaps, NetworkPolicies, HPAs and
PodDisruptionBudgets cluster-wide (a cluster-admin delegate role does this). Build steps use Harness Cloud and need no delegate.

## Notes

- Catalog items are held in memory per process (replicas don't share them), which is why `catalog.allowEdit` is `false`
  by default and the API enforces it. Replace `backend/src/store.js` with a DB-backed implementation for real persistence.
- Images are built for `linux/amd64` (Harness Cloud). For Arm node pools add a multi-arch build.
