/**
 * Event mapper (spec §21.1/§21.2/§21.4, FR-14, §21.3, §7.3).
 *
 * Translates the canonical bridge contract (`@paperclip-pixel/core`) into the
 * *current* Pixel Agents `AgentEvent` semantics, mapping ONLY the semantically
 * valid subset and routing everything richer into a sidecar entry.
 *
 * Safe mappings (spike SAA-175 §4; §21.2 table):
 *   sessionStart              — agent first appears (character spawn)
 *   sessionEnd                — agent leaves / despawns
 *   toolStart                 — a run starts (§21.4). Uses `toolName:"Task"`
 *                                with `input.description` set to the actual
 *                                issue title whenever it's known (see
 *                                `startWorkFor`/`issueTitles`), falling back
 *                                to the SYNTHETIC `"PaperclipWork"` name with
 *                                no input when it isn't. Never a fabricated
 *                                real tool ("Bash"/"Read"/etc.) — Paperclip's
 *                                own event catalog has no per-tool-call
 *                                telemetry at all to honestly source that
 *                                from (confirmed 2026-08-31 against the
 *                                host's full `PLUGIN_EVENT_TYPES` catalog).
 *                                "Task" is chosen because it's the one real
 *                                Claude-hook tool name whose caption format
 *                                (`formatToolStatus`) shows `input.description`
 *                                verbatim — the closest honest fit for "an
 *                                agent is working a specific ticket".
 *   toolEnd                   — the same run finishes/fails/cancels
 *   turnEnd(awaitingInput=false) — agent finished a unit of work (idle/done)
 *   turnEnd(awaitingInput=true)  — agent waiting on a human (awaiting reply)
 *   permissionRequest         — approval gate requiring human input
 *   transient toolStart+toolEnd pair, own toolId (never the run-tracking one)
 *                              — a discrete, already-completed action
 *                                (`issue.document.created/updated` -> "Write
 *                                <doc>"; a reassignment handoff ->
 *                                "SendMessage -> <new assignee>"). Paired
 *                                start+end immediately, on a toolId scoped to
 *                                the action itself, so it can never corrupt
 *                                the one "current work" toolId a real
 *                                run-started/run-finished pair owns (§21.4).
 *
 * Sidecar (no current AgentEvent correspondence, §21.5): run concurrency /
 * multi-project activity, behavioral proxies, temporal metrics, semantic
 * feedback, canonical Paperclip IDs, cost/budget, and subagent* (no genuine
 * Paperclip subagent semantics — Paperclip's own sub-agent/team concept, if
 * any, is not yet observed by this bridge).
 */

import type {
  AgentFeedbackKind,
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "../core/index.js";
import { BRIDGE_EVENT_KINDS } from "../core/index.js";

import type { AgentEvent, SessionAgentEvent } from "./pixel-agents-types.js";

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

/**
 * Synthetic `cwd` for a session, never a real filesystem path (§ transport.ts
 * doc comment). Its ONLY consumer-visible effect is Pixel Agents' own display
 * label, which it derives as `path.basename(cwd)` when adopting a hooks-only
 * external session — so the basename here is deliberately the agent's real,
 * human-readable name (falling back to the opaque agentId only when the name
 * is genuinely unknown yet), not the full synthetic session id. Slashes in a
 * name would otherwise split across path segments and only the last one
 * would show, so they're replaced; there is no other path-safety concern
 * since this string never touches a real filesystem.
 */
export function syntheticCwd(
  companyId: string,
  agentId: string,
  agentName?: string,
): string {
  const label = (agentName ?? agentId).replace(/[/\\]/g, "-").trim() || agentId;
  return `/paperclip/${companyId}/${label}`;
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
  /**
   * Whether a `toolStart` was actually emitted and not yet closed. Tracked
   * independently of `activeRunCount === 0` so an out-of-order/duplicate
   * `run.finished` (no matching `run.started` ever seen — §12.3/§31.1) never
   * fabricates a `toolEnd` for a tool that was never opened.
   */
  toolActive: boolean;
  /**
   * The agent's real display name (`AgentInput.name`), learned the first time
   * this agent is seen in an authoritative snapshot. Used to build a
   * human-readable synthetic `cwd` (see `sessionStartFor`) instead of the raw
   * `paperclip-bridge:<companyId>:<agentId>` session id, which is what Pixel
   * Agents falls back to displaying (`path.basename(cwd)`) when this is
   * unset. Undefined only for the edge case where an agent's very first
   * bridge signal is a live event rather than a snapshot.
   */
  agentName?: string;
}

/**
 * Stateful translator from bridge events to current `AgentEvent` semantics.
 *
 * State is per-agent (session presence + active-run concurrency) plus an
 * `issueId -> assigneeAgentId` index so a human question comment can be routed
 * to the agent responsible for that issue (the comment payload carries the
 * commenter, not the assignee), and an `issueId -> title` cache (learned from
 * snapshots and `issue.updated`) so a run/checkout's toolStart caption can
 * name the actual ticket instead of a generic synthetic string.
 */
export class EventMapper {
  private readonly sessions = new Map<string, AgentSessionState>();
  private readonly issueAssignees = new Map<string, string>();
  private readonly issueTitles = new Map<string, string>();

  /** Reset all session, issue-assignee, and issue-title state (e.g. on company switch). */
  reset(): void {
    this.sessions.clear();
    this.issueAssignees.clear();
    this.issueTitles.clear();
  }

  /**
   * Map an authoritative snapshot into `sessionStart` events for every agent
   * (character spawn) plus per-agent concurrency sidecar entries. Agents
   * already seen are not re-spawned (re-snapshot after reconnect is idempotent).
   *
   * Every newly-seen agent also gets an immediate confirming event
   * (`toolStart` when it already has an active run, `turnEnd` — idle —
   * otherwise). Pixel Agents only promotes a session from "pending" to a
   * real, visible character once a SECOND, non-`SessionStart`/`SessionEnd`
   * hook event arrives for the same session id (confirmed by reading its own
   * session-router: any other `hook_event_name` confirms a pending session,
   * not specifically a tool call). Without this, a `sessionStart` alone
   * leaves the agent "pending" forever — invisible — which is what most
   * agents are most of the time (idle), so the office only ever showed
   * whichever agents happened to have a run in flight when they were spawned
   * (and even then, only if a live `agent.run.started` event and its
   * `toolStart` still fired later — a snapshot alone never confirmed
   * anything). Confirmed 2026-08-31 against a live company: this is why "not
   * all agents show up" and why idle-vs-working state never reflected
   * anything.
   */
  mapSnapshot(snapshot: AuthoritativeSnapshotInput): SnapshotMappingResult {
    const agentEvents: SessionAgentEvent[] = [];
    const sidecarEntries: SidecarEntry[] = [];

    // Learn every known issue's title and current assignee up front: titles
    // so the active-run branch below (and any later event referencing one of
    // these issues) can build an honest "Task: <title>" caption instead of
    // the generic fallback, and assignees so a REASSIGNMENT the bridge only
    // ever observes via a live issue.updated (never a second snapshot read)
    // can still detect the correct previous assignee for the handoff blip
    // below, even when the original assignment was only ever seen here.
    for (const issue of snapshot.issues) {
      if (issue.title) this.issueTitles.set(issue.id, issue.title);
      if (issue.assigneeAgentId) this.issueAssignees.set(issue.id, issue.assigneeAgentId);
    }

    for (const agent of snapshot.agents) {
      const state = this.ensureSession(snapshot.company.id, agent.id);
      const activeRunCount = agent.activeRuns?.length ?? 0;
      if (!state.seen) {
        state.seen = true;
        state.agentName = agent.name;
        agentEvents.push(this.sessionStartFor(snapshot.company.id, agent.id, agent.name));
        if (activeRunCount > 0) {
          const issueId = agent.activeRuns?.[0]?.issueId ?? undefined;
          const started = this.startWorkFor(snapshot.company.id, agent.id, state, issueId);
          if (started) agentEvents.push(started);
        } else {
          agentEvents.push(this.turnEndFor(snapshot.company.id, agent.id, false));
        }
        sidecarEntries.push({
          kind: "lifecycle",
          companyId: snapshot.company.id,
          agentId: agent.id,
          transition: "started",
          reason: "snapshot",
          occurredAt: snapshot.observedAt,
        });
      }
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
        // Rising edge (0 -> 1 active runs): the character starts visibly
        // "working" (§21.4), captioned with the actual issue title when
        // known (see startWorkFor). Never re-fired while further concurrent
        // runs stack on top: the current AgentEvent model tracks one
        // "current" tool per session, so a second toolStart here would
        // corrupt the correlation a later toolEnd relies on. Full concurrency
        // (every run, not just "any active") is preserved losslessly in the
        // sidecar below for the richer Paperclip-embedded UI (§10). Usually a
        // no-op here because `issue.checked_out` (moments earlier in the real
        // checkout-then-run flow) already opened it via the same helper —
        // this is the fallback for whenever that wasn't observed (worker
        // restart mid-run, event delivered out of order, etc.).
        const started = this.startWorkFor(companyId, agentId, state, issueId);
        if (started) agentEvents.push(started);
        state.activeRunCount += 1;
        state.lastEventAt = occurredAt;
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
        // Falling edge (-> 0 active runs): close the synthetic tool the
        // rising edge opened, then the agent is idle / done between runs.
        // Gated on `toolActive` (not `activeRunCount === 0` alone) so an
        // out-of-order finish with no matching start never fabricates a
        // toolEnd for a tool that was never opened.
        if (state.activeRunCount === 0 && state.toolActive) {
          agentEvents.push(this.toolEndFor(companyId, p.agentId));
          state.toolActive = false;
        }
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
        if (title) this.issueTitles.set(issueId, title);
        // A real hand-off: this issue had a different, already-visible
        // assignee, and it's being reassigned to someone else. Represent it
        // as an honest, discrete "sent the work along" blip on the PREVIOUS
        // assignee's character — never on the run-tracking toolId (§21.4),
        // so it can never corrupt an in-progress run's own toolStart/toolEnd
        // correlation. Only fires when there was a real prior assignee with
        // an existing, visible character; never forces a spawn just to show
        // a departing handoff.
        const previousAssignee = this.issueAssignees.get(issueId);
        if (
          assigneeAgentId
          && previousAssignee
          && previousAssignee !== assigneeAgentId
        ) {
          const previousState = this.sessions.get(
            syntheticSessionId(companyId, previousAssignee),
          );
          if (previousState?.seen) {
            const recipientName =
              this.sessions.get(syntheticSessionId(companyId, assigneeAgentId))
                ?.agentName ?? assigneeAgentId;
            agentEvents.push(
              ...this.transientToolFor(
                companyId,
                previousAssignee,
                `handoff:${issueId}`,
                "SendMessage",
                { recipient: recipientName },
              ),
            );
          }
        }
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

      // A newly hired agent would otherwise only appear at the next 5-minute
      // reconciliation snapshot. Spawn it immediately, idle (no run has
      // started yet — never fabricate work that hasn't happened).
      case "agent.created": {
        const { agentId, name } = event.payload;
        if (!agentId) break;
        const state = this.ensureSession(companyId, agentId);
        if (!state.seen) {
          state.seen = true;
          state.agentName = name;
          agentEvents.push(this.sessionStartFor(companyId, agentId, name));
          agentEvents.push(this.turnEndFor(companyId, agentId, false));
        }
        sidecar = {
          kind: "lifecycle",
          companyId,
          agentId,
          transition: "started",
          reason: "hired",
          occurredAt,
        };
        break;
      }

      // A recovery signal — no dedicated AgentEvent kind fits "was stuck,
      // now isn't" (this is not a session boundary), so it's sidecar-only.
      case "agent.error_cleared": {
        sidecar = null;
        break;
      }

      // The claim-before-run moment — fires before the matching
      // agent.run.started, and already carries the specific issue, so it's
      // the earliest point the "Task: <title>" caption can honestly start
      // (see startWorkFor's toolActive gate: agent.run.started becomes a
      // no-op fallback once this has already fired for the same agent).
      case "issue.checked_out": {
        const { issueId, agentId } = event.payload;
        if (!agentId) break;
        const state = this.ensureSession(companyId, agentId);
        this.spawnIfUnseen(companyId, agentId, state, agentEvents, occurredAt);
        const started = this.startWorkFor(companyId, agentId, state, issueId);
        if (started) agentEvents.push(started);
        break;
      }

      // Only fires when another installed plugin explicitly calls the
      // host's issues.requestWakeup(s) capability (confirmed 2026-08-31 by
      // reading plugin-host-services.ts) — not a general "blocker resolved"
      // signal, and dormant unless such a plugin exists. Ensures the
      // character exists ahead of the run that's about to be requested;
      // never fabricates a busy state since no run has actually started.
      // When it does spawn, also confirms it idle (turnEnd) — a bare
      // sessionStart alone never promotes past Pixel Agents' own "pending"
      // state (see mapSnapshot's doc comment); a no-op for an already-seen
      // agent, matching every other spawn-if-unseen call site.
      case "issue.assignment_wakeup_requested": {
        const { assigneeAgentId } = event.payload;
        if (!assigneeAgentId) break;
        const state = this.ensureSession(companyId, assigneeAgentId);
        const wasUnseen = !state.seen;
        this.spawnIfUnseen(companyId, assigneeAgentId, state, agentEvents, occurredAt);
        if (wasUnseen) {
          agentEvents.push(this.turnEndFor(companyId, assigneeAgentId, false));
        }
        break;
      }

      // A document write is a discrete, already-completed action by the
      // time this event arrives — represented as an honest, immediate
      // toolStart+toolEnd pair on its OWN toolId (never the run-tracking
      // one), so it never corrupts an in-progress run's own correlation even
      // when (the common case) a document changes mid-run.
      case "issue.document.created":
      case "issue.document.updated": {
        const { issueId, documentId, title, agentId } = event.payload;
        if (!agentId) break;
        const state = this.ensureSession(companyId, agentId);
        this.spawnIfUnseen(companyId, agentId, state, agentEvents, occurredAt);
        agentEvents.push(
          ...this.transientToolFor(
            companyId,
            agentId,
            `doc:${documentId ?? issueId}`,
            "Write",
            { file_path: title ?? documentId ?? issueId },
          ),
        );
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
      state = { seen: false, activeRunCount: 0, lastEventAt: null, toolActive: false };
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
      // This path only ever has an agentId (event payloads don't carry
      // denormalized names) — reuse the name learned from a prior snapshot,
      // if any. Genuinely unknown only when an agent's very first bridge
      // signal is a live event rather than a snapshot; sessionStartFor falls
      // back to the raw id in that case.
      out.push(this.sessionStartFor(companyId, agentId, state.agentName));
    }
  }

  private sessionStartFor(
    companyId: string,
    agentId: string,
    agentName?: string,
  ): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: {
        kind: "sessionStart",
        source: ID_NAMESPACE,
        cwd: syntheticCwd(companyId, agentId, agentName),
      },
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

  /**
   * Stable per-agent synthetic tool id (one "current" tool slot, §21.4).
   * `toolName:"Task"` with `input.description` set produces Pixel Agents'
   * "Subtask: <description>" caption (`formatToolStatus`'s real, existing
   * case for that tool name); omitting `description` falls back to the
   * generic synthetic `"PaperclipWork"` name (caption: "Using PaperclipWork").
   */
  private toolStartFor(
    companyId: string,
    agentId: string,
    description?: string,
  ): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: description
        ? {
            kind: "toolStart",
            toolId: `${ID_NAMESPACE}:work:${companyId}:${agentId}`,
            toolName: "Task",
            input: { description },
          }
        : {
            kind: "toolStart",
            toolId: `${ID_NAMESPACE}:work:${companyId}:${agentId}`,
            toolName: "PaperclipWork",
          },
    };
  }

  private toolEndFor(companyId: string, agentId: string): SessionAgentEvent {
    return {
      sessionId: syntheticSessionId(companyId, agentId),
      event: {
        kind: "toolEnd",
        toolId: `${ID_NAMESPACE}:work:${companyId}:${agentId}`,
      },
    };
  }

  /**
   * Opens the run-tracking toolStart slot, captioned with the known issue
   * title when available (falls back to the generic synthetic name
   * otherwise). Gated on `state.toolActive` — a no-op returning `null` if
   * something already opened it (typically `issue.checked_out`, moments
   * earlier in the real checkout-then-run flow; see the call sites in
   * `mapSnapshot` and the `agent.run.started`/`issue.checked_out` cases,
   * whichever observes the agent first). Callers own pushing the returned
   * event into their own `agentEvents` array.
   */
  private startWorkFor(
    companyId: string,
    agentId: string,
    state: AgentSessionState,
    issueId: string | null | undefined,
  ): SessionAgentEvent | null {
    if (state.toolActive) return null;
    state.toolActive = true;
    const title = issueId ? this.issueTitles.get(issueId) : undefined;
    return this.toolStartFor(companyId, agentId, title);
  }

  /**
   * A discrete, already-completed action (a document write, a reassignment
   * handoff) represented as an immediate toolStart+toolEnd pair on its OWN
   * `scope`-suffixed toolId — never the shared run-tracking toolId
   * (`${ID_NAMESPACE}:work:...}`) `toolStartFor`/`toolEndFor` use — so it can
   * never corrupt an in-progress run's own start/end correlation even when
   * (the common case) the blip happens mid-run. Pixel Agents tracks
   * `activeToolStatuses` per toolId, so a distinct, transient id coexisting
   * alongside the main one is a supported shape, not a hack.
   */
  private transientToolFor(
    companyId: string,
    agentId: string,
    scope: string,
    toolName: string,
    input: unknown,
  ): SessionAgentEvent[] {
    const sessionId = syntheticSessionId(companyId, agentId);
    const toolId = `${ID_NAMESPACE}:blip:${companyId}:${agentId}:${scope}`;
    return [
      { sessionId, event: { kind: "toolStart", toolId, toolName, input } },
      { sessionId, event: { kind: "toolEnd", toolId } },
    ];
  }
}

/** Re-exported for consumers that need the raw AgentEvent type. */
export type { AgentEvent };
