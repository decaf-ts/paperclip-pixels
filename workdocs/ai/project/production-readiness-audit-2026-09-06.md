# Production Readiness Audit — 2026-09-06

## Scope and guardrails

This audit covers the outer Paperclip Pixels repository, its `pixel-agents/`
submodule fork, and the checked-in Docker/Kubernetes reference deployment.
`paperclip/` was inspected only as a plugin-SDK reference and was not
modified. No tracked files were modified during the audit.

## Verification performed

The outer package needs its documented post-install linker when working from
this checkout because it links the Paperclip SDK reference packages into local
`node_modules`. After that linker ran:

| Check | Result |
| --- | --- |
| `npm run typecheck` | Passed |
| `npm run lint` | Passed with three obsolete ESLint-disable warnings |
| `npm run test:all` | Passed: 16 domain suites / 150 tests, 22 worker suites / 495 tests, 11 UI suites / 116 tests |
| `npm run build` | Passed, with an esbuild warning about `import.meta` in CJS output |
| `npm pack --dry-run` | Passed; package contains 80 files, 989.7 kB compressed / 5.4 MB unpacked |
| `pixel-agents npm run check-types` | **Failed** |
| `pixel-agents` webview tests | Passed: 28 suites / 321 tests |

Outer UI tests emit React `act(...)` warnings. The intentional raw-snapshot
error-boundary regression test also logs a stack trace. Neither currently
fails the suite, but both make CI noisier than a release-quality gate should
be.

## Readiness verdict

The project is **not production ready**. The bridge has a solid tested core,
but the Pixel Agents fork cannot pass its normal typecheck in isolation, the
release automation is stale, public documentation contradicts the runtime
architecture, and the requested Paperclip UX is only partially implemented.

| Area | Assessment | Evidence |
| --- | --- | --- |
| Bridge core | Good foundation | Idempotent reducer, reconciliation, bounded temporal metrics, operational-proxy provenance, fail-closed new-work/reply policy, shared-secret feed auth, 761 passing automated tests. |
| Paperclip plugin UX | Partial | One `Pixel Office` page and sidebar exist. The page embeds Pixel Agents and includes an agent picker, overview, and intake/feedback controls. |
| Pixel Agents fork | Blocking | `npm run check-types` imports outer `src/pixel-agents-plugin/*` from fork tests. This crosses `rootDir`, makes the fork non-self-contained, and exposes additional strict guard-test type errors. |
| CI/release | Blocking | Root workflows still invoke removed/nonexistent `build:prod`, `coverage`, and documentation scripts, and do not validate the fork, images, or live integration. |
| Documentation | Blocking | Root README and User/Developer guides still describe the retired Claude-hook relay and state Pixel Agents lacks plugin loading, while the current deployment uses the fork's `--plugin` module and `POST /api/plugin-feed`. |
| Deployment | Development reference only | Compose/minikube manifests use local images, `imagePullPolicy: Never`, a checked-in development auth secret, manual per-company configuration, no immutable registry images, TLS/mTLS, NetworkPolicies, HA, backup/restore runbook, or production observability. |
| Assets/customization | Partial and materially below requested scope | Local package has only 24 whole character sheets plus palette/hue selection. It has no face, hair, skin, clothing, or accessory composition model; it also lacks the reference office layouts, floors, walls, furniture, and brand assets. |

## Product-requirement gap analysis

### Paperclip UI

Implemented today:

- A native plugin `page` and `sidebar` slot named `Pixel Office`.
- An iframe displaying the Pixel Agents browser UI.
- Per-agent selection of a full character sheet and hue shift.
- Company overview, company intake, feedback replies, stale-state gating, and
  operational proxy display.

Missing from the requested experience:

- Native `Office` menu with `Design/View` and `Configuration` children,
  matching host typography/icons and a red/green connection indicator.
- Fullscreen office viewing.
- A dedicated configuration page with bounded, configurable rolling relay
  communications (default requested: last 100) and agent communication/
  operational metrics.
- A `Character` tab on each native Paperclip agent detail page, with metrics
  beside customization.
- Native chart integration for the bridge's metrics.
- Paperclip-hosted office-layout configuration.

The installed Paperclip SDK does support `detailTab` slots scoped to `agent`,
so an agent Character/metrics tab is achievable through the public plugin API
without modifying Paperclip. The current manifest simply does not declare or
render it.

### Character assets and appearance

The current appearance API is a reliable whole-sheet assignment model: it
validates a catalog, preserves assignments, deterministically spreads defaults
over agents, synchronizes palette/hue state, and has extensive unit coverage.
It is not a granular character composer.

The Agent-Pixels reference contains character sprites plus floors, walls,
furniture, branding, and layout JSON. This repository contains only
`assets/characters/catalog.json` and `char_0.png` through `char_23.png`.
Before porting third-party assets, establish the applicable licence or obtain
permission, record provenance, and include an asset inventory/checksum test.

### Bridge and transport

Strengths:

- One package unifies the Paperclip worker, UI, relay mapper, feed endpoint,
  and Pixel Agents embedding module; this is simpler than three published
  components.
- At-least-once/unordered event assumptions, dedupe, periodic reconciliation,
  secret references, and policy separation are correct production-oriented
  choices.
- The feed rejects unauthenticated requests and new-work entry is structurally
  confined to company intake.

Gaps:

- No production measurement/SLO suite for latency, queue pressure, retries,
  delivery loss, relay history, or sustained resource use. use @decaf-ts/utils performance test utils for the effect.
- The external end-to-end suite depends on an already deployed shared stack;
  it is not a self-contained CI gate.
- Cleartext HTTP is permitted for configured internal host names. Production
  deployments should use TLS/mTLS or a mesh-authenticated private channel. => via config. dont make it mandatory, just make it the default for production deployments
- The build warns that `import.meta` is used in CJS output while the package
  advertises Node `>=20`; add a Node 20 artifact/runtime test before release. => move t node 24

## Architecture decision: converge on two plugins, not a third bridge service

### Recommendation

**Yes: converge on two installable/runtime plugins.** This should mean one
Paperclip plugin and one Pixel Agents plugin, connected by a small versioned
wire contract. It must **not** mean moving every line of integration code into
the Paperclip plugin or making the Pixel Agents fork import Paperclip-plugin
source.

The current runtime has already retired the old third process (the
`paperclip-pixel-relay` Claude-hook sidecar). In effect, it now has two runtime
surfaces:

1. the Paperclip plugin worker/UI, which observes Paperclip and pushes feed
   operations; and
2. the Pixel Agents embedding module, loaded by Pixel Agents' generic
   `--plugin` host, which authenticates and applies those operations and sends
   approved actions back.

However, they are packaged together in the outer npm package and their tests
currently cross-import source files. That packaging does not create a clean
two-plugin ownership boundary, and it is the direct cause of the fork's failed
standalone typecheck.

### Recommended target shape

```text
Paperclip host
  └── @decaf-ts/paperclip-pixels             [Paperclip plugin]
        - Paperclip SDK worker, UI, persistence, metrics, policy
        - snapshot/event normalization and reconciliation
        - outbound feed mapper and retry/observability client
        - Agent detail Character/metrics tab and Office pages
                         │ HTTPS/mTLS or explicitly configured internal HTTP
                         │ @decaf-ts/paperclip-pixels-contract (schemas only)
                         ▼
Pixel Agents host
  └── @decaf-ts/pixel-agents-paperclip-plugin [Pixel Agents plugin]
        - plugin manifest and lifecycle
        - authenticated feed endpoint and idempotent operation application
        - agent/appearance/layout source implementation
        - Pixel Agents UI contributions and reverse-action forwarding
```

`@decaf-ts/paperclip-pixels-contract` may be a small independently versioned
library or generated AsyncAPI/Zod artifacts. It is **not** a third deployed
service or plugin. It contains only stable DTOs, validation, operation ids,
error codes, protocol compatibility rules, and test fixtures; it must not
import Paperclip or Pixel Agents runtime code.

### What belongs where

| Concern | Paperclip plugin | Pixel Agents plugin | Shared contract only |
| --- | --- | --- | --- |
| Paperclip events, snapshots, metrics, reconciliation | Owns | Never imports | DTOs only |
| New-work / feedback authorization | Owns and enforces | May request an action, never creates work | Request/result schema |
| Feed authentication and operation application | Sends/retries | Owns endpoint, dedupe, acknowledgement | Envelope and error schema |
| Agent declaration, sprites, layout and animations | Provides intent/metrics | Owns visual/spatial implementation | Declarative operation schema |
| Character selection UI | Owns Paperclip detail/page UI and persisted preference | Owns rendering and asset validation | Appearance DTO |
| Pixel Agents menus/widgets/VS Code compatibility | Never imports | Owns | Stable capability declarations |
| Reverse actions (CEO intake/replies) | Validates and performs via Plugin SDK | Presents/forwards only | Action request/result schema |

### Why this is the highest-value simplification

- It removes the invalid fork-to-outer-source import path and restores a clean
  `npm ci` / typecheck / package workflow for the fork.
- Each artifact has one host, one lifecycle, one permission model, one release
  unit, and one test harness.
- It preserves upstreamability: the generic Pixel Agents plugin host remains
  Paperclip-agnostic; Paperclip-specific code remains outside the upstream
  core and can be distributed as its own plugin.
- It lets installations upgrade either side deliberately, with explicit
  protocol compatibility rather than accidental source-tree coupling.
- It eliminates the temptation to recreate the retired relay as a third
  daemon. Retries, batching, back-pressure, and observability belong in the
  Paperclip worker's outbound transport; HTTP receipt/application belongs in
  the Pixel Agents plugin.

### What should *not* be moved wholesale into the Paperclip plugin

Moving all bridge code into the Paperclip package would be counterproductive
if it absorbs the Pixel Agents plugin implementation. The Pixel Agents side
must remain independently installable and testable because it owns the
server/plugin-host lifecycle, UI renderer, asset privilege gate, action
surface, and VS Code/standalone compatibility. Bundling that code into the
Paperclip plugin would either reintroduce source coupling or require Paperclip
to ship code that it cannot run.

Likewise, the pure domain metric reducer can physically live with the
Paperclip plugin rather than being published as a general bridge package. Only
the serializable input/output contract should be shared. This avoids a false
three-component architecture while retaining testability.

### Risks and required controls

| Risk | Control |
| --- | --- |
| Paperclip and Pixel Agents versions drift | Protocol `schemaVersion`, compatibility matrix, consumer-driven contract tests, and reject/diagnose unsupported versions. - ignored we control versioning | 
| Two artifacts release non-atomically | Semver ranges plus a tested upgrade order; Pixel Agents plugin accepts the previous compatible schema during rolling upgrades. |
| Protocol package becomes a backdoor dependency | Keep it runtime-host-neutral; forbid imports of SDK, React, Pixel Agents server, and filesystem APIs. |
| Duplicate security enforcement | Preserve the hard boundary: Paperclip authorizes work creation; Pixel Agents forwards authenticated requests but cannot create work directly. |
| Larger operational burden | Ship a single Helm chart/Compose profile that deploys the two plugins together, with independent health and protocol-compatibility checks. |

### Migration plan
1. restructure repo to:
   - ./pixel-agents: remaisn as is;
   - ./paperclip: remais as is;
   - ./common: independent contracts package - this will be your `paperclip-pixels-common` (not contracts)
   - ./plugins/paperclip: idependent paperclip plugin package;
   - ./plugins/pixel-agents: independent pixel agents plugin
   - common doesnt know any other package; plguins only know common, have no connection to each other
2. Extract only DTOs, Zod validation, fixture builders, and compatibility tests
   to the neutral contract package.
3. Make both clean-clone CI pipelines pass independently, then add an
   integration matrix covering Paperclip-plugin N/N-1 against Pixel
   Agents-plugin N/N-1.
4. Remove the temporary combined-package entry only after a documented,
   tested migration path exists for Compose, Kubernetes, and current users.

## Highest-value remediation sequence

1. **Repair the fork boundary.** Move bridge/fork contract fixtures and types
   into a neutral, published contract package (or duplicate test fixtures);
   remove all fork imports of `../../../../src`; fix strict test typings; make
   `npm ci && npm run check-types && npm test && npm run package` succeed from
   a clean fork clone.
2. **Replace release CI.** Add one actual gate for the outer repository:
   submodules, typecheck, lint, build, all tests, fork checks, package smoke,
   image build, integration contract tests, SBOM/audit, and provenance-aware
   npm/container publishing. => Default to decaf-ts reusable actions when possible. i'll provide auth keys after implementation;
3. **Correct public docs.** Delete retired relay instructions, reconcile
   README/tutorials/architecture/runbooks, and add supported Docker,
   Kubernetes, configuration, chart, control, security, and troubleshooting
   documentation.
4. **Complete the Paperclip UX through public slots.** Add agent `detailTab`
   support; separate Design/View and Configuration screens; add a connection
   badge, fullscreen iframe control, bounded communications log, and native
   host-styled operational charts.
5. **Implement true character composition.** Define face/hair/skin/clothes/
   accessories schemas, asset layering and directional variants, a migration
   path from whole sheets, previews, validation, and sync contracts. Port
   external assets. license/provenance review accepted internally;
6. **Make deployment production-grade.** Publish immutable images, externalize
   secrets, add TLS/mTLS and NetworkPolicies, configure ingress and backups,
   add health/metrics/logging/alerts, remove committed dev secrets, and make
   initial company configuration declarative.

## Useful repository locations

- Current manifest: `src/manifest.ts`
- Current combined office page: `src/ui/PixelOfficePage.tsx`
- Character picker: `src/ui/components/character-picker.tsx`
- Relay: `src/relay.ts`
- Pixel Agents embedding: `src/pixel-agents-plugin/embedding.ts`
- Docker/Kubernetes reference deployment: `deploy/`
- Fork plugin host: `pixel-agents/server/src/plugins/`
- Legacy synchronization script: `scripts/sync-pixel-agents-legacy.mjs`
