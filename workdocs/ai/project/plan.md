# Delivery Plan — PAPERCLIP_PIXELS-1

- **Specification:** `PAPERCLIP_PIXELS-1` — Paperclip ↔ Pixel Agents translation
  layer.
- **Specification domain root:** [SAA-150](/SAA/issues/SAA-150) (status
  `in_progress`).
- **Constitution:** `AGENTS.md` (project root).
- **Specification record:** `workdocs/ai/project/specifications/PAPERCLIP_PIXELS_1.md`.
- **Implementation phases:** 0–8 (spec §36).
- **Definition of Done:** spec §37.
- **Status convention:** snapshots are point-in-time observations; Paperclip is
  authoritative for all lifecycle fields. This plan is reconciled against
  Paperclip via the `reconcile-delivery-plan` skill.

This plan reflects the CTO decomposition already created as Paperclip children
under [SAA-150](/SAA/issues/SAA-150) (phases 0–8, spec §36). Implementation
children are **non-blocking for decomposition** — they are already created and
may proceed against the locked spec plus decaf-ts conventions. Both this plan
and the project-root `AGENTS.md` should exist before the implementation children
complete, but they do not gate decomposition itself.

## Phase Overview (spec §36)

| Phase | Name | Owning package / track |
| --- | --- | --- |
| 0 | Contract lock (canonical bridge contract, `schemaVersion: 1`) | `packages/core` |
| 1 | Read-only raw projection (snapshot loader + event normalizer + idempotent reducer) | `packages/core` + `packages/paperclip-plugin` worker |
| 2 | Temporal metrics (rolling windows 5m/30m/2h/8h/24h) | `packages/core` |
| 3 | Behavioral proxies (load, sustained load, burstiness, friction, failure pressure, context switching, collaboration, momentum; confidence + provenance) | `packages/core` |
| 4 | Paperclip plugin UI bridge (worker `ctx.data`/`ctx.actions`/`ctx.streams`; embedded UI surface; live updates) | `packages/paperclip-plugin` worker + Paperclip plugin UI |
| 5 | Company intake / individual-agent feedback interaction (new-work gate, fail-closed routing) | `packages/paperclip-plugin` worker + Paperclip plugin UI + `packages/core` (policy) |
| 6 | Pixel Agents adapter (current `AgentEvent` mapping; rich sidecar) | `packages/pixel-agents-provider` |
| 7 | Rich graphical use | `packages/pixel-agents-provider` |
| 8 | Hardening + reviews (restart/duplicate/out-of-order/disconnect/company-switch safety) | cross-cutting |

## Work Tracks (Paperclip children under SAA-150)

### Back-End — `packages/core` (Phases 0–3 + feedback + policy + reconciliation)

- **Child:** [SAA-174](/SAA/issues/SAA-174) — _Implement packages/core —
  Paperclip↔Pixel bridge translation core (PAPERCLIP_PIXELS-1)_.
- **Status snapshot:** `in_progress`.
- **Scope:** canonical bridge contract lock (Phase 0, `schemaVersion: 1`); raw
  read-only projection + event normalizer + idempotent reducer (Phase 1);
  rolling-window temporal metrics (Phase 2); behavioral proxies with confidence
  + provenance (Phase 3); feedback classifier; action policy / new-work gate;
  periodic authoritative reconciliation (default 5 min, plus on reconnect /
  sequence anomaly / impossible transition). Must not import React, the Pixel
  Agents renderer, or Paperclip UI code.
- **Blocks:** the worker, UI, and provider tracks (they consume the core
  contract).

### Back-End — `packages/paperclip-plugin` worker (Phases 1–5 worker side)

- **Child:** [SAA-176](/SAA/issues/SAA-176) — _Implement packages/paperclip-plugin
  worker — Paperclip plugin manifest+SDK wiring (PAPERCLIP_PIXELS-1)_.
- **Status snapshot:** `blocked`.
- **Blocked by:** [SAA-174](/SAA/issues/SAA-174) (core).
- **Scope:** manifest / least-privilege capabilities; event subscriptions;
  authoritative snapshot bootstrap; SDK client calls; `ctx.state` persistence;
  `ctx.data` / `ctx.actions` / `ctx.streams` handlers (Phases 1–5 worker side);
  Zod validation on all handlers; host-authenticated actor identity; no resolved
  secrets in plugin state.

### Front-End — Paperclip plugin UI (Phases 4–5 UI)

- **Child:** [SAA-177](/SAA/issues/SAA-177) — _Implement Paperclip plugin UI —
  bridge rendering + company intake + fail-closed feedback (PAPERCLIP_PIXELS-1)_.
- **Status snapshot:** `blocked`.
- **Blocked by:** [SAA-174](/SAA/issues/SAA-174) (core).
- **Scope:** embedded Pixel UI surface; bridge rendering from `ctx.streams`
  (snapshot + deltas); full snapshot re-fetch on mount / company-switch /
  reconnect / sequence-gap / refresh; company/CEO intake action; individual-agent
  feedback UI with **fail-closed** new-work routing ("Send to company"). UI
  never calls Paperclip HTTP routes directly — all domain access routes through
  the worker bridge.

### Back-End (read-only) — Pixel Agents provider-registration research spike

- **Child:** [SAA-175](/SAA/issues/SAA-175) — _Research spike: Pixel Agents
  provider-registration boundary (PAPERCLIP_PIXELS-1 §39.1)_.
- **Status snapshot:** `in_progress`.
- **Scope:** read-only reassessment of the Pixel Agents provider-registration
  boundary (§39.1). Pixel Agents currently ships only `HookProvider`; provider
  registry is source-level. Determine whether the standalone adapter needs a
  minimal source-level registration or an external wrapper; prefer a small
  upstreamable provider change over a hard fork. Output is a finding/recommendation
  that unblocks the provider package.

### Back-End — `packages/pixel-agents-provider` (Phases 6–7)

- **Child:** [SAA-178](/SAA/issues/SAA-178) — _Implement packages/pixel-agents-provider
  — Pixel Agents bridge adapter + sidecar (PAPERCLIP_PIXELS-1)_.
- **Status snapshot:** `blocked`.
- **Blocked by:** [SAA-174](/SAA/issues/SAA-174) (core) and
  [SAA-175](/SAA/issues/SAA-175) (spike).
- **Scope:** consume the bridge contract; map only semantically valid current
  events to current `AgentEvent` semantics without fabricated tool claims;
  retain richer behavior in a sidecar; integrate at the smallest possible
  source-level adapter (Phases 6–7); never fake tool-hook semantics where no
  correspondence exists.

### Cross-cutting — Phase 8 hardening + reviews + the single commit

- **Phase 8:** restart-, duplicate-event-, out-of-order-event-, disconnect-,
  and company-switch-safety (NFR-4); performance validation (NFR-1–NFR-3);
  observability review (§32); versioning tests (§33.1).
- **Reviews (§37 Definition of Done):**
  - Security Engineer review (least-privilege manifest, trust boundary, no
    resolved secrets, host-authenticated actor, new-work invariant).
  - QA independent verification (policy tests §31.5, contract tests §31.3,
    Pixel Agents non-regression §31.4, fidelity/behavioral acceptance §37).
  - Code Documentation Specialist review (operational docs
    `docs/DESIGN_SPEC.md`, `docs/BRIDGE_CONTRACT.md`, `docs/SOURCES.md` per §8).
- **Single commit:** the domain root [SAA-150](/SAA/issues/SAA-150) owns exactly
  one user-approved commit through `git-ops`, including all code, tests, and
  documentation. Implementation/milestone children never commit independently.

## Dependency Graph

```mermaid
flowchart LR
    core["packages/core<br/>SAA-174<br/>(Phases 0–3 + policy + reconcile)"]
    worker["paperclip-plugin worker<br/>SAA-176<br/>(Phases 1–5 worker)"]
    ui["Paperclip plugin UI<br/>SAA-177<br/>(Phases 4–5 UI)"]
    spike["provider spike<br/>SAA-175<br/>(§39.1, read-only)"]
    provider["pixel-agents-provider<br/>SAA-178<br/>(Phases 6–7)"]
    harden["Phase 8 hardening<br/>+ reviews + single commit"]
    root["SAA-150 domain root<br/>(one user-approved commit)"]

    core --> worker
    core --> ui
    core --> provider
    spike --> provider
    worker --> harden
    ui --> harden
    provider --> harden
    harden --> root
```

## Acceptance Criteria (spec §37 Definition of Done)

Tracked as unchecked outcomes in the specification record
`workdocs/ai/project/specifications/PAPERCLIP_PIXELS_1.md` until verified:

- [ ] **Paperclip fidelity:** all displayed companies/agents/projects/issues
      reference canonical Paperclip IDs; concurrent runs preserved and
      queryable; multi-project activity preserved; events deduplicated;
      reconciliation repairs intentional test drift; Paperclip remains
      authoritative for every mutation.
- [ ] **Behavioral fidelity:** workload differentiates short burst from
      sustained load; context switching accounts for project/issue movement;
      blocking/approvals/failures contribute to friction; every proxy includes
      confidence and provenance/basis; UI never presents inferred
      stress/satisfaction as ground truth.
- [ ] **Interaction:** new work can enter through company/CEO intake;
      individual-agent feedback appears graphically; replies can continue
      existing work context; individual-agent reply handler cannot create new
      work; new-work-looking replies can be routed to company intake explicitly.
- [ ] **Pixel Agents:** existing functionality remains intact; no clone-per-run
      rule imposed; current supported activity events mapped without fabricated
      tool claims; rich sidecar data retained for future behaviors.
- [ ] **Reliability:** restart-, duplicate-event-, out-of-order-event-,
      disconnect-, and company-switch-safe.
- [ ] **Security:** least-privilege manifest; no resolved secrets persisted; UI
      uses worker bridge for Paperclip access; action context uses
      host-authenticated actor identity.

## Open Items For The Parent Owner

- Formalize the specification key (`PAPERCLIP_PIXELS`) by setting the project
  `shortname` or `SPECIFICATION_KEY` env so future domain records resolve
  deterministically (see specification record Risks).
- Resolve the Pixel Agents provider-registration boundary via the
  [SAA-175](/SAA/issues/SAA-175) spike before the provider package
  ([SAA-178](/SAA/issues/SAA-178)) proceeds (§39.1).
- Configure a leadership agent for CEO intake; migrate to first-class CEO Chat
  when available (§39.4 — roadmap, not a V1 dependency).

## Change Log

| Date | Author | Change |
| --- | --- | --- |
| 2026-08-22 | Delivery Documentation Specialist ([SAA-179](/SAA/issues/SAA-179)) | Created the delivery plan from the CTO decomposition (phases 0–8, spec §36) and cross-linked the Paperclip implementation children under [SAA-150](/SAA/issues/SAA-150). Repository edit left uncommitted for the parent domain root's single user-approved commit per `git-ops`. |
