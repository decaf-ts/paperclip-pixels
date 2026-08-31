# @decaf-ts/paperclip-pixels

A loss-minimizing translation layer that makes [Paperclip](https://github.com/paperclipai/paperclip) organizational state (companies, agents, runs, issues, approvals) visible as real, animated characters in [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) — without either project requiring a single source-code change.

One npm package, two things you run:

| What | Where it runs | What it is |
|---|---|---|
| **The Paperclip plugin** | Installed *into* Paperclip, as a forked worker process | `.` export — manifest + worker (event subscriptions, snapshot bootstrap, behavioral proxies, action policy, embedded "Pixel Office" dashboard UI) |
| **`paperclip-pixel-relay`** | A companion process you run *alongside* Pixel Agents | `bin` — a small, zero-dependency CLI that lets the plugin reach Pixel Agents' real (unmodified) hook endpoint |

Paperclip has a real plugin system; Pixel Agents does not (confirmed by reading its source — `hookProviders` is a hardcoded array baked in at build time, there is no plugin-loading mechanism at all). So "installing into Pixel Agents" isn't a thing — instead, `paperclip-pixel-relay` is a normal companion process, the same way you'd run a sidecar or a reverse proxy.

## How it works, in one paragraph

Pixel Agents ships one hook provider (`claudeProvider`) that accepts real Claude Code hook JSON at `POST /api/hooks/claude`. The plugin maps Paperclip events into that exact wire shape and posts them there — landing on Pixel Agents' own pre-existing "hooks-only external provider" adoption path (built for non-Claude tools like OpenCode/Copilot), which is what makes a character spawn and animate with zero Pixel Agents code touched. The one thing genuinely un-workaroundable without touching Pixel Agents source is its bearer token, which is randomly regenerated every boot with no override — so `paperclip-pixel-relay` runs next to Pixel Agents, reads the token straight off `~/.pixel-agents/server.json` on the local filesystem, and forwards the plugin's pushes with the right `Authorization` header attached.

## Install

```bash
npm install @decaf-ts/paperclip-pixels
```

### Part A — install the plugin into Paperclip

**Via the UI:** Organization → Settings → Plugins → **Install Plugin** → enter `@decaf-ts/paperclip-pixels` in the "npm Package Name" field → Install.

**Via the API** (what an automated/scripted deployment uses — this is exactly how `deploy/k8s/` bootstraps it in this repo):

```bash
curl -X POST "$PAPERCLIP_URL/api/plugins/install" \
  -H "Content-Type: application/json" \
  -d '{"packageName": "@decaf-ts/paperclip-pixels"}'
```

(Requires an instance-admin session in `authenticated` mode, or a `local_trusted` loopback session — see Paperclip's own plugin docs for auth details. For a **local, unpublished checkout** instead of the npm registry, pass `"isLocalPath": true` with `packageName` set to the absolute path of this package's directory, e.g. `/opt/paperclip-pixel-plugin` — that's the pattern this repo's own `deploy/docker/bridge-stack-entrypoint.sh` uses.)

Once installed, the plugin needs no further action to start reading Paperclip state — it activates immediately, subscribes to 12 Paperclip event types, and boots a company snapshot on first company access.

### Part B — run the relay next to Pixel Agents

The relay needs filesystem access to Pixel Agents' `~/.pixel-agents/` directory (to read its bearer token), so it must run **on the same machine, or same pod/container-group**, as the Pixel Agents process it's paired with.

```bash
# simplest: npx, no separate install
npx @decaf-ts/paperclip-pixels paperclip-pixel-relay

# or, if you installed the package:
paperclip-pixel-relay --port 8081 --pixel-agents-url http://127.0.0.1:8080
```

Options (all also settable via env var — see `--help`): `--port`/`$RELAY_PORT` (default `8081`), `--host`/`$RELAY_HOST` (default `127.0.0.1`), `--pixel-agents-url`/`$PIXEL_AGENTS_URL` (default `http://127.0.0.1:8080`), `--pixel-agents-home`/`$PIXEL_AGENTS_HOME`, and `--shared-secret`/`$RELAY_SHARED_SECRET`. A unique relay secret of at least 24 characters is mandatory; bind the same value as `pixelAgentsTokenRef` in Paperclip. This prevents the relay from becoming an unauthenticated credential-bearing hook proxy.

**Docker / Kubernetes:** see `deploy/` in this repo for a complete, working minikube stack (Postgres + Paperclip host with the plugin baked in + Pixel Agents + the relay as a same-pod sidecar container) as a concrete reference. The short version: run `paperclip-pixel-relay --host 0.0.0.0` as a second container in the same pod as Pixel Agents, sharing an `emptyDir` volume mounted at `~/.pixel-agents` in both containers.

### Configure the plugin

Set these on the plugin's instance config (Paperclip UI: Plugins → this plugin → Configure; or `POST /api/plugins/:id/config`):

| Field | Default | Meaning |
|---|---|---|
| `pixelAgentsUrl` | `http://127.0.0.1:8081` | Base URL of the running `paperclip-pixel-relay` (**not** Pixel Agents itself — the relay is the one that knows the bearer token). The default assumes Paperclip, the relay, and Pixel Agents are all on one machine; **set this explicitly** whenever the relay runs on a different host/pod than Paperclip (e.g. this repo's own k8s reference deployment, where the relay lives in the Pixel Agents pod). |
| `pixelAgentsTokenRef` | *(required by the relay)* | Secret reference resolved to the relay's shared secret. Pixel Agents' own token remains local to the companion. |
| `pixelAgentsUiUrl` | `http://localhost:8090` | Browser-reachable Pixel Agents URL embedded in the Pixel Office page. |
| `pixelAgentsProviderId` | `claude` | Path segment in the hook URL. Leave as `claude` — it's the only provider id Pixel Agents' unmodified route currently accepts. |
| `pixelAgentsRelayEnabled` | `true` | Explicit on/off switch. |

The relay is **on by default** — no configuration is strictly required to see it work, once both halves are running and reachable from each other.

### Verify it's working

1. Both processes running: Paperclip host with the plugin `status: "ready"` (`GET /api/plugins`), and `paperclip-pixel-relay` logging `listening on ... forwarding to ...`.
2. Trigger any Paperclip agent activity (a run starting is enough).
3. Check the Pixel Agents server logs for a line like:
   ```
   [Pixel Agents] Hook: Agent N - detected hooks-only external session (paperclip-bridge:<companyId>:<agentId>)
   ```
   That's the character being created. From there it animates through the normal tool/turn/permission lifecycle as the agent works.
4. Company-level control (send a message to the company, reply to an agent's feedback) happens through the plugin's own embedded "Pixel Office" page inside Paperclip's UI — not inside the Pixel Agents sprite canvas, which has no chat/text-input mechanism of any kind (by design — see the architecture docs for why).

### Known gap

Pixel Agents' per-character "context window" gauge is fed exclusively from real Claude Code transcript files and has no hook-based path at all — it stays empty for bridge-driven characters. This is a deliberate choice, not a bug: filling it would mean fabricating fake transcript files, and the number wouldn't mean anything honest for a Paperclip agent anyway (Paperclip has no context-window concept to report). The real per-agent workload/concurrency data this would otherwise show is available today in the plugin's own embedded dashboard.

## Documentation

- [`workdocs/tutorials/UserGuide.md`](https://github.com/decaf-ts/paperclip-pixels/blob/master/workdocs/tutorials/UserGuide.md) — operating this once installed: the company/CEO intake flow, replying to agents, reading behavioral signals.
- [`workdocs/tutorials/DeveloperGuide.md`](https://github.com/decaf-ts/paperclip-pixels/blob/master/workdocs/tutorials/DeveloperGuide.md) — monorepo layout, how the event mapping works, running the test suite, extending the bridge.
- [`deploy/README.md`](https://github.com/decaf-ts/paperclip-pixels/blob/master/deploy/README.md) — full Kubernetes/Docker reference deployment.

## License

MIT
