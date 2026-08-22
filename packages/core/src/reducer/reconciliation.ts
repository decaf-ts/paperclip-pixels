/**
 * Reconciliation (spec §12.4).
 *
 * Compares an authoritative snapshot to the derived state and repairs drift.
 * Returns the list of changed entities. Dedupe alone is insufficient; the
 * worker schedules reconciliation (default 5 min + on reconnect / sequence
 * anomaly / impossible transition / UI request after long inactivity).
 */

import type { AuthoritativeSnapshotInput, IssueInput } from "../domain/events";
import type { AgentWindowStore } from "../temporal/windows";
import { recomputeAgentRaw, type AgentState, type BridgeState } from "./reducer";

function issueChanged(prev: IssueInput, next: IssueInput): boolean {
  return (
    prev.status !== next.status ||
    prev.title !== next.title ||
    prev.assigneeAgentId !== next.assigneeAgentId ||
    (prev.blocked ?? false) !== (next.blocked ?? false) ||
    (prev.projectId ?? null) !== (next.projectId ?? null)
  );
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

/**
 * Repair derived state against an authoritative snapshot. Returns changed
 * entity references (e.g. `"agent:<id>"`, `"issue:<id>"`).
 */
export function reconcile(
  state: BridgeState,
  windows: AgentWindowStore,
  input: AuthoritativeSnapshotInput,
): { changedEntities: string[] } {
  const changed: string[] = [];
  const seenAgents = new Set<string>();
  const seenIssues = new Set<string>();
  const seenApprovals = new Set<string>();
  const seenProjects = new Set<string>();

  state.company = {
    id: input.company.id,
    name: input.company.name,
    status: input.company.status,
  };

  // Projects
  for (const project of input.projects) {
    seenProjects.add(project.id);
    const prev = state.projects.get(project.id);
    if (!prev) {
      state.projects.set(project.id, {
        id: project.id,
        companyId: project.companyId,
        name: project.name,
        status: project.status,
        leadAgentId: project.leadAgentId ?? null,
      });
      changed.push(`project:${project.id}`);
    } else if (
      prev.name !== project.name ||
      prev.status !== project.status ||
      (prev.leadAgentId ?? null) !== (project.leadAgentId ?? null)
    ) {
      prev.name = project.name;
      prev.status = project.status;
      prev.leadAgentId = project.leadAgentId ?? null;
      changed.push(`project:${project.id}`);
    }
  }
  // Drop projects no longer present in the authoritative snapshot.
  for (const id of [...state.projects.keys()]) {
    if (!seenProjects.has(id) && state.projects.get(id)?.companyId === input.company.id) {
      state.projects.delete(id);
      changed.push(`project:${id}:removed`);
    }
  }

  // Issues
  for (const issue of input.issues) {
    seenIssues.add(issue.id);
    const prev = state.issues.get(issue.id);
    if (!prev) {
      state.issues.set(issue.id, { ...issue });
      changed.push(`issue:${issue.id}`);
    } else if (issueChanged(prev, issue)) {
      Object.assign(prev, issue);
      changed.push(`issue:${issue.id}`);
    }
    if (issue.assigneeAgentId) seenAgents.add(issue.assigneeAgentId);
  }
  for (const id of [...state.issues.keys()]) {
    if (!seenIssues.has(id) && state.issues.get(id)?.companyId === input.company.id) {
      state.issues.delete(id);
      changed.push(`issue:${id}:removed`);
    }
  }

  // Approvals
  for (const ap of input.approvals) {
    seenApprovals.add(ap.id);
    const prev = state.approvals.get(ap.id);
    if (!prev) {
      state.approvals.set(ap.id, { ...ap });
      changed.push(`approval:${ap.id}`);
    } else if (prev.status !== ap.status || (prev.issueId ?? null) !== (ap.issueId ?? null)) {
      Object.assign(prev, ap);
      changed.push(`approval:${ap.id}`);
    }
  }
  for (const id of [...state.approvals.keys()]) {
    if (!seenApprovals.has(id) && state.approvals.get(id)?.companyId === input.company.id) {
      state.approvals.delete(id);
      changed.push(`approval:${id}:removed`);
    }
  }

  // Agents — repair identity/status and authoritative active runs.
  for (const agent of input.agents) {
    seenAgents.add(agent.id);
    const a = ensureAgent(state, agent.id, agent.companyId);
    let agentChanged = false;
    if (a.raw.name !== agent.name) {
      a.raw.name = agent.name;
      agentChanged = true;
    }
    if (a.raw.status !== agent.status) {
      a.raw.status = agent.status;
      agentChanged = true;
    }
    if (agent.role !== undefined && a.raw.role !== agent.role) {
      a.raw.role = agent.role;
      agentChanged = true;
    }
    if (agent.observedCostCents !== undefined) a.raw.observedCostCents = agent.observedCostCents;
    if (agent.observedInputTokens !== undefined) a.raw.observedInputTokens = agent.observedInputTokens;
    if (agent.observedOutputTokens !== undefined) a.raw.observedOutputTokens = agent.observedOutputTokens;

    // Reconcile active runs against the authoritative set.
    const authRunIds = new Set((agent.activeRuns ?? []).map((r) => r.id));
    let runsChanged = false;
    for (const runId of [...a.activeRuns.keys()]) {
      if (!authRunIds.has(runId)) {
        a.activeRuns.delete(runId);
        runsChanged = true;
      }
    }
    for (const run of agent.activeRuns ?? []) {
      if (!a.activeRuns.has(run.id)) {
        a.activeRuns.set(run.id, {
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
        runsChanged = true;
      }
    }
    if (runsChanged) {
      // Resync the window store's active-run tracker with authoritative runs.
      const tracked = windows.getActiveRuns(agent.id);
      for (const runId of [...tracked.keys()]) {
        if (!authRunIds.has(runId)) tracked.delete(runId);
      }
      for (const run of agent.activeRuns ?? []) {
        if (!tracked.has(run.id)) {
          tracked.set(run.id, {
            startedAt: run.startedAt ? new Date(run.startedAt).getTime() : null,
            issueId: run.issueId,
            projectId: run.projectId,
          });
        }
      }
    }
    if (agentChanged || runsChanged) changed.push(`agent:${agent.id}`);
    recomputeAgentRaw(state, agent.id);
  }
  // Drop agents no longer present.
  for (const id of [...state.agents.keys()]) {
    if (!seenAgents.has(id)) {
      state.agents.delete(id);
      changed.push(`agent:${id}:removed`);
    }
  }

  state.observedAt = input.observedAt;
  state.lastReconciledAt = new Date().toISOString();

  return { changedEntities: changed };
}
