import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
  BridgeEventBase,
} from "../src";

export const COMPANY_ID = "company-1";
export const AGENT_A = "agent-a";
export const AGENT_B = "agent-b";
export const PROJECT_X = "project-x";
export const PROJECT_Y = "project-y";
export const PROJECT_Z = "project-z";
export const ISSUE_1 = "issue-1";
export const ISSUE_2 = "issue-2";

/** Fixed base epoch (ms) for deterministic tests. */
export const BASE_MS = 1_700_000_000_000;

export function iso(ms: number): string {
  return new Date(BASE_MS + ms).toISOString();
}

export function baseEvent(eventId: string, tsMs: number, companyId = COMPANY_ID): BridgeEventBase {
  return {
    eventId,
    timestamp: iso(tsMs),
    companyId,
    actor: { id: "system", type: "system" },
    entity: { id: eventId, type: "event" },
  };
}

export function snapshot(overrides: Partial<AuthoritativeSnapshotInput> = {}): AuthoritativeSnapshotInput {
  return {
    company: { id: COMPANY_ID, name: "Acme", status: "active" },
    agents: [
      { id: AGENT_A, companyId: COMPANY_ID, name: "Alice", status: "idle", role: "engineer" },
      { id: AGENT_B, companyId: COMPANY_ID, name: "Bob", status: "idle", role: "engineer" },
    ],
    projects: [
      { id: PROJECT_X, companyId: COMPANY_ID, name: "Project X", status: "active" },
      { id: PROJECT_Y, companyId: COMPANY_ID, name: "Project Y", status: "active" },
      { id: PROJECT_Z, companyId: COMPANY_ID, name: "Project Z", status: "active" },
    ],
    issues: [
      { id: ISSUE_1, companyId: COMPANY_ID, projectId: PROJECT_X, title: "Issue 1", status: "in_progress", assigneeAgentId: AGENT_A },
    ],
    approvals: [],
    observedAt: iso(0),
    ...overrides,
  };
}

export function runStarted(
  eventId: string,
  tsMs: number,
  runId: string,
  agentId = AGENT_A,
  issueId: string | null = ISSUE_1,
  projectId: string | null = PROJECT_X,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.run.started",
    payload: { runId, agentId, issueId, projectId, invocationSource: "manual", startedAt: iso(tsMs) },
  };
}

export function runFinished(
  eventId: string,
  tsMs: number,
  runId: string,
  agentId = AGENT_A,
  durationMs?: number,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.run.finished",
    payload: { runId, agentId, issueId: ISSUE_1, projectId: PROJECT_X, status: "succeeded", finishedAt: iso(tsMs), durationMs },
  };
}

export function runFailed(
  eventId: string,
  tsMs: number,
  runId: string,
  agentId = AGENT_A,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.run.failed",
    payload: { runId, agentId, issueId: ISSUE_1, projectId: PROJECT_X, error: "boom", finishedAt: iso(tsMs) },
  };
}

export function runCancelled(
  eventId: string,
  tsMs: number,
  runId: string,
  agentId = AGENT_A,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.run.cancelled",
    payload: { runId, agentId, issueId: ISSUE_1, projectId: PROJECT_X, finishedAt: iso(tsMs) },
  };
}

export function statusChanged(
  eventId: string,
  tsMs: number,
  status: string,
  agentId = AGENT_A,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.status_changed",
    payload: { agentId, status },
  };
}

export function issueUpdated(
  eventId: string,
  tsMs: number,
  issueId: string,
  status: string,
  opts: { blocked?: boolean; assigneeAgentId?: string | null; projectId?: string | null; title?: string } = {},
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "issue.updated",
    payload: {
      issueId,
      projectId: opts.projectId ?? PROJECT_X,
      status,
      title: opts.title,
      assigneeAgentId: opts.assigneeAgentId ?? AGENT_A,
      blocked: opts.blocked,
    },
  };
}

export function commentCreated(
  eventId: string,
  tsMs: number,
  body: string,
  opts: { issueId?: string; agentId?: string; isQuestion?: boolean } = {},
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "issue.comment.created",
    payload: {
      commentId: `comment-${eventId}`,
      issueId: opts.issueId ?? ISSUE_1,
      agentId: opts.agentId ?? AGENT_A,
      userId: null,
      body,
      isQuestion: opts.isQuestion,
    },
  };
}

export function approvalCreated(
  eventId: string,
  tsMs: number,
  approvalId: string,
  agentId = AGENT_A,
  issueId: string | null = ISSUE_1,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "approval.created",
    payload: { approvalId, issueId, agentId, type: "review", status: "pending" },
  };
}

export function approvalDecided(
  eventId: string,
  tsMs: number,
  approvalId: string,
  decision = "approved",
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "approval.decided",
    payload: { approvalId, issueId: ISSUE_1, decision, decidedAt: iso(tsMs) },
  };
}

export function costEvent(
  eventId: string,
  tsMs: number,
  costCents: number,
  agentId = AGENT_A,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "cost_event.created",
    payload: {
      costEventId: eventId,
      agentId,
      runId: null,
      issueId: ISSUE_1,
      projectId: PROJECT_X,
      costCents,
      inputTokens: 100,
      outputTokens: 50,
    },
  };
}

export function budgetIncidentOpened(
  eventId: string,
  tsMs: number,
  agentId = AGENT_A,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "budget.incident.opened",
    payload: { incidentId: `inc-${eventId}`, scopeType: "agent", scopeId: agentId, metric: "spend", status: "open" },
  };
}
