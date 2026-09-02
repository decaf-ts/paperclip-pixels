# Paperclip Pixel Agents Bridge Stack — Deployment

Reproducible deployment of the Paperclip Pixel Agents bridge stack on a local
**minikube** cluster (with a **docker-compose fallback** for environments
without k8s). Specification: PAPERCLIP_PIXELS-1; plugin-architecture rework:
PAPERCLIP_PIXELS-2 (WS2-C bridge port + WS2-D embedding surface).

## Stack

| Component | Image | Port | Role |
|-----------|-------|------|------|
| Postgres  | `postgres:17-alpine`            | 5432 | Paperclip metadata DB |
| Paperclip host | `paperclip-pixel-host:local` | 3100 | Paperclip API + UI, with the bridge plugin loaded |
| Pixel Agents | `pixel-agents:local`         | 8080 (UI/WS), 8081 (plugin feed) | Pixel Agents standalone server (SPA + WS) **with the Paperclip bridge embedding module loaded in-process** via the fork CLI's generic `--plugin` loader |

The bridge plugin is published as [`@decaf-ts/paperclip-pixels`](..) (source: repo root — `src/`) and runs as a **forked worker child
process of the Paperclip host** (loaded via `installPlugin({ localPath })`
in this reference deployment; a real install uses `installPlugin({ packageName: "@decaf-ts/paperclip-pixels" })` instead — see the [package README](../README.md#install)),
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
  (this repo's `src/pixel-agents-plugin/embedding.ts`, bundled by
  `npm run build` and vendored into the image). Through the fork's generic
  plugin-module loader the module registers the Paperclip plugin in-process
  (manifest + reply actions through the WS2-A1/A2 plugin host) and serves
  `POST /api/plugin-feed` on its own sidecar listener (`:8081`).
- The Paperclip worker's relay (`src/relay.ts`) pushes feed-operation
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
one. **After creating your first company**, set `pixelAgentsUrl` to
`http://pixel-agents:8081` (the feed listener's cluster address) and
`pixelAgentsTokenRef` to a Paperclip secret holding the same shared secret
as `PAPERCLIP_PIXEL_FEED_TOKEN` on the plugin's instance config — Paperclip
UI: Plugins → this plugin → Configure, or `POST /api/plugins/:id/config`;
see the [package README](../README.md#configure-the-plugin). There
is currently no automated way to set this before a company exists (Paperclip
plugin config is company-scoped), so this is a one-time manual step per
deployment, not something the entrypoint script can do for you.

## Build

The host image reuses the published Paperclip base (`ghcr.io/paperclipai/paperclip:latest`)
and only adds the vendored bridge plugin + a bootstrap entrypoint. The
pixel-agents image builds the standalone CLI from the submodule (it ships no
Dockerfile) **and vendors the bridge embedding module** — so the plugin repo
build must run before either image is built.

```bash
# from the repo root (submodules initialized: paperclip/, pixel-agents/)
# 1. Build the bridge plugin first — the host image vendors the plugin's
#    pre-built dist/ (worker + manifest + UI bundle), and the pixel-agents
#    image vendors dist/pixel-agents-embedding.cjs (the in-process embedding
#    module the fork CLI loads via --plugin). `npm run build` bundles the
#    worker/manifest/embedding with esbuild then the UI with
#    scripts/build-ui.mjs.
( npm install && npm run build )
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

# The pixel-agents pod reads the feed shared secret + optional reply API key
# from a k8s secret (see deploy/k8s/pixel-agents.yaml env):
kubectl -n paperclip-pixels create secret generic paperclip-pixel-feed \
  --from-literal=token="$(openssl rand -hex 32)" \
  --from-literal=apiToken='<board-api-key>'

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

**1) Rebuild the plugin bundle from the current tree** (the host image
vendors the pre-built `dist/`; see "Build" above):

```bash
# repo root
npm install && npm run build
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
`pixelAgentsUrl=http://pixel-agents:8081` and a `pixelAgentsTokenRef`
secret holding the same value as `PAPERCLIP_PIXEL_FEED_TOKEN` (see "How the
bridge reaches Pixel Agents" above).

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
PAPERCLIP_PIXEL_E2E_HOST_URL=LOGIN_ORIGIN=http://172.24.0.1:3100 \
DB_HOST=172.24.0.1 DB_PORT=15432 NO_GATE=1 npm test
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
   plugin feed (`src/pixel-agents-plugin/`, `src/relay.ts` pushing
   `POST /api/plugin-feed`), and WS2-D wired the embedding surface
   (in-process registration via the fork CLI's generic `--plugin` loader)
   and deleted the dead `bin/paperclip-pixel-relay.js`. The relay container,
   its emptyDir token-sharing volume, and the `watchAllSessions` seed
   initContainer are gone from the deployment manifests with it.

2. **RESOLVED — Bridge plugin packaging.** The worker now builds as a
   self-contained esbuild bundle (`scripts/build.mjs`)
   with `@paperclip-pixel/core`, `@paperclipai/plugin-sdk`, `@paperclipai/shared`,
   and `zod` inlined; only Node built-ins/react/react-dom stay external.
   `deploy/docker/build-plugin-bundle.sh` now just copies `package.json` +
   the already-self-contained `dist/` into the image — no more vendoring
   dependency files or patching `exports` maps.

3. **Two deployment-enabling defects were fixed in this work:**
   - `src/constants.ts` — added the `jobs.schedule`
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
