/**
 * Event mapper (spec §21.1/§21.2, FR-14, §21.3, §7.3).
 *
 * Translates the canonical bridge contract (`@paperclip-pixel/core`) into the
 * *current* Pixel Agents `AgentEvent` semantics, mapping ONLY the semantically
 * valid subset and routing everything richer into a sidecar entry. It never
 * fabricates tool-hook semantics where no correspondence exists (FR-14).
 *
 * Safe mappings (spike SAA-175 §4):
 *   sessionStart            — agent first appears (character spawn)
 *   sessionEnd              — agent leaves / despawns
 *   turnEnd(awaitingInput=false) — agent finished a unit of work (idle/done)
 *   turnEnd(awaitingInput=true)  — agent waiting on a human (awaiting reply)
 *   permissionRequest       — approval gate requiring human input
 *
 * Sidecar (no current AgentEvent correspondence, §21.5): run concurrency /
 * multi-project activity, behavioral proxies, temporal metrics, semantic
 * feedback, canonical Paperclip IDs, cost/budget, and toolStart/toolEnd/
 * subagent* (no genuine Paperclip tool/subagent semantics).
 */

import type {
  AgentFeedbackKind,
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "@paperclip-pixel/core";
import { BRIDGE_EVENT_KINDS } from "@paperclip-pixel/core";

import type { AgentEvent, SessionAgentEvent } from "./pixel-agents-types";

/**
 * Parse and lightly validate a raw envelope into a typed bridge input event.
 * Returns null when the envelope is missing required fields or carries an
 * unknown kind (non-mappable -> dropped, never faked). Used by both the
 * provider (`normalizeHookEvent`) and the transport ingress path.
 */
export function parseBridgeEvent(
  raw: Record<string, unknown>,
): BridgeInputEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const kind = (raw as { kind?: unknown }).kind;
  if (typeof kind !== "string") return null;
  if (!(BRIDGE_EVENT_KINDS as readonly string[]).includes(kind)) return null;
  const eventId = (raw as { eventId?: unknown }).eventId;
  const timestamp = (raw as { timestamp?: unknown }).timestamp;
  const companyId = (raw as { companyId?: unknown }).companyId;
  const payload = (raw as { payload?: unknown }).payload;
  if (typeof eventId !== "string") return null;
  if (typeof timestamp !== "string") return null;
  if (typeof companyId !== "string") return null;
  if (!payload || typeof payload !== "object") return null;
  return raw as unknown as BridgeInputEvent;
}

/** Namespace prefix for every synthetic id this adapter synthesizes (§21.3). */
export const ID_NAMESPACE = "paperclip-bridge";

/**
 * Stable, namespaced synthetic session id for a Paperclip agent character.
 * Deterministic in `(companyId, agentId)` so reconnects/re-snapshots address
 * the same character, and namespaced so it can never collide with a real
 * provider id (real ids are bare slugs/uuids; ours always carry the prefix).
 */
export function syntheticSessionId(companyId: string, agentId: string): string {
  return `${ID_NAMESPACE}:${companyId}:${agentId}`;
}

/** Paperclip agent statuses that mean the agent has left / despawned. */
const OFFLINE_STATUSES = new Set([
  "offline",
  "removed",
  "deleted",
  "archived",
  "offboarded",
]);

/** Approval statuses that represent an unresolved gate awaiting a human. */
const PENDING_APPROVAL_STATUSES = new Set([
  "pending",
  "open",
  "requested",
  "awaiting",
  "undecided",
]);

// ---------------------------------------------------------------------------
// Sidecar entries — richer per-event semantics with no AgentEvent home (§21.5)
// ---------------------------------------------------------------------------

export type SidecarEntry =
  | {
      kind: "lifecycle";
      companyId: string;
      agentId: string;
      transition: "started" | "ended";
      reason?: string;
      occurredAt: string;
    }
  | {
      kind: "status";
      companyId: string;
      agentId: string;
      status: string;
      previousStatus?: string;
      occurredAt: string;
    }
  | {
      kind: "run-activity";
      companyId: string;
      agentId: string;
      runId: string;
      issueId?: string | null;
      projectId?: string | null;
      activity: "started" | "finished" | "failed" | "cancelled";
      status?: string;
      error?: unknown;
      activeRunCount: number;
      occurredAt: string;
    }
  | {
      kind: "issue";
      companyId: string;
      agentId?: string | null;
      issueId: string;
      projectId?: string | null;
      status: string;
      title?: string;
      blocked?: boolean;
      occurredAt: string;
    }
  | {
      kind: "comment-feedback";
      companyId: string;
      agentId?: string | null;
      issueId: string;
      commentId: string;
      authorType: "user" | "agent" | "system";
      isQuestion: boolean;
      feedbackKind: AgentFeedbackKind;
      occurredAt: string;
    }
  | {
      kind: "approval";
      companyId: string;
      agentId?: string | null;
      approvalId: string;
      issueId?: string | null;
      type?: string;
      status: string;
      decision?: string;
      occurredAt: string;
    }
  | {
      kind: "budget";
      companyId: string;
      incidentId: string;
      scopeType: string;
      scopeId: string;
      metric: string;
      status: string;
      occurredAt: string;
    }
  | {
      kind: "cost";
      companyId: string;
      agentId?: string | null;
      runId?: string | null;
      issueId?: string | null;
      projectId?: string | null;
      costCents?: number;
      inputTokens?: number;
      outputTokens?: number;
      occurredAt: string;
    };

/** Result of mapping a single bridge event. */
export interface MappingResult {
  /** Zero, one, or two AgentEvents (a `sessionStart` may precede the primary). */
  agentEvents: SessionAgentEvent[];
  /** Richer semantics with no AgentEvent home, or null when none apply. */
  sidecar: SidecarEntry | null;
}

/** Result of mapping an authoritative snapshot (bootstrap). */
export interface SnapshotMappingResult {
  agentEvents: SessionAgentEvent[];
  sidecarEntries: SidecarEntry[];
}

interface AgentSessionState {
  seen: boolean;
  activeRunCount: number;
  lastEventAt: string | null;
}

/**
 * Stateful translator from bridge events to current `AgentEvent` semantics.
 *
 * State is per-agent (session presence + active-run concurrency) plus an
 * `issueId -> assigneeAgentId` index so a human question comment can be routed
 * to the agent responsible for that issue (the comment payload carries the
 * commenter, not the assignee).
 */
export class EventMapper {
  private readonly sessions = new Map<string, AgentSessionState>();
  private readonly issueAssignees = new Map<string, string>();

  /** Reset all session and issue-assignee state (e.g. on company switch). */
  reset(): void {
    this.sessions.clear();
    this.issueAssignees.clear();
  }

  /**
   * Map an authoritative snapshot into `sessionStart` events for every agent
   * (character spawn) plus per-agent concurrency sidecar entries. Agents
   * already seen are not re-spawned (re-snapshot after reconnect is idempotent).
   */
  mapSnapshot(snapshot: AuthoritativeSnapshotInput): SnapshotMappingResult {
    const agentEvents: SessionAgentEvent[] = [];
    const sidecarEntries: SidecarEntry[] = [];

    for (const agent of snapshot.agents) {
      const state = this.ensureSession(snapshot.company.id, agent.id);
      if (!state.seen) {
        state.seen = true;
        agentEvents.push(this.sessionStartFor(snapshot.company.id, agent.id));
        sidecarEntries.push({
          kind: "lifecycle",
          companyId: snapshot.company.id,
          agentId: agent.id,
          transition: "started",
          reason: "snapshot",
          occurredAt: snapshot.observedAt,
        });
      }
      const activeRunCount = agent.activeRuns?.length ?? 0;
      state.activeRunCount = activeRunCount;
      state.lastEventAt = snapshot.observedAt;
      for (const run of agent.activeRuns ?? []) {
        sidecarEntries.push({
          kind: "run-activity",
          companyId: snapshot.company.id,
          agentId: agent.id,
          runId: run.id,
          issueId: run.issueId ?? null,
          projectId: run.projectId ?? null,
          activity: "started",
          status: run.status,
          activeRunCount,
          occurredAt: snapshot.observedAt,
        });
      }
    }

    return { agentEvents, sidecarEntries };
  }

  /** Map a continuous bridge event into AgentEvent(s) + a sidecar entry. */
  mapEvent(event: BridgeInputEvent): MappingResult {
    const companyId = event.companyId;
    const occurredAt = event.timestamp;
    const agentEvents: SessionAgentEvent[] = [];
    let sidecar: SidecarEntry | null = null;

    switch (event.kind) {
      case "agent.status_changed": {
        const { agentId, status, previousStatus } = event.payload;
        sidecar = {
          kind: "status",
          companyId,
          agentId,
          status,
          previousStatus,
          occurredAt,
        };
        if (OFFLINE_STATUSES.has(status)) {
          const state = this.ensureSession(companyId, agentId);
          if (state.seen) {
            state.seen = false;
            state.activeRunCount = 0;
            agentEvents.push(this.sessionEndFor(companyId, agentId, status));
          }
        }
        break;
      }

      case "agent.run.started": {
        const { agentId, runId, issueId, projectId, invocationSource } =
          event.payload;
        const state = this.ensureSession(companyId, agentId);
        this.spawnIfUnseen(companyId, agentId, state, agentEvents, occurredAt);
        state.activeRunCount += 1;
        state.lastEventAt = occurredAt;
        // No AgentEvent expresses "actively working" without faking a tool
        // invocation (FR-14); active work is richer semantics -> sidecar only.
        sidecar = {
          kind: "run-activity",
          companyId,
          agentId,
          runId,
          issueId: issueId ?? null,
          projectId: projectId ?? null,
          activity: "started",
          status: invocationSource ?? "running",
          activeRunCount: state.activeRunCount,
          occurredAt,
        };
        break;
      }

      case "agent.run.finished":
      case "agent.run.cancelled":
      case "agent.run.failed": {
        const p = event.payload;
        const activity =
          event.kind === "agent.run.finished"
            ? "finished"
            : event.kind === "agent.run.failed"
              ? "failed"
              : "cancelled";
        const state = this.ensureSession(companyId, p.agentId);
        this.spawnIfUnseen(companyId, p.agentId, state, agentEvents, occurredAt);
        if (state.activeRunCount > 0) state.activeRunCount -= 1;
        state.lastEventAt = occurredAt;
        // A finished unit of work -> the agent is idle / done between runs.
        agentEvents.push(this.turnEndFor(companyId, p.agentId, false));
        sidecar = {
          kind: "run-activity",
          companyId,
          agentId: p.agentId,
          runId: p.runId,
          issueId: p.issueId ?? null,
          projectId: p.projectId ?? null,
          activity,
          status: "status" in p ? (p as { status: string }).status : activity,
          error: "error" in p ? (p as { error?: unknown }).error : undefined,
          activeRunCount: state.activeRunCount,
          occurredAt,
        };
        break;
      }

      case "issue.updated": {
        const { issueId, projectId, status, title, assigneeAgentId, blocked } =
          event.payload;
        if (assigneeAgentId !== undefined && assigneeAgentId !== null) {
          this.issueAssignees.set(issueId, assigneeAgentId);
        }
        sidecar = {
          kind: "issue",
          companyId,
          agentId: assigneeAgentId ?? null,
          issueId,
          projectId: projectId ?? null,
          status,
          title,
          blocked,
          occurredAt,
        };
        break;
      }

      case "issue.comment.created": {
        const { commentId, issueId, agentId, userId, isQuestion } =
          event.payload;
        const authorType: "user" | "agent" | "system" = userId
          ? "user"
          : agentId
            ? "agent"
            : "system";
        const feedbackKind: AgentFeedbackKind = isQuestion
          ? "question"
          : "informational";
        sidecar = {
          kind: "comment-feedback",
          companyId,
          agentId: agentId ?? null,
          issueId,
          commentId,
          authorType,
          isQuestion: Boolean(isQuestion),
          feedbackKind,
          occurredAt,
        };
        // A human asking a question on an agent's assigned issue -> the agent
        // is waiting on a human reply (turnEnd awaitingInput=true). Only map
        // when we can target the responsible agent; otherwise sidecar only.
        if (isQuestion && userId && !agentId) {
          const assignee = this.issueAssignees.get(issueId);
          if (assignee) {
            const state = this.ensureSession(companyId, assignee);
            this.spawnIfUnseen(
              companyId,
              assignee,
              state,
              agentEvents,
              occurredAt,
            );
            agentEvents.push(this.turnEndFor(companyId, assignee, true));
          }
        }
        break;
      }

      case "approval.created": {
        const { approvalId, issueId, agentId, type, status } = event.payload;
        sidecar = {
          kind: "approval",
          companyId,
          agentId: agentId ?? null,
          approvalId,
          issueId: issueId ?? null,
          type,
          status,
          occurredAt,
        };
        if (PENDING_APPROVAL_STATUSES.has(status)) {
          const target = agentId ?? (issueId ? this.issueAssignees.get(issueId) : undefined);
          if (target) {
            const state = this.ensureSession(companyId, target);
            this.spawnIfUnseen(
              companyId,
              target,
              state,
              agentEvents,
              occurredAt,
            );
            agentEvents.push(this.permissionRequestFor(companyId, target));
          }
        }
        break;
      }

      case "approval.decided": {
        const { approvalId, issueId, decision } = event.payload;
        const agentId = this.approvalAgentId(issueId);
        sidecar = {
          kind: "approval",
          companyId,
          agentId: agentId ?? null,
          approvalId,
          issueId: issueId ?? null,
          status: "decided",
          decision,
          occurredAt,
        };
        // Resolution of an approval gate has no dedicated AgentEvent; the
        // "waiting" visual clears naturally on the agent's next completed unit
        // of work. Kept as sidecar to avoid fabricating a state transition.
        break;
      }

      case "budget.incident.opened": {
        const p = event.payload;
        sidecar = {
          kind: "budget",
          companyId,
          incidentId: p.incidentId,
          scopeType: p.scopeType,
          scopeId: p.scopeId,
          metric: p.metric,
          status: p.status,
          occurredAt,
        };
        break;
      }

      case "budget.incident.resolved": {
        const p = event.payload;
        sidecar = {
          kind: "budget",
          companyId,
          incidentId: p.incidentId,
          scopeType: p.scopeType,
          scopeId: p.scopeId,
          metric: "",
          status: p.status,
          occurredAt,
        };
        break;
      }

      case "cost_event.created": {
        const p = event.payload;
        sidecar = {
          kind: "cost",
          companyId,
          agentId: p.agentId ?? null,
          runId: p.runId ?? null,
          issueId: p.issueId ?? null,
          projectId: p.projectId ?? null,
          costCents: p.costCents,
          inputTokens: p.inputTokens,
          outputTokens: p.outputTokens,
          occurredAt,
        };
        break;
      }

      default: {
        // Exhaustiveness guard: unknown kinds are non-mappable -> sidecar-less.
        sidecar = null;
      }
    }

    return { agentEvents, sidecar };
  }

  // -- internals -----------------------------------------------------------

  private approvalAgentId(issueId?: string | null): string | undefined {
    if (!issueId) return undefined;
    return this.issueAssignees.get(issueId);
  }

  private ensureSession(
    companyId: string,
    agentId: string,
  ): AgentSessionState {
    const key = syntheticSessionId(companyId, agentId);
    let state = this.sessions.get(key);
    if (!state) {
      state = { seen: false, activeRunCount: 0, lastEventAt: null };
      this.sessions.set(key, state);
    }
    return state;
  }

  private spawnIfUnseen(
    companyId: string,
    agentId: string,
    state: AgentSessionState,
    out: SessionAgentEvent[],
    _occurredAt: string,
  ): void {
    if (!state.seen) {
      state.seen = true;
      out.push(this.sessionStartFor(companyId, agentId));
    }
  }

  private sessionStartFor(companyId: string, agentId: string): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: { kind: "sessionStart", source: ID_NAMESPACE },
    };
  }

  private sessionEndFor(
    companyId: string,
    agentId: string,
    reason: string,
  ): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: { kind: "sessionEnd", reason },
    };
  }

  private turnEndFor(
    companyId: string,
    agentId: string,
    awaitingInput: boolean,
  ): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: { kind: "turnEnd", awaitingInput },
    };
  }

  private permissionRequestFor(
    companyId: string,
    agentId: string,
  ): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: { kind: "permissionRequest" },
    };
  }
}

/** Re-exported for consumers that need the raw AgentEvent type. */
export type { AgentEvent };
