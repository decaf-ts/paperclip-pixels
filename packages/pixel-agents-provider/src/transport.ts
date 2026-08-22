/**
 * Transport (spec §7.3, §8, §21, §30, §39.1; spike SAA-175 §3/§5/§6).
 *
 * Feeds mapped `AgentEvent`s (and the richer sidecar) into the Pixel Agents
 * runtime/provider boundary. Owns an {@link EventMapper} and a
 * {@link BehaviorSidecar}, manages connection state, and marks state visibly
 * stale on disconnect with a full re-snapshot on reconnect (§30).
 *
 * Boundary note (spike §3/§5/§6): the current Pixel Agents runtime is
 * single-provider and normalizes hook events via one injected provider, so a
 * coexisting bridge cannot yet reach the runtime through `POST /api/hooks/:id`
 * without the recommended upstream per-`providerId` dispatch change. This
 * transport therefore delivers *already-mapped* `AgentEvent`s to an abstract
 * {@link AgentEventSink} (the V1 embedded-UI / direct-consumption path, spike
 * option c) plus an {@link HttpPushSink} convenience. No Pixel Agents core
 * feature is assumed or modified (NFR-8).
 */

import type {
  AgentFeedback,
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
  VersionedAgentBehaviorVector,
  WindowedMetrics,
} from "@paperclip-pixel/core";

import { BehaviorSidecar, type SidecarSnapshot } from "./behavior-sidecar";
import {
  EventMapper,
  parseBridgeEvent,
  type SidecarEntry,
} from "./event-mapper";
import { PAPERCLIP_BRIDGE_PROVIDER_ID } from "./paperclip-provider";
import type { SessionAgentEvent } from "./pixel-agents-types";

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

/** Options for {@link HttpPushSink}. */
export interface HttpPushSinkOptions {
  /** Base URL of the receiving endpoint. */
  baseUrl: string;
  /** Provider id used in the path. Defaults to the bridge provider id. */
  providerId?: string;
  /** Bearer auth token sent on each request. */
  authToken?: string;
  /** Injected fetch implementation (keeps the package free of node globals). */
  fetch: FetchLike;
}

/**
 * `AgentEventSink` that POSTs each mapped event as a JSON envelope to an HTTP
 * endpoint. The envelope shape is `{ providerId, sessionId, event }`.
 *
 * Reaching the *current* Pixel Agents runtime with this still requires the
 * upstream per-`providerId` dispatch change (spike §5/§6); the sink is
 * otherwise a generic push transport for the embedded UI / future endpoints.
 */
export class HttpPushSink implements AgentEventSink {
  private readonly baseUrl: string;
  private readonly providerId: string;
  private readonly authToken?: string;
  private readonly fetch: FetchLike;
  private lastError: string | undefined;

  constructor(options: HttpPushSinkOptions) {
    this.baseUrl = options.baseUrl.replace(/\/$/, "");
    this.providerId = options.providerId ?? PAPERCLIP_BRIDGE_PROVIDER_ID;
    this.authToken = options.authToken;
    this.fetch = options.fetch;
  }

  /** Most recent push error, if any (cleared on a successful push). */
  get lastPushError(): string | undefined {
    return this.lastError;
  }

  async emit(event: SessionAgentEvent): Promise<void> {
    const url = `${this.baseUrl}/api/hooks/${this.providerId}`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.authToken) headers.authorization = `Bearer ${this.authToken}`;
    const body = JSON.stringify({
      providerId: this.providerId,
      sessionId: event.sessionId,
      event: event.event,
    });
    try {
      const res = await this.fetch(url, { method: "POST", headers, body });
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
