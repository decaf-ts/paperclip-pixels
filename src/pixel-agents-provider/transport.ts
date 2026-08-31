/**
 * Transport (spec §7.3, §8, §21, §30, §39.1).
 *
 * Feeds mapped `AgentEvent`s (and the richer sidecar) into the Pixel Agents
 * runtime/provider boundary. Owns an {@link EventMapper} and a
 * {@link BehaviorSidecar}, manages connection state, and marks state visibly
 * stale on disconnect with a full re-snapshot on reconnect (§30).
 *
 * Wire boundary (NFR-8, zero-upstream-change requirement): Pixel Agents ships
 * exactly one hook provider today (`claudeProvider`, id `"claude"`), and its
 * `POST /api/hooks/:id` route only forwards a body to a handler when it looks
 * Claude-shaped (`session_id` + `hook_event_name`). There is no generic /
 * per-provider dispatch to attach a distinct "paperclip-bridge" wire format
 * to. Rather than requiring an upstream change to add one, {@link
 * HttpPushSink} serializes every mapped `AgentEvent` into the REAL Claude
 * hook JSON body `claudeProvider.normalizeHookEvent` already accepts
 * unmodified (`toClaudeHookBody`, verbatim shape of
 * `pixel-agents/server/src/providers/hook/claude/claude.ts:129-248`) and
 * posts it to `/api/hooks/claude`. Every `sessionStart` deliberately omits
 * `transcript_path`, which routes it onto Pixel Agents' own existing
 * "hooks-only external provider" path (`fileWatcher.ts`'s
 * `adoptExternalSessionFromHook`, built for non-Claude CLIs like
 * OpenCode/Copilot that have no transcript file) — a first-class, already-
 * shipped feature, not a hack. This borrows Claude's hook *vocabulary* as a
 * wire-protocol necessity only: every user-visible value (tool name, session
 * identity, cwd) is a synthetic, honestly-Paperclip-branded string, never a
 * claim that a real Claude Code session exists.
 */

import type {
  AgentFeedback,
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
  VersionedAgentBehaviorVector,
  WindowedMetrics,
} from "../core/index.js";

import { BehaviorSidecar, type SidecarSnapshot } from "./behavior-sidecar.js";
import {
  EventMapper,
  parseBridgeEvent,
  type SidecarEntry,
} from "./event-mapper.js";
import type { SessionAgentEvent } from "./pixel-agents-types.js";

/** Connection state of the bridge transport (§30). */
export type BridgeConnectionState = "disconnected" | "connected";

/**
 * The Pixel Agents runtime/provider boundary: consumes already-mapped
 * `AgentEvent`s bound to a synthetic session id.
 */
export interface AgentEventSink {
  emit(event: SessionAgentEvent): void | Promise<void>;
}

/** Minimal fetch-like function (injectable so the package stays pure-TS). */
export type FetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string }>;

/** The one hook provider id Pixel Agents ships today (`claude.ts:295`). */
export const CLAUDE_WIRE_PROVIDER_ID = "claude";

/**
 * Serialize one mapped `AgentEvent` into the real Claude hook JSON body
 * `claudeProvider.normalizeHookEvent` accepts unmodified. Returns null for
 * event kinds with no Claude hook correspondence (subagent kinds, progress —
 * dropped here rather than pushed as junk the receiver would ignore anyway).
 */
export function toClaudeHookBody(
  event: SessionAgentEvent,
): Record<string, unknown> | null {
  const sessionId = event.sessionId;
  switch (event.event.kind) {
    case "sessionStart":
      // No transcript_path: routes onto Pixel Agents' own hooks-only
      // external-provider adoption path (built for non-Claude CLIs). `cwd`
      // is set by EventMapper.sessionStartFor()/syntheticCwd() — its
      // basename becomes Pixel Agents' own display label for this session,
      // so it's the agent's real name whenever the mapper knows it. The
      // plain session-id fallback only covers a directly hand-built event
      // (e.g. a test double) that skipped the mapper entirely.
      return {
        hook_event_name: "SessionStart",
        session_id: sessionId,
        source: event.event.source ?? "startup",
        cwd: event.event.cwd ?? `/paperclip/${sessionId}`,
      };
    case "sessionEnd":
      return {
        hook_event_name: "SessionEnd",
        session_id: sessionId,
        reason: event.event.reason,
      };
    case "toolStart":
      return {
        hook_event_name: "PreToolUse",
        session_id: sessionId,
        tool_name: event.event.toolName,
        tool_input: event.event.input ?? {},
      };
    case "toolEnd":
      return { hook_event_name: "PostToolUse", session_id: sessionId };
    case "turnEnd":
      return event.event.awaitingInput
        ? {
            hook_event_name: "Notification",
            session_id: sessionId,
            notification_type: "idle_prompt",
          }
        : { hook_event_name: "Stop", session_id: sessionId };
    case "permissionRequest":
      return { hook_event_name: "PermissionRequest", session_id: sessionId };
    // No Claude hook correspondence for subagent*/progress (§21.5: sidecar
    // only) — never fabricate a SubagentStart/Stop the bridge has no genuine
    // evidence for.
    default:
      return null;
  }
}

/** Options for {@link HttpPushSink}. */
export interface HttpPushSinkOptions {
  /** Base URL of the receiving endpoint. */
  baseUrl: string;
  /**
   * Provider id used in the URL path. Defaults to `"claude"` — the only id
   * Pixel Agents' unmodified route currently dispatches on (the `:id`
   * segment is otherwise inert, but sending the real id keeps this
   * forward-compatible with a future per-provider dispatch restoring scoping
   * by it).
   */
  providerId?: string;
  /** Bearer auth token sent on each request. */
  authToken?: string;
  /** Injected fetch implementation (keeps the package free of node globals). */
  fetch: FetchLike;
}

/**
 * `AgentEventSink` that POSTs each mapped event, serialized via {@link
 * toClaudeHookBody}, to Pixel Agents' real (unmodified) `/api/hooks/claude`
 * endpoint. Events with no Claude hook correspondence are silently skipped
 * (never sent as junk).
 */
export class HttpPushSink implements AgentEventSink {
  private readonly baseUrl: string;
  private readonly providerId: string;
  private readonly authToken?: string;
  private readonly fetch: FetchLike;
  private lastError: string | undefined;

  constructor(options: HttpPushSinkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.providerId = options.providerId ?? CLAUDE_WIRE_PROVIDER_ID;
    this.authToken = options.authToken;
    this.fetch = options.fetch;
  }

  /** Most recent push error, if any (cleared on a successful push). */
  get lastPushError(): string | undefined {
    return this.lastError;
  }

  async emit(event: SessionAgentEvent): Promise<void> {
    const body = toClaudeHookBody(event);
    if (!body) return;
    const url = `${this.baseUrl}/api/hooks/${this.providerId}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    try {
      const res = await this.fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        this.lastError = `push failed: ${res.status} ${res.statusText}`;
      } else {
        this.lastError = undefined;
      }
    } catch (err) {
      this.lastError = `push error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}

/** Options for {@link BridgeTransport}. */
export interface BridgeTransportOptions {
  /** Sink that receives mapped AgentEvents (the PA provider boundary). */
  agentEventSink: AgentEventSink;
  /** Sidecar; a fresh one is created when omitted. */
  sidecar?: BehaviorSidecar;
  /** Mapper; a fresh one is created when omitted. */
  mapper?: EventMapper;
  /** Initial connection state. Default `connected`. */
  initialConnected?: boolean;
}

/**
 * Bridges canonical Paperclip events/snapshots into mapped `AgentEvent`s plus a
 * rich sidecar, delivered to an {@link AgentEventSink}.
 */
export class BridgeTransport {
  private readonly sink: AgentEventSink;
  private readonly sidecar: BehaviorSidecar;
  private readonly mapper: EventMapper;
  private connected: boolean;

  constructor(options: BridgeTransportOptions) {
    this.sink = options.agentEventSink;
    this.sidecar = options.sidecar ?? new BehaviorSidecar();
    this.mapper = options.mapper ?? new EventMapper();
    this.connected = options.initialConnected ?? true;
  }

  /** The sidecar channel (richer semantics, §21.5). */
  get behaviorSidecar(): BehaviorSidecar {
    return this.sidecar;
  }

  /** The event mapper. */
  get eventMapper(): EventMapper {
    return this.mapper;
  }

  /** Current connection state. */
  get connectionState(): BridgeConnectionState {
    return this.connected ? "connected" : "disconnected";
  }

  /** Whether the sidecar is currently marked stale (disconnected, §30). */
  isStale(): boolean {
    return this.sidecar.isStale();
  }

  /**
   * Ingest an authoritative snapshot (bootstrap / reconnect): spawn a character
   * (`sessionStart`) for each agent and populate the sidecar concurrency. Only
   * emits while connected; while disconnected the sidecar is still updated.
   */
  ingestSnapshot(snapshot: AuthoritativeSnapshotInput): void {
    this.sidecar.setCompany(snapshot.company.id);
    const { agentEvents, sidecarEntries } = this.mapper.mapSnapshot(snapshot);
    for (const entry of sidecarEntries) this.sidecar.ingestEntry(entry);
    for (const agent of snapshot.agents) {
      this.sidecar.setConcurrency(agent.id, {
        activeRunCount: agent.activeRuns?.length ?? 0,
        runs: (agent.activeRuns ?? []).map((r) => ({
          runId: r.id,
          issueId: r.issueId ?? null,
          projectId: r.projectId ?? null,
          status: r.status,
        })),
      });
    }
    if (this.connected) {
      for (const ev of agentEvents) this.emit(ev);
    }
  }

  /** Ingest a continuous bridge event: map, update sidecar, emit if connected. */
  ingestEvent(event: BridgeInputEvent): void {
    const { agentEvents, sidecar } = this.mapper.mapEvent(event);
    if (sidecar) this.sidecar.ingestEntry(sidecar);
    if (this.connected) {
      for (const ev of agentEvents) this.emit(ev);
    }
  }

  /** Parse and ingest a raw envelope. Returns false if it was non-mappable. */
  ingestRaw(raw: Record<string, unknown>): boolean {
    const event = parseBridgeEvent(raw);
    if (!event) return false;
    this.ingestEvent(event);
    return true;
  }

  // -- richer core outputs forwarded to the sidecar ------------------------

  setBehavior(agentId: string, behavior: VersionedAgentBehaviorVector): void {
    this.sidecar.setBehavior(agentId, behavior);
  }

  setMetrics(agentId: string, metrics: WindowedMetrics[]): void {
    this.sidecar.setMetrics(agentId, metrics);
  }

  setFeedback(agentId: string, feedback: AgentFeedback[]): void {
    this.sidecar.setFeedback(agentId, feedback);
  }

  /** Serialized, schema-versioned sidecar snapshot. */
  sidecarSnapshot(): SidecarSnapshot {
    return this.sidecar.snapshot();
  }

  // -- connection lifecycle (§30) ------------------------------------------

  /** Mark the bridge connected; mapped events resume flowing to the sink. */
  connect(): void {
    this.connected = true;
  }

  /**
   * Mark the bridge disconnected: state becomes visibly stale and mapped
   * events stop flowing to the sink (they still update the stale sidecar).
   */
  disconnect(reason = "disconnected"): void {
    this.connected = false;
    this.sidecar.markStale(reason);
  }

  /**
   * Reconnect: resume emitting, and when a fresh authoritative snapshot is
   * supplied, re-spawn characters / repopulate the sidecar and clear staleness.
   * Without a snapshot the sidecar remains stale until one arrives.
   */
  reconnect(snapshot?: AuthoritativeSnapshotInput): void {
    this.connected = true;
    if (snapshot) {
      this.ingestSnapshot(snapshot);
      this.sidecar.clearStale();
    }
  }

  /** Reset all mapper + sidecar state (e.g. on company switch). */
  reset(): void {
    this.mapper.reset();
    this.sidecar.clear();
  }

  /** Release the transport (sinks own their own disposal). */
  dispose(): void {
    this.connected = false;
  }

  // -- internals -----------------------------------------------------------

  private emit(event: SessionAgentEvent): void {
    const result = this.sink.emit(event);
    if (result && typeof (result as Promise<void>).then === "function") {
      // Fire-and-forget async sinks (e.g. HttpPushSink); errors are captured
      // by the sink itself to avoid an unhandled rejection on the read path.
      (result as Promise<void>).catch(() => undefined);
    }
  }
}

/** Re-exported sidecar entry type for transport consumers. */
export type { SidecarEntry };
