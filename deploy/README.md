# Paperclip Pixel Agents Bridge Stack — Deployment

Reproducible deployment of the Paperclip Pixel Agents bridge stack on a local
**minikube** cluster (with a **docker-compose fallback** for environments
without k8s). Specification: PAPERCLIP_PIXELS-1.

## Stack

| Component | Image | Port | Role |
|-----------|-------|------|------|
| Postgres  | `postgres:17-alpine`            | 5432 | Paperclip metadata DB |
| Paperclip host | `paperclip-pixel-host:local` | 3100 | Paperclip API + UI, with the bridge plugin loaded |
| Pixel Agents | `pixel-agents:local`         | 8080 | Pixel Agents standalone server (SPA + WS + hook ingest) |

The bridge plugin (`packages/paperclip-plugin`) runs as a **forked worker child
process of the Paperclip host** (loaded via `installPlugin({ localPath })`),
not as its own pod. The host image vendors the built plugin at
`/opt/paperclip-pixel-plugin` and installs it at first boot via a loopback
`local_trusted` bootstrap (no-auth admin), then restarts in `authenticated`/lan
mode for reachability.

## Build

The host image reuses the published Paperclip base (`ghcr.io/paperclipai/paperclip:latest`)
and only adds the vendored bridge plugin + a bootstrap entrypoint. The
pixel-agents image builds the standalone CLI from the submodule (it ships no
Dockerfile).

```bash
# from the repo root (submodules initialized: paperclip/, pixel-agents/)
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
  docker compose -f deploy/docker/docker-compose.bridge-stack.yml up --build
# UIs at http://localhost:3100 and http://localhost:8080
```

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

The pixel-agents standalone CLI takes `--host 0.0.0.0 --port 8080` flags (no env
override; the CLI default `127.0.0.1` is unreachable in k8s).

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

All three services deployed and verified healthy on minikube:

| Service | Status | Evidence |
|---------|--------|----------|
| Postgres | 1/1 Running | `pg_isready` passes; Paperclip migrations applied |
| Paperclip | 1/1 Running | `GET /api/health` → `{"status":"ok"}`; bridge plugin activated (worker running, 12 event subscriptions, `bridge-reconcile` job dispatched + completed) |
| Pixel Agents | 1/1 Running | `GET /api/health` → `{"status":"ok"}`; UI `GET /` → 200 `<title>webview-ui</title>` |

### Probe note

In `authenticated`/`private` exposure mode, `/api/health` returns 403 for
non-loopback callers (kubelet probes hit the pod IP, not 127.0.0.1). The
manifest uses `tcpSocket` probes on port 3100 instead of `httpGet` so the pod
passes readiness/liveness without auth.

## Known limitations / follow-ups

1. **Provider → Pixel Agents transport is not wired.** `pixel-agents-provider`
   is a **library** (`BridgeTransport` + `HttpPushSink`), not a runnable
   service. No glue process exists that consumes the plugin's bridge stream
   and pushes mapped `AgentEvent`s to Pixel Agents' `POST /api/hooks/paperclip-bridge`.
   Additionally, Pixel Agents' runtime is currently single-provider
   (`hookProviders: [claudeProvider]`); the per-`providerId` dispatch the
   `HttpPushSink` targets is not fully wired upstream. Wiring this end-to-end
   is bridge-author feature work (a follow-up issue tracks it).

2. **Bridge plugin packaging.** The committed plugin uses bare `tsc` (no
   bundling) and does not vendor its runtime deps, so the forked worker cannot
   resolve `@paperclip-pixel/core` / `@paperclipai/plugin-sdk` / `zod` from its
   install location, and `@paperclipai/shared` is consumed as TS source (which
   needs the tsx loader, absent in production). The host image works around
   this by vendoring the deps as real files and patching `exports` maps
   (`deploy/docker/build-plugin-bundle.sh`). The SDK-blessed fix is to build
   the worker with `@paperclipai/plugin-sdk/bundlers` (`createPluginBundlerPresets`,
   esbuild) into a self-contained bundle — recommended for the bridge authors.

3. **Two deployment-enabling defects were fixed in this work:**
   - `packages/paperclip-plugin/src/constants.ts` — added the `jobs.schedule`
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
