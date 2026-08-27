# AGENTS.md — Paperclip Pixel Bridge

This is the **project-root constitution** for the Paperclip ↔ Pixel Agents
translation layer (specification `PAPERCLIP_PIXELS-1`, domain root
[SAA-150](/SAA/issues/SAA-150)). It is distinct from the `paperclip/AGENTS.md`
submodule file (which governs the Paperclip submodule, not this project) and
takes precedence for all work under this repository root.

- **Specification:** `PAPERCLIP_PIXELS-1` — Paperclip ↔ Pixel Agents translation
  layer.
- **Specification domain root:** [SAA-150](/SAA/issues/SAA-150).
- **Specification record:** `workdocs/ai/project/specifications/PAPERCLIP_PIXELS_1.md`.
- **Delivery plan:** `workdocs/ai/project/plan.md`.
- **Status:** locked for V1 (implementation-grade design specification,
  sections 1–42 in the [SAA-150](/SAA/issues/SAA-150) description). The 16
  locked decisions (§2) stand unless an upstream API makes one technically
  impossible.

## Project

Paperclip ↔ Pixel Agents translation layer (`PAPERCLIP_PIXELS-1`). A
loss-minimizing bridge that makes Paperclip operational state legible and
useful inside the Pixel Agents graphical environment **without** turning Pixel
Agents into a second source of business truth and **without** reducing
Paperclip's richer model to a binary `working / idle` character state.

Final architectural principle (§42): _A faithful observer and policy-aware
translator of Paperclip organizational reality, not an alternative orchestration
engine and not a renderer._

### One package, at the repo root

This project ships as a single npm package, `@decaf-ts/paperclip-pixels`,
living directly at the repository root (not nested under `packages/*` — an
earlier revision split it into three sub-packages with their own
`package.json`s; that added real friction, `workspace:*` references plain npm
can't resolve, for no benefit, since only one of the three was ever published.
`paperclip/` and `pixel-agents/` remain **git submodules only**, kept purely
for reference/future upstream contributions — never modified, never a build
dependency beyond that).

- **`src/core/`** — domain logic + behavioral proxies: snapshot loader, event
  normalizer + idempotent reducer, entity/run/concurrency projection, temporal
  windows, behavioral proxy calculator, feedback classifier, action policy /
  new-work gate, reconciliation. **Must not import React, the Pixel Agents
  renderer, or Paperclip UI code.** No rendering decisions.
- **`src/{worker,manifest,actions,relay,snapshot,subscriptions,persistence}.ts`,
  `src/ui/`** — Paperclip host integration: manifest / capabilities, event
  subscriptions, authoritative snapshot bootstrap, SDK client calls,
  `ctx.state` persistence, `ctx.data` / `ctx.actions` / `ctx.streams` handlers,
  embedded Pixel UI surface (renders inside Paperclip's own UI).
- **`src/pixel-agents-provider/`** — Pixel Agents adapter: consumes the bridge
  contract, maps only semantically valid current events to current
  `AgentEvent` semantics, retains richer behavior in a sidecar, integrates at
  the smallest possible source-level adapter, never fakes tool-hook semantics
  where no correspondence exists.
- **`bin/paperclip-pixel-relay.js`** — the companion CLI a user runs alongside
  Pixel Agents (published as this package's `bin`; Pixel Agents has no
  plugin-loading mechanism of its own, so there's nothing to "install into"
  it).

Data flow (§7, §8): Paperclip (authoritative) → public Plugin SDK only →
`src/core` (raw + metrics + semantics) → canonical bridge contract →
`src/pixel-agents-provider` maps it to Pixel Agents' real wire format → the
`paperclip-pixel-relay` CLI (reads Pixel Agents' locally-generated bearer
token, forwards with correct auth) → Pixel Agents' real, unmodified
`/api/hooks/claude` endpoint; UI-facing state also flows to the embedded
Paperclip UI plugin page.

## Stack And Conventions

- **Language:** TypeScript.
- **Template:** bootstrapped from decaf-ts's `ts-workspace` template, but its
  `gulpfile.js`-based dual CJS/ESM build was replaced with an esbuild bundle
  (`scripts/build.mjs`/`scripts/build-ui.mjs`) suited to a Paperclip plugin
  (self-contained worker bundle + a separate UI bundle), and its single-Jest
  test setup was split into three runners for the same reason — see
  `workdocs/tutorials/DeveloperGuide.md`'s "Building and testing" section.
  Reuse `tsconfig.json`, ESLint, and Prettier as-is.
- **Dependency resolution:** real npm `dependencies`/`devDependencies` for
  everything publishable. `@paperclipai/plugin-sdk`/`@paperclipai/shared`
  (inside the `paperclip/` submodule) are the one exception — plain npm can't
  resolve them (`plugin-sdk`'s own `package.json` depends on `shared` via the
  pnpm/yarn-only `workspace:*` protocol) — `npm install`'s `postinstall` hook
  (`scripts/link-paperclip-sdk.mjs`) symlinks them in instead.
- **Normative integration surface:** compile against the installed
  `@paperclipai/plugin-sdk` types — **not** future-looking prose. Do not depend
  on unreleased Paperclip roadmap features or unreleased Pixel Agents provider
  types (§4.1, §38).
- **Upstream neutrality (NFR-8):** public/exposed APIs only — no direct
  database access, no undocumented host internals, no private Paperclip routes,
  no invasive Pixel Agents core hacks. Upstream contributions are welcome but
  not required for V1 correctness (locked decision 16).

## Architecture Invariants (locked, spec §2)

These invariants are locked for V1 and may not be relaxed without CTO approval
(and, where product scope is implicated, Product Manager approval).

1. **Paperclip is the sole source of truth for organizational/business state.**
2. **Pixel Agents owns visual/spatial state** (character identity/appearance,
   spatial presentation, office layout, animations, visual activity,
   environmental behavior). Its core is agent/platform agnostic.
3. **The bridge is information-rich and presentation-poor.** It exposes derived
   telemetry and behavioral proxies — not business truth, and not fictional
   psychology. Pixel Agents chooses how to animate them.
4. **No clone-per-run policy.** Concurrent Paperclip runs are preserved as
   run-level data; the bridge does not require one graphical character per run.
5. **At-least-once / unordered event model.** Paperclip event delivery is
   treated as at-least-once and not globally ordered. Reducers are idempotent
   with `eventId` dedupe, plus **periodic authoritative reconciliation**
   (default 5 min; also on reconnect / sequence anomaly / impossible
   transition / UI request after long inactivity). The runtime is events-first,
   not poll-based.
6. **Single trust boundary.** All Paperclip domain access routes through the
   worker bridge; UI components **never** call Paperclip HTTP routes directly
   (§28.2).
7. **Least-privilege manifest.** Request only required capabilities. Read-only
   visualization needs no mutation caps; individual-agent feedback needs no
   `issues.create` capability (§14, §28.1).
8. **Public/exposed APIs only** (locked decision 10): no direct DB, private
   routes, or Pixel Agents core hacks.

## Security-Critical Invariant: New-Work Intake

This is a security-critical invariant (§5.2, §17, §18, §28).

- **New work enters through company/leadership intake only.** The user is a
  client of the company, not a direct task dispatcher to arbitrary individual
  agents. Only the company/CEO intake action may originate unrestricted
  new-work intent.
- **Individual-agent conversations are feedback channels** that may report
  progress, ask questions, expose blockers, request clarification, or accept
  replies in the context of existing work — but they **must never silently
  create new Paperclip work objects**.
- **The UI fails closed.** If text entered in an individual-agent interaction
  appears to introduce new work, no mutation occurs and a deliberate "Send to
  company" / "Open company intake" path is offered.
- **The hard guarantee is the action path, not a language classifier.** The
  structural boundary is enforced by separate APIs / capabilities / action
  paths: individual-agent reply actions require an existing `issueId` / `runId`
  / `taskKey` binding and the reply handler does not hold or invoke
  `issues.create` for arbitrary text. A language model or heuristic may
  _suggest_ new work, but the guarantee comes from the action path.

## No Fictional Psychology

"Stress", "satisfaction", "engagement", and similar human concepts are **never
asserted as facts** (locked decision 13, §11.11–11.12). The bridge exposes
**operational proxies** — each with explicit `confidence` and `basis` provenance
— and the UI must never present them as ground-truth emotion.

## Versioning

Every serialized bridge payload carries `schemaVersion: 1` (§33.1, NFR-6).
Breaking changes increment the schema version. Persist compact time buckets in
`ctx.state` (instance / company / project / agent / run scopes) so 24h metrics
survive restart even when Paperclip lacks retrospective event history (§39.3).

## Input Validation

- All `ctx.data` / `ctx.actions` / `ctx.streams` handlers **validate payloads
  with Zod** (§28.4, FR-11). Untrusted UI input is never trusted structurally.
- Action context uses **host-authenticated actor identity**, not user-supplied
  actor IDs (§15, §28.4).
- **No resolved secrets in plugin state** (§28.3, FR-12): retain references,
  resolve at call time. Never log secrets or full sensitive prompts by default
  (§32, NFR-7).

## Git Policy

The domain root [SAA-150](/SAA/issues/SAA-150) owns **exactly one
user-approved commit** through the `git-ops` skill.

- Milestone and implementation children **never commit independently**. They
  leave repository edits uncommitted in the workspace for the parent domain
  root executor to include in the single final commit.
- The commit message uses specification ID `PAPERCLIP_PIXELS-1`.
- Branch identity: `PAPERCLIP_PIXELS-1`.
- Delivery Documentation Specialist writes documentation artifacts
  (`AGENTS.md`, `plan.md`, specification records) but **never stages, commits,
  amends, branches, pushes, or creates pull requests**.

## Testing

Jest unit / integration / contract / policy tests per §31 (the repository's
`test`, `test:integration`, and `test:all` scripts drive Jest).

- **Core unit tests (§31.1):** reducers, temporal windows, behavioral proxies,
  confidence/provenance.
- **Contract tests (§31.3):** raw projection fidelity over fixtures; all
  displayed entities reference canonical Paperclip IDs; concurrent runs
  preserved.
- **Policy tests (§31.5):** new-work invariant — individual-agent reply cannot
  create an issue; new work only in intake paths; reply without existing
  context fails closed.
- **Pixel Agents tests (§31.4):** non-regression; existing behavior unchanged;
  adapter cannot corrupt unrelated sessions.
- **Reproducible evidence is required before technical approval.** Do not claim
  a check passed unless it was actually executed successfully.

## Governance And Ownership

| Role | Owner | Responsibility |
| --- | --- | --- |
| Product | Product Manager | Scope and acceptance (parent spec is user-authored and locked for V1) |
| Technical | CTO | Architecture, feasibility, security, and operational governance; approves changes to this `AGENTS.md` |
| Documentation | Delivery Documentation Specialist | Domain record structure, links, status snapshots; sole writer of this file and `workdocs/ai/project/plan.md` |
| Verification | QA | Independent validation of policy and fidelity invariants |
| Implementation | Executors (decomposed children) | Implementation facts, artifacts, self-verification |

Only apply governance changes to this file when explicitly requested or
approved by the CTO. Escalate ambiguous product scope to the Product Manager.

## References

- Parent specification (user-authored, locked for V1):
  [SAA-150](/SAA/issues/SAA-150), sections 1–42.
- Specification domain record:
  `workdocs/ai/project/specifications/PAPERCLIP_PIXELS_1.md`.
- Delivery plan: `workdocs/ai/project/plan.md`.
- Initialize milestone: [SAA-172](/SAA/issues/SAA-172).
- `delivery-docs` mapping: issue document `delivery-docs` on
  [SAA-150](/SAA/issues/SAA-150).
