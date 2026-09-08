# Paperclip Pixels — Paperclip ↔ Pixel Agents bridge

A loss-minimizing translation layer that makes [Paperclip](https://github.com/paperclipai/paperclip) organizational state (companies, agents, runs, issues, approvals) visible as real, animated characters in a [Pixel Agents](https://github.com/pixel-agents-hq/pixel-agents) pixel office — integrated strictly through public extension surfaces: Paperclip's Plugin SDK on one side, the Pixel Agents fork's generic plugin host on the other.

## Architecture: two plugins, one wire contract

The bridge ships as **two independent plugins joined by a neutral contract package** (board Revision 3 target shape):

| Package | Path | Runs in | Owns |
|---|---|---|---|
| `paperclip-pixels-common` | [`./common`](./common) | *(nowhere — schemas only)* | The versioned wire contract: feed DTOs, Zod validation, operation ids, error codes, `schemaVersion` compatibility rules, fixture builders. Imports no other package. |
| `@decaf-ts/paperclip-pixels-plugin` | [`./plugins/paperclip`](./plugins/paperclip) | The Paperclip host (forked plugin worker) | Snapshot bootstrap + event subscriptions, temporal metrics, behavioral proxies, policy (fail-closed new-work gate), persistence, the Pixel Office UI (`page` + `sidebar` slots), and the outbound feed mapper + HTTP sink/retry client. |
| `@decaf-ts/pixel-agents-paperclip-plugin` | [`./plugins/pixel-agents`](./plugins/pixel-agents) | The Pixel Agents server process | Plugin manifest + lifecycle registration, the authenticated `POST /api/plugin-feed` endpoint, idempotent feed-operation application, agent/appearance/layout sources, and reverse-action (reply) forwarding. |

The two plugin packages depend **only** on `paperclip-pixels-common`, never on each other. The two upstream trees in this repo are references:

- [`./paperclip`](./paperclip) — the Paperclip core submodule. Reference-only, never modified: the bridge uses only the public Plugin SDK (`page`, `sidebar`, and agent-scoped `detailTab` slots).
- [`./pixel-agents`](./pixel-agents) — a deliberate **fork** of upstream `pixel-agents-hq/pixel-agents` (baseline upstream tag `v1.4.1`, local tag `fork-baseline-v1.4.1`). The fork adds the generic plugin host the bridge loads through. Upstream is **reference-only — never PR'd**; divergence is tracked unilaterally in the fork's `FORK.md` policy and `DIVERGENCE.md` log (one row per fork-side change), and the fork lives at its own remote (`decaf-ts/as-pixels`, branch `legacy`).

### How it works, in one paragraph

The Paperclip plugin worker observes Paperclip (authoritative snapshot + subscribed events), reduces them into per-company state, and pushes **feed operations** — `declareAgents` / `removeAgents` / `updateAgentStatus` / `updateAgentActivity` / `assignAgentAppearance` / `dialogLines`, batched as `{ schemaVersion, companyId, operations }` — to the Pixel Agents plugin's `POST /api/plugin-feed` endpoint over HTTP with a **bearer shared secret** (constant-time compare, 401 fail-closed, token never in the URL). The Pixel Agents plugin is loaded in-process by the fork's generic `--plugin <module>` host, applies those operations through the host's **sanctioned agent/team and appearance sources**, and forwards click-menu replies back to Paperclip through the host's performAction proxy into the plugin's existing fail-closed feedback actions. Pixel Agents **may request actions but can never create work** — all new work originates through Paperclip's company/leadership intake, enforced structurally on the action path.

## Install and run (two-plugin deployment)

The quickest path is the reference Compose stack, which builds both plugin halves from this repo and wires the shared secret for you:

```bash
git clone --recurse-submodules <this-repo> && cd paperclip-pixels
npm install && npm run build --workspaces   # builds common + both plugins, incl. the Pixel Agents embedding bundle
PAPERCLIP_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_FEED_TOKEN=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.bridge-stack.yml up --build
# Paperclip UI: http://localhost:3100 — Pixel Agents UI: http://localhost:8080
```

See [`deploy/README.md`](./deploy/README.md) for the full minikube/Kubernetes reference, the e2e runbook, and every environment variable.

Manual (component-by-component) deployment:

1. **Paperclip side** — install the Paperclip plugin. Via the UI: Organization → Settings → Plugins → **Install Plugin**; or via the API (`POST /api/plugins/install`, requires an instance-admin session):
   ```bash
   curl -X POST "$PAPERCLIP_URL/api/plugins/install" \
     -H "Content-Type: application/json" \
     -d '{"packageName": "@decaf-ts/paperclip-pixels-plugin"}'
   ```
   For a local unpublished checkout pass `"isLocalPath": true` with `packageName` set to the absolute path of the built `plugins/paperclip` package — the pattern `deploy/docker/bridge-stack-entrypoint.sh` uses.
2. **Pixel Agents side** — run the Pixel Agents fork (server + webview) with the bridge plugin module loaded through the fork's generic `--plugin` host:
   ```bash
   PAPERCLIP_PIXEL_FEED_TOKEN=<shared-secret> \
   pixel-agents --host 0.0.0.0 --port 8080 \
     --plugin /path/to/pixel-agents-embedding.cjs
   ```
   The embedding bundle is produced by `npm run build` in `plugins/pixel-agents` (`plugins/pixel-agents/dist/pixel-agents-embedding.cjs`; the reference images vendor it at `/opt/paperclip-pixel-embedding/`). The module **refuses to start** without `PAPERCLIP_PIXEL_FEED_TOKEN` — the feed endpoint is fail-closed by construction.
3. **Configure the Paperclip plugin** (below) so the worker pushes to your Pixel Agents plugin's feed listener.

### Upgrading from the former combined package

Before the two-plugin rework, this repo's root published one combined bridge package — a single npm entry that installed the Paperclip plugin *and* shipped the Pixel Agents embedding module from one root `dist/`. **That combined entry is removed and no longer published or shipped; the two-plugin install above is the only supported path.** The repo root is now a private workspace root (not published at all), and the installable Paperclip-side plugin is `@decaf-ts/paperclip-pixels-plugin`.

If you installed the combined package, migrate as follows:

1. **Replace the Paperclip plugin** — install `@decaf-ts/paperclip-pixels-plugin` by name (UI: Organization → Settings → Plugins → **Install Plugin**; or the `POST /api/plugins/install` call above). The replacement registers under the **same plugin id** (`paperclip-pixel.paperclip-plugin`), so Paperclip takes over the existing registry row instead of creating a new one. **Do not uninstall the old plugin first** — uninstall soft-deletes the plugin record (and `purge: true` hard-deletes its persisted data); installing over it preserves everything.
2. **Re-check the config** — `pixelAgentsUrl` and `pixelAgentsTokenRef` keep their stored values across the swap; they now simply target the feed listener of the plugin-owned embedding module (step 3). Re-save them only if that address or shared secret changed.
3. **Swap the Pixel Agents embedding bundle** — the embedding module is now built by [`plugins/pixel-agents`](./plugins/pixel-agents) (`plugins/pixel-agents/dist/pixel-agents-embedding.cjs`), no longer by the root package. Replace the old bundle path in the fork's `--plugin <module>` flag and restart Pixel Agents with the same `PAPERCLIP_PIXEL_FEED_TOKEN`.
4. **Nothing else migrates** — the worker's persisted state (per-company snapshots, character/appearance assignments, metrics) lives in Paperclip's plugin-data storage under that same plugin id, so it survives the swap as-is; characters reappear as agents become active. The old package's `dist/` does not need to be kept or migrated — remove the old npm install when convenient.

For the deployment flavors (Compose, Kubernetes/Helm) see the upgrade runbook in [`deploy/README.md`](./deploy/README.md#upgrading-a-deployment-from-the-former-combined-package); for the day-to-day operator view see the [User Guide](./workdocs/tutorials/UserGuide.md#upgrading-from-the-former-combined-package).

## Configuration reference

### Paperclip plugin instance config

Set on the plugin's instance config (Paperclip UI: Plugins → this plugin → Configure, or `POST /api/plugins/:id/config`). Global-only; per-agent values (character + hue) live on the Pixel Office page's picker.

| Key | Default | Meaning |
|---|---|---|
| `pixelAgentsUrl` | `http://127.0.0.1:8081` | Base URL of the Pixel Agents plugin's feed listener (`POST /api/plugin-feed`). Set explicitly for separate-container topologies (e.g. `http://pixel-agents:8081` in the reference stack). |
| `pixelAgentsTokenRef` | *(none)* | Secret reference resolved to the feed shared secret (the same value as `PAPERCLIP_PIXEL_FEED_TOKEN` on the Pixel Agents side). With a token configured, `pixelAgentsUrl` must be valid http(s). |
| `pixelAgentsAllowedHttpHosts` | `[]` | Internal hostnames the operator explicitly trusts to carry the feed bearer token over cleartext `http:` (the transport contract otherwise rejects token-on-cleartext for non-loopback hosts). Set `["pixel-agents"]` for the bundled Compose topology. |
| `pixelAgentsUiUrl` | `http://localhost:8090` | Browser-reachable Pixel Agents URL embedded in the Pixel Office page iframe. |
| `pixelAgentsRelayEnabled` | on when `pixelAgentsUrl` is set | Explicit on/off switch for the feed push. |
| `paperclipApiBaseUrl` | `http://127.0.0.1:3100` | Paperclip API base the worker polls for real tool-call activity (`GET /api/heartbeat-runs/:runId/log`); also the reply-forwarder target base. Only used when `paperclipApiTokenRef` is set. |
| `paperclipApiTokenRef` | *(none)* | Board API key for the tool-activity poller. Without it, activity shows the generic "Task: …" placeholder; everything else keeps working. |
| `dialogPanePrivacyOptIn` | `false` | Per-company opt-in for fuller (still bounded) conversation extracts in the office's dialog pane. OFF ships only pre-redacted, truncated excerpts; redaction is always on. |

### Pixel Agents plugin environment

The embedding module runs inside the Pixel Agents server process and has no Paperclip config channel, so it reads environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PAPERCLIP_PIXEL_FEED_TOKEN` | *(required)* | Shared secret for `POST /api/plugin-feed`. Must equal the Paperclip-side `pixelAgentsTokenRef`. Startup fails without it. |
| `PAPERCLIP_PIXEL_FEED_HOST` / `PAPERCLIP_PIXEL_FEED_PORT` | `127.0.0.1` / `8081` | Feed listener bind. Containerized topologies set `0.0.0.0:8081`. |
| `PAPERCLIP_PIXEL_API_BASE_URL` | `http://127.0.0.1:3100` | Paperclip API base for the click-menu reply forwarder. |
| `PAPERCLIP_PIXEL_API_TOKEN` | *(none)* | Board API key for the reply forwarder. Without it replies fail closed with `forwarderNotConfigured`. |

### Transport (TLS vs cleartext)

Cleartext HTTP stays available **via config** for internal hosts: with a feed token configured, a plain `http:` `pixelAgentsUrl` is accepted only for loopback, the bundled deployment service names, or a host the operator declares in `pixelAgentsAllowedHttpHosts` — anything else is rejected at configure time and the relay is disabled fail-secure. **TLS/mTLS is the production default**: production deployments should front the feed listener with TLS (or a mesh-authenticated private channel) and use an `https:` URL; the cleartext exception exists for loopback dev and trusted internal service names, not for the public internet.

## Verify it's working

1. Paperclip host: plugin `status: "ready"` (`GET /api/plugins`).
2. Pixel Agents server: started with `--plugin <embedding module>` and no startup abort; the feed listener answers `401` without credentials (that's the fail-closed gate working).
3. Trigger any Paperclip agent activity (a run starting is enough). Characters spawn on first activity, animate while working (`PaperclipWork` status), show a permission bubble on pending approvals, a "waiting for input" state on human questions, and despawn when the agent goes offline.
4. Interaction happens through the plugin's **Pixel Office** page inside Paperclip's UI (company intake, agent replies, behavioral signals) and through the click-menu **Reply…** action on a character in the office — both route into the same fail-closed Paperclip actions. The sprite canvas itself has no free-text input (by design).

### Troubleshooting

- **No characters appear** — check `pixelAgentsRelayEnabled` is on and `pixelAgentsUrl` points at the feed listener (the Pixel Agents container, not its UI port); check the shared secret matches on both sides (`pixelAgentsTokenRef` ↔ `PAPERCLIP_PIXEL_FEED_TOKEN`); check the Pixel Agents server actually started with `--plugin` (the loader aborts startup on a module that fails to load).
- **Pushes rejected with 401** — token mismatch; the endpoint compares constant-time and never accepts the token via URL.
- **Feed configured but nothing arrives on a non-loopback `http:` URL** — the transport contract rejected a token on an untrusted cleartext host; add the hostname to `pixelAgentsAllowedHttpHosts` or front the listener with TLS.
- **Characters render bundled palettes instead of the 24-sheet catalog** — the catalog directory must be granted to Pixel Agents through the fork's privilege-gated `addExternalAssetDirectory` path (see the [architecture handbook](./workdocs/ai/architecture-handbook.md) §5.7); the declaration is retried on plugin restart.
- **Click-menu replies fail with `forwarderNotConfigured`** — set `PAPERCLIP_PIXEL_API_TOKEN` (a board API key) on the Pixel Agents side.

### Known gap

Pixel Agents' per-character "context window" gauge is fed exclusively from real Claude Code transcript files — it stays empty for bridge-driven characters. This is deliberate: filling it would mean fabricating fake transcript data. The real per-agent workload/concurrency data is in the plugin's own Pixel Office dashboard.

## Documentation

- [`workdocs/tutorials/UserGuide.md`](./workdocs/tutorials/UserGuide.md) — install/configure/run for the two-plugin deployment and day-to-day operation: intake flow, replying to agents, reading behavioral signals.
- [`workdocs/tutorials/DeveloperGuide.md`](./workdocs/tutorials/DeveloperGuide.md) — repo/package layout, how the feed mapping works, building and testing each package, extending the bridge.
- [`workdocs/ai/architecture-handbook.md`](./workdocs/ai/architecture-handbook.md) — components, contracts, trust boundaries, security architecture, decisions and risks.
- [`deploy/README.md`](./deploy/README.md) — full Docker/Kubernetes reference deployment, configuration, and the e2e runbook.

## License

MIT
