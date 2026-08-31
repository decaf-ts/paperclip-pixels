/**
 * Decoupled input contracts (spec §7.1, NFR-8, §12).
 *
 * Core owns its input types and has ZERO runtime dependency on the host
 * plugin SDK, the visual renderer, or any host UI code. The host plugin
 * worker (a separate package/ticket) is responsible for mapping host
 * snapshots and events into these core-owned types.
 *
 * Field shapes are aligned to the public host plugin SDK types so the
 * worker can map losslessly, but core never imports that package at runtime.
 */

import type { RawRunProjection } from "./raw.js";

// ---------------------------------------------------------------------------
// Authoritative snapshot input (spec §12.1)
// ---------------------------------------------------------------------------

export interface CompanyInput {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
}

export interface AgentInput {
  id: string;
  companyId: string;
  name: string;
  status: string;
  role?: string | null;
  title?: string | null;
  /** Active runs known at snapshot time (orchestration state). */
  activeRuns?: RunSummaryInput[];
  /** Observed cumulative cost/token values, when the SDK exposes them. */
  observedCostCents?: number;
  observedInputTokens?: number;
  observedOutputTokens?: number;
}

export interface ProjectInput {
  id: string;
  companyId: string;
  name: string;
  status?: string;
  leadAgentId?: string | null;
}

export interface RunSummaryInput {
  id: string;
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  status: string;
  invocationSource?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  error?: string | null;
}

export interface IssueInput {
  id: string;
  companyId: string;
  projectId?: string | null;
  title?: string;
  status: string;
  assigneeAgentId?: string | null;
  identifier?: string | null;
  /** Whether the issue is currently blocked (blocked-by relations / attention). */
  blocked?: boolean;
  /** Issue IDs that block this issue, when known. */
  blockedByIssueIds?: string[];
  /** Runs known for this issue at snapshot time. */
  runs?: RunSummaryInput[];
  /** Approvals waiting on this issue, when known. */
  approvalsWaiting?: ApprovalInput[];
  /** Cost summary, when exposed by the SDK. */
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ApprovalInput {
  id: string;
  companyId: string;
  issueId?: string | null;
  agentId?: string | null;
  type?: string;
  status: string;
  requestedByAgentId?: string | null;
  decidedAt?: string | null;
}

export interface AuthoritativeSnapshotInput {
  company: CompanyInput;
  agents: AgentInput[];
  projects: ProjectInput[];
  issues: IssueInput[];
  approvals: ApprovalInput[];
  /** ISO 8601 timestamp at which the snapshot was observed. */
  observedAt: string;
}

// ---------------------------------------------------------------------------
// Event-first runtime input (spec §12.2)
// ---------------------------------------------------------------------------

export interface BridgeEventActor {
  id?: string;
  type?: "user" | "agent" | "system" | "plugin";
}

export interface BridgeEventEntity {
  id?: string;
  type?: string;
}

/** Common envelope fields carried by every bridge input event. */
export interface BridgeEventBase {
  /** Unique event identifier (UUID). First-line idempotency key (§12.3). */
  eventId: string;
  /** ISO 8601 timestamp when the event occurred. */
  timestamp: string;
  /** Company the event belongs to. */
  companyId: string;
  actor?: BridgeEventActor;
  entity?: BridgeEventEntity;
}

// --- Per-kind payloads -----------------------------------------------------

export interface AgentStatusChangedPayload {
  agentId: string;
  status: string;
  previousStatus?: string;
}

export interface AgentRunStartedPayload {
  runId: string;
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  invocationSource?: string | null;
  startedAt?: string | null;
}

export interface AgentRunFinishedPayload {
  runId: string;
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  status: string;
  finishedAt?: string | null;
  durationMs?: number;
}

export interface AgentRunFailedPayload {
  runId: string;
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  error?: unknown;
  finishedAt?: string | null;
}

export interface AgentRunCancelledPayload {
  runId: string;
  agentId: string;
  issueId?: string | null;
  projectId?: string | null;
  finishedAt?: string | null;
}

export interface IssueUpdatedPayload {
  issueId: string;
  projectId?: string | null;
  status: string;
  title?: string;
  assigneeAgentId?: string | null;
  blocked?: boolean;
}

export interface IssueCommentCreatedPayload {
  commentId: string;
  issueId: string;
  agentId?: string | null;
  userId?: string | null;
  body: string;
  /** Heuristic flag set by the worker when the comment reads as a question. */
  isQuestion?: boolean;
}

export interface ApprovalCreatedPayload {
  approvalId: string;
  issueId?: string | null;
  agentId?: string | null;
  type?: string;
  status: string;
}

export interface ApprovalDecidedPayload {
  approvalId: string;
  issueId?: string | null;
  decision: string;
  decidedAt?: string | null;
}

export interface BudgetIncidentOpenedPayload {
  incidentId: string;
  scopeType: string;
  scopeId: string;
  metric: string;
  status: string;
}

export interface BudgetIncidentResolvedPayload {
  incidentId: string;
  scopeType: string;
  scopeId: string;
  status: string;
}

export interface CostEventCreatedPayload {
  costEventId: string;
  agentId?: string | null;
  runId?: string | null;
  issueId?: string | null;
  projectId?: string | null;
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
}

/**
 * `agentId` here is the new agent's own id, read from the envelope's
 * top-level `entityId` (never `payload.agentId`, which the host's generic
 * activity-log payload construction sets to the *actor* who created the
 * agent, not the agent itself — confirmed by reading
 * `server/src/services/activity-log.ts`'s `persistActivity`: it always
 * spreads `details` first, then unconditionally overwrites `agentId` with
 * the actor's id).
 */
export interface AgentCreatedPayload {
  agentId: string;
  name?: string;
  role?: string;
}

/** Same `agentId`-from-`entityId` caveat as {@link AgentCreatedPayload}. */
export interface AgentErrorClearedPayload {
  agentId: string;
}

/**
 * `agentId` is the checking-out agent in the common case (an agent checks
 * itself out before acting), but is technically the API actor's id per the
 * same host payload-construction rule — a human/system-triggered checkout on
 * another agent's behalf would report the actor here, not the checked-out
 * agent. Accepted as a best-effort signal (self-checkout is the dominant
 * real-world pattern; see this company's own git-ops conventions).
 */
export interface IssueCheckedOutPayload {
  issueId: string;
  agentId?: string | null;
}

/**
 * Fires only when a plugin explicitly calls the host's
 * `issues.requestWakeup`/`requestWakeups` capability (confirmed by reading
 * `server/src/services/plugin-host-services.ts`) — not a general "blocker
 * resolved" signal. Dormant unless some other installed plugin in the
 * company actively uses that capability.
 */
export interface IssueAssignmentWakeupRequestedPayload {
  issueId: string;
  assigneeAgentId?: string | null;
  reason?: string;
}

/**
 * Shared shape for `issue.document.created`/`issue.document.updated`.
 * `agentId` here IS reliably the authoring actor (the host's activity-log
 * `details` object for this action never sets its own `agentId` key, so
 * nothing overwrites the generic actor-id field — unlike
 * {@link IssueCheckedOutPayload}).
 */
export interface IssueDocumentPayload {
  issueId: string;
  documentId?: string;
  title?: string;
  agentId?: string | null;
}

// --- Discriminated union ---------------------------------------------------

export type BridgeInputEvent =
  | (BridgeEventBase & {
      kind: "agent.status_changed";
      payload: AgentStatusChangedPayload;
    })
  | (BridgeEventBase & {
      kind: "agent.run.started";
      payload: AgentRunStartedPayload;
    })
  | (BridgeEventBase & {
      kind: "agent.run.finished";
      payload: AgentRunFinishedPayload;
    })
  | (BridgeEventBase & {
      kind: "agent.run.failed";
      payload: AgentRunFailedPayload;
    })
  | (BridgeEventBase & {
      kind: "agent.run.cancelled";
      payload: AgentRunCancelledPayload;
    })
  | (BridgeEventBase & {
      kind: "issue.updated";
      payload: IssueUpdatedPayload;
    })
  | (BridgeEventBase & {
      kind: "issue.comment.created";
      payload: IssueCommentCreatedPayload;
    })
  | (BridgeEventBase & {
      kind: "approval.created";
      payload: ApprovalCreatedPayload;
    })
  | (BridgeEventBase & {
      kind: "approval.decided";
      payload: ApprovalDecidedPayload;
    })
  | (BridgeEventBase & {
      kind: "budget.incident.opened";
      payload: BudgetIncidentOpenedPayload;
    })
  | (BridgeEventBase & {
      kind: "budget.incident.resolved";
      payload: BudgetIncidentResolvedPayload;
    })
  | (BridgeEventBase & {
      kind: "cost_event.created";
      payload: CostEventCreatedPayload;
    })
  | (BridgeEventBase & {
      kind: "agent.created";
      payload: AgentCreatedPayload;
    })
  | (BridgeEventBase & {
      kind: "agent.error_cleared";
      payload: AgentErrorClearedPayload;
    })
  | (BridgeEventBase & {
      kind: "issue.checked_out";
      payload: IssueCheckedOutPayload;
    })
  | (BridgeEventBase & {
      kind: "issue.assignment_wakeup_requested";
      payload: IssueAssignmentWakeupRequestedPayload;
    })
  | (BridgeEventBase & {
      kind: "issue.document.created";
      payload: IssueDocumentPayload;
    })
  | (BridgeEventBase & {
      kind: "issue.document.updated";
      payload: IssueDocumentPayload;
    });

/** All event kinds core handles (spec §12.2). */
export const BRIDGE_EVENT_KINDS = [
  "agent.status_changed",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "issue.updated",
  "issue.comment.created",
  "approval.created",
  "approval.decided",
  "budget.incident.opened",
  "budget.incident.resolved",
  "cost_event.created",
  "agent.created",
  "agent.error_cleared",
  "issue.checked_out",
  "issue.assignment_wakeup_requested",
  "issue.document.created",
  "issue.document.updated",
] as const;

export type BridgeEventKind = (typeof BRIDGE_EVENT_KINDS)[number];

/** Convenience: extract the agent id targeted by an event, if any. */
export function eventAgentId(event: BridgeInputEvent): string | undefined {
  const p = event.payload as { agentId?: string | null };
  return p.agentId ?? undefined;
}

/** Convenience: extract the run projection shape from a run event payload. */
export function runProjectionFromEvent(
  payload:
    | AgentRunStartedPayload
    | AgentRunFinishedPayload
    | AgentRunFailedPayload
    | AgentRunCancelledPayload,
  status: string,
): RawRunProjection {
  return {
    runId: payload.runId,
    agentId: payload.agentId,
    issueId: payload.issueId ?? null,
    projectId: payload.projectId ?? null,
    status,
    invocationSource:
      "invocationSource" in payload ? payload.invocationSource ?? null : null,
    startedAt: "startedAt" in payload ? payload.startedAt ?? null : null,
    finishedAt: "finishedAt" in payload ? payload.finishedAt ?? null : null,
    error: "error" in payload ? payload.error : undefined,
  };
}
