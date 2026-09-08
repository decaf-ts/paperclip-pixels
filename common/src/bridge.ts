/**
 * Bridge snapshot + stream wire contract (spec §15, §16).
 *
 * The worker's `bridge-snapshot` data handler serves `BridgeCompanySnapshot`;
 * the worker pushes `BridgeStreamEvent` envelopes on the company-scoped
 * `behavior:<companyId>` stream channel. Every payload carries
 * `schemaVersion: 1` (NFR-6).
 */

import { z } from "zod";

import { SCHEMA_VERSION } from "./version.js";
import type {
  AgentBehaviorVector,
  RawAgentProjection,
  VersionedAgentBehaviorVector,
  WindowedMetrics,
  TimeWindow,
} from "./analytics.js";
import type { AgentFeedback } from "./analytics.js";
import type { ApprovalInput, IssueInput, ProjectInput } from "./events.js";
import type { AgentCharacterAssignment } from "./appearance.js";

/** Recommended stream event envelope for worker → UI bridge updates (§16). */
export interface BridgeUiEvent<T = unknown> {
  schemaVersion: 1;
  eventId: string;
  type: string;
  companyId: string;
  occurredAt: string;
  payload: T;
}

/** Per-agent view: raw projection + windowed metrics + behavior vector. */
export interface BridgeAgentView {
  projection: RawAgentProjection;
  metrics: Record<TimeWindow, WindowedMetrics>;
  behavior: VersionedAgentBehaviorVector;
}

export interface BridgeCompanySnapshot {
  schemaVersion: 1;
  company: { id: string; name: string; status?: string };
  summary: {
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
  };
  agents: BridgeAgentView[];
  issues: IssueInput[];
  projects: ProjectInput[];
  approvals: ApprovalInput[];
  feedback: AgentFeedback[];
  observedAt?: string;
  lastReconciledAt?: string;
}

/** Delta payload for `agent.metrics.changed`. */
export interface AgentMetricsDelta {
  agentId: string;
  metrics: Record<TimeWindow, WindowedMetrics>;
}

/** Delta payload for `feedback.changed`. */
export interface FeedbackChangedDelta {
  feedback: AgentFeedback;
  removed?: boolean;
}

/** Stream event envelope emitted by the worker on `behavior:<companyId>` (§16). */
export type BridgeStreamEvent =
  | (BridgeUiEvent<BridgeCompanySnapshot> & { type: "bridge.snapshot" })
  | (BridgeUiEvent<unknown> & { type: "company.summary.changed" })
  | (BridgeUiEvent<RawAgentProjection> & { type: "agent.projection.changed" })
  | (BridgeUiEvent<AgentMetricsDelta> & { type: "agent.metrics.changed" })
  | (BridgeUiEvent<AgentBehaviorVector> & { type: "agent.behavior.changed" })
  | (BridgeUiEvent<FeedbackChangedDelta> & { type: "feedback.changed" });

/** Delta types the UI knows how to apply. Unknown types trigger a full re-fetch. */
export const BRIDGE_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "bridge.snapshot",
  "company.summary.changed",
  "agent.projection.changed",
  "agent.metrics.changed",
  "agent.behavior.changed",
  "feedback.changed",
]);

export const BridgeUiEventSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  eventId: z.string().min(1),
  type: z.string().min(1),
  companyId: z.string().min(1),
  occurredAt: z.string().min(1),
  payload: z.unknown(),
});

/** Type guard for streamed envelopes (defends against unknown/foreign types). */
export function isBridgeStreamEvent(event: unknown): event is BridgeStreamEvent {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as { type?: unknown; schemaVersion?: unknown };
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.type === "string" &&
    BRIDGE_STREAM_EVENT_TYPES.has(candidate.type)
  );
}

/** UI-side alias for a per-agent character assignment (frozen contract). */
export type PixelAgentCharacterAssignment = AgentCharacterAssignment;
