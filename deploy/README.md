# Paperclip Pixel Agents Bridge Stack — Deployment

Reproducible deployment of the Paperclip Pixel Agents bridge stack on a local
**minikube** cluster (with a **docker-compose fallback** for environments
without k8s). Specification: PAPERCLIP_PIXELS-1; plugin-architecture rework:
PAPERCLIP_PIXELS-2 (WS2-C bridge port + WS2-D embedding surface).

> **Production deployment (Revision 3, WS6):** this README documents the
> **development reference** path (`:local` images, single node). For a
> production-grade install use the **single Helm chart**
> [`deploy/helm/paperclip-pixels`](helm/paperclip-pixels) — immutable
> digest-pinned images, externalized secrets, TLS/mTLS default, NetworkPolicies,
> ingress, HA sizing, backup/restore, and observability. Operator docs:
> [`OPERATIONS.md`](OPERATIONS.md) · [`SECURITY.md`](SECURITY.md) ·
> [`OBSERVABILITY.md`](OBSERVABILITY.md) ·
> [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) · [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md).

## Stack

| Component | Image | Port | Role |
|-----------|-------|------|------|
| Postgres  | `postgres:17-alpine`            | 5432 | Paperclip metadata DB |
| Paperclip host | `paperclip-pixel-host:local` | 3100 | Paperclip API + UI, with the bridge plugin loaded |
| Pixel Agents | `pixel-agents:local`         | 8080 (UI/WS), 8081 (plugin feed) | Pixel Agents standalone server (SPA + WS) **with the Paperclip bridge embedding module loaded in-process** via the fork CLI's generic `--plugin` loader |

The bridge is two plugins joined by a neutral contract package (board
Revision 3 target shape): `@decaf-ts/paperclip-pixels-common` (schemas only,
`./common`), the Paperclip-side plugin `@decaf-ts/paperclip-pixels-plugin`
(source `plugins/paperclip/`), and the Pixel Agents-side plugin
`@decaf-ts/pixel-agents-paperclip-plugin` (source
`plugins/pixel-agents/`). This reference deployment builds those three
packages and vendors the two plugin artifacts into the images: the host
image vendors the Paperclip plugin's pre-built `plugins/paperclip/dist/`,
and the pixel-agents image vendors the embedding bundle
`plugins/pixel-agents/dist/pixel-agents-embedding.cjs`. The plugin runs
as a **forked worker child process of the Paperclip host** (loaded via
`installPlugin({ localPath })` in this reference deployment; a real
install uses `installPlugin({ packageName: "@decaf-ts/paperclip-pixels-plugin" })`
instead — see the [package README](../README.md#install-and-run-two-plugin-deployment)),
not as its own pod. The host image vendors the built plugin at
`/opt/paperclip-pixel-plugin` and installs it at first boot via a loopback
`local_trusted` bootstrap (no-auth admin), then restarts in `authenticated`/lan
mode for reachability.

### How the bridge reaches Pixel Agents (first-class plugin path, WS2+)

The retired design (PAPERCLIP_PIXELS-1) impersonated Claude hooks: a
same-pod `paperclip-pixel-relay` sidecar read Pixel Agents' bearer token off
disk and forwarded Claude-hook-shaped pushes to `POST /api/hooks/claude`.
That whole path — the relay CLI, the impersonation, the sidecar — is
**retired** (WS2-C deleted the impersonation code; WS2-D deleted the dead
relay bin and wired the replacement):

- The Pixel Agents container runs the fork CLI with
  `--plugin /opt/paperclip-pixel-embedding/pixel-agents-embedding.cjs`
  (canonical source `plugins/pixel-agents/src/embedding.ts`, bundled by
  `npm run build` in `plugins/pixel-agents` into
  `plugins/pixel-agents/dist/pixel-agents-embedding.cjs` and vendored
  into the image).
  Through the fork's generic plugin-module loader the module registers the
  Paperclip plugin in-process (manifest + reply actions through the WS2-A1/A2
  plugin host) and serves `POST /api/plugin-feed` on its own sidecar listener
  (`:8081`).
- The Paperclip worker's relay (`plugins/paperclip/src/relay.ts`) pushes
  feed-operation
  batches (agent declarations, status, activity, removals — plus
  palette/hueShift seats) to that endpoint; the embedding surface applies
  them through the plugin's sanctioned agent/team source. Characters,
  labels, status animations, and the click-menu reply flow all ride
  first-class plugin surfaces now — zero impersonation, zero upstream
  surface abuse.
- **Fail-closed auth:** the feed endpoint requires a shared-secret bearer
  token (`PAPERCLIP_PIXEL_FEED_TOKEN` on the pixel-agents side; the same
  value configured as the Paperclip plugin's `pixelAgentsTokenRef` secret).
  Unauthenticated pushes get `401`; a token never rides the URL; the
  embedding module refuses to start without a token configured.
- **Click-menu replies** flow back through the plugin's registered actions
  to Paperclip's performAction proxy
  (`POST /api/plugins/:pluginId/actions/:key` → the plugin's existing
  `agent.reply-to-feedback` / `company.send-message` actions — never direct
  issue creation). The forwarder target is `PAPERCLIP_PIXEL_API_BASE_URL`
  (default `http://paperclip:3100` in compose) with a board API key in
  `PAPERCLIP_PIXEL_API_TOKEN`; without the key the feed still applies, but
  replies fail closed with `forwarderNotConfigured`.

The Paperclip-side plugin config (`pixelAgentsUrl`) defaults to
`http://127.0.0.1:8081` — right for the common single-machine "try it out"
case, but **wrong for the containerized topologies here**, where the
embedding surface runs in the pixel-agents container/pod, not the Paperclip
one. Plugin config is **company-scoped**, and a fresh deployment has zero
`plugin_config` rows, so the worker→feed relay push does not fire until it is
set. This repo automates that as a one-time bootstrap (SAA-961 Finding 2):
`deploy/scripts/init-company.sh` registers the feed token as a company secret
and applies `{ companyId, configJson: { pixelAgentsUrl, pixelAgentsTokenRef,
pixelAgentsAllowedHttpHosts } }` via `POST /api/plugins/:id/config`. The host
image vendors the script and the entrypoint calls it best-effort on first
boot; run it once after the first company exists:

```bash
# compose dev path (env already supplies the feed URL/token/allowed hosts)
docker compose -f deploy/docker/docker-compose.bridge-stack.yml exec paperclip \
  /usr/local/bin/init-company.sh http://127.0.0.1:3100

# k8s dev path (feed URL/token/allowed hosts come from the Deployment env)
kubectl -n paperclip-pixels exec deploy/paperclip -- \
  /usr/local/bin/init-company.sh http://127.0.0.1:3100

# helm / production: set initialCompany.config (slug + relay fields) so the
# first-boot entrypoint applies it, or run the same command with
# PIXELS_COMPANY_ID / the feed env.
```

The script auto-discovers the company (by slug from `initialCompany.config`,
or the single company) when `PIXELS_COMPANY_ID` is not supplied. It needs the
feed token (`PAPERCLIP_PIXEL_FEED_TOKEN`) in the paperclip container to
register the secret; the compose/k8s/helm deployments already pass it. The
manual UI path (Plugins → this plugin → Configure) still works as a fallback.
See `deploy/OPERATIONS.md` and the [package README](../README.md#configure-the-plugin).

> Note: `pixelAgentsAllowedHttpHosts` is only required for a cleartext `http:`
> `pixelAgentsUrl` pointing at a **non-loopback** host that is not in the
> plugin's default trusted set; the https-when-token contract otherwise
> rejects the feed+bearer token combination on such a host (SAA-734). The
> helm chart renders `PAPERCLIP_PIXEL_ALLOWED_HTTP_HOSTS` from
> `transport.feed.*` (including the actual `<svc>-pixel-agents` host) so the
> templated feed URL is reachable.

## Build

The host image reuses the published Paperclip base (`ghcr.io/paperclipai/paperclip:latest`)
and only adds the vendored bridge plugin + a bootstrap entrypoint. The
pixel-agents image builds the standalone CLI from the submodule (it ships no
Dockerfile) **and vendors the bridge embedding module** — so the plugin repo
build must run before either image is built.

```bash
# from the repo root (submodules initialized: paperclip/, pixel-agents/)
# 1. Build the bridge packages first — the host image vendors the
#    Paperclip plugin's pre-built plugins/paperclip/dist/ (worker +
#    manifest + UI bundle), and the pixel-agents image vendors
#    plugins/pixel-agents/dist/pixel-agents-embedding.cjs (the
#    in-process embedding module the fork CLI loads via --plugin).
#    `common` builds first (both plugins depend on it), then
#    plugins/paperclip bundles the worker/manifest/UI with esbuild +
#    scripts/build-ui.mjs and plugins/pixel-agents emits the tsc output
#    plus the embedding bundle.
( npm install && npm run build --workspaces )
# 2. Build the images. The host image reuses the published Paperclip base
#    (ghcr.io/paperclipai/paperclip:latest) and only adds the vendored bridge
#    plugin + a bootstrap entrypoint. The pixel-agents image builds the
#    standalone CLI from the submodule (it ships no Dockerfile) and vendors
#    the embedding module.
docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
docker build -t pixel-agents:local         -f deploy/docker/Dockerfile.pixel-agents .
```

## Deploy on minikube

```bash
minikube start
# load the built images into minikube's containerd (or build inside minikube
# with `eval $(minikube docker-env)` when the runtime is docker, not containerd)
minikube image load paperclip-pixel-host:local
minikube image load pixel-agents:local

# Secret material is never committed. Copy the template and fill in real
# values (auth secret, feed shared token, board API key, Postgres creds);
# kustomize generates the `paperclip-secrets` / `postgres-credentials` /
# `paperclip-pixel-feed` Secrets from it (see deploy/k8s/kustomization.yaml):
cp deploy/k8s/secrets.env.example deploy/k8s/secrets.env
#   edit deploy/k8s/secrets.env  (set BETTER_AUTH_SECRET, PAPERCLIP_PIXEL_FEED_TOKEN,
#   PAPERCLIP_PIXEL_API_TOKEN, POSTGRES_PASSWORD, DATABASE_URL)

kubectl apply -k deploy/k8s/
kubectl -n paperclip-pixels rollout status deploy/paperclip
kubectl -n paperclip-pixels rollout status deploy/pixel-agents
```

### Reach the UIs (port-forward)

```bash
kubectl -n paperclip-pixels port-forward svc/paperclip   3100:3100   # http://localhost:3100
kubectl -n paperclip-pixels port-forward svc/pixel-agents 8080:8080   # http://localhost:8080
```

- Paperclip API health: `curl http://localhost:3100/api/health` → `{"status":"ok",...}`
- Paperclip UI: open `http://localhost:3100` (login page; `SERVE_UI=true`).
- Pixel Agents UI: open `http://localhost:8080` (React SPA).
- Pixel Agents health: `curl http://localhost:8080/api/health`.

## Fallback: docker-compose

For environments without k8s:

```bash
PAPERCLIP_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_FEED_TOKEN=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_API_TOKEN=<board-api-key> \
  docker compose -f deploy/docker/docker-compose.bridge-stack.yml up --build
# UIs at http://localhost:3100 and http://localhost:8080
```

## Upgrading a deployment from the former combined package

Before the two-plugin rework, the images vendored the bridge artifacts from
the repo root's single combined package (one npm entry; root `dist/` +
`assets/` for the host image, root `dist/pixel-agents-embedding.cjs` for the
pixel-agents image). **That combined entry is removed and no longer published
or shipped; the two-plugin + `common` deployment is the only supported
path.** The repo root is now a private workspace root — nothing is installed
from it; the images vendor the per-package artifacts instead.

What changed is **only where the vendored bridge artifacts come from**. The
service topology, ports, environment variables, secrets flow, volumes, and
the first-boot entrypoint bootstrap are all unchanged, so an upgrade is a
rebuild + rolling redeploy:

1. **Rebuild the bridge packages** (both images vendor the pre-built
   `plugins/*/dist/`; `common` builds first — both plugins depend on it):

   ```bash
   # repo root — either builds all three packages:
   npm install && npm run build --workspaces
   # or per-package:
   npm --prefix common run build \
     && npm --prefix plugins/paperclip run build \
     && npm --prefix plugins/pixel-agents run build
   ```

2. **Rebuild both images** from the repo root (unchanged commands; the
   Dockerfiles now copy the per-package artifacts — the host image vendors
   `plugins/paperclip/{package.json,dist,assets}` to
   `/opt/paperclip-pixel-plugin`, the pixel-agents image vendors
   `plugins/pixel-agents/dist/pixel-agents-embedding.cjs` to
   `/opt/paperclip-pixel-embedding/`):

   ```bash
   docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
   docker build -t pixel-agents:local         -f deploy/docker/Dockerfile.pixel-agents .
   ```

3. **Redeploy** exactly as you did before:

   - **Compose (dev profile)** — same file, same env vars:

     ```bash
     PAPERCLIP_AUTH_SECRET=$(openssl rand -hex 32) \
     PAPERCLIP_PIXEL_FEED_TOKEN=$(openssl rand -hex 32) \
     PAPERCLIP_PIXEL_API_TOKEN=<board-api-key> \
       docker compose -f deploy/docker/docker-compose.bridge-stack.yml up --build
     ```

     Named volumes (`pgdata`, `paperclip-data`) persist across the upgrade;
     the Paperclip plugin state on `paperclip-data` survives because the
     replacement plugin registers under the same plugin id
     (`paperclip-pixel.paperclip-plugin`). For a local-path install the
     registry row stores the vendored path (`/opt/paperclip-pixel-plugin` —
     the same path in the old and new images), so once the new image runs,
     the persisted row reactivates at boot against the new build's code: a
     pure image swap, no plugin reinstall or data migration step.

   - **Kubernetes (`deploy/k8s`)** — reload the rebuilt images and re-apply;
     the manifests, generated Secrets, and env are unchanged:

     ```bash
     minikube image load paperclip-pixel-host:local
     minikube image load pixel-agents:local
     kubectl apply -k deploy/k8s/
     kubectl -n paperclip-pixels rollout status deploy/paperclip
     kubectl -n paperclip-pixels rollout status deploy/pixel-agents
     ```

   - **Helm chart ([`deploy/helm/paperclip-pixels`](helm/paperclip-pixels))**
     — the chart deploys the two plugins + `common` by construction (the
     host image vendors the Paperclip plugin, the pixel-agents image vendors
     the embedding bundle, both built from the plugin packages). Pull the
     newly built images by tag/digest and `helm upgrade` with the updated
     `image.*.tag`/`image.*.digest` values; no values restructuring is
     needed.

No migration of the old combined package's `dist/` is needed — the images
never read it. On the Paperclip side, config (`pixelAgentsUrl`,
`pixelAgentsTokenRef`, `pixelAgentsAllowedHttpHosts`, …) and per-company
plugin data carry over under the same plugin id; only re-save config if the
feed listener address or shared secret changed.

## Rebuild + redeploy runbook (shared daemon, e2e stack)

Runbook for the disposable e2e bridge stack (compose project
`paperclip-pixels-e2e`) on the shared docker daemon behind the
`docker-socket-proxy` — the deployed stack the canonical `e2e/` Playwright
suite runs against (spec PAPERCLIP_PIXELS-2; SAA-465 / SAA-473 evidence).

**Build access through the socket proxy.** The sandbox has no buildx
component, so `docker build` uses the classic builder: a plain
`POST /build` per step, which the proxy allowlists
(`^(/v[\d\.]+)?/build`, amended 2026-09-01; everything else stays
default-deny and `/session` stays gated off — BuildKit, which needs
`POST /session` + gRPC, is intentionally **not** usable through the proxy).
Consequences:

- Use plain `docker build -t … -f … .` from the repo root. Do **not** use
  `docker compose … up --build` / `DOCKER_BUILDKIT=1` — those need
  buildx/BuildKit and fail against the proxy.
- `docker exec` into the proxy (`EXEC=1`) works for inspecting the live
  HAProxy config at `/tmp/haproxy.cfg` when you need to verify the
  allowlist. Never disable or bypass the proxy.

**1) Rebuild the plugin packages from the current tree** (the images
vendor the pre-built `plugins/*/dist/`; see "Build" above):

```bash
# repo root
npm install && npm run build --workspaces
```

**2) Rebuild both images** (repo root; requires `paperclip/` and
`pixel-agents/` submodules initialized; the pixel-agents image runs
`npm ci` + `esbuild` + `tsc -b && vite build` for the webview, so the
submodule working tree must typecheck):

```bash
docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
docker build -t pixel-agents:local         -f deploy/docker/Dockerfile.pixel-agents .
```

**3) Redeploy the e2e stack** from the fresh images (the checked-in
override publishes Postgres at 15432 and points `PAPERCLIP_PUBLIC_URL` at
the docker bridge gateway). The pixel-agents service now requires the feed
shared secret (fail-closed), and takes the optional board API key that
powers the click-menu reply forwarder:

```bash
PAPERCLIP_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_FEED_TOKEN=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_API_TOKEN=<board-api-key> \
  docker compose -p paperclip-pixels-e2e \
    -f deploy/docker/docker-compose.bridge-stack.yml \
    -f deploy/docker/docker-compose.e2e-override.yml up -d
```

After the first company exists, configure the Paperclip plugin to match:
`pixelAgentsUrl=http://pixel-agents:8081`, a `pixelAgentsTokenRef`
secret holding the same value as `PAPERCLIP_PIXEL_FEED_TOKEN`, and
`pixelAgentsAllowedHttpHosts=["pixel-agents"]` (so the cleartext internal
feed link may carry the bearer token; see "How the bridge reaches Pixel
Agents" above).

`up -d` recreates only services whose image/config changed; named volumes
(`pgdata`, `paperclip-data`) persist. For a fully fresh instance (fresh
instance DB + fresh Paperclip home), also run `docker compose -p
paperclip-pixels-e2e … down -v` first — the stack is disposable and
re-seedable.

**4) Verify + re-seed the board user.**

```bash
docker ps --filter name=paperclip-pixels-e2e   # all services Up, db (healthy)
curl -s http://172.24.0.1:3100/api/health      # {"status":"ok",...}
```

On a fresh instance, create the board user through the real sign-up path
(`POST /api/auth/sign-up/email` with name/email/password), then complete the
board claim in the UI and grant `instance_admin` (procedure recorded on
SAA-465). The `e2e/` suite's login helper performs the same flow
(`e2e/helpers/login.ts`).

Wakeup contract note (verified on the 2026-09-01 redeploy, SAA-473): the
`POST /api/agents/:id/wakeup` route only reads `issueId` from the **nested**
`payload` object (`{"payload":{"issueId":"…"}}` → `contextSnapshot.issueId` →
the `agent.run.*` plugin-event payload). A top-level `issueId` is silently
dropped and the run's `agent.run.failed` event arrives unbound, so the e2e
bound-feedback seed never appears (`e2e/helpers/api-client.ts` `wakeupAgent`
nests it correctly). Also send the deployment's own `Origin` header on
board-mutation API calls, or the board-mutation guard answers 403.

**5) Run the canonical e2e suite against the redeployed stack:**

```bash
cd e2e && pnpm install --frozen-lockfile && npm run install-browsers
PAPERCLIP_PIXEL_E2E_HOST_URL=http://172.24.0.1:3100 \
PAPERCLIP_PIXEL_E2E_LOGIN_ORIGIN=http://172.24.0.1:3100 \
PAPERCLIP_PIXEL_E2E_DB_HOST=172.24.0.1 PAPERCLIP_PIXEL_E2E_DB_PORT=15432 \
PAPERCLIP_PIXEL_E2E_NO_GATE=1 npm test
```

**Leave the stack running and healthy when done** — it is shared with
concurrent workstream legs.

## Configuration

Key env (see `deploy/k8s/paperclip.yaml` for the full set):

- `PAPERCLIP_BIND=lan` — required so the listener is reachable via the pod IP
  (loopback bind is unreachable in k8s; `local_trusted` mode forces loopback,
  which is why the plugin install runs in a throwaway loopback bootstrap).
- `PAPERCLIP_DEPLOYMENT_MODE=authenticated`, `PAPERCLIP_DEPLOYMENT_EXPOSURE=private`.
- `PAPERCLIP_MIGRATION_AUTO_APPLY=true` — the host migrates its own schema.
- `PAPERCLIP_BOOTSTRAP_PORT=3101` — the one-shot loopback bootstrap server port.
- `PAPERCLIP_PIXEL_PLUGIN_PATH=/opt/paperclip-pixel-plugin` — baked-in plugin.
- `DATABASE_URL`, `BETTER_AUTH_SECRET` — required.

The pixel-agents standalone CLI takes `--host 0.0.0.0 --port 8080 --plugin
/opt/paperclip-pixel-embedding/pixel-agents-embedding.cjs` flags (no env
override for the flags themselves; the CLI default `127.0.0.1` is unreachable
in k8s). The embedding module's own env:

- `PAPERCLIP_PIXEL_FEED_HOST`/`PAPERCLIP_PIXEL_FEED_PORT` — feed listener
  bind (default `127.0.0.1:8081`; both containerized topologies set
  `0.0.0.0:8081`).
- `PAPERCLIP_PIXEL_FEED_TOKEN` — **required** shared secret for
  `POST /api/plugin-feed` (constant-time bearer compare, 401 on any
  unauthenticated push; the module refuses to start without it). Configure
  the same value as the Paperclip plugin's `pixelAgentsTokenRef` secret.
- `PAPERCLIP_PIXEL_API_BASE_URL` — Paperclip API base for the click-menu
  reply forwarder (default `http://127.0.0.1:3100`).
- `PAPERCLIP_PIXEL_API_TOKEN` — board API key for the reply forwarder
  (optional; without it replies fail closed with `forwarderNotConfigured`).

**Host-allowlist note (verified live on the 2026-09-02 WS2-D redeploy):** the
forwarder's in-container target uses the compose/k8s service name
(`http://paperclip:3100` /
`http://paperclip.paperclip-pixels.svc.cluster.local:3100`), and Paperclip's
host allowlist answers unknown `Host` headers with
`403 Hostname '…' is not allowed`. Both manifests therefore set
`PAPERCLIP_ALLOWED_HOSTNAMES` to the in-network service name (additive with
the `PAPERCLIP_PUBLIC_URL` hostname) — keep them consistent if you rename the
service or change the forwarder target.

## Shared sprites/characters assets (PAPERCLIP_PIXELS-2 condition C2)

The shared sprite/character catalogs (`plugins/paperclip/assets/characters` +
`plugins/paperclip/assets/composition`) are **image-baked** into both the
paperclip-pixel-host (`/opt/paperclip-pixel-plugin/assets`) and pixel-agents
(`/opt/paperclip-pixel-embedding/assets`) images, so they are rebuilt with the
image. Condition C2 requires the same shared asset set to be deliverable by
**volume** instead of only baked. This is wired across all three deploy
targets, and the baked copy stays the **default fallback** (a container
without the shared-asset volume keeps working).

The mechanism is uniform: a shared-assets volume is mounted at
`/opt/paperclip-pixel-shared-assets` in **both** the paperclip host and the
pixel-agents pod, containing the same `characters/` + `composition/` content
as `plugins/paperclip/assets`. The catalog loaders are pointed at the mounted
catalog with the `PIXEL_CHARACTER_CATALOG` /
`PIXEL_COMPOSITION_CATALOG` env overrides (honored by both plugins'
`resolveCharacterCatalogDir` / `resolveCompositionCatalogDir`). When those
overrides are absent (the default), the image-baked copy is used.

> **Pixel Agents grant note:** the pixel-agents image grants
> `/opt/paperclip-pixel-shared-assets/characters` as a WS1
> `externalAssetDirectories` entry (in addition to the baked
> `/opt/paperclip-pixel-embedding/assets/characters`), so the WS4-C
> `declareCharacterCatalog` privilege gate accepts the shared sheets. The
> privilege gate points at the shared catalog only when `PIXEL_CHARACTER_CATALOG`
> is set (shared assets enabled); otherwise the baked grant path is used.

### Compose (dev)

`deploy/docker/docker-compose.bridge-stack.yml` bind-mounts the repo's
`plugins/paperclip/assets` into both services at
`/opt/paperclip-pixel-shared-assets` and sets the catalog overrides. Override
the source with `PAPERCLIP_PIXELS_SHARED_ASSETS` (e.g. a populated volume /
external checkout). Removing the `volumes:` + env block reverts to the baked
copy.

### Kubernetes (minikube / kustomize)

The base manifests (`deploy/k8s/`) stay baked-only. An **opt-in overlay**
`deploy/overlays/shared-assets/` mounts the same `shared-assets` hostPath
volume at `/opt/paperclip-pixel-shared-assets` in both Deployments and sets the
catalog overrides:

```bash
# populate the host path (minikube node), then apply the overlay
minikube ssh -- sudo mkdir -p /opt/paperclip-pixels/shared-assets
minikube ssh -- sudo cp -r plugins/paperclip/assets/* /opt/paperclip-pixels/shared-assets/
kustomize build deploy/overlays/shared-assets | kubectl apply -f -
```

The overlay is deliberately opt-in so the base manifests keep the baked copy
as the fallback. hostPath is the single-node reference choice; production with
replicas across nodes should use a **ReadWriteMany PVC** (or an object-store /
CSI mount) populated by a seed Job — hostPath is per-node.

### Helm (values-driven)

`deploy/helm/paperclip-pixels` adds a `sharedAssets` values block. When
`sharedAssets.enabled` is `true` the chart mounts the shared-assets PVC at
`/opt/paperclip-pixel-shared-assets` in both workloads and sets the catalog
overrides; it also creates a `*-shared-assets` PVC (unless
`sharedAssets.existingClaim` references your own), and keeps the baked copy as
the fallback while disabled. Populate the claim with `plugins/paperclip/assets`
content.

```bash
helm upgrade --install paperclip-pixels deploy/helm/paperclip-pixels \
  --set secrets.betterAuthSecret=...,secrets.feedToken=...,secrets.postgresPassword=... \
  --set sharedAssets.enabled=true
```

## How the bridge plugin gets loaded (no manual admin step)

Paperclip's `POST /api/plugins/install` requires an instance-admin session in
`authenticated` mode (a human must accept the CEO invite and sign in). To make
the deployment fully automated, the entrypoint (`bridge-stack-entrypoint.sh`):

1. Starts a one-shot **loopback `local_trusted`** server on `127.0.0.1:3101`
   (local-implicit board admin — no auth).
2. `curl POST /api/plugins/install {packageName:/opt/paperclip-pixel-plugin, isLocalPath:true}`
   — installs AND activates the plugin (writes a `ready` registry row + forks
   the worker).
3. Records a marker file on the PVC; stops the bootstrap server.
4. `exec`s the real server in `authenticated`/lan mode. On every subsequent
   boot, the host's `loadAll()` reactivates the persisted `ready` plugin.

This mirrors the upstream `bootstrap-company.sh` company-import pattern.

## Verified state (minikube, single-node)

Historical evidence from the PAPERCLIP_PIXELS-1 deployment (the transport
described below is the **retired** Claude-hook impersonation path, kept as a
record; the live path since WS2-C/WS2-D is the first-class plugin feed —
see "How the bridge reaches Pixel Agents" above):

| Service | Status | Evidence |
|---------|--------|----------|
| Postgres | 1/1 Running | `pg_isready` passes; Paperclip migrations applied |
| Paperclip | 1/1 Running | `GET /api/health` → `{"status":"ok"}`; bridge plugin activated (worker running, 12 event subscriptions, `bridge-reconcile` job dispatched + completed) |
| Pixel Agents | 2/2 Running (main + `paperclip-pixel-relay`, retired since WS2-D) | `GET /api/health` → `{"status":"ok"}`; UI `GET /` → 200 `<title>webview-ui</title>` |
| Bridge (Paperclip → Pixel Agents) | Live-verified against a pristine (`git diff origin/main` empty) `pixel-agents/` checkout (impersonation path, since retired) | A SessionStart/PreToolUse/PostToolUse/Stop/PermissionRequest sequence pushed through the relay produced `[Pixel Agents] Hook: Agent 1 - detected hooks-only external session (...)` and the full animation lifecycle in the real pod logs — zero Pixel Agents source changes. Network path confirmed from inside the actual Paperclip pod (`curl http://pixel-agents:8081/...` → `200 ok`). |

### Probe note

In `authenticated`/`private` exposure mode, `/api/health` returns 403 for
non-loopback callers (kubelet probes hit the pod IP, not 127.0.0.1). The
manifest uses `tcpSocket` probes on port 3100 instead of `httpGet` so the pod
passes readiness/liveness without auth.

## Known limitations / follow-ups

1. **RESOLVED (PAPERCLIP_PIXELS-1) — and superseded by the WS2 plugin path.**
   The original transport (`HttpPushSink` serializing events into the real
   Claude hook JSON body, pushed through the same-pod
   `paperclip-pixel-relay` CLI to the unmodified `/api/hooks/claude`
   endpoint) is **retired**: WS2-C ported the bridge onto the first-class
   plugin feed (the Pixel Agents-side plugin, with the worker relay pushing
   `POST /api/plugin-feed`), and WS2-D wired the embedding surface
   (in-process registration via the fork CLI's generic `--plugin` loader)
   and deleted the dead `bin/paperclip-pixel-relay.js`. The relay container,
   its emptyDir token-sharing volume, and the `watchAllSessions` seed
   initContainer are gone from the deployment manifests with it.

2. **RESOLVED — Bridge plugin packaging.** The worker now builds as a
   self-contained esbuild bundle (`plugins/paperclip/scripts/build.mjs`)
   with `@paperclip-pixel/core`, `@paperclipai/plugin-sdk`, `@paperclipai/shared`,
   and `zod` inlined; only Node built-ins/react/react-dom stay external.
   `deploy/docker/build-plugin-bundle.sh` now just copies `package.json` +
   the already-self-contained `dist/` into the image — no more vendoring
   dependency files or patching `exports` maps.

3. **Two deployment-enabling defects were fixed in this work:**
   - `plugins/paperclip/src/constants.ts` — added the `jobs.schedule`
     capability (the host rejects install with "Capability 'jobs.schedule' is
     required when jobs are declared" because the manifest declares the
     `bridge-reconcile` job).
   - `deploy/docker/Dockerfile.pixel-agents` — copy the server's runtime
     `node_modules` (fastify + plugins) into the runtime stage; esbuild
     externalizes node_modules so the bundle needs them at runtime.

## Reproducibility note for this run

In the execution environment used to produce this, the host docker daemon was a
docker-socket-proxy that **403-blocks `docker build`**, and the minikube
containerd-runtime cluster's `nerdctl build` **starves the single-node control
plane** (DNS/resource exhaustion wedges the API server) under build load. The
manifests/Dockerfiles here are reproducible in any environment with working
image-build capability. See the issue thread for the live-verification status.
