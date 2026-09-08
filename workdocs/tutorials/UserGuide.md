# User Guide — Paperclip ↔ Pixel Agents Bridge

This guide covers installing, configuring, and running the two-plugin bridge deployment, then using it day to day. The quickest way to try it out is the reference Compose stack — see [`deploy/README.md`](../deploy/README.md) for the full Kubernetes/Docker walkthrough you can copy from.

## Install / configure / run (two-plugin deployment)

The bridge is two plugins joined by a neutral wire contract:

- the **Paperclip plugin** (`@decaf-ts/paperclip-pixels-plugin`, canonical source `plugins/paperclip/`) — installed into Paperclip, where its worker observes events and pushes feed operations; and
- the **Pixel Agents plugin** (`@decaf-ts/pixel-agents-paperclip-plugin`, canonical source `plugins/pixel-agents/`) — loaded into the Pixel Agents fork's server process through its generic `--plugin <module>` host, where it serves the authenticated `POST /api/plugin-feed` endpoint and applies operations to the office.

### Run the reference stack

```bash
git clone --recurse-submodules <this-repo> && cd paperclip-pixels
npm install && npm run build --workspaces
PAPERCLIP_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_FEED_TOKEN=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.bridge-stack.yml up --build
# Paperclip UI: http://localhost:3100 — Pixel Agents UI: http://localhost:8080
```

The compose stack builds both images (Paperclip host with the plugin vendored; Pixel Agents fork with the bridge embedding module vendored) and wires the feed shared secret end to end. The full variable set and the minikube equivalent are in [`deploy/README.md`](../deploy/README.md).

### Configure

1. Install the Paperclip plugin (UI: Organization → Settings → Plugins → Install Plugin, or `POST /api/plugins/install`) — see the [package README](../README.md#install-and-run-two-plugin-deployment) for the exact requests, including local-checkout installs.
2. Run Pixel Agents with `--plugin <embedding module>` and `PAPERCLIP_PIXEL_FEED_TOKEN` set (the module refuses to start without the token).
3. After creating your first company, point the Paperclip plugin at the feed listener: `pixelAgentsUrl` (e.g. `http://pixel-agents:8081` in the containerized stack), `pixelAgentsTokenRef` holding the same secret as `PAPERCLIP_PIXEL_FEED_TOKEN`, and — for a cleartext internal hostname — `pixelAgentsAllowedHttpHosts: ["pixel-agents"]`. The full configuration reference (all keys, both sides, transport rules) lives in the [package README](../README.md#configuration-reference).

## Upgrading from the former combined package

If you installed the bridge as the old single combined package (the pre-split npm entry that installed the Paperclip plugin and shipped the Pixel Agents embedding module from one root), that entry is **removed and no longer published or shipped** — the two-plugin deployment described above is the only supported path. The upgrade is a swap, not a reconfiguration:

1. **Install the replacement plugin** — Organization → Settings → Plugins → **Install Plugin** → `@decaf-ts/paperclip-pixels-plugin` (or the API equivalent; see the [package README](../README.md#upgrading-from-the-former-combined-package)). It registers under the same plugin id as the combined install, so your existing config and data are taken over in place. Don't uninstall the old plugin first — uninstalling removes the plugin record, and `purge` deletes its data.
2. **Re-check the config** — `pixelAgentsUrl` and `pixelAgentsTokenRef` keep their values; re-save them only if the feed listener's address or shared secret changed.
3. **Swap the embedding bundle on the Pixel Agents side** — the `--plugin` module now comes from the Pixel Agents plugin package (`plugins/pixel-agents/dist/pixel-agents-embedding.cjs`). Point the flag at the new bundle and restart with the same `PAPERCLIP_PIXEL_FEED_TOKEN`.
4. **Your office carries over** — characters, picked appearances, and metrics history persist in Paperclip's plugin data under the same plugin id, so nothing is lost and nothing needs migrating; characters reappear as agents become active. The old package's files don't need to be kept.

Operators running the Compose or Kubernetes/Helm deployment have a matching rebuild + redeploy runbook in [`deploy/README.md`](../deploy/README.md#upgrading-a-deployment-from-the-former-combined-package).

## What you'll see

Once the Paperclip plugin is installed and the Pixel Agents plugin module is loaded, every agent that does anything in Paperclip appears as an animated character in your Pixel Agents office:

- **A character spawns** the first time an agent becomes active (a run starts, or any tracked event fires for it).
- **It animates while working** — a synthetic "PaperclipWork" status shows while the agent has at least one active run, and clears when the last one finishes.
- **A permission bubble appears** when a Paperclip approval is created and awaiting a decision (`pending`/`open`/`requested`/`awaiting`/`undecided` status).
- **A "waiting for input" state** appears when a human asks the agent a question via an issue comment.
- **The character despawns** when the agent goes offline (removed, deleted, archived, or offboarded).

Characters are keyed by `paperclip-bridge:<companyId>:<agentId>` — one character per Paperclip agent, regardless of how many concurrent runs it has. Concurrency itself (how many runs are active, which issues/projects they touch) is preserved losslessly — it just isn't rendered as multiple clones. You can see the full picture (every active run, per-window behavioral signals, cost/budget context) in the plugin's own dashboard, described below.

## Where to actually interact

There are two sanctioned interaction surfaces, both routing into the same fail-closed Paperclip actions:

- **The Pixel Office page** embedded in Paperclip's UI (**Paperclip → your company → Pixel Office**, the page + sidebar entry the plugin registers). The sprite canvas itself is a pure activity visualizer with no free-text input (this is intentional; see the [Developer Guide](DeveloperGuide.md) for why).
- **The click-menu "Reply…" action** on a character in the office — routes through the Pixel Agents plugin host's privileged action path back into the plugin's `agent.reply-to-feedback` action.

From the Pixel Office page you can:

### Send new work to the company

Use the **company intake** box at the top. This is the *only* path for new work to enter — by design, matching Paperclip's own model where all new tickets go through the CEO/leadership agent, never through an incidental conversation with an individual agent. The Pixel Agents side can *request* actions but is structurally incapable of creating work. Type your request and send; it opens (or reuses) a session with your company's leadership agent.

### Reply to an agent

Click any agent card to open its detail view. If it has outstanding feedback (a question, a blocker, a completion note), you can reply directly — your reply is posted as a comment on the specific issue that feedback came from. (The in-office click-menu reply lands in the same place.)

**Fail-closed by design:** if what you type looks like it's introducing genuinely new work rather than continuing the existing conversation, the reply is rejected with a **"Send to company"** option instead of silently creating a new issue. This isn't just a UI nicety — the server-side action handler has no code path capable of creating an issue from this surface at all; it's structurally impossible, not just discouraged.

### Read the operational signals

Each agent's detail view shows:
- Every active run, with its issue/project, never collapsed into a single count.
- Windowed metrics (5m/30m/2h/8h/24h): busy ratio, run starts/finishes/failures, issue/project switches.
- Behavioral proxies — **load**, **friction**, **momentum**, **collaboration**, and so on — each labeled with a confidence score and its evidence basis. These are explicitly operational estimates, never presented as claims about how an agent "feels." You'll never see a made-up "satisfaction" score presented as fact.

## Configuring who leads intake

The company intake box needs a leadership agent to route to. The plugin picks one automatically — the first agent whose role is `ceo` or who has no manager (`reportsTo: null`) and is actually invokable (not paused, pending, or terminated) — and remembers that choice. If your org structure changes (a new CEO, the old one archived), the plugin re-resolves automatically the next time the stored choice turns out to be invokable.

## Troubleshooting

**No characters are appearing at all.**
Check the plugin's config has `pixelAgentsRelayEnabled` on (it defaults on once `pixelAgentsUrl` is set) and `pixelAgentsUrl` pointing at the Pixel Agents plugin's feed listener — in the containerized stack that's `http://pixel-agents:8081`, not the UI port and not a loopback address. Check the Pixel Agents server actually started with the `--plugin` module: the fork's loader aborts startup if the module can't load or register, and the module itself refuses to start without `PAPERCLIP_PIXEL_FEED_TOKEN`. A `401` on pushes means the shared secret differs from the Paperclip-side `pixelAgentsTokenRef`.

**Pushes stopped after I set a token on an `http://` URL.**
That's the transport contract failing closed: with a token configured, cleartext `http:` is accepted only for loopback, the bundled deployment service names, or a host you explicitly listed in `pixelAgentsAllowedHttpHosts`. Declare the internal hostname, or front the feed listener with TLS and use `https:` (the production default).

**A reply I sent isn't showing up as a comment.**
The reply only posts if it's bound to existing work — a feedback item with a resolvable `issueId`. If the underlying feedback couldn't be resolved server-side (e.g. it expired, or belongs to a different company), the action fails closed rather than guessing; you'll see an error, not a silent no-op. Click-menu replies additionally need `PAPERCLIP_PIXEL_API_TOKEN` set on the Pixel Agents side; without it they fail closed with `forwarderNotConfigured`.

**Characters render with default palettes instead of the picked sheets.**
The plugin's character catalog directory must be granted to Pixel Agents through its privilege-gated external-asset path; the declaration is retried on plugin restart once the grant exists. See the [architecture handbook](../workdocs/ai/architecture-handbook.md) §5.7.

**The context/token gauge above a character is always empty.**
Expected — see the "Known gap" note in the [package README](../README.md#known-gap).
