# Spec-driven Harness demo app

A small Node.js full-stack app built to show **spec -> commit -> Harness CI -> Harness CD -> GKE** with a
change that is visible on screen. The whole UI is rendered from one file, `spec/app.spec.yaml`.

```
 browser ──► frontend (nginx :8080) ──/api/*──► backend (Express :3000)
              static HTML/JS/CSS                  REST API + validated app spec
```

| Part | Tech | Image |
|---|---|---|
| `backend/` | Node 22, Express 5 + `yaml` (only two dependencies); `node:test` tests | `backend/Dockerfile` (context = repo root, bakes in the spec) |
| `frontend/` | Vanilla JS, no build step, unprivileged nginx proxying `/api` | `frontend/Dockerfile` (context = `frontend/`) |
| `spec/` | App spec + schema docs + example variants | |
| `k8s/` | Kustomize base + `dev` / `prod` overlays for GKE | |

## Run it locally

```bash
npm run install:all
npm run dev                # http://localhost:3000  (backend serves the frontend, spec live-reloads)
npm test                   # API + spec tests
npm run validate-spec      # CI gate for spec files
```

Edit `spec/app.spec.yaml` while `npm run dev` runs and the page updates within ~4 seconds.
Try a bigger change: `npm run spec:use dark-ocean` (and `git checkout spec/app.spec.yaml` to revert).

Full stack in containers, same wiring as the cluster: `docker compose up --build` -> http://localhost:8080

## REST API

| Method & path | Description |
|---|---|
| `GET /api/spec` | The validated spec plus its `hash` (frontend polls this to live-update) |
| `GET /api/version` | Backend version, commit, environment, **pod name** (set at build / deploy time) |
| `GET /api/stats` | Uptime, request count, item count |
| `GET /api/items` `GET /api/items/:id` | Catalog |
| `POST /api/items` `PUT /api/items/:id` `DELETE /api/items/:id` | Catalog writes (in-memory, per pod) |
| `GET /api/health` | Health via the frontend proxy |
| `GET /healthz` `GET /readyz` | Kubernetes liveness / readiness (backend); frontend serves its own `/healthz` |

## The spec-driven demo loop

1. Change `spec/app.spec.yaml` (banner text, hero title, colours, section order, layout, ...). The
   [spec reference](spec/README.md) lists every option. Ask Cursor to do it from a written spec:
   `.cursor/rules/spec-driven-development.mdc` tells it to change the spec first and only touch code
   when a new kind of block is needed.
2. Commit and push -> Harness pipeline runs `npm run validate-spec`, `npm test`, builds and pushes both images.
3. Harness CD updates the image tags and rolls out to GKE (rolling update, zero downtime).
4. An already-open browser tab picks up the new spec on its own. The footer badge shows
   `web <version> | api <version> | pod <name> | spec <hash>` so you can point at exactly what is running.

## Build the images

```bash
REGISTRY=REGION-docker.pkg.dev/PROJECT_ID/spec-demo     # Artifact Registry repo
VERSION=$(git rev-parse --short HEAD)                   # or your pipeline's build / tag number

docker build -f backend/Dockerfile -t $REGISTRY/backend:$VERSION \
  --build-arg APP_VERSION=$VERSION --build-arg GIT_SHA=$VERSION --build-arg BUILD_TIME=$(date -u +%FT%TZ) .
docker build -t $REGISTRY/frontend:$VERSION \
  --build-arg APP_VERSION=$VERSION --build-arg GIT_SHA=$VERSION --build-arg BUILD_TIME=$(date -u +%FT%TZ) frontend
```

## Deploy to GKE

One-time setup:

```bash
gcloud artifacts repositories create spec-demo --repository-format=docker --location=REGION
gcloud auth configure-docker REGION-docker.pkg.dev
gcloud container clusters get-credentials CLUSTER --region REGION
```

Then either let Harness do it, or by hand:

```bash
cd k8s/overlays/dev
kustomize edit set image \
  spec-demo-backend=$REGISTRY/backend:$VERSION \
  spec-demo-frontend=$REGISTRY/frontend:$VERSION
kubectl apply -k .
kubectl -n spec-demo-dev get svc frontend      # EXTERNAL-IP is your app URL (port 80)
```

| Overlay | Namespace | Replicas | Extras |
|---|---|---|---|
| `dev` | `spec-demo-dev` | 1 + 1 | |
| `prod` | `spec-demo-prod` | HPA 2-6 each | PodDisruptionBudgets |

Base manifests: non-root, no privilege escalation, all capabilities dropped, seccomp `RuntimeDefault`,
read-only root FS on the backend, resource requests/limits (Autopilot-friendly), startup/liveness/readiness
probes, `maxUnavailable: 0` rolling updates, graceful drain on SIGTERM. The frontend is a `LoadBalancer`
Service; `k8s/optional/ingress.yaml` shows the Ingress alternative.

Before first use replace `REGION` / `PROJECT_ID` in `k8s/base/kustomization.yaml` (or override with `kustomize edit set image`).

## Mapping to Harness

| Pipeline step | Command / config |
|---|---|
| Spec gate (CI, Run step) | `npm run validate-spec` |
| Test (CI, Run step) | `npm run install:all && npm test` |
| Build & push backend (CI, Build and Push to GAR) | Dockerfile `backend/Dockerfile`, **context = repo root**, build args `APP_VERSION`, `GIT_SHA` |
| Build & push frontend | Dockerfile `frontend/Dockerfile`, context `frontend/` |
| Deploy (CD, Kubernetes service) | Manifest type **Kustomize**, folder `k8s/overlays/<env>`; two artifacts / image overrides for `spec-demo-backend` and `spec-demo-frontend` |
| Verify | `GET /healthz` on the frontend Service, or `/api/version` to confirm the new version/pod |

## Notes

- Items are held in memory per process (replicas don't share them), which is why `catalog.allowEdit` is `false` by
  default. Replace `backend/src/store.js` with a DB-backed implementation if you need real persistence.
- Docker and cluster steps above were not executed in the authoring environment; the backend tests, the spec flow and
  the Kustomize rendering (`npm run k8s:render:dev|prod`) were.
