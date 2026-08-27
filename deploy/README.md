# Paperclip Pixel Agents Bridge Stack — Deployment

Reproducible deployment of the Paperclip Pixel Agents bridge stack on a local
**minikube** cluster (with a **docker-compose fallback** for environments
without k8s). Specification: PAPERCLIP_PIXELS-1.

## Stack

| Component | Image | Port | Role |
|-----------|-------|------|------|
| Postgres  | `postgres:17-alpine`            | 5432 | Paperclip metadata DB |
| Paperclip host | `paperclip-pixel-host:local` | 3100 | Paperclip API + UI, with the bridge plugin loaded |
| Pixel Agents | `pixel-agents:local`         | 8080 | Pixel Agents standalone server (SPA + WS + hook ingest) — **unmodified upstream** |
| Relay | `pixel-agents:local` (same image, `command` override) | 8081 | `paperclip-pixel-relay` CLI, same pod as Pixel Agents — see below |

The bridge plugin is published as [`@decaf-ts/paperclip-pixels`](..) (source: repo root — `src/`, `bin/`) and runs as a **forked worker child
process of the Paperclip host** (loaded via `installPlugin({ localPath })`
in this reference deployment; a real install uses `installPlugin({ packageName: "@decaf-ts/paperclip-pixels" })` instead — see the [package README](../README.md#install)),
not as its own pod. The host image vendors the built plugin at
`/opt/paperclip-pixel-plugin` and installs it at first boot via a loopback
`local_trusted` bootstrap (no-auth admin), then restarts in `authenticated`/lan
mode for reachability.

### How the bridge reaches Pixel Agents (zero source changes, either side)

Pixel Agents ships exactly one hook provider (`claudeProvider`, id `claude`)
and its `POST /api/hooks/:id` route only forwards Claude-shaped bodies. Rather
than requiring an upstream change to add a second provider, the relay
(`@paperclip-pixel/pixel-agents-provider`'s `HttpPushSink`, an internal
dependency inlined into the published package's bundle) serializes every
mapped bridge event into the **real Claude hook JSON body**
`claudeProvider.normalizeHookEvent` already accepts, and never sends a
`transcript_path` — which routes every synthetic session onto Pixel Agents'
own existing "hooks-only external provider" adoption path (built for
non-Claude CLIs like OpenCode/Copilot; see `fileWatcher.ts`'s
`adoptExternalSessionFromHook`). Confirmed live: pushing this shape produces
`[Pixel Agents] Hook: Agent N - detected hooks-only external session (...)`
in the pod logs and a real, animated character — no Pixel Agents source
touched.

The one thing that genuinely cannot be worked around without touching source
is Pixel Agents' bearer token: it's a fresh `crypto.randomUUID()` minted on
every boot with no env/CLI override, so nothing outside the pod can know it
in advance. `paperclip-pixel-relay` (published as this package's `bin`,
source: `bin/paperclip-pixel-relay.js`, zero
deps) runs as a second container in the **same pod**, sharing an
`emptyDir` `~/.pixel-agents` volume with the main container so it can read
the token straight off disk, and forwards the plugin's already-correctly-shaped
push to the real `/api/hooks/claude` endpoint with the right
`Authorization: Bearer` header. `deploy/k8s/pixel-agents.yaml` also seeds
`~/.pixel-agents/config.json` with `watchAllSessions: true` via an
initContainer (data, not code — `configPersistence.ts` already reads this
exact file/shape) since a synthetic Paperclip `cwd` is never a "tracked"
project directory.

The Paperclip-side plugin config (`pixelAgentsUrl`) defaults to
`http://127.0.0.1:8081` — right for the common single-machine "try it out"
case, but **wrong for this k8s topology**, where the relay runs in the Pixel
Agents pod, not the Paperclip one. **After creating your first company**, set
`pixelAgentsUrl` to `http://pixel-agents:8081` (the relay's cluster address)
on the plugin's instance config — Paperclip UI: Plugins → this plugin →
Configure, or `POST /api/plugins/:id/config`; see the [package
README](../README.md#configure-the-plugin). There
is currently no automated way to set this before a company exists (Paperclip
plugin config is company-scoped), so this is a one-time manual step per
deployment, not something the entrypoint script can do for you.

Only "controlling Paperclip from inside Pixel Agents" was not attempted: the
standalone Pixel Agents web UI has no free-text/chat mechanism anywhere in
its protocol (confirmed by reading the full `ClientMessage` union and the
webview source — no `<textarea>`, no chat/reply code path) and no terminal
concept at all (`cli.ts` never constructs a `TerminalAdapter` — that's
VS-Code-adapter-only). Building one would require an actual Pixel Agents
source change, so per this project's own new-work rule ("all new tickets go
through the CEO; other agent interaction is purely conversational, and can be
skipped where no such concept already exists") this stays out of scope.
Company intake and agent-reply control **do** work today, through the
existing Paperclip-embedded "Pixel Office" plugin page (`packages/
paperclip-plugin/src/ui/PixelOfficePage.tsx`) — it just renders inside
Paperclip's own UI, not inside the separate sprite-based office canvas.

## Build

The host image reuses the published Paperclip base (`ghcr.io/paperclipai/paperclip:latest`)
and only adds the vendored bridge plugin + a bootstrap entrypoint. The
pixel-agents image builds the standalone CLI from the submodule (it ships no
Dockerfile).

```bash
# from the repo root (submodules initialized: paperclip/, pixel-agents/)
# 1. Build the bridge plugin first — the host image vendors the plugin's
#    pre-built dist/ (worker + manifest + UI bundle). `npm run build` bundles
#    the worker/manifest with esbuild then the UI with scripts/build-ui.mjs,
#    producing dist/worker.js, dist/manifest.js, and dist/ui/index.js (the UI
#    bundle the host mounts from manifest.entrypoints.ui).
( npm install && npm run build )
# 2. Build the images. The host image reuses the published Paperclip base
#    (ghcr.io/paperclipai/paperclip:latest) and only adds the vendored bridge
#    plugin + a bootstrap entrypoint. The pixel-agents image builds the
#    standalone CLI from the submodule (it ships no Dockerfile).
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

All three services deployed and verified healthy on minikube, including a
live end-to-end bridge push:

| Service | Status | Evidence |
|---------|--------|----------|
| Postgres | 1/1 Running | `pg_isready` passes; Paperclip migrations applied |
| Paperclip | 1/1 Running | `GET /api/health` → `{"status":"ok"}`; bridge plugin activated (worker running, 12 event subscriptions, `bridge-reconcile` job dispatched + completed) |
| Pixel Agents | 2/2 Running (main + `paperclip-pixel-relay`) | `GET /api/health` → `{"status":"ok"}`; UI `GET /` → 200 `<title>webview-ui</title>` |
| Bridge (Paperclip → Pixel Agents) | Live-verified against a pristine (`git diff origin/main` empty) `pixel-agents/` checkout | A SessionStart/PreToolUse/PostToolUse/Stop/PermissionRequest sequence pushed through the relay produced `[Pixel Agents] Hook: Agent 1 - detected hooks-only external session (...)` and the full animation lifecycle in the real pod logs — zero Pixel Agents source changes. Network path confirmed from inside the actual Paperclip pod (`curl http://pixel-agents:8081/...` → `200 ok`). |

### Probe note

In `authenticated`/`private` exposure mode, `/api/health` returns 403 for
non-loopback callers (kubelet probes hit the pod IP, not 127.0.0.1). The
manifest uses `tcpSocket` probes on port 3100 instead of `httpGet` so the pod
passes readiness/liveness without auth.

## Known limitations / follow-ups

1. **RESOLVED — Provider → Pixel Agents transport is now wired.** `HttpPushSink`
   (`src/pixel-agents-provider/transport.ts`) serializes every mapped
   event into the real Claude hook JSON body and pushes it through the
   same-pod `paperclip-pixel-relay` CLI (published as this package's `bin` —
   see `README.md`) to Pixel Agents' real,
   unmodified `/api/hooks/claude` endpoint — see "How the bridge reaches
   Pixel Agents" above. Live-verified: a pushed event produces a real
   character (`[Pixel Agents] Hook: Agent N - detected hooks-only external session`)
   and the full tool/turn/permission animation lifecycle, with zero Pixel
   Agents source changes.

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
