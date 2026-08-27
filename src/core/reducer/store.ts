/**
 * BridgeStore — the central state owner (spec §7.1, §12).
 *
 * Owns the raw projection, temporal windows, behavioral proxies, feedback, and
 * exposes the action-policy surface. It is the only mutator of derived state.
 * Core has no runtime dependency on the host SDK, the visual renderer,
 * or any host UI code.
 */

import type { AgentBehaviorVector, BehavioralSignal, VersionedAgentBehaviorVector } from "../domain/behavior.js";
import type { AgentFeedback } from "../domain/feedback.js";
import type { TimeWindow, WindowedMetrics } from "../domain/metrics.js";
import { TIME_WINDOWS, WINDOW_DURATION_MS } from "../domain/metrics.js";
import type {
  ApprovalInput,
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
  IssueInput,
} from "../domain/events.js";
import type { RawAgentProjection, RawRunProjection } from "../domain/raw.js";
import { EventDeduper } from "./idempotency.js";
import { applyEvent, createState, recomputeAgentRaw, type BridgeState } from "./reducer.js";
import { reconcile } from "./reconciliation.js";
import {
  AgentWindowStore,
  type AgentWindowMetrics,
  type CompactAgentBuckets,
} from "../temporal/windows.js";
import type { BehaviorContext } from "../behavior/workload.js";
import {
  computeBurstiness,
  computeCollaboration,
  computeContextSwitching,
  computeIdleAvailability,
  computeInterruptionPressure,
  computeLoad,
  computeProjectSpread,
  computeSustainedLoad,
  computeWaiting,
} from "../behavior/workload.js";
import { computeFailurePressure, computeFriction } from "../behavior/friction.js";
import {
  computeEngagementProxy,
  computeMomentum,
  computeStressProxy,
} from "../behavior/momentum.js";
import { roundTo } from "../temporal/rates.js";

/** Every serialized bridge payload carries this (§33.1, NFR-6). */
export const BRIDGE_SCHEMA_VERSION = 1 as const;

export interface BridgeStoreOptions {
  /** Compute the optional stressProxy signal. Default false (spec §11.11). */
  enableStressProxy?: boolean;
  /** Compute the optional engagementProxy signal. Default false (spec §11.12). */
  enableEngagementProxy?: boolean;
  /** Minimum behavior publish interval in ms (NFR-2). Default 250. */
  minPublishMs?: number;
  /** Maximum deferred behavior publish interval in ms (NFR-2). Default 1000. */
  maxPublishMs?: number;
  /** Decimal places used for semantic (rounded-value) change detection. Default 2. */
  valuePrecision?: number;
  /** Restart-safe compact bucket history to restore on construction (§39.3). */
  restoredBuckets?: Record<string, CompactAgentBuckets>;
}

export interface RawSnapshot {
  schemaVersion: 1;
  company: { id: string; name: string; status?: string } | undefined;
  agents: RawAgentProjection[];
  issues: IssueInput[];
  projects: Array<{ id: string; companyId: string; name: string; status?: string; leadAgentId?: string | null }>;
  approvals: ApprovalInput[];
  observedAt?: string;
  lastReconciledAt?: string;
}

export interface CompanySummary {
  schemaVersion: 1;
  companyId: string;
  companyName: string;
  agentCount: number;
  activeRunCount: number;
  openIssueCount: number;
  blockedIssueCount: number;
  waitingApprovalCount: number;
  observedAt?: string;
  lastReconciledAt?: string;
}

export interface BehaviorChangedEvent {
  schemaVersion: 1;
  type: "agent.behavior.changed";
  companyId: string;
  agentId: string;
  occurredAt: string;
  payload: VersionedAgentBehaviorVector;
}

type BehaviorListener = (event: BehaviorChangedEvent) => void;

const DEFAULT_MIN_PUBLISH_MS = 250;
const DEFAULT_MAX_PUBLISH_MS = 1000;
const DEFAULT_PRECISION = 2;

interface AgentPublishState {
  lastEmittedAt: number;
  lastRounded: Record<string, number> | undefined;
  lastBand: string;
  pending: boolean;
}

function bandFor(value: number): string {
  if (value >= 0.72) return "high";
  if (value >= 0.42) return "moderate";
  return "low";
}

export class BridgeStore {
  private readonly state: BridgeState;
  private readonly windows: AgentWindowStore;
  private readonly deduper: EventDeduper;
  private readonly listeners = new Set<BehaviorListener>();
  private readonly publish = new Map<string, AgentPublishState>();
  private readonly enableStressProxy: boolean;
  private readonly enableEngagementProxy: boolean;
  private readonly minPublishMs: number;
  private readonly maxPublishMs: number;
  private readonly valuePrecision: number;
  private lastObservedAtMs = 0;

  constructor(options: BridgeStoreOptions = {}) {
    this.state = createState();
    this.windows = new AgentWindowStore();
    this.deduper = new EventDeduper();
    this.enableStressProxy = options.enableStressProxy ?? false;
    this.enableEngagementProxy = options.enableEngagementProxy ?? false;
    this.minPublishMs = options.minPublishMs ?? DEFAULT_MIN_PUBLISH_MS;
    this.maxPublishMs = options.maxPublishMs ?? DEFAULT_MAX_PUBLISH_MS;
    this.valuePrecision = options.valuePrecision ?? DEFAULT_PRECISION;
    if (options.restoredBuckets) {
      this.windows.restoreAll(options.restoredBuckets);
    }
  }

  // --- Snapshot loading (§12.1) -------------------------------------------

  /** Replace derived state with an authoritative snapshot (startup). */
  replaceAuthoritativeSnapshot(input: AuthoritativeSnapshotInput): void {
    // Fresh entity state; temporal buckets are retained (empty on first start,
    // or restored from persisted compact state via constructor options).
    this.state.agents.clear();
    this.state.issues.clear();
    this.state.projects.clear();
    this.state.approvals.clear();
    this.state.feedback.clear();
    this.state.company = {
      id: input.company.id,
      name: input.company.name,
      status: input.company.status,
    };

    for (const project of input.projects) {
      this.state.projects.set(project.id, {
        id: project.id,
        companyId: project.companyId,
        name: project.name,
        status: project.status,
        leadAgentId: project.leadAgentId ?? null,
      });
    }
    for (const issue of input.issues) {
      this.state.issues.set(issue.id, { ...issue });
    }
    for (const ap of input.approvals) {
      this.state.approvals.set(ap.id, { ...ap });
    }
    for (const agent of input.agents) {
      const raw: RawAgentProjection = {
        companyId: agent.companyId,
        agentId: agent.id,
        name: agent.name,
        status: agent.status,
        role: agent.role ?? null,
        activeRuns: [],
        activeRunCount: 0,
        assignedIssues: [],
        blockedIssues: [],
        projectIds: [],
        approvalsWaiting: [],
        recentEvents: [],
        observedCostCents: agent.observedCostCents,
        observedInputTokens: agent.observedInputTokens,
        observedOutputTokens: agent.observedOutputTokens,
        observedAt: input.observedAt,
      };
      const activeRuns = new Map<string, RawRunProjection>();
      const tracked = this.windows.getActiveRuns(agent.id);
      tracked.clear();
      for (const run of agent.activeRuns ?? []) {
        activeRuns.set(run.id, {
          runId: run.id,
          agentId: run.agentId,
          issueId: run.issueId ?? null,
          projectId: run.projectId ?? null,
          status: run.status,
          invocationSource: run.invocationSource ?? null,
          startedAt: run.startedAt ?? null,
          finishedAt: run.finishedAt ?? null,
          error: run.error ?? undefined,
        });
        tracked.set(run.id, {
          startedAt: run.startedAt ? new Date(run.startedAt).getTime() : null,
          issueId: run.issueId,
          projectId: run.projectId,
        });
      }
      this.state.agents.set(agent.id, {
        raw,
        activeRuns,
        recentEvents: [],
      });
      recomputeAgentRaw(this.state, agent.id);
    }
    this.state.observedAt = input.observedAt;
    const observedMs = new Date(input.observedAt).getTime();
    if (Number.isFinite(observedMs)) {
      this.lastObservedAtMs = Math.max(this.lastObservedAtMs, observedMs);
    }
  }

  // --- Events (§12.2, §12.3) ----------------------------------------------

  /** Apply one normalized event idempotently. */
  async applyPaperclipEvent(event: BridgeInputEvent): Promise<void> {
    if (this.deduper.seen(event.eventId)) {
      return; // duplicate — idempotent no-op
    }
    const affected = applyEvent(this.state, event, this.windows);
    const eventMs = new Date(event.timestamp).getTime();
    if (Number.isFinite(eventMs)) {
      this.lastObservedAtMs = Math.max(this.lastObservedAtMs, eventMs);
    }
    const wallNow = this.lastObservedAtMs || Date.now();
    for (const agentId of affected) {
      this.tryPublish(agentId, wallNow, false);
    }
  }

  /** Force-publish any pending behavior changes (e.g. after idle). */
  flushBehavior(now = Date.now()): void {
    for (const agentId of this.state.agents.keys()) {
      this.tryPublish(agentId, now, true);
    }
  }

  // --- Reconciliation (§12.4) ---------------------------------------------

  /** Repair drift against an authoritative snapshot. */
  reconcile(input: AuthoritativeSnapshotInput): { changedEntities: string[] } {
    const result = reconcile(this.state, this.windows, input);
    const now = Date.now();
    for (const e of result.changedEntities) {
      if (e.startsWith("agent:") && !e.endsWith(":removed")) {
        this.tryPublish(e.slice("agent:".length), now, false);
      }
    }
    return result;
  }

  // --- Accessors ----------------------------------------------------------

  getRawSnapshot(): RawSnapshot {
    return {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      company: this.state.company,
      agents: [...this.state.agents.values()].map((a) => ({ ...a.raw, recentEvents: a.recentEvents.slice() })),
      issues: [...this.state.issues.values()].map((i) => ({ ...i })),
      projects: [...this.state.projects.values()].map((p) => ({ ...p })),
      approvals: [...this.state.approvals.values()].map((a) => ({ ...a })),
      observedAt: this.state.observedAt,
      lastReconciledAt: this.state.lastReconciledAt,
    };
  }

  getWindowedMetrics(agentId: string, window: TimeWindow, now = this.lastObservedAtMs || Date.now()): WindowedMetrics {
    return this.windows.getWindowedMetrics(agentId, window, now);
  }

  getBehaviorVector(agentId: string, now = this.lastObservedAtMs || Date.now()): VersionedAgentBehaviorVector {
    const vector = this.computeBehavior(agentId, now);
    return { schemaVersion: BRIDGE_SCHEMA_VERSION, ...vector };
  }

  /** Feedback for an agent id or issue id. */
  getFeedback(id: string): AgentFeedback[] {
    const out: AgentFeedback[] = [];
    for (const fb of this.state.feedback.values()) {
      if (fb.agentId === id || fb.issueId === id) out.push({ ...fb });
    }
    return out;
  }

  /**
   * Resolve a single feedback record by its id, scoped to `companyId`.
   *
   * The feedback map is keyed by feedback id (reducer `createFeedback` →
   * `state.feedback.set(${event.eventId}:${kind}, fb)`). Returns the feedback
   * only when it exists AND belongs to `companyId`; otherwise `undefined`.
   * This is the server-side source of truth used by the reply action handler
   * (spec §5.2, §18.3) so a caller can never forge a feedback object or comment
   * on another company's issue.
   */
  getFeedbackById(companyId: string, feedbackId: string): AgentFeedback | undefined {
    const fb = this.state.feedback.get(feedbackId);
    if (fb && fb.companyId === companyId) return { ...fb };
    return undefined;
  }

  getOutstandingFeedback(companyId?: string): AgentFeedback[] {
    const out: AgentFeedback[] = [];
    for (const fb of this.state.feedback.values()) {
      if (companyId && fb.companyId !== companyId) continue;
      out.push({ ...fb });
    }
    return out;
  }

  getCompanySummary(): CompanySummary {
    const agents = [...this.state.agents.values()];
    let activeRunCount = 0;
    for (const a of agents) activeRunCount += a.raw.activeRunCount;
    let blockedIssueCount = 0;
    let openIssueCount = 0;
    for (const i of this.state.issues.values()) {
      openIssueCount++;
      if (i.blocked) blockedIssueCount++;
    }
    let waitingApprovalCount = 0;
    for (const ap of this.state.approvals.values()) {
      if (ap.status === "pending" || ap.status === "open") waitingApprovalCount++;
    }
    return {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      companyId: this.state.company?.id ?? "",
      companyName: this.state.company?.name ?? "",
      agentCount: agents.length,
      activeRunCount,
      openIssueCount,
      blockedIssueCount,
      waitingApprovalCount,
      observedAt: this.state.observedAt,
      lastReconciledAt: this.state.lastReconciledAt,
    };
  }

  /** Raw agent projection for a single agent. */
  getAgentProjection(agentId: string): RawAgentProjection | undefined {
    const a = this.state.agents.get(agentId);
    return a ? { ...a.raw, recentEvents: a.recentEvents.slice() } : undefined;
  }

  // --- Restart-safe state (§39.3) ----------------------------------------

  exportCompactBuckets(): Record<string, CompactAgentBuckets> {
    return this.windows.exportAll();
  }

  restoreCompactBuckets(data: Record<string, CompactAgentBuckets>): void {
    this.windows.restoreAll(data);
  }

  // --- Behavior change events (§16, NFR-2) --------------------------------

  on(event: "agentBehaviorChanged", listener: BehaviorListener): () => void {
    if (event !== "agentBehaviorChanged") {
      throw new Error(`Unsupported event: ${event}`);
    }
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(change: BehaviorChangedEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(change);
      } catch {
        // listener errors must not corrupt bridge state
      }
    }
  }

  // --- Internal behavior computation -------------------------------------

  private buildContext(agentId: string, now: number): BehaviorContext | undefined {
    const a = this.state.agents.get(agentId);
    if (!a) return undefined;
    const metrics = {} as Record<TimeWindow, AgentWindowMetrics>;
    for (const w of TIME_WINDOWS) {
      metrics[w] = this.windows.getExtendedMetrics(agentId, w, now);
    }
    let blockedIssueCount = 0;
    let assignedIssueCount = 0;
    for (const issue of this.state.issues.values()) {
      if (issue.assigneeAgentId === agentId) {
        assignedIssueCount++;
        if (issue.blocked) blockedIssueCount++;
      }
    }
    let waitingApprovalCount = 0;
    for (const ap of this.state.approvals.values()) {
      if ((ap.status === "pending" || ap.status === "open") && (ap.requestedByAgentId === agentId || ap.agentId === agentId)) {
        waitingApprovalCount++;
      }
    }
    const activeRuns = [...a.activeRuns.values()];
    const activeDistinctProjects = new Set(
      activeRuns.map((r) => r.projectId).filter((p): p is string => !!p),
    ).size;
    return {
      agentId,
      companyId: a.raw.companyId,
      now,
      metrics,
      blockedIssueCount,
      assignedIssueCount,
      waitingApprovalCount,
      activeRunCount: a.raw.activeRunCount,
      activeDistinctProjects,
      everObserved: a.recentEvents.length > 0 || a.raw.status !== "unknown",
    };
  }

  private computeBehavior(agentId: string, now: number): AgentBehaviorVector {
    const ctx = this.buildContext(agentId, now);
    const zero: BehavioralSignal = { value: 0, confidence: 0, basis: [] };
    if (!ctx) {
      return {
        agentId,
        companyId: "",
        calculatedAt: new Date(now).toISOString(),
        load: zero,
        sustainedLoad: zero,
        burstiness: zero,
        friction: zero,
        failurePressure: zero,
        interruptionPressure: zero,
        collaboration: zero,
        waiting: zero,
        idleAvailability: { value: 1, confidence: 0, basis: [] },
        contextSwitching: zero,
        projectSpread: zero,
        momentum: zero,
      };
    }
    const load = computeLoad(ctx);
    const sustainedLoad = computeSustainedLoad(ctx);
    const burstiness = computeBurstiness(ctx);
    const failurePressure = computeFailurePressure(ctx);
    const friction = computeFriction(ctx);
    const interruptionPressure = computeInterruptionPressure(ctx);
    const collaboration = computeCollaboration(ctx);
    const waiting = computeWaiting(ctx);
    const idleAvailability = computeIdleAvailability(ctx);
    const contextSwitching = computeContextSwitching(ctx);
    const projectSpread = computeProjectSpread(ctx);
    const momentum = computeMomentum(ctx);

    const vector: AgentBehaviorVector = {
      agentId,
      companyId: ctx.companyId,
      calculatedAt: new Date(now).toISOString(),
      load,
      sustainedLoad,
      burstiness,
      friction,
      failurePressure,
      interruptionPressure,
      collaboration,
      waiting,
      idleAvailability,
      contextSwitching,
      projectSpread,
      momentum,
    };
    if (this.enableStressProxy) {
      vector.stressProxy = computeStressProxy(ctx, sustainedLoad, friction, interruptionPressure, failurePressure);
    }
    if (this.enableEngagementProxy) {
      vector.engagementProxy = computeEngagementProxy(ctx, sustainedLoad, momentum, collaboration, failurePressure);
    }
    return vector;
  }

  private tryPublish(agentId: string, now: number, force: boolean): void {
    const vector = this.computeBehavior(agentId, now);
    let pub = this.publish.get(agentId);
    if (!pub) {
      pub = { lastEmittedAt: 0, lastRounded: undefined, lastBand: "", pending: false };
      this.publish.set(agentId, pub);
    }

    const rounded = this.roundVector(vector);
    const band = bandFor(rounded["sustainedLoad"] ?? 0);
    const changed = this.changed(pub.lastRounded, rounded) || pub.lastBand !== band;

    if (!changed) {
      pub.pending = false;
      return;
    }

    const sinceLast = now - pub.lastEmittedAt;
    const mayPublish = force || pub.lastEmittedAt === 0 || sinceLast >= this.minPublishMs;
    const mustPublish = sinceLast >= this.maxPublishMs;

    if (mayPublish || mustPublish) {
      pub.lastEmittedAt = now;
      pub.lastRounded = rounded;
      pub.lastBand = band;
      pub.pending = false;
      const event: BehaviorChangedEvent = {
        schemaVersion: BRIDGE_SCHEMA_VERSION,
        type: "agent.behavior.changed",
        companyId: vector.companyId,
        agentId,
        occurredAt: new Date(now).toISOString(),
        payload: { schemaVersion: BRIDGE_SCHEMA_VERSION, ...vector },
      };
      this.emit(event);
    } else {
      pub.pending = true;
    }
  }

  private roundVector(vector: AgentBehaviorVector): Record<string, number> {
    const out: Record<string, number> = {};
    const keys: Array<keyof AgentBehaviorVector> = [
      "load",
      "sustainedLoad",
      "burstiness",
      "friction",
      "failurePressure",
      "interruptionPressure",
      "collaboration",
      "waiting",
      "idleAvailability",
      "contextSwitching",
      "projectSpread",
      "momentum",
    ];
    for (const k of keys) {
      const sig = vector[k] as BehavioralSignal | undefined;
      if (sig) out[k] = roundTo(sig.value, this.valuePrecision);
    }
    if (vector.stressProxy) out["stressProxy"] = roundTo(vector.stressProxy.value, this.valuePrecision);
    if (vector.engagementProxy) out["engagementProxy"] = roundTo(vector.engagementProxy.value, this.valuePrecision);
    return out;
  }

  private changed(prev: Record<string, number> | undefined, next: Record<string, number>): boolean {
    if (!prev) return true;
    const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
    for (const k of keys) {
      if ((prev[k] ?? 0) !== (next[k] ?? 0)) return true;
    }
    return false;
  }
}

// Re-export window duration for consumers that need scheduling hints.
export { WINDOW_DURATION_MS };
