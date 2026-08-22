/**
 * Behavior sidecar (spec §21.5).
 *
 * Carries the richer bridge semantics that the current `AgentEvent` union
 * cannot express — behavioral proxies, temporal windowed metrics, run-level
 * concurrency / multi-project activity, semantic feedback, canonical Paperclip
 * IDs / raw projection, and cost/budget — in a sidecar channel consumed by the
 * Paperclip-embedded UI and/or future Pixel Agents behavior APIs. It never
 * destroys richer semantics and never presents inferred stress/satisfaction as
 * ground truth (FR-15).
 *
 * Every serialized sidecar payload carries `schemaVersion: 1` (§33.1, NFR-6).
 * On disconnect the sidecar is marked visibly stale (§30); a fresh authoritative
 * snapshot on reconnect clears staleness.
 */

import type {
  AgentFeedback,
  VersionedAgentBehaviorVector,
  WindowedMetrics,
} from "@paperclip-pixel/core";

import type { SidecarEntry } from "./event-mapper";

/** Per-agent richer state retained in the sidecar. */
export interface SidecarAgent {
  agentId: string;
  /** Latest behavioral proxy vector, when computed by core (§9.3). */
  behavior?: VersionedAgentBehaviorVector;
  /** Rolling-window temporal metrics per window, when computed by core (§9.2). */
  metrics?: WindowedMetrics[];
  /** Outstanding semantic feedback bound to existing work (§9.4). */
  feedback?: AgentFeedback[];
  /** Current run-level concurrency summary (§10). */
  concurrency: {
    activeRunCount: number;
    runs: Array<{
      runId: string;
      issueId?: string | null;
      projectId?: string | null;
      status: string;
    }>;
  };
  /** Distinct projects with recent activity (multi-project activity, §10). */
  projectIds: string[];
  /** Bounded recent sidecar entries (newest last), retained for the UI. */
  recent: SidecarEntry[];
}

/**
 * Serialized sidecar snapshot. Always carries `schemaVersion: 1`.
 * `stale` is true while the bridge is disconnected (§30).
 */
export interface SidecarSnapshot {
  schemaVersion: 1;
  companyId?: string;
  generatedAt: string;
  stale: boolean;
  staleReason?: string;
  staleSince?: string;
  agents: SidecarAgent[];
}

/** Options for constructing a {@link BehaviorSidecar}. */
export interface BehaviorSidecarOptions {
  /** Maximum recent entries retained per agent (bounded, §13). Default 64. */
  maxRecentPerAgent?: number;
}

const DEFAULT_MAX_RECENT = 64;

/**
 * Aggregates richer bridge semantics for the sidecar channel.
 *
 * The sidecar does not recompute behavior/metrics (core owns that); it receives
 * core's outputs and per-event {@link SidecarEntry}s from the mapper, retains
 * the latest per-agent view, and exposes a versioned, stale-aware snapshot.
 */
export class BehaviorSidecar {
  private readonly maxRecentPerAgent: number;
  private companyId?: string;
  private readonly agents = new Map<string, SidecarAgent>();
  private stale = false;
  private staleReason?: string;
  private staleSince?: string;
  private generatedAt: string;

  constructor(options: BehaviorSidecarOptions = {}) {
    this.maxRecentPerAgent = options.maxRecentPerAgent ?? DEFAULT_MAX_RECENT;
    this.generatedAt = new Date(0).toISOString();
  }

  /** Set the company this sidecar is scoped to (cleared on company switch). */
  setCompany(companyId: string): void {
    this.companyId = companyId;
  }

  /** Reset all retained state (e.g. on company switch). */
  clear(): void {
    this.agents.clear();
    this.stale = false;
    this.staleReason = undefined;
    this.staleSince = undefined;
    this.generatedAt = new Date(0).toISOString();
  }

  /** Ingest a per-event sidecar entry from the mapper. */
  ingestEntry(entry: SidecarEntry): void {
    this.companyId = entry.companyId;
    this.touch();
    const agentId = sidecarAgentId(entry);
    if (!agentId) return;
    const agent = this.ensureAgent(agentId);
    this.pushRecent(agent, entry);
    this.applyEntry(agent, entry);
  }

  /** Replace the latest behavioral proxy vector for an agent. */
  setBehavior(agentId: string, behavior: VersionedAgentBehaviorVector): void {
    this.ensureAgent(agentId).behavior = behavior;
    this.touch();
  }

  /** Replace the rolling-window metrics for an agent. */
  setMetrics(agentId: string, metrics: WindowedMetrics[]): void {
    this.ensureAgent(agentId).metrics = metrics;
    this.touch();
  }

  /** Replace the outstanding feedback for an agent. */
  setFeedback(agentId: string, feedback: AgentFeedback[]): void {
    this.ensureAgent(agentId).feedback = feedback;
    this.touch();
  }

  /** Set the run-level concurrency summary for an agent (§10). */
  setConcurrency(
    agentId: string,
    concurrency: SidecarAgent["concurrency"],
  ): void {
    this.ensureAgent(agentId).concurrency = concurrency;
    const projects = new Set<string>();
    for (const run of concurrency.runs) {
      if (run.projectId) projects.add(run.projectId);
    }
    this.ensureAgent(agentId).projectIds = [...projects];
    this.touch();
  }

  /** Mark the sidecar visibly stale (disconnect / reconnect in progress, §30). */
  markStale(reason: string, since = new Date().toISOString()): void {
    this.stale = true;
    this.staleReason = reason;
    this.staleSince = since;
    this.touch();
  }

  /** Clear staleness after a fresh authoritative snapshot on reconnect. */
  clearStale(): void {
    this.stale = false;
    this.staleReason = undefined;
    this.staleSince = undefined;
    this.touch();
  }

  /** Whether the sidecar is currently marked stale. */
  isStale(): boolean {
    return this.stale;
  }

  /** Produce a serialized, schema-versioned snapshot of the sidecar. */
  snapshot(): SidecarSnapshot {
    return {
      schemaVersion: 1,
      companyId: this.companyId,
      generatedAt: this.generatedAt,
      stale: this.stale,
      staleReason: this.staleReason,
      staleSince: this.staleSince,
      agents: [...this.agents.values()].map((a) => ({
        agentId: a.agentId,
        behavior: a.behavior,
        metrics: a.metrics,
        feedback: a.feedback,
        concurrency: a.concurrency,
        projectIds: a.projectIds,
        recent: a.recent,
      })),
    };
  }

  // -- internals -----------------------------------------------------------

  private ensureAgent(agentId: string): SidecarAgent {
    let agent = this.agents.get(agentId);
    if (!agent) {
      agent = {
        agentId,
        concurrency: { activeRunCount: 0, runs: [] },
        projectIds: [],
        recent: [],
      };
      this.agents.set(agentId, agent);
    }
    return agent;
  }

  private pushRecent(agent: SidecarAgent, entry: SidecarEntry): void {
    agent.recent.push(entry);
    if (agent.recent.length > this.maxRecentPerAgent) {
      agent.recent.splice(0, agent.recent.length - this.maxRecentPerAgent);
    }
  }

  private applyEntry(agent: SidecarAgent, entry: SidecarEntry): void {
    switch (entry.kind) {
      case "run-activity": {
        const runs = agent.concurrency.runs;
        if (entry.activity === "started") {
          runs.push({
            runId: entry.runId,
            issueId: entry.issueId,
            projectId: entry.projectId,
            status: entry.status ?? "running",
          });
        } else {
          const idx = runs.findIndex((r) => r.runId === entry.runId);
          if (idx >= 0) runs.splice(idx, 1);
        }
        agent.concurrency.activeRunCount = entry.activeRunCount;
        if (entry.projectId) {
          const projects = new Set(agent.projectIds);
          if (entry.activity === "started") projects.add(entry.projectId);
          agent.projectIds = [...projects];
        }
        break;
      }
      default:
        // Other entry kinds are retained in `recent` only; their structured
        // views (behavior/metrics/feedback) are set explicitly from core.
        break;
    }
  }

  private touch(): void {
    this.generatedAt = new Date().toISOString();
  }
}

/** Extract the agent id a sidecar entry pertains to, if any. */
function sidecarAgentId(entry: SidecarEntry): string | undefined {
  switch (entry.kind) {
    case "lifecycle":
    case "status":
    case "run-activity":
      return entry.agentId;
    case "issue":
    case "comment-feedback":
    case "approval":
    case "cost":
      return entry.agentId ?? undefined;
    case "budget":
      return undefined;
    default:
      return undefined;
  }
}
