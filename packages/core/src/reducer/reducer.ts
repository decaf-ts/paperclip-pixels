/**
 * Idempotent reducer (spec §12, NFR-1).
 *
 * Applies a single normalized `BridgeInputEvent` to the derived state and the
 * temporal window store. Common events are O(1)/O(log n): a single map lookup
 * for the affected agent/issue and a constant-size bucket update.
 */

import type { AgentFeedback, AgentFeedbackKind } from "../domain/feedback";
import type {
  RawAgentProjection,
  RawIssueRef,
  RawObservedEvent,
  RawRunProjection,
} from "../domain/raw";
import type {
  ApprovalInput,
  BridgeInputEvent,
  IssueInput,
} from "../domain/events";
import { runProjectionFromEvent } from "../domain/events";
import type { AgentWindowStore } from "../temporal/windows";

/** Bounded recent-event retention per agent. */
export const RECENT_EVENTS_PER_AGENT = 50;

export interface AgentState {
  raw: RawAgentProjection;
  activeRuns: Map<string, RawRunProjection>;
  recentEvents: RawObservedEvent[];
}

export interface BridgeState {
  schemaVersion: 1;
  company?: { id: string; name: string; status?: string };
  agents: Map<string, AgentState>;
  issues: Map<string, IssueInput>;
  projects: Map<string, { id: string; companyId: string; name: string; status?: string; leadAgentId?: string | null }>;
  approvals: Map<string, ApprovalInput>;
  feedback: Map<string, AgentFeedback>;
  observedAt?: string;
  lastReconciledAt?: string;
}

export function createState(): BridgeState {
  return {
    schemaVersion: 1,
    agents: new Map(),
    issues: new Map(),
    projects: new Map(),
    approvals: new Map(),
    feedback: new Map(),
  };
}

function ensureAgent(state: BridgeState, agentId: string, companyId: string): AgentState {
  let a = state.agents.get(agentId);
  if (!a) {
    a = {
      raw: {
        companyId,
        agentId,
        name: agentId,
        status: "unknown",
        activeRuns: [],
        activeRunCount: 0,
        assignedIssues: [],
        blockedIssues: [],
        projectIds: [],
        approvalsWaiting: [],
        recentEvents: [],
        observedAt: new Date().toISOString(),
      },
      activeRuns: new Map(),
      recentEvents: [],
    };
    state.agents.set(agentId, a);
  }
  return a;
}

function pushRecent(a: AgentState, ev: RawObservedEvent): void {
  a.recentEvents.push(ev);
  if (a.recentEvents.length > RECENT_EVENTS_PER_AGENT) {
    a.recentEvents.shift();
  }
  a.raw.recentEvents = a.recentEvents.slice();
}

function toIssueRef(issue: IssueInput): RawIssueRef {
  return {
    issueId: issue.id,
    projectId: issue.projectId ?? null,
    status: issue.status,
    title: issue.title,
  };
}

/** Recompute the derived raw projection fields for an agent from its maps. */
export function recomputeAgentRaw(state: BridgeState, agentId: string): void {
  const a = state.agents.get(agentId);
  if (!a) return;
  const runs = [...a.activeRuns.values()];
  a.raw.activeRuns = runs;
  a.raw.activeRunCount = runs.length;
  a.raw.projectIds = unique(runs.map((r) => r.projectId).filter((p): p is string => !!p));
  // Assigned/blocked issues + waiting approvals are derived from the issues map.
  const assigned: RawIssueRef[] = [];
  const blocked: RawIssueRef[] = [];
  for (const issue of state.issues.values()) {
    if (issue.assigneeAgentId === agentId) {
      assigned.push(toIssueRef(issue));
      if (issue.blocked) blocked.push(toIssueRef(issue));
    }
  }
  a.raw.assignedIssues = assigned;
  a.raw.blockedIssues = blocked;
  const approvalsWaiting = [...state.approvals.values()]
    .filter((ap) => ap.status === "pending" || ap.status === "open")
    .map((ap) => ({
      approvalId: ap.id,
      issueId: ap.issueId ?? null,
      type: ap.type,
      status: ap.status,
      requestedByAgentId: ap.requestedByAgentId ?? null,
    }));
  a.raw.approvalsWaiting = approvalsWaiting;
  a.raw.observedAt = new Date().toISOString();
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function tsOf(event: BridgeInputEvent): number {
  return new Date(event.timestamp).getTime();
}

function durationMs(startedAt: string | null | undefined, finishedAt: string | null | undefined): number | undefined {
  if (!startedAt || !finishedAt) return undefined;
  const d = new Date(finishedAt).getTime() - new Date(startedAt).getTime();
  return Number.isFinite(d) && d >= 0 ? d : undefined;
}

function hasExistingWorkContext(state: BridgeState, issueId?: string | null, runId?: string | null): boolean {
  if (runId) {
    for (const a of state.agents.values()) {
      if (a.activeRuns.has(runId)) return true;
    }
  }
  if (issueId) return state.issues.has(issueId);
  return false;
}

function createFeedback(
  state: BridgeState,
  event: BridgeInputEvent,
  kind: AgentFeedbackKind,
  agentId: string,
  summary: string,
  opts: {
    issueId?: string | null;
    runId?: string | null;
    projectId?: string | null;
    requiresResponse?: boolean;
    detail?: string;
  },
): AgentFeedback | undefined {
  const existing = hasExistingWorkContext(state, opts.issueId, opts.runId);
  const id = `${event.eventId}:${kind}`;
  if (state.feedback.has(id)) return state.feedback.get(id);
  const fb: AgentFeedback = {
    id,
    companyId: event.companyId,
    agentId,
    runId: opts.runId ?? undefined,
    issueId: opts.issueId ?? undefined,
    projectId: opts.projectId ?? undefined,
    kind,
    summary,
    detail: opts.detail,
    requiresResponse: opts.requiresResponse ?? false,
    existingWorkContext: existing,
    createdAt: event.timestamp,
    provenance: { eventIds: [event.eventId] },
  };
  state.feedback.set(id, fb);
  return fb;
}

/**
 * Apply one normalized event. Mutates `state` and `windows`. Returns the
 * agent ids whose behavior should be recomputed.
 */
export function applyEvent(
  state: BridgeState,
  event: BridgeInputEvent,
  windows: AgentWindowStore,
): string[] {
  const now = tsOf(event);
  const affected: string[] = [];
  const recordObserved = (agentId: string, ev: RawObservedEvent) => {
    const a = ensureAgent(state, agentId, event.companyId);
    pushRecent(a, ev);
    affected.push(agentId);
  };

  switch (event.kind) {
    case "agent.status_changed": {
      const p = event.payload;
      const a = ensureAgent(state, p.agentId, event.companyId);
      a.raw.status = p.status;
      recordObserved(p.agentId, {
        eventId: event.eventId,
        kind: event.kind,
        timestamp: event.timestamp,
        agentId: p.agentId,
        summary: `status -> ${p.status}`,
      });
      break;
    }
    case "agent.run.started": {
      const p = event.payload;
      const run = runProjectionFromEvent(p, "running");
      const a = ensureAgent(state, p.agentId, event.companyId);
      a.activeRuns.set(p.runId, run);
      windows.recordRunStart(p.agentId, p.runId, now, p.issueId, p.projectId);
      if (p.issueId || p.projectId) windows.noteContext(p.agentId, now, p.issueId, p.projectId);
      recomputeAgentRaw(state, p.agentId);
      recordObserved(p.agentId, {
        eventId: event.eventId,
        kind: event.kind,
        timestamp: event.timestamp,
        agentId: p.agentId,
        runId: p.runId,
        issueId: p.issueId ?? undefined,
        projectId: p.projectId ?? undefined,
        summary: `run ${p.runId} started`,
      });
      break;
    }
    case "agent.run.finished":
    case "agent.run.failed":
    case "agent.run.cancelled": {
      const p = event.payload;
      const kind = event.kind === "agent.run.finished" ? "finished" : event.kind === "agent.run.failed" ? "failed" : "cancelled";
      const status = kind === "finished" ? (event.payload as { status: string }).status : kind;
      const prior = aRun(state, p.runId);
      const startedAt = prior?.startedAt ?? null;
      const finishedAt = (event.payload as { finishedAt?: string | null }).finishedAt ?? event.timestamp;
      const dur = durationMs(startedAt, finishedAt);
      windows.recordRunEnd(p.agentId, p.runId, now, kind, dur);
      const a = ensureAgent(state, p.agentId, event.companyId);
      const run = a.activeRuns.get(p.runId);
      if (run) {
        run.status = status;
        run.finishedAt = finishedAt ?? null;
        a.activeRuns.delete(p.runId);
      }
      recomputeAgentRaw(state, p.agentId);
      recordObserved(p.agentId, {
        eventId: event.eventId,
        kind: event.kind,
        timestamp: event.timestamp,
        agentId: p.agentId,
        runId: p.runId,
        issueId: p.issueId ?? undefined,
        projectId: p.projectId ?? undefined,
        summary: `run ${p.runId} ${kind}`,
      });
      if (kind === "failed") {
        createFeedback(state, event, "failure", p.agentId, `Run ${p.runId} failed`, {
          runId: p.runId,
          issueId: p.issueId,
          requiresResponse: false,
        });
      } else if (kind === "finished") {
        createFeedback(state, event, "result", p.agentId, `Run ${p.runId} finished`, {
          runId: p.runId,
          issueId: p.issueId,
          requiresResponse: false,
        });
      }
      break;
    }
    case "issue.updated": {
      const p = event.payload;
      let issue = state.issues.get(p.issueId);
      if (!issue) {
        issue = {
          id: p.issueId,
          companyId: event.companyId,
          projectId: p.projectId ?? null,
          title: p.title,
          status: p.status,
          assigneeAgentId: p.assigneeAgentId ?? null,
          blocked: p.blocked ?? false,
        };
        state.issues.set(p.issueId, issue);
      } else {
        issue.status = p.status;
        if (p.title !== undefined) issue.title = p.title;
        if (p.assigneeAgentId !== undefined) issue.assigneeAgentId = p.assigneeAgentId;
        if (p.blocked !== undefined) issue.blocked = p.blocked;
        if (p.projectId !== undefined) issue.projectId = p.projectId;
      }
      if (issue.assigneeAgentId) {
        recomputeAgentRaw(state, issue.assigneeAgentId);
        if (issue.blocked) {
        createFeedback(state, event, "blocked", issue.assigneeAgentId, `Issue ${p.issueId} is blocked`, {
          issueId: p.issueId,
          projectId: issue.projectId,
          requiresResponse: true,
        });
          recordObserved(issue.assigneeAgentId, {
            eventId: event.eventId,
            kind: event.kind,
            timestamp: event.timestamp,
            issueId: p.issueId,
            projectId: issue.projectId ?? undefined,
            summary: `issue ${p.issueId} updated -> ${p.status}`,
          });
        }
      }
      break;
    }
    case "issue.comment.created": {
      const p = event.payload;
      const issue = state.issues.get(p.issueId);
      const agentId = p.agentId ?? issue?.assigneeAgentId ?? undefined;
      if (agentId) {
        windows.record(agentId, {
          commentEvents: 1,
          questionEvents: p.isQuestion ? 1 : 0,
          issues: [p.issueId],
        }, now);
        if (p.isQuestion) {
          windows.noteContext(agentId, now, p.issueId, issue?.projectId);
        }
        const kind: AgentFeedbackKind = p.isQuestion ? "question" : "progress";
        createFeedback(state, event, kind, agentId, p.body.slice(0, 160) || "comment", {
          issueId: p.issueId,
          projectId: issue?.projectId ?? null,
          requiresResponse: p.isQuestion ? true : false,
          detail: p.body,
        });
        recordObserved(agentId, {
          eventId: event.eventId,
          kind: event.kind,
          timestamp: event.timestamp,
          agentId: agentId,
          issueId: p.issueId,
          summary: p.isQuestion ? "question asked" : "comment posted",
        });
      }
      break;
    }
    case "approval.created": {
      const p = event.payload;
      const ap: ApprovalInput = {
        id: p.approvalId,
        companyId: event.companyId,
        issueId: p.issueId ?? null,
        agentId: p.agentId ?? null,
        type: p.type,
        status: p.status,
        requestedByAgentId: p.agentId ?? null,
      };
      state.approvals.set(p.approvalId, ap);
      const agentId = p.agentId ?? (p.issueId ? state.issues.get(p.issueId)?.assigneeAgentId : undefined);
      if (agentId) {
        windows.record(agentId, { approvalWaitEvents: 1, issues: p.issueId ? [p.issueId] : [] }, now);
        recomputeAgentRaw(state, agentId);
        createFeedback(state, event, "approval", agentId, `Approval ${p.approvalId} requested`, {
          issueId: p.issueId ?? undefined,
          requiresResponse: true,
        });
        recordObserved(agentId, {
          eventId: event.eventId,
          kind: event.kind,
          timestamp: event.timestamp,
          agentId: agentId,
          issueId: p.issueId ?? undefined,
          summary: `approval ${p.approvalId} created`,
        });
      }
      break;
    }
    case "approval.decided": {
      const p = event.payload;
      const ap = state.approvals.get(p.approvalId);
      if (ap) {
        ap.status = p.decision;
        ap.decidedAt = p.decidedAt ?? event.timestamp;
      }
      const agentId = ap?.requestedByAgentId ?? ap?.agentId ?? (p.issueId ? state.issues.get(p.issueId)?.assigneeAgentId : undefined);
      if (agentId) {
        recomputeAgentRaw(state, agentId);
        recordObserved(agentId, {
          eventId: event.eventId,
          kind: event.kind,
          timestamp: event.timestamp,
          agentId: agentId,
          issueId: p.issueId ?? ap?.issueId ?? undefined,
          summary: `approval ${p.approvalId} decided (${p.decision})`,
        });
      }
      break;
    }
    case "budget.incident.opened": {
      const p = event.payload;
      const agentId = p.scopeType === "agent" ? p.scopeId : undefined;
      if (agentId) {
        windows.record(agentId, { blockedEvents: 1 }, now);
        createFeedback(state, event, "warning", agentId, `Budget incident opened (${p.metric})`, {
          requiresResponse: true,
          detail: `scope ${p.scopeType}:${p.scopeId} metric ${p.metric}`,
        });
        recordObserved(agentId, {
          eventId: event.eventId,
          kind: event.kind,
          timestamp: event.timestamp,
          agentId: agentId,
          summary: `budget incident ${p.incidentId} opened`,
        });
      }
      break;
    }
    case "budget.incident.resolved": {
      const p = event.payload;
      const agentId = p.scopeType === "agent" ? p.scopeId : undefined;
      if (agentId) {
        recordObserved(agentId, {
          eventId: event.eventId,
          kind: event.kind,
          timestamp: event.timestamp,
          agentId: agentId,
          summary: `budget incident ${p.incidentId} resolved`,
        });
      }
      break;
    }
    case "cost_event.created": {
      const p = event.payload;
      if (p.agentId) {
        windows.record(p.agentId, {
          costCents: p.costCents ?? 0,
          inputTokens: p.inputTokens ?? 0,
          outputTokens: p.outputTokens ?? 0,
          issues: p.issueId ? [p.issueId] : [],
          projects: p.projectId ? [p.projectId] : [],
        }, now);
        const a = ensureAgent(state, p.agentId, event.companyId);
        if (p.costCents !== undefined) a.raw.observedCostCents = (a.raw.observedCostCents ?? 0) + p.costCents;
        if (p.inputTokens !== undefined) a.raw.observedInputTokens = (a.raw.observedInputTokens ?? 0) + p.inputTokens;
        if (p.outputTokens !== undefined) a.raw.observedOutputTokens = (a.raw.observedOutputTokens ?? 0) + p.outputTokens;
        recordObserved(p.agentId, {
          eventId: event.eventId,
          kind: event.kind,
          timestamp: event.timestamp,
          agentId: p.agentId,
          runId: p.runId ?? undefined,
          issueId: p.issueId ?? undefined,
          summary: `cost event ${p.costCents ?? 0}c`,
        });
      }
      break;
    }
  }

  return unique(affected);
}

function aRun(state: BridgeState, runId: string): RawRunProjection | undefined {
  for (const a of state.agents.values()) {
    const r = a.activeRuns.get(runId);
    if (r) return r;
  }
  return undefined;
}
