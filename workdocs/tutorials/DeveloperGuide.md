# Developer Guide — Paperclip ↔ Pixel Agents Bridge

For contributors working on the bridge itself. If you just want to install and use it, see the [package README](../README.md) and the [User Guide](UserGuide.md).

## Repo layout

Five trees, per the board Revision 3 target shape — two independent plugin packages joined by a neutral contract package, plus the two upstream references:

```
common/                      paperclip-pixels-common — the neutral wire contract (schemas only):
                               DTOs, Zod validation, operation ids, error codes,
                               schemaVersion compatibility rules, fixture builders, contract tests.
                               Imports no other package; no SDK, React, server, or filesystem code.
plugins/paperclip/           @decaf-ts/paperclip-pixels-plugin — the Paperclip-side plugin:
  src/
    core/                      Pure translation logic, zero I/O, zero dependency on either host
      domain/                    raw projection, temporal metrics, behavior vectors, feedback,
      reducer/                   idempotent event reducer, reconciliation, in-memory store
      temporal/                  rolling-window ring buffers
      behavior/                  workload/friction/momentum/confidence calculators
      policy/                    new-work intake gate, agent-reply fail-closed gate
    worker.ts                  Paperclip plugin entrypoint: snapshot bootstrap, subscriptions, feed wiring
    manifest.ts                Plugin manifest (capabilities, UI slots, config schema)
    actions.ts                 company.send-message / agent.reply-to-feedback / agent.set-pixel-appearance
    relay.ts                   Per-company feed transport + HTTP sink lifecycle, config parsing
    feed-mapper.ts, feed-sink.ts  canonical bridge events → feed operations; ordered batch POSTs
    snapshot.ts, subscriptions.ts, persistence.ts, characters.ts, tool-activity-poller.ts
    ui/                        the embedded "Pixel Office" dashboard (React, runs inside Paperclip's UI)
  test/                       domain (jest) + worker/relay/actions (vitest) + UI (jest+jsdom) suites
  assets/characters/          the CC0 24-sheet catalog shipped with the package
plugins/pixel-agents/        @decaf-ts/pixel-agents-paperclip-plugin — the Pixel Agents-side plugin:
  src/
    manifest.ts                host manifest: agent/team + appearance sources, reply actions,
                               click-menu item, dialog-pane widget, override capabilities
    plugin.ts, embedding.ts    registration through the fork's plugin host + the --plugin module
                               entrypoint (feed listener, appearance declaration, reply forwarding)
    feed-server.ts             the mountable POST /api/plugin-feed handler (bearer auth, batch
                               validation, declared-agent cache)
    feed.ts, feed-mapper.ts, feed-sink.ts, appearance.ts, dialog.ts, reply-forwarder.ts
  src/__tests__/              vitest suite (mapper, feed server, embedding, forwarder, appearance)
pixel-agents/                the FORK of upstream pixel-agents-hq/pixel-agents (baseline tag
                               fork-baseline-v1.4.1). Adds the generic plugin host, contribution
                               points, appearance source, and privilege gates the bridge loads
                               through. Upstream is reference-only — never PR'd; every fork-side
                               change is logged in DIVERGENCE.md under the FORK.md policy.
paperclip/                   the Paperclip core submodule. Reference-only, never modified — the
                               bridge integrates strictly through the public plugin SDK.
(repo root)                  the private npm workspace root — no publishable package: it wires
                               common/ + plugins/paperclip + plugins/pixel-agents together
                               (one `npm install` at the root prepares all three), keeps the
                               cross-package orchestration scripts, and symlinks the Paperclip
                               plugin SDK from the paperclip/ submodule into
                               node_modules/@paperclipai/ (scripts/link-paperclip-sdk.mjs,
                               run by the root `postinstall` hook).
deploy/                      Reference Kubernetes stack + Dockerfiles + Compose (see deploy/README.md)
e2e/                         Canonical Playwright suites (deployed-stack paperclip specs + fixtures)
workdocs/tutorials/          This guide + the User Guide (repo convention — `docs/` is reserved)
workdocs/ai/                 Architecture handbook + per-ticket domain records (specifications —
                               owned by the Delivery Documentation Specialist; read, don't edit)
```

Dependency rule (enforced by review and by the packages' own imports): **plugins depend only on `common`, never on each other**; `common` knows no other package. The plugins never import the `pixel-agents/` fork internals or the `paperclip/` submodule at runtime — wire shapes are mirrored by hand in `common` and verified against the reference sources.

## How the bridge works

1. The **Paperclip plugin worker** (`plugins/paperclip/src/worker.ts`) bootstraps each company from an authoritative snapshot and subscribes to Paperclip events through the public SDK. It reduces them with the pure `core/` domain into per-company state.
2. The worker's **relay** (`relay.ts`) owns one feed mapper + HTTP sink per company: `feed-mapper.ts` translates canonical bridge events, snapshots, and the appearance map into **feed operations** — `declareAgents` / `removeAgents` / `updateAgentStatus` / `updateAgentActivity` / `assignAgentAppearance` / `dialogLines` — batched as `{ schemaVersion, companyId, operations }` (schema frozen in `common/src/feed.ts`) and POSTed to `POST /api/plugin-feed` with a bearer shared secret.
3. The **Pixel Agents plugin** (`plugins/pixel-agents/`) is loaded in-process by the fork's generic `--plugin <module>` host. Its feed server validates each batch fail-closed (bearer token, constant-time compare, 1 MB cap, all-or-nothing operation validation) and applies operations through the host's **sanctioned agent/team and appearance sources** — never by impersonating a webview or a hook provider.
4. **Replies flow back** through the office's click-menu "Reply…" action: the privileged `invokePluginAction` path → the plugin's reply forwarder → Paperclip's performAction proxy (`POST /api/plugins/:pluginId/actions/:key`) → the *same* fail-closed `agent.reply-to-feedback` / `company.send-message` handlers the Pixel Office UI uses. There is no issue-creation code anywhere on this path.

### The zero-core-change constraint

- **Paperclip side:** integrated with strictly through the public plugin SDK — `ctx.state`, `ctx.data`, `ctx.actions`, `ctx.streams`, `ctx.events`, `ctx.config`, `ctx.http`, capabilities-gated. No `paperclip/` submodule file is ever modified.
- **Pixel Agents side:** the fork is *ours*, so fork changes are allowed — but they must be generic host features (logged in `DIVERGENCE.md`, never proposed upstream), never bridge-specific logic. The bridge itself is a `--plugin` module using only the host's public API: manifest, sources, contribution points, actions. An operator loading no `--plugin` module gets the unchanged base runtime (the fork's guard suites pin that equivalence).
- If a mapping seems to need an upstream source change, that's a signal to (a) find an existing extension point, (b) put richer data in the worker's dashboard instead, or (c) propose a genuine standalone upstream change through the fork governance process — never silently patch a submodule.

### Why the sprite canvas is read-only for text

The Pixel Agents `ClientMessage` union has no variants carrying free text intended for an agent/provider, so the office canvas cannot host a chat box. Interaction therefore lives in the plugin's Pixel Office page inside Paperclip, plus the click-menu reply action — both routed into the same fail-closed actions.

## Building and testing

Each package builds and tests standalone. Commands verified against each `package.json`:

```bash
# neutral contract package
cd common && npm install && npm run build && npm run test

# Pixel Agents-side plugin
cd plugins/pixel-agents && npm install && npm run build && npm run test

# Paperclip-side plugin (worker/UI/core home)
cd plugins/paperclip && npm install && npm run build && npm run test:all
#   test:domain (jest)   core translation/metrics
#   test:worker (vitest) worker/relay/actions/manifest/subscriptions/snapshot
#   test                 UI components (jest + jsdom + testing-library)
```

`npm run build` in `plugins/pixel-agents` also emits the deployed embedding bundle `plugins/pixel-agents/dist/pixel-agents-embedding.cjs` — the artifact the fork's generic `--plugin` loader loads in every deployed topology.

Three runners exist in `plugins/paperclip` because the code has three genuinely different execution needs: the pure core is plain Node CommonJS (jest via `jest.config.domain.ts`); the worker/relay/actions side needs Vitest for its ESM-native handling of the real Paperclip plugin SDK test harness; the UI components need `jsdom` + React Testing Library (`jest.config.ts`). `npm run typecheck` / `typecheck:ui` run the TS gates; `npm run lint` runs ESLint.

**Local dev symlinks:** `@paperclipai/plugin-sdk` and `@paperclipai/shared` (inside the `paperclip/` submodule) can't be installed as normal npm dependencies — the SDK's own `package.json` uses the pnpm/yarn-only `workspace:*` protocol. `npm install` at the repo root runs `scripts/link-paperclip-sdk.mjs` automatically (the `postinstall` hook) to symlink them into `node_modules/@paperclipai/`. If you hit `Cannot find module '@paperclipai/...'`, re-run `node scripts/link-paperclip-sdk.mjs`.

**The fork's own gates** (run inside `pixel-agents/`): `npm run check-types` (now clean-clone green — the Revision 3 fork-boundary repair removed every cross-repo `../../../../src` import in favor of fork-local fixtures), plus its server/webview/e2e suites. A fork change without a `DIVERGENCE.md` row is incomplete by definition.

## Local end-to-end testing (Kubernetes)

`deploy/k8s/` is a complete, working reference stack — see [`deploy/README.md`](../deploy/README.md) for the full build/deploy walkthrough. The short version, once you have `docker` and `minikube`:

```bash
npm install && npm run build --workspaces
docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
docker build -t pixel-agents:local -f deploy/docker/Dockerfile.pixel-agents .
minikube start
minikube image load paperclip-pixel-host:local
minikube image load pixel-agents:local
kubectl -n paperclip-pixels create secret generic paperclip-pixel-feed \
  --from-literal=token="$(openssl rand -hex 32)"
kubectl apply -k deploy/k8s/
```

You can verify the feed path end-to-end without creating a real Paperclip company by pushing a batch straight at the plugin feed endpoint:

```bash
kubectl -n paperclip-pixels port-forward svc/pixel-agents 8081:8081 &
TOKEN=<the PAPERCLIP_PIXEL_FEED_TOKEN you deployed with>
curl -X POST http://localhost:8081/api/plugin-feed \
  -H "Content-Type: application/json" -H "Authorization: Bearer $TOKEN" \
  -d '{"schemaVersion":1,"companyId":"test-company","operations":[{"op":"declareAgents","agents":[{"key":"paperclip-bridge:test-company:test-agent","name":"Test Agent"}]}]}'
# expect 200; then check the office UI (port-forward 8080) — the character appears.
# Without the Authorization header the endpoint answers 401 (fail-closed by design).
```

The canonical Playwright suites (`e2e/`) run against the disposable compose stack — build/deploy/suite instructions are in [`deploy/README.md`](../deploy/README.md).

## Extending the mapping

Adding a new Paperclip event type or feed operation:

1. Add the raw shape to the canonical event contract (`common/src/events.ts` / the `BridgeInputEvent` union) and the subscription in `plugins/paperclip/src/subscriptions.ts`.
2. Decide honestly whether it maps to a real feed operation the Pixel Agents host already understands, or belongs in the worker's dashboard data only. When genuinely unsure, dashboard-only is the conservative default: a wrong dashboard choice loses a visual; a fabricated feed operation loses truthfulness.
3. If it's a real feed operation: extend the batch schema in `common/src/feed.ts` (increment `schemaVersion` on breaking changes), add the case to `plugins/paperclip/src/feed-mapper.ts`, and the apply case in `plugins/pixel-agents/src/feed-server.ts` / the sanctioned host source it drives.
4. Write the failing-first test in `common/src/__tests__/` (contract), `plugins/pixel-agents/src/__tests__/plugin-feed-mapper.test.ts` + `plugin-feed-server.test.ts` (map + apply), and the worker/relay suite in `plugins/paperclip/test/` for the end-to-end body assertion.

## Policy invariants that must never regress

These are release-blocking (pinned by `plugins/paperclip/test/` actions/worker/policy suites and the fork's fail-closed guard suites):

- `issues.create` is never reachable from the individual-agent reply path — grep the whole tree for it; it should only ever appear in company-intake-adjacent code, never in `handleAgentReplyToFeedback`.
- A reply with no server-resolved `existingWorkContext`/`issueId`/`runId` fails closed (`ROUTE_TO_COMPANY`), never silently drops or silently creates.
- The feedback object in reply payloads is never caller-suppliable — only ever resolved server-side by id (`.strict()` schemas).
- The Pixel Agents side can request actions but never create work; the plugin host offers no work-creation primitive, and the forwarder routes only into the two existing actions.
- `common/` stays schemas-only: no SDK, React, server, or filesystem imports ever land in it.
