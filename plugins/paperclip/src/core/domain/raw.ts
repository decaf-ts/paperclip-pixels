/**
 * Raw Paperclip projection (spec §9.1).
 *
 * The bridge preserves raw facts before deriving interpretations. Exact
 * Paperclip IDs are retained. Numeric values are optional when the current
 * Paperclip SDK does not expose sufficient source data — never invent zero as
 * "unknown".
 */

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

/**
 * A compact, retained observation. The bridge does not retain raw payloads
 * indefinitely (spec §9.1, §13); recent events are kept bounded per agent.
 */
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

/**
 * Concurrency and multi-project semantics (spec §10). The bridge preserves
 * run-level concurrency without encoding renderer policy (no clone-per-run).
 */
export interface AgentExecutionState {
  agentId: string;
  activeRuns: Array<{
    runId: string;
    issueId?: string;
    projectId?: string;
    status: string;
  }>;
}
