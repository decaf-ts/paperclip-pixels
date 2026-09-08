/**
 * Derived analytics/behavior wire DTOs (spec §9, §11).
 *
 * The worker computes these from the raw projection; the Pixel Agents side and
 * the UI consume them as serializable payloads. The reducer/metric store
 * itself lives with the Paperclip plugin — only the serializable
 * input/output shapes are shared here.
 */

import { z } from "zod";

// --- Raw projection (spec §9.1) --------------------------------------------

export interface RawRunProjection {
  runId: string;
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  status: string;
  invocationSource?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: unknown;
}

export interface RawIssueRef {
  issueId: string;
  projectId?: string | null;
  status: string;
  title?: string;
}

export interface RawApprovalRef {
  approvalId: string;
  issueId?: string | null;
  type?: string;
  status: string;
  requestedByAgentId?: string | null;
}

export interface RawObservedEvent {
  eventId: string;
  kind: string;
  timestamp: string;
  agentId?: string;
  issueId?: string;
  runId?: string;
  projectId?: string;
  summary: string;
}

export interface RawAgentProjection {
  companyId: string;
  agentId: string;
  name: string;
  status: string;
  role?: string | null;
  activeRuns: RawRunProjection[];
  activeRunCount: number;
  assignedIssues: RawIssueRef[];
  blockedIssues: RawIssueRef[];
  projectIds: string[];
  approvalsWaiting: RawApprovalRef[];
  recentEvents: RawObservedEvent[];
  observedCostCents?: number;
  observedInputTokens?: number;
  observedOutputTokens?: number;
  observedAt: string;
}

export interface AgentExecutionState {
  agentId: string;
  activeRuns: Array<{
    runId: string;
    issueId?: string;
    projectId?: string;
    status: string;
  }>;
}

// --- Temporal metrics (spec §9.2) ------------------------------------------

export const TIME_WINDOWS = ["5m", "30m", "2h", "8h", "24h"] as const;
export type TimeWindow = (typeof TIME_WINDOWS)[number];

export interface WindowedMetrics {
  window: TimeWindow;
  busyRatio?: number;
  idleRatio?: number;
  runStarts: number;
  runFinishes: number;
  runFailures: number;
  runCancellations: number;
  issueTransitions: number;
  projectSwitches: number;
  distinctProjects: number;
  distinctIssues: number;
  commentEvents: number;
  questionEvents: number;
  blockedEvents: number;
  approvalWaitEvents: number;
  meanRunDurationMs?: number;
  p95RunDurationMs?: number;
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  samples: number;
  coverageMs: number;
}

export const WindowedMetricsSchema: z.ZodType<WindowedMetrics> = z.object({
  window: z.enum(TIME_WINDOWS),
  busyRatio: z.number().optional(),
  idleRatio: z.number().optional(),
  runStarts: z.number(),
  runFinishes: z.number(),
  runFailures: z.number(),
  runCancellations: z.number(),
  issueTransitions: z.number(),
  projectSwitches: z.number(),
  distinctProjects: z.number(),
  distinctIssues: z.number(),
  commentEvents: z.number(),
  questionEvents: z.number(),
  blockedEvents: z.number(),
  approvalWaitEvents: z.number(),
  meanRunDurationMs: z.number().optional(),
  p95RunDurationMs: z.number().optional(),
  costCents: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  samples: z.number(),
  coverageMs: z.number(),
});

// --- Behavioral proxies (spec §9.3) ----------------------------------------

export interface BehavioralSignal {
  value: number;
  confidence: number;
  basis: string[];
}

export interface Hysteresis {
  enter: number;
  exit: number;
}

export interface AgentBehaviorVector {
  agentId: string;
  companyId: string;
  calculatedAt: string;
  load: BehavioralSignal;
  sustainedLoad: BehavioralSignal;
  burstiness: BehavioralSignal;
  friction: BehavioralSignal;
  failurePressure: BehavioralSignal;
  interruptionPressure: BehavioralSignal;
  collaboration: BehavioralSignal;
  waiting: BehavioralSignal;
  idleAvailability: BehavioralSignal;
  contextSwitching: BehavioralSignal;
  projectSpread: BehavioralSignal;
  momentum: BehavioralSignal;
  stressProxy?: BehavioralSignal;
  engagementProxy?: BehavioralSignal;
}

export interface VersionedAgentBehaviorVector extends AgentBehaviorVector {
  schemaVersion: 1;
}

export const BehavioralSignalSchema: z.ZodType<BehavioralSignal> = z.object({
  value: z.number().min(0).max(1),
  confidence: z.number().min(0).max(1),
  basis: z.array(z.string()),
});

// --- Feedback (spec §9.4) ---------------------------------------------------

export const AGENT_FEEDBACK_KINDS = [
  "progress",
  "question",
  "blocked",
  "warning",
  "review",
  "approval",
  "result",
  "completion",
  "failure",
  "informational",
] as const;

export type AgentFeedbackKind = (typeof AGENT_FEEDBACK_KINDS)[number];

export interface AgentFeedback {
  id: string;
  companyId: string;
  agentId: string;
  runId?: string;
  issueId?: string;
  projectId?: string;
  kind: AgentFeedbackKind;
  summary: string;
  detail?: string;
  requiresResponse: boolean;
  existingWorkContext: boolean;
  createdAt: string;
  provenance: {
    eventIds?: string[];
    commentId?: string;
    sessionId?: string;
  };
}

// --- Derived bridge aggregates (spec §15) -----------------------------------

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
