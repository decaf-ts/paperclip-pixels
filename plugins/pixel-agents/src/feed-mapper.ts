/**
 * Plugin feed mapper (spec PAPERCLIP_PIXELS-2, WS2-C) — the stateful
 * translator from the canonical bridge contract to plugin feed operations
 * (feed.ts), replacing the retired Claude-hook-vocabulary `EventMapper`.
 *
 * Every operation it emits is a sanctioned WS2-A1 agent-source call:
 *   - agent appears / identity or seat changes → `declareAgents` (idempotent
 *     upsert by key; palette/hueShift ride the declaration — the sanctioned
 *     seat path, replacing `saveAgentSeats` seat-driving)
 *   - agent leaves → `removeAgents`
 *   - working / idle / waiting-on-a-human → `updateAgentStatus`
 *   - current work caption ("Task: <title>", real tool descriptions from the
 *     activity poller) → `updateAgentActivity` (one caption per agent)
 *   - character assignment change → `assignAgentAppearance` (WS4-C: the
 *     first-class appearance path — characterId is the WS3 frozen id, the
 *     embedding surface resolves it to a sheet index)
 *   - conversation extracts (comment bodies, run edges, approval waits) →
 *     `dialogLines` (WS4-C: redacted/truncated plugin-side per the
 *     per-company `dialogPanePrivacyOptIn` toggle, default OFF)
 *
 * Parity with the retired mapping: stuck-agent detection (a human question
 * comment or pending approval on an agent's issue → waiting + awaitingInput),
 * run rising/falling edges (active vs waiting), snapshot self-heal, and the
 * re-declare-on-resync contract. Deltas from the hook mapping are deliberate
 * and recorded on SAA-536: the reassignment-handoff and document-write
 * transient "blips" are dropped — the one-caption-per-agent source cannot
 * host a transient second caption without clobbering the run caption.
 */

import { clampDialogLine, dialogExtract } from "./dialog.js";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
  PluginAgentDeclaration,
  PluginFeedDialogLine,
  PluginFeedOperation,
} from "paperclip-pixels-common";

/** Pixel Agents' built-in character-sheet count (the seat/fallback palette
 * range the embedding host's declaration validator accepts without an
 * external asset grant — the first six catalog entries mirror exactly these
 * sheets). See `declarationFor` for the clamp rationale. */
const BUILT_IN_SEAT_PALETTE_COUNT = 6;

/** Stable per-agent unique team name (the retired transcript hack's grouping
 *  semantics, through the sanctioned declaration field): each Paperclip
 *  agent sits in its own one-agent "team" so unrelated agents are never
 *  grouped into a synthetic lead hierarchy, while the declaration's `name`
 *  still carries the real office label. */
function bridgeTeamName(agentId: string): string {
  // djb2 — deterministic across restarts, no crypto need (not a secret).
  let hash = 5381;
  for (let i = 0; i < agentId.length; i += 1) {
    hash = ((hash * 33) ^ agentId.charCodeAt(i)) >>> 0;
  }
  return `paperclip-bridge-${hash.toString(16)}`;
}

/** One agent's appearance, as resolved by the worker (WS3 frozen contract).
 * `characterId` rides the wire for the WS4-C first-class appearance path:
 * the embedding surface resolves it to a positional index in the catalog it
 * declared through the WS4-A appearance source. */
export interface FeedAppearanceEntry {
  agentId: string;
  agentName: string;
  /** WS3 catalog character id (e.g. `pixel-agents:char-3`). */
  characterId: string;
  palette: number;
  hueShift: number;
}

/** Mapper options (WS4-C). */
export interface PluginFeedMapperOptions {
  /** Per-company `dialogPanePrivacyOptIn` (CEO decision 2, default OFF):
   *  OFF ships only short redacted/truncated comment excerpts in dialog
   *  lines; ON ships fuller (still bounded) excerpts. Set at relay
   *  configure time; a toggle change rebuilds the mapper. */
  dialogPrivacyOptIn?: boolean;
}

interface AgentFeedState {
  /** Last declaration pushed (name + seat) — declare ops are emitted only on
   *  change (the host upserts, but the wire stays quiet when nothing changed). */
  declared?: { name: string; palette?: number; hueShift?: number };
  /** Last characterId assigned through the first-class appearance path
   *  (WS4-C) — assignment ops are emitted only on change. `undefined` =
   *  never assigned; `null` = explicitly reverted to palette rendering. */
  assignedCharacterId?: string | null;
  /** Last status pushed, for diffing. `undefined` = never pushed. */
  status?: "active" | "waiting";
  awaitingInput?: boolean;
  /** Run-edge lifecycle flag: true from the rising edge (first active run /
   *  checkout) until the falling edge (last run finished) or a
   *  waiting-on-human transition. Tool-activity captions replace the visible
   *  caption without touching this flag — the run's falling edge still owns
   *  the clear. */
  runCaptionOpen: boolean;
  activeRunCount: number;
}

/** Paperclip agent statuses that mean the agent has left / despawns. */
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

/** Caption for an in-flight run: the actual issue title when known. */
function runCaption(title?: string): string {
  return title ? `Task: ${title}` : "Task: Paperclip work";
}

/**
 * Stateful translator: canonical bridge events/snapshots + appearance maps →
 * plugin feed operations. One instance per company (created by the relay).
 */
export class PluginFeedMapper {
  private readonly agents = new Map<string, AgentFeedState>();
  private readonly issueAssignees = new Map<string, string>();
  private readonly issueTitles = new Map<string, string>();
  private readonly appearances = new Map<string, FeedAppearanceEntry>();
  private readonly dialogPrivacyOptIn: boolean;

  constructor(options: PluginFeedMapperOptions = {}) {
    // Guardrail default OFF (CEO decision 2): only an explicit true at
    // relay-configure time ever ships fuller extracts.
    this.dialogPrivacyOptIn = options.dialogPrivacyOptIn === true;
  }

  /** Drop all state (relay re-sync): the next snapshot re-declares everyone
   *  and re-pushes statuses — the bounded-time self-heal contract. */
  reset(): void {
    this.agents.clear();
    this.issueAssignees.clear();
    this.issueTitles.clear();
  }

  /** Record the company's appearance map (WS3 single source of truth) and
   * return declare upserts for every entry whose seat changed, plus
   * first-class appearance assignments (WS4-C) for every entry whose
   * characterId changed. Safe to call repeatedly; also consulted by every
   * later declare for new agents. */
  setAppearances(entries: FeedAppearanceEntry[]): PluginFeedOperation[] {
    const operations: PluginFeedOperation[] = [];
    for (const entry of entries) {
      this.appearances.set(entry.agentId, entry);
      const state = this.ensureState(entry.agentId);
      if (
        !state.declared
        || state.declared.name !== entry.agentName
        || state.declared.palette !== entry.palette
        || state.declared.hueShift !== entry.hueShift
      ) {
        operations.push({ op: "declareAgents", agents: [this.declarationFor(entry.agentId, entry.agentName)] });
      }
      // First-class appearance path (WS4-C): assign the agent's character
      // through the WS4-A source when it changed. palette/hueShift above
      // remain the seat/fallback (and hueShift still tints plugin sheets).
      if (state.assignedCharacterId !== entry.characterId) {
        state.assignedCharacterId = entry.characterId;
        operations.push({
          op: "assignAgentAppearance",
          key: entry.agentId,
          characterId: entry.characterId,
        });
      }
    }
    return operations;
  }

  /** The declaration for one agent from the current appearance map (name
   * falls back to the agent id — the worker always knows the real name by
   * the time it configures the relay).
   *
   * Seat-palette clamp (SAA-694): the declaration's `palette` is the SEAT /
   * fallback index into Pixel Agents' built-in sheet set, but the WS3
   * catalog's `palette` field counts the whole (17-entry) catalog — indices
   * ≥ the built-in sheet count are rejected fail-closed by the embedding
   * host's declaration validator whenever no external asset grant has
   * widened the palette (every docker deployment: the catalog ships only in
   * the Paperclip image, never in the pixel-agents image). Cycling the
   * catalog index into the built-in range keeps the seat fallback valid
   * everywhere — catalog entries 0..5 ARE the built-in sheets, so char_N
   * falls back to its built-in counterpart — while `hueShift` (which tints
   * plugin sheets when the WS4-A path IS active) rides unchanged. */
  private declarationFor(agentId: string, name: string): PluginAgentDeclaration {
    const appearance = this.appearances.get(agentId);
    return {
      key: agentId,
      name,
      teamName: bridgeTeamName(agentId),
      ...(appearance
        ? {
          palette: appearance.palette % BUILT_IN_SEAT_PALETTE_COUNT,
          hueShift: appearance.hueShift,
        }
        : {}),
    };
  }

  /** Push a declaration and record it in the agent's state. */
  private declare(
    agentId: string,
    name: string,
    operations: PluginFeedOperation[],
  ): void {
    const state = this.ensureState(agentId);
    const appearance = this.appearances.get(agentId);
    const declaration = this.declarationFor(agentId, name);
    operations.push({ op: "declareAgents", agents: [declaration] });
    state.declared = {
      name,
      ...(appearance ? { palette: appearance.palette, hueShift: appearance.hueShift } : {}),
    };
  }

  /** Declare an agent (spawn character) when not yet declared. */
  private declareIfUnknown(
    agentId: string,
    name: string | undefined,
    operations: PluginFeedOperation[],
  ): void {
    const state = this.ensureState(agentId);
    if (state.declared) return;
    this.declare(agentId, name ?? agentId, operations);
  }

  private ensureState(agentId: string): AgentFeedState {
    let state = this.agents.get(agentId);
    if (!state) {
      state = { runCaptionOpen: false, activeRunCount: 0 };
      this.agents.set(agentId, state);
    }
    return state;
  }

  /** Best-known display label for one agent (dialog lines only — captions
   *  and declarations have their own name resolution): the appearance-map
   *  name, else the last declared name, else the raw agent id. */
  private agentLabel(agentId: string): string {
    const appearance = this.appearances.get(agentId);
    if (appearance) return appearance.agentName;
    return this.agents.get(agentId)?.declared?.name ?? agentId;
  }

  /** Push one dialog-pane line (WS4-C) after the shared wire clamp. Empty
   *  composed lines are dropped, never faked. */
  private pushDialogLine(text: string, operations: PluginFeedOperation[]): void {
    const line = clampDialogLine(text);
    if (line.length === 0) return;
    const lines: PluginFeedDialogLine[] = [{ text: line }];
    operations.push({ op: "dialogLines", lines });
  }

  private pushStatus(
    agentId: string,
    status: "active" | "waiting",
    awaitingInput: boolean,
    operations: PluginFeedOperation[],
  ): void {
    const state = this.ensureState(agentId);
    if (state.status === status && state.awaitingInput === awaitingInput) return;
    state.status = status;
    state.awaitingInput = awaitingInput;
    operations.push({
      op: "updateAgentStatus",
      key: agentId,
      status,
      ...(status === "waiting" ? { awaitingInput } : {}),
    });
  }

  /** Map an authoritative snapshot: (re-)declare every agent, then repair
   *  status/caption edges (idempotent — already-matching state emits nothing). */
  mapSnapshot(snapshot: AuthoritativeSnapshotInput): PluginFeedOperation[] {
    const operations: PluginFeedOperation[] = [];

    for (const issue of snapshot.issues) {
      if (issue.title) this.issueTitles.set(issue.id, issue.title);
      if (issue.assigneeAgentId) this.issueAssignees.set(issue.id, issue.assigneeAgentId);
    }

    for (const agent of snapshot.agents) {
      const appearance = this.appearances.get(agent.id);
      const name = appearance?.agentName ?? agent.name;
      const state = this.ensureState(agent.id);
      const activeRunCount = agent.activeRuns?.length ?? 0;

      this.declareIfUnknown(agent.id, name, operations);
      if (state.declared && state.declared.name !== name) {
        this.declare(agent.id, name, operations);
      }

      if (activeRunCount > 0) {
        // Working: open the run caption and go active.
        const issueId = agent.activeRuns?.[0]?.issueId ?? undefined;
        const title = issueId ? this.issueTitles.get(issueId) : undefined;
        if (!state.runCaptionOpen) {
          state.runCaptionOpen = true;
          operations.push({ op: "updateAgentActivity", key: agent.id, activity: runCaption(title) });
        }
        this.pushStatus(agent.id, "active", false, operations);
      } else if (state.status !== undefined) {
        // Known agent, no runs: close an open caption / active state. An
        // agent never pushed as active (e.g. genuinely awaiting input since
        // its first event) keeps its event-derived status — a snapshot never
        // clobbers awaitingInput (parity with the retired mapper).
        if (state.runCaptionOpen || state.status === "active") {
          state.runCaptionOpen = false;
          operations.push({ op: "updateAgentActivity", key: agent.id, activity: null });
          this.pushStatus(agent.id, "waiting", false, operations);
        }
      } else {
        // First time seen idle: declare an honest idle state.
        this.pushStatus(agent.id, "waiting", false, operations);
      }
      state.activeRunCount = activeRunCount;
    }
    return operations;
  }

  /** Map one canonical bridge event into feed operations. */
  mapEvent(event: BridgeInputEvent): PluginFeedOperation[] {
    const companyId = event.companyId;
    void companyId; // batched by the relay; the mapper is per-company
    const operations: PluginFeedOperation[] = [];

    switch (event.kind) {
      case "agent.status_changed": {
        const { agentId, status } = event.payload;
        if (OFFLINE_STATUSES.has(status)) {
          const state = this.agents.get(agentId);
          if (state?.declared) {
            this.appearances.delete(agentId);
            this.agents.delete(agentId);
            operations.push({ op: "removeAgents", keys: [agentId] });
          }
        }
        break;
      }

      case "issue.checked_out":
      case "agent.run.started": {
        const agentId = event.payload.agentId;
        if (!agentId) break; // checked_out carries a nullable agent id
        const issueId = "issueId" in event.payload ? event.payload.issueId : undefined;
        const state = this.ensureState(agentId);
        this.declareIfUnknown(agentId, this.appearances.get(agentId)?.agentName, operations);
        // Rising edge (0 active runs): go active with the issue caption.
        // `issue.checked_out` fires just before `agent.run.started` for the
        // same run (earliest honest caption point) but does NOT touch the
        // run counter — only run.started/finished own it, so a checkout+run
        // pair can never double-count one run. Further concurrent runs stack
        // without re-firing (one caption slot).
        if (state.activeRunCount === 0 && !state.runCaptionOpen) {
          state.runCaptionOpen = true;
          const title = issueId ? this.issueTitles.get(issueId) : undefined;
          operations.push({ op: "updateAgentActivity", key: agentId, activity: runCaption(title) });
          this.pushStatus(agentId, "active", false, operations);
        }
        if (event.kind === "agent.run.started") {
          state.activeRunCount += 1;
          // Dialog-pane line (WS4-C): a run edge is conversation-worthy
          // activity the worker already sees — no new host surface.
          const title = issueId ? this.issueTitles.get(issueId) : undefined;
          this.pushDialogLine(
            `${this.agentLabel(agentId)} started a run${title ? `: ${title}` : ""}`,
            operations,
          );
        }
        break;
      }

      case "agent.run.finished":
      case "agent.run.failed":
      case "agent.run.cancelled": {
        const p = event.payload;
        const state = this.ensureState(p.agentId);
        // Dialog line only when the mapper actually knew the run — a
        // phantom falling edge (never-seen run) is not conversation.
        const knewRun = state.activeRunCount > 0;
        if (state.activeRunCount > 0) state.activeRunCount -= 1;
        if (state.activeRunCount === 0 && (state.runCaptionOpen || state.status === "active")) {
          state.runCaptionOpen = false;
          operations.push({ op: "updateAgentActivity", key: p.agentId, activity: null });
          this.pushStatus(p.agentId, "waiting", false, operations);
        }
        if (knewRun) {
          const verb =
            event.kind === "agent.run.finished"
              ? "finished"
              : event.kind === "agent.run.failed"
                ? "failed"
                : "cancelled";
          this.pushDialogLine(`${this.agentLabel(p.agentId)} ${verb} a run`, operations);
        }
        break;
      }

      case "issue.updated": {
        const { issueId, title, assigneeAgentId } = event.payload;
        if (title) this.issueTitles.set(issueId, title);
        if (assigneeAgentId !== undefined && assigneeAgentId !== null) {
          this.issueAssignees.set(issueId, assigneeAgentId);
        }
        // The reassignment-handoff blip is deliberately dropped (see the
        // module doc): one caption per agent cannot host a transient blip
        // without clobbering the run caption.
        break;
      }

      case "issue.comment.created": {
        const { issueId, agentId, userId, isQuestion, body } = event.payload;
        // Dialog-pane line (WS4-C): one conversation extract per comment,
        // redacted/truncated plugin-side per the privacy toggle. Author
        // label: the agent's known name, or "Human" for user comments.
        const author = agentId ? this.agentLabel(agentId) : "Human";
        const extract = dialogExtract(body ?? "", this.dialogPrivacyOptIn);
        if (extract.length > 0) {
          this.pushDialogLine(
            `${author}${isQuestion ? " (question)" : ""}: ${extract}`,
            operations,
          );
        }
        // Stuck-agent detection parity: a human question on an agent's
        // assigned issue → the agent waits on a human reply.
        if (isQuestion && userId && !agentId) {
          const assignee = this.issueAssignees.get(issueId);
          if (assignee) {
            this.declareIfUnknown(assignee, this.appearances.get(assignee)?.agentName, operations);
            const state = this.ensureState(assignee);
            state.runCaptionOpen = false;
            this.pushStatus(assignee, "waiting", true, operations);
          }
        }
        break;
      }

      case "approval.created": {
        const { issueId, agentId, status } = event.payload;
        if (PENDING_APPROVAL_STATUSES.has(status)) {
          const target = agentId ?? (issueId ? this.issueAssignees.get(issueId) : undefined);
          if (target) {
            this.declareIfUnknown(target, this.appearances.get(target)?.agentName, operations);
            const state = this.ensureState(target);
            state.runCaptionOpen = false;
            this.pushStatus(target, "waiting", true, operations);
            this.pushDialogLine(
              `${this.agentLabel(target)} is waiting for an approval`,
              operations,
            );
          }
        }
        break;
      }

      case "agent.created": {
        const { agentId, name } = event.payload;
        if (!agentId) break;
        this.declareIfUnknown(agentId, name ?? this.appearances.get(agentId)?.agentName, operations);
        const state = this.ensureState(agentId);
        if (state.status === undefined) {
          this.pushStatus(agentId, "waiting", false, operations);
        }
        break;
      }

      case "issue.assignment_wakeup_requested": {
        const { assigneeAgentId } = event.payload;
        if (!assigneeAgentId) break;
        this.declareIfUnknown(assigneeAgentId, this.appearances.get(assigneeAgentId)?.agentName, operations);
        const state = this.ensureState(assigneeAgentId);
        if (state.status === undefined) {
          this.pushStatus(assigneeAgentId, "waiting", false, operations);
        }
        break;
      }

      case "issue.document.created":
      case "issue.document.updated":
      case "approval.decided":
      case "agent.error_cleared":
      case "budget.incident.opened":
      case "budget.incident.resolved":
      case "cost_event.created": {
        // No agent-source correspondence (the document-write blip is
        // deliberately dropped — see the module doc); richer semantics stay
        // in the worker's bridge store and UI sidecar channels.
        break;
      }

      default: {
        // Exhaustiveness guard: unknown kinds map to nothing, never faked.
        break;
      }
    }
    return operations;
  }

  /** A real tool call observed by the activity poller: replace the caption
   *  (one per agent — the latest real activity wins over the run caption).
   *  The run-edge lifecycle flag is untouched: the run's own falling edge
   *  still clears the caption when the run ends. */
  mapToolActivity(agentId: string, caption: string): PluginFeedOperation[] {
    const operations: PluginFeedOperation[] = [];
    this.declareIfUnknown(agentId, this.appearances.get(agentId)?.agentName, operations);
    this.ensureState(agentId);
    operations.push({ op: "updateAgentActivity", key: agentId, activity: caption });
    return operations;
  }
}
