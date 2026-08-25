# Architecture Handbook — Paperclip ↔ Pixel Agents Bridge

This is the project-level **architecture handbook** for the Paperclip-Pixel
bridge. It covers the original translation layer (`PAPERCLIP_PIXELS-1`) and
the bridge plugin packaging + provider→Pixel-Agents relay glue
(`PAPERCLIP_PIXELS-2`). It is a living document: it is kept current
with the system as it actually is, never a dated snapshot, and never carries
a version number. It describes the system as a whole at the architecture
level — components, data flow, integration points, trust boundaries, build &
deploy, and the architectural decisions behind them.

It is **connective tissue, not a restatement**. The locked functional/
non-functional requirements, the canonical bridge contract, the per-phase
delivery plan, and the per-ticket domain records are owned elsewhere and
referenced here, not duplicated:

- **Specification domain record (normative for V1):** [`workdocs/ai/project/specifications/PAPERCLIP_PIXELS_1.md`](./specifications/PAPERCLIP_PIXELS_1.md) — referenced below as _the spec_; its numbered sections (§9 contract, §14 manifest, §15 protocol, §16 streams, §26 surfaces, §27 Paperclip UI example, §28 security, §29 performance, §30 failure handling) are the authoritative detail.
- **PAPERCLIP_PIXELS-2** (bridge plugin esbuild bundling + in-plugin
  `BridgeRelay`) has no separate specification domain record of its own; it
  is delivered as the SAA-229 gate-reviewed commit and is documented here at
  the architecture level. Its in-plugin relay is provider-agnostic and
  depends on the upstream `pixel-agents` per-`providerId` dispatch change
  (spike SAA-175 §5/§6, CTO-reviewed) to reach the live Pixel Agents runtime.
- **Delivery plan:** [`workdocs/ai/project/plan.md`](./plan.md).
- **Project constitution / locked invariants:** project-root [`AGENTS.md`](../../../AGENTS.md).

Source-level JSDoc (per-file/class/function) is owned by Code Documentation
Specialist; per-ticket domain records (specification/bug/incident/release/test)
are owned by Delivery Documentation Specialist. This handbook references both;
it does not replace them.

---

## 00. Index

| Field | Value |
| --- | --- |
| Project | Paperclip ↔ Pixel Agents translation layer (`PAPERCLIP_PIXELS-1`) + bridge plugin packaging & relay glue (`PAPERCLIP_PIXELS-2`) |
| Owning team | Paperclip engineering (CTO governance) |
| Specification | `PAPERCLIP_PIXELS-1` — see spec domain record linked above; `PAPERCLIP_PIXELS-2` documented here (no separate spec record) |
| Lifespan | Always current; updated in place as the system changes |
| Diagrams | Inline Mermaid (simple flows); no PlantUML assets required yet |

**Table of contents**

- 01. Introduction and Overview
- 02. Glossary
- 03. System Context
- 04. Architecture Goals and Principles
- 05. Logical Architecture (incl. Bridge Relay subsystem — PAPERCLIP_PIXELS-2)
- 06. Deployment Architecture (build pipeline + deploy bundle flow)
- 08. Security Architecture (FR-9 trust boundary + relay outbound boundary)
- 09. Architecture Decisions and Risks
- 10. Interfaces (manifest UI surface + bridge contract + relay config & hook endpoint)

Sections 07 (Data Architecture) and the optional Operational/Observability and
System-Component-Equivalency sections are intentionally omitted at this stage:
the bridge owns no authoritative data store (§07 belongs to the Design
Specification's entity docs and the spec's §13/§39.3 state guidance), and there
is no production operational maturity or predecessor system to map yet. They
will be added when the system has real content for them, not as stubs.

**Reading guidance**

| Audience | Sections | Why |
| --- | --- | --- |
| Engineering (plugin/UI) | 05, 06, 08, 10 | How the UI is built, bundled, wired, and kept inside the trust boundary |
| Engineering (core/adapter) | 03, 04, 05 | System shape, invariants, package boundaries |
| Security / compliance | 04, 08 | Trust boundary, least-privilege manifest, input validation |
| Integration partners | 03, 10 | External boundaries and the host-discovered UI surface |

---

## 01. Introduction and Overview

The Paperclip-Pixel bridge is a read-mostly translation layer that observes
Paperclip's authoritative organizational/business state, derives temporal
metrics and behavioral proxies from observed events, and exposes them to two
presentations — an embedded **Paperclip plugin UI** (the Pixel Office) and a
**Pixel Agents** visual runtime — through one canonical bridge contract. The
bridge is information-rich and presentation-poor: it supplies business context
and never dictates rendering. Paperclip remains the sole source of truth for
all business state; the bridge owns only a derived, restart-safe cache.

**Purpose of this document**

| Audience | Purpose |
| --- | --- |
| New engineers | Understand the system shape and where their package fits |
| Reviewers / security | Verify the trust boundary, least-privilege manifest, and build/deploy flow |
| Integration partners | See the external boundaries and the host-discovered UI surface |

**System summary**

| Attribute | Description |
| --- | --- |
| Platform type | Paperclip host plugin (worker + embedded UI) plus a standalone Pixel Agents adapter |
| Primary technologies | TypeScript, pnpm/npm workspaces, `@paperclipai/plugin-sdk`, React (UI bundle, host-injected), esbuild (worker + UI bundling via SDK-blessed presets), `tsc` (type declarations), Docker (deploy) |
| Core capabilities | Raw event projection, rolling-window temporal metrics, behavioral proxies with confidence/provenance, company intake + individual-agent feedback, live UI updates, optional in-plugin relay of mapped events to a Pixel Agents server hook endpoint (`PAPERCLIP_PIXELS-2`) |
| Deployment models | Host image reusing the published Paperclip base + a self-contained, pre-built plugin `dist/` (no runtime dep vendoring); standalone Pixel Agents CLI image |
| Integration interfaces | Public Paperclip Plugin SDK only (`ctx.data`/`ctx.actions`/`ctx.streams`/`ctx.events`/`ctx.state`); host-mounted UI bundle; optional operator-configured outbound HTTP to `POST /api/hooks/<providerId>` on a Pixel Agents server |
| Data zones | Paperclip (authoritative, external) · bridge derived cache (`ctx.state`, restart-safe) · host UI runtime (React, host-injected) · operator-configured Pixel Agents server (outbound relay target) |

---

## 02. Glossary

| Term | Definition |
| --- | --- |
| Bridge | The Paperclip-Pixel translation layer as a whole |
| Worker | The plugin's host-loaded script (`entrypoints.worker` → `dist/worker.js`); runs in the host plugin process |
| UI bundle | The host-loaded browser bundle (`entrypoints.ui` → `dist/ui/index.js`) mounted into declared UI slots |
| Pixel Office | The bridge's embedded Paperclip UI surface (page + sidebar slots) |
| Bridge contract | The canonical, versioned (`schemaVersion: 1`) data/action/stream shapes the worker serves and the UI/adapter consume (spec §9) |
| `ctx.data` / `ctx.actions` / `ctx.streams` / `ctx.events` / `ctx.state` | Public Plugin SDK surfaces the worker exposes to the UI; the only permitted path across the trust boundary (FR-9) |
| Behavior channel | The company-scoped stream channel `behavior:<companyId>` over which the worker pushes `BridgeStreamEvent` deltas |
| Host | The Paperclip application that loads the plugin worker and mounts the UI bundle |
| Slot | A host UI extension point (`page` or `sidebar`) declared in the manifest and bound to a named export of the UI bundle |
| Bridge relay | The optional in-plugin subsystem (`BridgeRelay`, `PAPERCLIP_PIXELS-2`) that pushes mapped canonical bridge events to a Pixel Agents server hook endpoint, one `BridgeTransport` + `HttpPushSink` per company |
| `instanceConfigSchema` | The operator-editable, company-scoped plugin config schema (manifest) the relay reads; fields `pixelAgentsUrl`, `pixelAgentsTokenRef` (a `secret-ref` binding, never a plaintext value), `pixelAgentsProviderId`, `pixelAgentsRelayEnabled` |
| `BridgeTransport` | Per-company transport in `@paperclip-pixel/pixel-agents-provider` that maps canonical `BridgeInputEvent`s / snapshots to `AgentEvent`s plus a rich sidecar and pushes them through an `AgentEventSink` |
| `HttpPushSink` | `AgentEventSink` that POSTs each mapped envelope (`{ providerId, sessionId, event }`) to `<baseUrl>/api/hooks/<providerId>`, optionally with a bearer token |

---

## 03. System Context

```mermaid
graph LR
  subgraph Authoritative["Paperclip (authoritative)"]
    PC[Paperclip platform]
  end
  subgraph Bridge["Paperclip-Pixel bridge"]
    WK[plugin worker]
    UI[Pixel Office UI bundle]
    RL[BridgeRelay<br/>per-company transport + HTTP sink]
  end
  subgraph Presentations
    PA[Pixel Agents adapter/runtime]
    PAS[Pixel Agents server<br/>hook endpoint]
  end
  HOST[Paperclip host app]
  PC -->|"public Plugin SDK only<br/>(events, reconciliation)"| WK
  WK -->|ctx.data / ctx.actions / ctx.streams| UI
  WK -->|canonical bridge contract| PA
  WK -->|"same canonical events/snapshots"| RL
  RL -->|"POST /api/hooks/&lt;providerId&gt;<br/>(operator-configured, optional)"| PAS
  HOST -->|loads worker, mounts UI bundle| WK
  HOST -->|injects React + SDK UI hooks| UI
```

**External systems and boundaries**

- **Paperclip (authoritative).** All business state lives here. The bridge
  reaches it through the public Plugin SDK only — events, SDK client calls,
  and authoritative reconciliation reads. No direct DB, private routes, or
  host internals (NFR-8, locked decision 10).
- **Paperclip host app.** Loads the worker from `entrypoints.worker` and
  mounts the UI bundle from `entrypoints.ui` into the declared slots. The
  host injects React and the SDK UI hooks at runtime; the UI bundle ships
  neither (see §06/§08).
- **Pixel Agents.** Consumes the canonical bridge contract through a
  minimal source-level adapter; owns all visual/spatial state. The bridge
  supplies business context only.
- **Pixel Agents server (relay target, `PAPERCLIP_PIXELS-2`).** An
  operator-configured outbound HTTP target. When the relay is enabled for a
  company, the worker's `BridgeRelay` POSTs mapped event envelopes to
  `<pixelAgentsUrl>/api/hooks/<providerId>` (default provider id
  `paperclip-bridge`). The relay is provider-agnostic and additive; reaching
  the live Pixel Agents runtime additionally requires the upstream
  per-`providerId` dispatch change (spike SAA-175 §5/§6) so the
  `paperclip-bridge` provider is normalized instead of the single injected
  `claudeProvider`.

**Trust boundaries.** There are two trust boundaries: (1) all Paperclip
domain access routes through the worker bridge; UI components never call
Paperclip HTTP routes directly (FR-9, §28.2); (2) the relay's outbound
HTTP is operator-gated per company and pushes only mapped bridge envelopes
— the worker never accepts inbound requests from the Pixel Agents server
(detail in §08).

---

## 04. Architecture Goals and Principles

| Goal | Description |
| --- | --- |
| Paperclip fidelity | Displayed entities reference canonical Paperclip IDs; Paperclip stays authoritative for every mutation |
| Presentation-poor bridge | Expose derived telemetry and behavioral proxies, never business truth or fictional psychology |
| Upstream neutrality | Public/exposed APIs only; no direct DB, private routes, or Pixel Agents core hacks (NFR-8) |
| Restart-safe derived state | Compact time buckets persist in `ctx.state` so metrics survive restart even without retrospective event history |
| Live, eventually-consistent UI | Full snapshot on mount/company-switch/reconnect/sequence-gap/refresh; stream deltas otherwise (NFR-3) |

**Locked guiding principles** (from `AGENTS.md` §"Architecture Invariants",
spec §2; not relaxed without CTO approval):

1. Paperclip is the sole source of truth for organizational/business state.
2. Pixel Agents owns visual/spatial state; its core is agent/platform agnostic.
3. The bridge is information-rich and presentation-poor.
4. No clone-per-run policy — concurrent runs are preserved as run-level data.
5. At-least-once / unordered event model; idempotent reducers with `eventId`
   dedupe plus periodic authoritative reconciliation (default 5 min).
6. Single trust boundary — UI never calls Paperclip HTTP routes directly.
7. Least-privilege manifest — request only required capabilities.
8. Public/exposed APIs only.

**Recurring structural patterns**

- **Worker-bridge-UI split.** Worker owns all Paperclip access; UI is a thin,
  host-mounted view that talks to the worker only through SDK bridge hooks.
- **Snapshot + delta.** Authoritative snapshot on (re)mount/company-switch;
  streamed deltas otherwise; always re-fetchable after disconnect (FR-13).
- **Externalized host runtime.** The UI bundle externalizes React and the SDK
  UI hooks so the host injects them — the bundle never ships its own copy and
  stays inside the trust boundary.
- **Company-scoped streams.** Live deltas flow on `behavior:<companyId>`, one
  channel per company, opened explicitly by the worker per company.

---

## 05. Logical Architecture

Three workspace packages (spec §7, §8):

1. **`packages/core` (`@paperclip-pixel/core`)** — snapshot loader, event
   normalizer + idempotent reducer, entity/run/concurrency projection,
   temporal windows, behavioral proxy calculator, feedback classifier,
   action policy / new-work gate, reconciliation. **Must not import React,
   the Pixel Agents renderer, or Paperclip UI code.**
2. **`packages/paperclip-plugin`** — manifest/capabilities, event
   subscriptions, authoritative snapshot bootstrap, SDK client calls,
   `ctx.state` persistence, `ctx.data`/`ctx.actions`/`ctx.streams` handlers,
   the embedded Pixel Office UI surface (worker + UI bundle), and — as of
   `PAPERCLIP_PIXELS-2` — the in-plugin `BridgeRelay` (`src/relay.ts`) that
   forwards the same canonical events/snapshots to an optional Pixel Agents
   server hook endpoint.
3. **`packages/pixel-agents-provider`** — consumes the bridge contract, maps
   only semantically valid current events to current `AgentEvent` semantics,
   retains richer behavior in a sidecar, integrates at the smallest possible
   source-level adapter. As of `PAPERCLIP_PIXELS-2` it is also a **runtime
   dependency of the plugin** and exports the relay primitives
   (`BridgeTransport`, `HttpPushSink`, `PAPERCLIP_BRIDGE_PROVIDER_ID`,
   `FetchLike`) consumed by `BridgeRelay`.

```mermaid
graph TD
  subgraph Host["Paperclip host (loads plugin)"]
    WK[worker.ts<br/>entrypoints.worker]
    UIB[UI bundle<br/>entrypoints.ui]
    RL[BridgeRelay<br/>src/relay.ts]
  end
  CORE[packages/core<br/>reducer + proxies]
  PA[packages/pixel-agents-provider<br/>BridgeTransport + HttpPushSink]
  PAS[Pixel Agents server<br/>POST /api/hooks/&lt;providerId&gt;]
  WK --> CORE
  WK -->|"ctx.data/actions/streams"| UIB
  WK -->|"canonical bridge contract"| PA
  WK -->|"same canonical events/snapshots"| RL
  RL --> PA
  PA -->|"HTTP push (operator-gated)"| PAS
```

**UI wiring subsystem (this layer's focus).** The plugin UI is built and
exposed as two artifacts from `packages/paperclip-plugin`:

- **Worker** — bundled by esbuild (`scripts/build.mjs` using
  `createPluginBundlerPresets` from `@paperclipai/plugin-sdk/bundlers`) into
  a self-contained `dist/worker.js` (+ `dist/manifest.js`). It inlines
  `@paperclip-pixel/core`, `@paperclipai/plugin-sdk`, `@paperclipai/shared`,
  `zod`, and `@paperclip-pixel/pixel-agents-provider`, externalizing only
  `node:*` built-ins, so the forked worker process never has to resolve them
  from an install location at runtime. It implements the bridge handlers, the
  company-scoped stream, and — as of `PAPERCLIP_PIXELS-2` — owns the
  `BridgeRelay` (see "Bridge Relay subsystem" below).
- **UI bundle** — bundled by esbuild (`scripts/build-ui.mjs`) from
  `src/ui/index.tsx` to `dist/ui/index.js`. Re-exports the two slot
  components: `PixelOfficePage` (page slot) and `PixelOfficeSidebar`
  (sidebar slot). The bundle talks to the worker only through the SDK
  bridge hooks (`usePluginData`, `usePluginStream`) and the bridge contract
  in `src/ui/bridge-contract.ts` — never to Paperclip directly (FR-9).

The bridge contract the UI consumes is defined UI-side in
`src/ui/bridge-contract.ts` (the UI's view of the canonical contract, spec
§9/§15/§16/§29.3): `BridgeCompanySnapshot` served by the worker's
`bridge-snapshot` data handler, `BridgeStreamEvent` envelopes pushed on the
`behavior:<companyId>` channel, `BRIDGE_DATA_KEYS.snapshot = "bridge-snapshot"`,
`BRIDGE_ACTION_KEYS`, and `behaviorChannel(companyId)` → `` `behavior:${companyId}` ``.

The worker side of that contract (this layer): `worker.ts` opens the
company-scoped channel on company setup — `ctx.streams.open(behaviorChannel(companyId), companyId)` — and emits deltas via
`ctx.streams.emit(behaviorChannel(change.companyId), uiEvent)`. Stream
channels are therefore **company-scoped**, not a single global channel.

### Bridge Relay subsystem (PAPERCLIP_PIXELS-2)

`src/relay.ts` adds an optional, operator-gated, **per-company** relay that
forwards the same canonical events and snapshots the worker already produces
for the UI to a Pixel Agents server's hook endpoint. It is additive to the
UI bridge: enabling/disabling the relay never changes what the UI receives.

**Shape.** `BridgeRelay` owns a `Map<companyId, CompanyRelay>`, where each
`CompanyRelay` is a `BridgeTransport` (from
`@paperclip-pixel/pixel-agents-provider`, the same mapper used by the
standalone adapter) wired to an `HttpPushSink`. The sink POSTs each mapped
envelope — `{ providerId, sessionId, event }` — to
`<baseUrl>/api/hooks/<providerId>` (default `paperclip-bridge`), optionally
with a bearer `Authorization` header. The sink's outbound push is routed
through the **SDK-gated `ctx.http.fetch`** (declared `http.outbound`
capability; host-managed tracing/audit applies) and adapted to the provider's
injectable `FetchLike` so the provider stays free of node globals — the Node
global `fetch` is never used.

**Config source.** Configuration is operator-set, **company-scoped** plugin
config, read via `ctx.config.get(companyId)` and declared in the manifest's
`instanceConfigSchema` (`relayConfigSchema` in `src/manifest.ts`). The worker
env is scrubbed by the host, so env vars are not available — config is the
only path. Fields: `pixelAgentsUrl` (required to enable; must be `https:` when
a token is configured), `pixelAgentsTokenRef` (optional `secret-ref` binding,
resolved at `configure` time via `ctx.secrets.resolve` — declared
`secrets.read-ref`; the raw token is never persisted or logged),
`pixelAgentsProviderId` (default `paperclip-bridge`, regex `^[a-z0-9-]+$`),
`pixelAgentsRelayEnabled` (default on when a URL is set). The relay enables
itself as soon as a non-empty URL is present unless explicitly disabled. If
`pixelAgentsTokenRef` resolution fails, the relay stays disabled for that
company (fail-securely).

**Lifecycle wiring** (`src/worker.ts`):

- **`setup()`** — constructs one module-level `BridgeRelay` (the host forks
  one worker process per plugin instance). Each bootstrapped company calls
  `relay.configure(companyId, companyConfig)` then
  `relay.ingestSnapshot(companyId, snapshot)` to seed the sidecar and spawn a
  character per agent. The worker declares `multiCompanyConfig: true` to opt
  in to per-company `onConfigChanged` delivery instead of single-tenant
  collapse/restart.
- **Event loop** — every canonical `BridgeInputEvent` the worker applies to
  its `BridgeStore` is also forwarded via `relay.ingestEvent(companyId, bridgeEvent)`,
  a no-op when the company has no relay configured.
- **Reconciliation job** — `relay.ingestSnapshot(...)` is re-fed after each
  authoritative reconciliation so the relay sidecar resyncs and re-spawns
  agents that appeared since the last pass.
- **`onConfigChanged(newConfig, { companyId })`** — reconfigures only the
  affected company's relay (disposes the prior transport, rebuilds from the
  new config; disables itself if the URL is gone). Errors are caught and
  logged — a config change must never crash the worker.
- **`onValidateConfig(config)`** — validates `pixelAgentsUrl` is an
  http(s) URL, **rejects `http:` whenever `pixelAgentsTokenRef` is configured**
  (cleartext must never carry a token; `http:` is allowed only when
  token-less), `pixelAgentsTokenRef` a `secret_ref` binding or non-empty
  string, `pixelAgentsProviderId` matches `^[a-z0-9-]+$`, and
  `pixelAgentsRelayEnabled` a boolean.
- **`onHealth()`** — reports `companies` (bootstrapped) and `relayCompanies`
  (active relay count) in `details`.
- **`onShutdown()`** — `relay.disposeAll()` disposes every company transport.

**Upstream dependency.** The relay is provider-agnostic: it pushes
correctly shaped envelopes and the Pixel Agents HTTP route accepts and
acknowledges them today. Reaching the *current* Pixel Agents runtime (events
appearing in the office UI) additionally requires the upstream
per-`providerId` dispatch change so the `paperclip-bridge` provider is
normalized instead of the single injected `claudeProvider` (spike SAA-175
§5/§6, CTO-reviewed, tracked separately — not part of this diff).

---

## 06. Deployment Architecture

### Build pipeline

The plugin is built from `packages/paperclip-plugin` with a single
`pnpm run build`, which orders two stages (`prebuild` runs `rimraf ./dist`
first):

```text
node scripts/build.mjs && node scripts/build-ui.mjs
```

1. **`node scripts/build.mjs`** — bundles the **worker + manifest** with
   esbuild using the SDK-blessed presets from
   `@paperclipai/plugin-sdk/bundlers` (`createPluginBundlerPresets`):
   - Entries: `src/worker.ts` → `dist/worker.js`, `src/manifest.ts` →
     `dist/manifest.js` (ESM, sourcemap on, `minify: false`).
   - **Inlined** into each bundle: `@paperclip-pixel/core`,
     `@paperclipai/plugin-sdk`, `@paperclipai/shared` (consumed as TS
     source), `zod`, and `@paperclip-pixel/pixel-agents-provider`. The
     forked worker process therefore never has to resolve these from an
     install location at runtime — the bundle is self-contained.
   - **Externalized:** `node:*` built-ins only (per the plugin loader
     contract). The worker loads in plain Node with no `tsx` loader.
   - `tsc -p tsconfig.json` is no longer the worker build step. It is kept
     for type declarations (`build:types` runs `--emitDeclarationOnly`) and
     typechecking (`typecheck` runs `--noEmit`). The worker `tsconfig.json`
     excludes `src/ui`, declares no JSX mode, and — as of this diff — adds
     `"types": ["node"]` (plus the `@types/node` devDependency) so
     `tsc --noEmit` passes against Node globals like `fetch`.
2. **`node scripts/build-ui.mjs`** — bundles the UI with esbuild:
   - Entry: `src/ui/index.tsx` → output `dist/ui/index.js` (ESM, `browser`
     platform, `es2022` target, sourcemap on).
   - **`jsx: "automatic"` is set explicitly** because esbuild would otherwise
     auto-discover the worker `tsconfig.json`, which excludes `src/ui` and
     declares no `jsx` mode. Automatic JSX runtime imports from
     `react/jsx-runtime`.
   - **Externalized:** `react`, `react-dom`, `react/jsx-runtime`, and
     `@paperclipai/plugin-sdk/ui`. The host injects these at runtime, so the
     bundle ships no copy of React and reaches Paperclip only through the
     worker bridge (FR-9, §28.2). This mirrors the SDK reference pattern in
     `paperclip/packages/plugins/examples/plugin-kitchen-sink-example/scripts/build-ui.mjs`.

The plugin `package.json` exposes a `paperclipPlugin` field
(`{ "manifest": "./dist/manifest.js", "worker": "./dist/worker.js" }`) so the
host loader can locate the built artifacts, and points `exports`/`types` at
`src/*.ts` (types resolve from source). `pnpm run build:worker` rebuilds only
the worker/manifest bundles, `pnpm run build:ui` rebuilds only the UI bundle,
and `pnpm run typecheck:ui` (`tsc -p tsconfig.test.json --noEmit`)
type-checks the UI sources against the test tsconfig. `esbuild` is a
devDependency of `packages/paperclip-plugin`.

### Deploy bundle flow

Deployment builds two Docker images from the repo root after the plugin is
built (per `deploy/README.md`):

```bash
( cd packages/paperclip-plugin && pnpm install && pnpm run build )
docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
docker build -t pixel-agents:local         -f deploy/docker/Dockerfile.pixel-agents .
```

- **Host image** (`Dockerfile.paperclip-pixel-host`) reuses the published
  Paperclip base (`ghcr.io/paperclipai/paperclip:latest`) and only adds the
  **self-contained bridge plugin** plus a bootstrap entrypoint. It does not
  rebuild the plugin — it consumes the already-built `dist/`.
- **Plugin bundling** is performed by `deploy/docker/build-plugin-bundle.sh`,
  which assembles a self-contained copy of the plugin at a target directory.
  Because the worker/manifest bundles are now esbuild-bundled (inlining
  `core`/`sdk`/`shared`/`zod`/`pixel-agents-provider`), the script is
  simplified to copying only `packages/paperclip-plugin/package.json` and the
  **whole `dist/` tree** (`cp -R .../dist`). There is no more vendoring of
  `core`/`sdk`/`shared` as real files under `node_modules/`, no `zod`
  install, and no `@paperclipai/shared` exports-rewriting step. The layout
  produced is just:
  ```text
  <target>/
    package.json   (from packages/paperclip-plugin)
    dist/          (worker.js, manifest.js, ui/index.js -- all self-contained)
  ```
  Because `dist/` contains `worker.js`, `manifest.js`, and `ui/index.js`,
  the UI bundle ships inside the same `dist/` as the worker — the host finds
  it via the manifest's `entrypoints.ui` (`"./dist/ui"`). No separate UI
  shipping step is needed. The Dockerfile correspondingly only `COPY`s
  `packages/paperclip-plugin` (no longer `packages/core`,
  `paperclip/.../sdk`, or `paperclip/.../shared`).
- **Pixel Agents image** (`Dockerfile.pixel-agents`) builds the standalone
  CLI from the `pixel-agents` submodule; it ships no Dockerfile of its own
  beyond this one.

> Repo layout note: the project-root `docs/` directory is a gitignored
> publish output (the `npm run drawings`/`uml` scripts copy
> `workdocs/{drawings,uml,assets,resources}` into it). Source-tracked
> project documentation therefore lives under `workdocs/ai/project/`
> (this handbook, the spec record, and the plan), not under `docs/`.

---

## 08. Security Architecture

| Layer | Description | Key mechanisms |
| --- | --- | --- |
| Trust boundary (UI ↔ worker) | All Paperclip domain access routes through the worker; the UI never calls Paperclip HTTP routes directly (FR-9, §28.2) | UI bundle externalizes React + SDK UI hooks; UI reaches the worker only via `ctx.data`/`ctx.actions`/`ctx.streams` |
| Relay outbound boundary (`PAPERCLIP_PIXELS-2`) | The relay's outbound HTTP to the Pixel Agents server is operator-gated per company, push-only, routed through the SDK-gated `ctx.http.fetch` (declared `http.outbound`), and carries only mapped bridge envelopes; the worker never accepts inbound from that server | `instanceConfigSchema` gates `pixelAgentsUrl`/`pixelAgentsRelayEnabled`; relay disabled by default when no URL; `onValidateConfig` enforces http(s) URL + rejects `http:` with a token + provider id regex; bearer token is operator-bound via a `secrets.read-ref`-gated secret reference, never a plaintext config value |
| Least-privilege manifest | Request only required capabilities (FR-10, §14, §28.1) | `capabilities` array in `manifest.ts`; read-only visualization needs no mutation caps; feedback needs no `issues.create` |
| Input validation | All `ctx.data`/`ctx.actions`/`ctx.streams` payloads validated with Zod; host-authenticated actor identity, not user-supplied actor IDs (FR-11, §28.4) | Zod schemas on every handler; `onValidateConfig` validates relay config fields |
| Secrets | No resolved secrets in plugin state — retain references, resolve at call time; never log secrets/full sensitive prompts by default (FR-12, §28.3, NFR-7) | `ctx.state` holds references only; the relay token is resolved per company from the operator-bound `pixelAgentsTokenRef` (`ctx.secrets.resolve`, `secrets.read-ref`), lives only in memory for the sink's lifetime, and is never logged or persisted |

### FR-9 trust boundary (UI ↔ worker)

The UI bundle and the worker communicate **only** through the public Plugin
SDK bridge surfaces. Concretely, in this diff:

- `src/ui/bridge-contract.ts` defines the UI-side contract: the snapshot
  data key (`bridge-snapshot`), the action keys (`BRIDGE_ACTION_KEYS`), and
  the company-scoped stream channel (`behaviorChannel(companyId)` →
  `` `behavior:${companyId}` ``).
- `src/ui/use-bridge.ts` consumes the snapshot and stream **only** through
  `usePluginData` / `usePluginStream` from `@paperclipai/plugin-sdk/ui` —
  never a Paperclip HTTP route. It fetches a full snapshot on mount,
  company switch, reconnect, detected sequence gap, and explicit refresh,
  and marks state visibly stale while the stream is disconnected (§30.1),
  blocking state-changing actions while stale.
- `scripts/build-ui.mjs` externalizes `react`, `react-dom`,
  `react/jsx-runtime`, and `@paperclipai/plugin-sdk/ui`, so the host
  injects them at runtime and the bundle ships no own copy of React — it
  has no path to Paperclip except the worker bridge.
- `worker.ts` is the sole origin of streamed deltas: it opens
  `behaviorChannel(companyId)` per company and emits `BridgeStreamEvent`
  envelopes through `ctx.streams.emit`.

There is no `fetch`/HTTP client in the UI bundle for Paperclip routes; the
build externalization and the SDK-hook-only data path make that boundary
structural, not merely conventional.

### Relay outbound boundary (PAPERCLIP_PIXELS-2)

The `BridgeRelay` introduces a second, narrower boundary: an **outbound**
HTTP path from the worker to an operator-configured Pixel Agents server.

- **Operator-gated, per company.** The relay is disabled by default; it
  enables itself only when a company's `instanceConfigSchema` config sets a
  non-empty `pixelAgentsUrl` (unless `pixelAgentsRelayEnabled` is explicitly
  `false`). Each company is configured independently; enabling company A's
  relay never affects company B.
- **Push-only, through the gated HTTP surface.** The worker only POSTs mapped
  envelopes to `<baseUrl>/api/hooks/<providerId>`; it never opens a listener and
  never accepts inbound requests from that server. There is no inbound surface
  to attack from the Pixel Agents server side. The push is routed through the
  SDK-gated `ctx.http.fetch` behind the declared `http.outbound` capability —
  the host's capability validator and outbound tracing/audit cover it; the Node
  global `fetch` is never used.
- **Config is the only path.** The worker env is scrubbed by the host, so
  env vars are unavailable inside the plugin; the relay reads its URL/token
  only from operator plugin config via `ctx.config.get(companyId)`. The bearer
  token is operator-bound as a `pixelAgentsTokenRef` secret reference, resolved
  at `configure` time via `ctx.secrets.resolve` (`secrets.read-ref`), sent only
  on the outbound hook POST, lives only in memory, and is never logged or
  persisted.
- **Validated config.** `onValidateConfig` enforces that `pixelAgentsUrl` is
  an http(s) URL — and **rejects `http:` whenever a token ref is configured**
  (cleartext must never carry a bearer token; token-less `http:` is allowed for
  isolated sidecar deployments) — `pixelAgentsUrl` must therefore be `https:`
  when a token is used. It also enforces `pixelAgentsProviderId` matches
  `^[a-z0-9-]+$`, the token ref is a `secret_ref` binding or non-empty string,
  and the enable flag is boolean — rejecting malformed operator input before it
  reaches the relay.
- **Failure isolation.** `onConfigChanged` and `setup()` catch and log relay
  errors; a relay misconfiguration or push failure must never crash the
  worker or break the UI bridge. `HttpPushSink.lastPushError` surfaces the
  most recent push error per company (cleared on a successful push) for
  health/observability.

### New-work invariant (security-critical)

New work enters through company/leadership intake only. Individual-agent
conversations are feedback channels bound to existing work; the reply handler
does not hold or invoke `issues.create`. The UI **fails closed**: text that
appears to introduce new work triggers no mutation and offers a deliberate
"Send to company" / "Open company intake" path. The hard guarantee is the
action path, not a language classifier (spec §5.2/§17/§18, `AGENTS.md`
§"Security-Critical Invariant"). See the spec domain record for the full
statement.

---

## 09. Architecture Decisions and Risks

### ADR-01 — UI bundle via esbuild with externalized host runtime

**Context & problem.** The Pixel Office UI is React, but it must load inside
the Paperclip host, which already provides React and the SDK UI hooks. Shipping
a second React copy would duplicate the runtime and risk version/context
mismatch. The worker build (`tsc`) excludes `src/ui` and has no JSX config, so
it cannot produce the UI bundle.

**Alternatives considered**

| Option | Description |
| --- | --- |
| `tsc` for the UI too | Rejected: worker `tsconfig.json` excludes `src/ui` and declares no `jsx` mode; reusing it would require a separate UI tsconfig and still would not externalize the host runtime |
| esbuild, bundling React in | Rejected: duplicates the host's React, risks context mismatch, and gives the bundle an independent runtime path that weakens the FR-9 boundary |
| **esbuild, externalizing React + SDK UI hooks** | Chosen |

**Decision.** **esbuild with `react`, `react-dom`, `react/jsx-runtime`, and
`@paperclipai/plugin-sdk/ui` externalized** — the host injects them at runtime.
`jsx: "automatic"` is set explicitly (the worker tsconfig that esbuild might
auto-discover excludes `src/ui` and has no JSX mode).

**Pros / Cons**

| Pros | Cons |
| --- | --- |
| No duplicated React; host is the single runtime | UI build is a second tool beyond `tsc` |
| Structural FR-9 boundary — bundle has no Paperclip path except the worker | Requires `esbuild` devDependency |

**Summary.** Externalization makes the trust boundary structural and keeps the
host the single React provider. Mirrors the SDK kitchen-sink reference.

### ADR-02 — Company-scoped behavior stream channel

**Context & problem.** Behavior deltas must not leak across companies, and the
UI must be able to subscribe per company and re-fetch a full snapshot on
company switch (NFR-3).

**Decision.** **One stream channel per company: `behavior:<companyId>`.** The
worker opens it explicitly on company setup
(`ctx.streams.open(behaviorChannel(companyId), companyId)`) and emits deltas
to the company-scoped channel; the UI subscribes via
`usePluginStream(behaviorChannel(companyId), { companyId })` and resets state
on company switch. (Previously a single global `behavior` channel was used;
this diff makes it company-scoped.)

**Summary.** Company-scoping prevents cross-company bleed and aligns the stream
with the per-company snapshot lifecycle.

### ADR-03 — Route-based sidebar link, not plugin-id-based

**Context & problem.** The page slot declares `routePath: "pixel-office"`, and
the sidebar should navigate to the page without depending on the internal
plugin id.

**Decision.** The sidebar links to `/${PIXEL_OFFICE_PAGE_ROUTE}`
(`pixel-office`) via the host's `useHostNavigation().linkProps`, not to a
plugin-id path. The route segment is a shared constant (`PIXEL_OFFICE_PAGE_ROUTE`)
mirrored in both plugin core (`src/constants.ts`) and the UI
(`src/ui/bridge-contract.ts`).

### ADR-04 — Self-contained esbuild worker/manifest bundle (PAPERCLIP_PIXELS-2)

**Context & problem.** The forked plugin worker process loads in plain Node
(no `tsx` loader). With bare `tsc` output, the worker had to resolve
`@paperclip-pixel/core`, `@paperclipai/plugin-sdk`, `@paperclipai/shared`, and
`zod` from an install location at runtime — which the deploy bundle could only
satisfy by vendoring those packages as real files under `node_modules/` and
rewriting `@paperclipai/shared`'s TS-source exports to point at built dist JS.
That vendoring was fragile (CJS/ESM `import` condition patching for core,
shared exports rewriting, an isolated `zod` npm install) and left residual
worker-runtime defects (see `deploy/README.md` "Known limitations").

**Alternatives considered**

| Option | Description |
| --- | --- |
| Keep `tsc` + runtime vendoring | Rejected: fragile, package-shape-dependent, breaks when upstream `shared` exports point at TS source |
| Bundle with a hand-rolled esbuild config | Rejected: reinvents the SDK-blessed externalization rules (what to inline vs externalize as `node:*`) |
| **esbuild via `createPluginBundlerPresets` from `@paperclipai/plugin-sdk/bundlers`** | Chosen |

**Decision.** Bundle the worker and manifest with esbuild using the
SDK-blessed presets (`scripts/build.mjs` → `createPluginBundlerPresets`).
Runtime deps (`@paperclip-pixel/core`, `@paperclipai/plugin-sdk`,
`@paperclipai/shared` consumed as TS source, `zod`,
`@paperclip-pixel/pixel-agents-provider`) are **inlined**; only `node:*`
built-ins are externalized. `tsc` is demoted to type declarations
(`build:types`) and typechecking (`typecheck`), adding `"types": ["node"]` +
`@types/node` so Node globals like `fetch` typecheck.

**Pros / Cons**

| Pros | Cons |
| --- | --- |
| Forked worker loads in plain Node with no runtime resolution | Worker build is now esbuild, not `tsc` (separate type-declaration step needed for consumers) |
| Deploy bundle collapses to `package.json` + `dist/` — no vendoring, no exports rewriting, no isolated `zod` install | Bundled worker is larger and less debuggable than `tsc` output (sourcemaps mitigate) |
| Externalization rules come from the SDK presets, not hand-maintained | — |

**Summary.** Self-contained bundles remove the fragile runtime vendoring and
make the deploy shape `package.json` + `dist/` only.

### ADR-05 — In-plugin per-company BridgeRelay (PAPERCLIP_PIXELS-2)

**Context & problem.** The bridge already produces canonical events/snapshots
for the UI. To also drive a Pixel Agents server, those same events must reach
its `POST /api/hooks/<providerId>` endpoint — without a second event pipeline,
without an inbound listener, and without breaking the per-company model.

**Alternatives considered**

| Option | Description |
| --- | --- |
| Separate relay process outside the plugin | Rejected: duplicates event subscription/bootstrap, splits the canonical pipeline, second deployable to operate |
| Push from the UI bundle | Rejected: violates FR-9 (UI has no Paperclip path) and only fires while the UI is open |
| **In-plugin `BridgeRelay` fed the same canonical events** | Chosen |

**Decision.** Add `BridgeRelay` in `src/relay.ts`, constructed once in
`setup()`, owning one `BridgeTransport` + `HttpPushSink` per company (reusing
the same `@paperclip-pixel/pixel-agents-provider` mapper the standalone
adapter uses). The worker forwards every canonical `BridgeInputEvent` and
each authoritative snapshot to the relay alongside applying them to its
`BridgeStore`; the relay is a no-op for companies with no config. Config is
operator-set, company-scoped plugin config (`instanceConfigSchema`), not env
(host scrubs env). `multiCompanyConfig: true` opts into per-company
`onConfigChanged` so config edits reconfigure only the affected company
without a worker restart.

**Pros / Cons**

| Pros | Cons |
| --- | --- |
| One canonical event pipeline; relay is additive and no-op when disabled | Adds an outbound HTTP path (second boundary, see §08) requiring operator config |
| Reuses the provider mapper; provider-agnostic | Reaching the live Pixel Agents runtime still needs the upstream per-`providerId` dispatch change (spike SAA-175) |
| Per-company config + lifecycle hooks; failures are isolated and logged | — |

**Summary.** The relay reuses the canonical pipeline and the provider mapper,
is operator-gated per company, and is provider-agnostic until the upstream
dispatch change lands.

**Risk register**

| ID | Risk | Impact | Likelihood | Mitigation | Owner | Status |
| --- | --- | --- | --- | --- | --- | --- |
| R1 | UI bundle accidentally imports a Paperclip HTTP client, breaking FR-9 | High | Low | Externalize React + SDK UI hooks; UI reaches worker only via SDK bridge hooks; policy tests (§31.5) | Engineering | Mitigated by build externalization |
| R2 | Stream channel not company-scoped → cross-company bleed | High | Low | Company-scoped `behavior:<companyId>` channel opened per company; UI resets on company switch | Engineering | Mitigated |
| R3 | Host lacks `ui.sidebar.register` capability → sidebar slot rejected | Medium | Low | Manifest declares `ui.sidebar.register` alongside `ui.page.register` | Engineering | Mitigated |
| R4 | Worker bundle accidentally externalizes an inlined dep → runtime resolution failure in the forked worker | High | Low | SDK-blessed `createPluginBundlerPresets` owns the inline/externalize rules; build logs the inlined/externalized lists | Engineering | Mitigated by SDK presets (PAPERCLIP_PIXELS-2) |
| R5 | Relay push failure or misconfiguration crashes the worker / breaks the UI bridge | High | Low | `setup()`/`onConfigChanged` catch+log relay errors; relay is no-op when disabled; UI bridge is independent of relay | Engineering | Mitigated by failure isolation (PAPERCLIP_PIXELS-2) |
| R6 | Relay enabled for the wrong company / cross-company event bleed | High | Low | Per-company `Map<companyId, CompanyRelay>`; `onConfigChanged` is per-company; `multiCompanyConfig: true` | Engineering | Mitigated (PAPERCLIP_PIXELS-2) |

---

## 10. Interfaces

### IF001 — Manifest UI surface (host-discovered)

The host discovers the UI through the plugin manifest (`src/manifest.ts`,
spec §14/§19/§26/§27):

- **`entrypoints`**
  - `worker`: `"./dist/worker.js"`
  - `ui`: `"./dist/ui"` — the host loads the UI bundle from this directory.
- **`ui.slots`** — the two slots the host mounts:

| Slot type | id | displayName | exportName | routePath |
| --- | --- | --- | --- | --- |
| `page` | `pixel-office-page` | Pixel Office | `PixelOfficePage` | `pixel-office` |
| `sidebar` | `pixel-office-sidebar` | Pixel Office | `PixelOfficeSidebar` | — |

The host loads the UI bundle from `entrypoints.ui` and mounts the named export
matching each slot's `exportName`. The bundle's entry
(`src/ui/index.tsx`) re-exports exactly those two names. Slot ids, export
names, and the page route are shared constants in `src/constants.ts`
(`UI_SLOT_IDS`, `UI_EXPORT_NAMES`, `PIXEL_OFFICE_PAGE_ROUTE = "pixel-office"`),
mirrored UI-side in `src/ui/bridge-contract.ts`.

**Capabilities required for these slots** (least-privilege, FR-10):
`ui.page.register` and `ui.sidebar.register` (the latter added in this diff).
Read-only visualization requests no mutation capabilities; feedback requests
no `issues.create`.

### IF002 — Worker ↔ UI bridge contract

```mermaid
sequenceDiagram
    participant UI as Pixel Office UI
    participant W as worker (plugin)
    participant PC as Paperclip
    Note over UI,W: trust boundary (FR-9): SDK bridge hooks only
    UI->>W: usePluginData("bridge-snapshot", {companyId})
    W-->>UI: BridgeCompanySnapshot (full)
    W->>UI: ctx.streams.emit("behavior:<companyId>", BridgeStreamEvent)
    UI->>W: ctx.actions (BRIDGE_ACTION_KEYS, e.g. company.send-message / agent.reply-to-feedback)
    W->>PC: round-trip mutation (Paperclip authoritative)
    Note over UI: reconnect/sequence-gap/refresh → re-fetch full snapshot (NFR-3)
```

- **Data (snapshot):** worker serves `BridgeCompanySnapshot` on the
  `bridge-snapshot` data key (`BRIDGE_DATA_KEYS.snapshot`). The UI fetches a
  full snapshot on mount, company switch, reconnect, detected sequence gap,
  and explicit refresh (NFR-3, FR-13).
- **Stream (deltas):** worker pushes `BridgeStreamEvent` envelopes on the
  company-scoped `behavior:<companyId>` channel, opened per company. Every
  payload carries `schemaVersion: 1` (NFR-6).
- **Actions:** UI invokes worker actions by `BRIDGE_ACTION_KEYS`
  (spec §15/§17/§18), e.g. `company.send-message` (the sole new-work intake
  path) and `agent.reply-to-feedback` (bound to existing work; cannot create
  issues). All payloads are Zod-validated; actor identity is
  host-authenticated (FR-11).
- **Disconnect safety:** while the stream is disconnected the UI marks state
  visibly stale and blocks state-changing actions (§30.1); a full snapshot is
  always re-fetchable (FR-13).

The full canonical contract shapes (`RawAgentProjection`, `WindowedMetrics`,
`AgentBehaviorVector`, `AgentFeedback`, etc.) are defined in the spec domain
record (§9) and the `packages/core` contract; this handbook references them
rather than restating field lists.

### IF003 — Relay operator config (`instanceConfigSchema`, PAPERCLIP_PIXELS-2)

The manifest (`src/manifest.ts`) declares a company-scoped
`instanceConfigSchema` (`relayConfigSchema`) that the host renders as an
operator-editable config form and validates. The worker reads it per company
via `ctx.config.get(companyId)` and through the delivered `newConfig` in
`onConfigChanged`.

| Field | Type | Required | Default | Notes |
| --- | --- | --- | --- | --- |
| `pixelAgentsUrl` | string (`format: uri`) | to enable | — | Base URL of the Pixel Agents server (e.g. `https://pixel-agents:8080`); must be `https:` when a token ref is configured; relay enables itself when set |
| `pixelAgentsTokenRef` | string (`format: secret-ref`) | no | — | `secret_ref` binding resolved to the bearer token via `ctx.secrets.resolve`; never a plaintext value; `x-paperclip-advanced` |
| `pixelAgentsProviderId` | string (`^[a-z0-9-]+$`) | no | `paperclip-bridge` | Provider id in the hook path; `x-paperclip-advanced` |
| `pixelAgentsRelayEnabled` | boolean | no | on when URL set | Explicit on/off; `x-paperclip-advanced` |

`onValidateConfig` enforces the URL is http(s) — **rejecting `http:` whenever
`pixelAgentsTokenRef` is configured** so a bearer token never travels over
cleartext — the provider id matches the regex, the token ref is a `secret_ref`
binding or non-empty string when present, and the enable flag is a boolean.
The relay is disabled by default; it activates only when a company has a
non-empty `pixelAgentsUrl` (unless explicitly disabled), and stays disabled if
the token ref fails to resolve (fail-secure).

### IF004 — Pixel Agents hook endpoint (relay outbound, PAPERCLIP_PIXELS-2)

When enabled for a company, the relay POSTs mapped event envelopes to the
operator-configured Pixel Agents server:

```mermaid
sequenceDiagram
    participant W as worker (plugin)
    participant R as BridgeRelay
    participant T as BridgeTransport
    participant S as HttpPushSink
    participant PA as Pixel Agents server
    Note over W: applies canonical event to BridgeStore (for UI)
    W->>R: ingestEvent(companyId, BridgeInputEvent)
    R->>T: ingestEvent(event)
    T->>S: push(AgentEvent envelope)
    S->>PA: POST <baseUrl>/api/hooks/<providerId>
    Note over S,PA: { providerId, sessionId, event }<br/>optional Authorization: Bearer <token>
    PA-->>S: acknowledge
    S-->>T: ok / lastPushError cleared
```

- **Endpoint:** `POST <pixelAgentsUrl>/api/hooks/<providerId>` (default
  `paperclip-bridge`).
- **Envelope:** `{ providerId, sessionId, event }` — the same shape the
  standalone adapter produces, so the provider is shared.
- **Auth:** optional bearer token resolved per company from the
  `pixelAgentsTokenRef` secret reference (`ctx.secrets.resolve`), sent as
  `Authorization: Bearer <token>` only on the outbound POST; never logged.
  Pushes flow through the SDK-gated `ctx.http.fetch` (declared
  `http.outbound`).
- **Snapshots:** `ingestSnapshot` seeds/re-syncs the sidecar (spawns a
  character per agent) at bootstrap and after each authoritative
  reconciliation.
- **Health:** `onHealth()` reports `companies` (bootstrapped) and
  `relayCompanies` (active relay count); `HttpPushSink.lastPushError` exposes
  the most recent per-company push error (cleared on success).
- **Upstream dependency:** the route accepts and acknowledges envelopes today;
  reaching the live Pixel Agents runtime requires the upstream per-`providerId`
  dispatch change (spike SAA-175 §5/§6) so the `paperclip-bridge` provider is
  normalized instead of the single injected `claudeProvider`.
