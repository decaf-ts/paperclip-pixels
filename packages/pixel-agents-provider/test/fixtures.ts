import type {
  AgentFeedback,
  AgentFeedbackKind,
  AuthoritativeSnapshotInput,
  BehavioralSignal,
  BridgeEventBase,
  BridgeInputEvent,
  VersionedAgentBehaviorVector,
  WindowedMetrics,
} from "@paperclip-pixel/core";

export const COMPANY_ID = "company-1";
export const AGENT_A = "agent-a";
export const AGENT_B = "agent-b";
export const AGENT_C = "agent-c";
export const AGENT_NEW = "agent-new";
export const PROJECT_X = "project-x";
export const PROJECT_Y = "project-y";
export const ISSUE_1 = "issue-1";
export const ISSUE_2 = "issue-2";

/** Fixed base epoch (ms) for deterministic tests. */
export const BASE_MS = 1_700_000_000_000;

export function iso(ms: number): string {
  return new Date(BASE_MS + ms).toISOString();
}

export function baseEvent(
  eventId: string,
  tsMs: number,
  companyId = COMPANY_ID,
): BridgeEventBase {
  return {
    eventId,
    timestamp: iso(tsMs),
    companyId,
    actor: { id: "system", type: "system" },
    entity: { id: eventId, type: "event" },
  };
}

// ---------------------------------------------------------------------------
// Bridge event builders
// ---------------------------------------------------------------------------

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
    payload: {
      runId,
      agentId,
      issueId,
      projectId,
      invocationSource: "manual",
      startedAt: iso(tsMs),
    },
  };
}

export function runFinished(
  eventId: string,
  tsMs: number,
  runId: string,
  agentId = AGENT_A,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.run.finished",
    payload: {
      runId,
      agentId,
      issueId: ISSUE_1,
      projectId: PROJECT_X,
      status: "succeeded",
      finishedAt: iso(tsMs),
    },
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
    payload: {
      runId,
      agentId,
      issueId: ISSUE_1,
      projectId: PROJECT_X,
      error: "boom",
      finishedAt: iso(tsMs),
    },
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
    payload: {
      runId,
      agentId,
      issueId: ISSUE_1,
      projectId: PROJECT_X,
      finishedAt: iso(tsMs),
    },
  };
}

export function statusChanged(
  eventId: string,
  tsMs: number,
  status: string,
  agentId = AGENT_A,
  previousStatus?: string,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "agent.status_changed",
    payload: {
      agentId,
      status,
      ...(previousStatus !== undefined ? { previousStatus } : {}),
    },
  };
}

export function issueUpdated(
  eventId: string,
  tsMs: number,
  issueId: string,
  status: string,
  opts: {
    assigneeAgentId?: string | null;
    projectId?: string | null;
    title?: string;
    blocked?: boolean;
  } = {},
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
  opts: {
    issueId?: string;
    agentId?: string;
    userId?: string;
    isQuestion?: boolean;
  } = {},
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "issue.comment.created",
    payload: {
      commentId: `comment-${eventId}`,
      issueId: opts.issueId ?? ISSUE_1,
      agentId: opts.agentId ?? null,
      userId: opts.userId ?? null,
      body,
      isQuestion: opts.isQuestion,
    },
  };
}

export function approvalCreated(
  eventId: string,
  tsMs: number,
  approvalId: string,
  opts: {
    agentId?: string;
    issueId?: string;
    status?: string;
    type?: string;
  } = {},
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "approval.created",
    payload: {
      approvalId,
      issueId: opts.issueId ?? ISSUE_1,
      agentId: opts.agentId ?? AGENT_A,
      type: opts.type ?? "review",
      status: opts.status ?? "pending",
    },
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
    payload: {
      approvalId,
      issueId: ISSUE_1,
      decision,
      decidedAt: iso(tsMs),
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
    payload: {
      incidentId: `inc-${eventId}`,
      scopeType: "agent",
      scopeId: agentId,
      metric: "spend",
      status: "open",
    },
  };
}

export function budgetIncidentResolved(
  eventId: string,
  tsMs: number,
): BridgeInputEvent {
  return {
    ...baseEvent(eventId, tsMs),
    kind: "budget.incident.resolved",
    payload: {
      incidentId: `inc-${eventId}`,
      scopeType: "agent",
      scopeId: AGENT_A,
      status: "resolved",
    },
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

// ---------------------------------------------------------------------------
// Authoritative snapshot builder
// ---------------------------------------------------------------------------

export function snapshot(
  overrides: Partial<AuthoritativeSnapshotInput> = {},
): AuthoritativeSnapshotInput {
  return {
    company: { id: COMPANY_ID, name: "Acme", status: "active" },
    agents: [
      { id: AGENT_A, companyId: COMPANY_ID, name: "Alice", status: "idle" },
      { id: AGENT_B, companyId: COMPANY_ID, name: "Bob", status: "idle" },
      { id: AGENT_C, companyId: COMPANY_ID, name: "Carol", status: "idle" },
    ],
    projects: [
      { id: PROJECT_X, companyId: COMPANY_ID, name: "Project X" },
      { id: PROJECT_Y, companyId: COMPANY_ID, name: "Project Y" },
    ],
    issues: [
      {
        id: ISSUE_1,
        companyId: COMPANY_ID,
        projectId: PROJECT_X,
        title: "Issue 1",
        status: "in_progress",
        assigneeAgentId: AGENT_A,
      },
    ],
    approvals: [],
    observedAt: iso(0),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Core-owned payload builders (behavior / metrics / feedback)
// ---------------------------------------------------------------------------

function signal(
  value = 0.5,
  confidence = 0.5,
  basis: string[] = ["fixture"],
): BehavioralSignal {
  return { value, confidence, basis };
}

export function behaviorVector(
  overrides: Partial<VersionedAgentBehaviorVector> = {},
): VersionedAgentBehaviorVector {
  return {
    schemaVersion: 1,
    agentId: AGENT_A,
    companyId: COMPANY_ID,
    calculatedAt: iso(0),
    load: signal(0.4),
    sustainedLoad: signal(0.35),
    burstiness: signal(0.2),
    friction: signal(0.1),
    failurePressure: signal(0.05),
    interruptionPressure: signal(0.1),
    collaboration: signal(0.7),
    waiting: signal(0.25),
    idleAvailability: signal(0.8),
    contextSwitching: signal(0.3),
    projectSpread: signal(0.5),
    momentum: signal(0.6),
    ...overrides,
  };
}

export function windowedMetrics(
  overrides: Partial<WindowedMetrics> = {},
): WindowedMetrics {
  return {
    window: "5m",
    runStarts: 1,
    runFinishes: 0,
    runFailures: 0,
    runCancellations: 0,
    issueTransitions: 0,
    projectSwitches: 0,
    distinctProjects: 1,
    distinctIssues: 1,
    commentEvents: 0,
    questionEvents: 0,
    blockedEvents: 0,
    approvalWaitEvents: 0,
    samples: 1,
    coverageMs: 5 * 60 * 1000,
    ...overrides,
  };
}

export function feedback(
  kind: AgentFeedbackKind,
  overrides: Partial<AgentFeedback> = {},
): AgentFeedback {
  return {
    id: `fb-${kind}`,
    companyId: COMPANY_ID,
    agentId: AGENT_A,
    kind,
    summary: `fixture ${kind}`,
    requiresResponse: kind === "question" || kind === "approval",
    existingWorkContext: true,
    createdAt: iso(0),
    provenance: {},
    ...overrides,
  };
}
