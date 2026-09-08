/**
 * Decoupled input contracts (spec §7.1, NFR-8, §12).
 *
 * The bridge preserves raw facts before deriving interpretations. These are
 * the serializable input shapes the Paperclip worker maps host snapshots and
 * events into, and the Pixel Agents side consumes. Pure types + Zod; no host
 * SDK, no visual renderer, no host UI.
 */

import { z } from "zod";

// ---------------------------------------------------------------------------
// Authoritative snapshot input (spec §12.1)
// ---------------------------------------------------------------------------

export interface CompanyInput {
  id: string;
  name: string;
  description?: string | null;
  status?: string;
}

export const CompanyInputSchema: z.ZodType<CompanyInput> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullish(),
  status: z.string().optional(),
});

export interface AgentInput {
  id: string;
  companyId: string;
  name: string;
  status: string;
  role?: string | null;
  title?: string | null;
  activeRuns?: RunSummaryInput[];
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

export const ProjectInputSchema: z.ZodType<ProjectInput> = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  name: z.string().min(1),
  status: z.string().optional(),
  leadAgentId: z.string().nullish(),
});

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

export const RunSummaryInputSchema: z.ZodType<RunSummaryInput> = z.object({
  id: z.string().min(1),
  agentId: z.string().min(1),
  issueId: z.string().nullish(),
  projectId: z.string().nullish(),
  status: z.string().min(1),
  invocationSource: z.string().nullish(),
  startedAt: z.string().nullish(),
  finishedAt: z.string().nullish(),
  error: z.string().nullish(),
});

export const AgentInputSchema: z.ZodType<AgentInput> = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  name: z.string().min(1),
  status: z.string().min(1),
  role: z.string().nullish(),
  title: z.string().nullish(),
  activeRuns: z.array(RunSummaryInputSchema).optional(),
  observedCostCents: z.number().optional(),
  observedInputTokens: z.number().optional(),
  observedOutputTokens: z.number().optional(),
});

export interface IssueInput {
  id: string;
  companyId: string;
  projectId?: string | null;
  title?: string;
  status: string;
  assigneeAgentId?: string | null;
  identifier?: string | null;
  blocked?: boolean;
  blockedByIssueIds?: string[];
  runs?: RunSummaryInput[];
  approvalsWaiting?: ApprovalInput[];
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export const IssueInputSchema: z.ZodType<IssueInput> = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  projectId: z.string().nullish(),
  title: z.string().optional(),
  status: z.string().min(1),
  assigneeAgentId: z.string().nullish(),
  identifier: z.string().nullish(),
  blocked: z.boolean().optional(),
  blockedByIssueIds: z.array(z.string()).optional(),
  runs: z.array(RunSummaryInputSchema).optional(),
  approvalsWaiting: z.array(z.lazy(() => ApprovalInputSchema)).optional(),
  costCents: z.number().optional(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
});

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

export const ApprovalInputSchema: z.ZodType<ApprovalInput> = z.object({
  id: z.string().min(1),
  companyId: z.string().min(1),
  issueId: z.string().nullish(),
  agentId: z.string().nullish(),
  type: z.string().optional(),
  status: z.string().min(1),
  requestedByAgentId: z.string().nullish(),
  decidedAt: z.string().nullish(),
});

export interface AuthoritativeSnapshotInput {
  company: CompanyInput;
  agents: AgentInput[];
  projects: ProjectInput[];
  issues: IssueInput[];
  approvals: ApprovalInput[];
  observedAt: string;
}

export const AuthoritativeSnapshotInputSchema: z.ZodType<AuthoritativeSnapshotInput> = z.object({
  company: CompanyInputSchema,
  agents: z.array(AgentInputSchema),
  projects: z.array(ProjectInputSchema),
  issues: z.array(IssueInputSchema),
  approvals: z.array(ApprovalInputSchema),
  observedAt: z.string().min(1),
});

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
  eventId: string;
  timestamp: string;
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

export interface AgentCreatedPayload {
  agentId: string;
  name?: string;
  role?: string;
}

export interface AgentErrorClearedPayload {
  agentId: string;
}

export interface IssueCheckedOutPayload {
  issueId: string;
  agentId?: string | null;
}

export interface IssueAssignmentWakeupRequestedPayload {
  issueId: string;
  assigneeAgentId?: string | null;
  reason?: string;
}

export interface IssueDocumentPayload {
  issueId: string;
  documentId?: string;
  title?: string;
  agentId?: string | null;
}

// --- Discriminated union ---------------------------------------------------

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

export type BridgeInputEvent =
  | (BridgeEventBase & { kind: "agent.status_changed"; payload: AgentStatusChangedPayload })
  | (BridgeEventBase & { kind: "agent.run.started"; payload: AgentRunStartedPayload })
  | (BridgeEventBase & { kind: "agent.run.finished"; payload: AgentRunFinishedPayload })
  | (BridgeEventBase & { kind: "agent.run.failed"; payload: AgentRunFailedPayload })
  | (BridgeEventBase & { kind: "agent.run.cancelled"; payload: AgentRunCancelledPayload })
  | (BridgeEventBase & { kind: "issue.updated"; payload: IssueUpdatedPayload })
  | (BridgeEventBase & { kind: "issue.comment.created"; payload: IssueCommentCreatedPayload })
  | (BridgeEventBase & { kind: "approval.created"; payload: ApprovalCreatedPayload })
  | (BridgeEventBase & { kind: "approval.decided"; payload: ApprovalDecidedPayload })
  | (BridgeEventBase & { kind: "budget.incident.opened"; payload: BudgetIncidentOpenedPayload })
  | (BridgeEventBase & { kind: "budget.incident.resolved"; payload: BudgetIncidentResolvedPayload })
  | (BridgeEventBase & { kind: "cost_event.created"; payload: CostEventCreatedPayload })
  | (BridgeEventBase & { kind: "agent.created"; payload: AgentCreatedPayload })
  | (BridgeEventBase & { kind: "agent.error_cleared"; payload: AgentErrorClearedPayload })
  | (BridgeEventBase & { kind: "issue.checked_out"; payload: IssueCheckedOutPayload })
  | (BridgeEventBase & {
      kind: "issue.assignment_wakeup_requested";
      payload: IssueAssignmentWakeupRequestedPayload;
    })
  | (BridgeEventBase & { kind: "issue.document.created"; payload: IssueDocumentPayload })
  | (BridgeEventBase & { kind: "issue.document.updated"; payload: IssueDocumentPayload });

/** Convenience: extract the agent id targeted by an event, if any. */
export function eventAgentId(event: BridgeInputEvent): string | undefined {
  const p = event.payload as { agentId?: string | null };
  return p.agentId ?? undefined;
}
