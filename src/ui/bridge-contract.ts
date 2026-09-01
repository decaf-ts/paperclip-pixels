/**
 * UI-side view of the canonical bridge contract (spec PAPERCLIP_PIXELS-1,
 * §9, §15, §16, §26, §29.3).
 *
 * The worker's `bridge-snapshot` data handler (spec §15) serves
 * `BridgeCompanySnapshot`; the worker pushes `BridgeStreamEvent` envelopes on
 * the company-scoped `behavior:<companyId>` stream channel (spec §16). Every
 * payload carries `schemaVersion: 1` (NFR-6).
 *
 * The UI never calls Paperclip HTTP routes directly (FR-9, §28.2): all domain
 * access goes through the worker via `ctx.data` / `ctx.actions` /
 * `ctx.streams`.
 */

import type {
  AgentFeedback,
  ApprovalInput,
  CompanySummary,
  IssueInput,
  ProjectInput,
  RawAgentProjection,
  TimeWindow,
  VersionedAgentBehaviorVector,
  WindowedMetrics,
  BridgeUiEvent,
} from "../core/index.js";

/**
 * Per-agent view: the raw projection (canonical Paperclip IDs, run-level
 * concurrency preserved — FR-1, FR-2), rolling-window metrics (FR-3), and the
 * behavioral proxy vector (FR-4).
 */
export interface BridgeAgentView {
  projection: RawAgentProjection;
  metrics: Record<TimeWindow, WindowedMetrics>;
  behavior: VersionedAgentBehaviorVector;
}

/**
 * Full company snapshot served by the worker's `bridge-snapshot` data handler.
 *
 * The UI fetches a full snapshot on mount, company switch, reconnect,
 * detected sequence gap, and explicit refresh (NFR-3, §29.3, FR-13) and
 * applies stream deltas otherwise.
 */
export interface BridgeCompanySnapshot {
  schemaVersion: 1;
  company: { id: string; name: string; status?: string };
  summary: CompanySummary;
  agents: BridgeAgentView[];
  issues: IssueInput[];
  projects: ProjectInput[];
  approvals: ApprovalInput[];
  /** Outstanding individual-agent feedback (spec §9.4, §26.3). */
  feedback: AgentFeedback[];
  observedAt?: string;
  lastReconciledAt?: string;
}

/** Delta payload for `agent.metrics.changed`. */
export interface AgentMetricsDelta {
  agentId: string;
  metrics: Record<TimeWindow, WindowedMetrics>;
}

/** Delta payload for `feedback.changed` (upsert or remove by `feedback.id`). */
export interface FeedbackChangedDelta {
  feedback: AgentFeedback;
  removed?: boolean;
}

/**
 * Stream event envelope emitted by the worker on `behavior:<companyId>`
 * (spec §16). `type` discriminates the delta kind; `payload` is the typed
 * delta.
 */
export type BridgeStreamEvent =
  | (BridgeUiEvent<BridgeCompanySnapshot> & { type: "bridge.snapshot" })
  | (BridgeUiEvent<CompanySummary> & { type: "company.summary.changed" })
  | (BridgeUiEvent<RawAgentProjection> & { type: "agent.projection.changed" })
  | (BridgeUiEvent<AgentMetricsDelta> & { type: "agent.metrics.changed" })
  | (BridgeUiEvent<VersionedAgentBehaviorVector> & { type: "agent.behavior.changed" })
  | (BridgeUiEvent<FeedbackChangedDelta> & { type: "feedback.changed" });

/** Delta types the UI knows how to apply. Unknown types trigger a full re-fetch (§29.3). */
export const BRIDGE_STREAM_EVENT_TYPES: ReadonlySet<string> = new Set<string>([
  "bridge.snapshot",
  "company.summary.changed",
  "agent.projection.changed",
  "agent.metrics.changed",
  "agent.behavior.changed",
  "feedback.changed",
]);

/** Type guard for streamed envelopes (defends against unknown/foreign event types). */
export function isBridgeStreamEvent(
  event: unknown,
): event is BridgeStreamEvent {
  if (typeof event !== "object" || event === null) return false;
  const candidate = event as { type?: unknown; schemaVersion?: unknown };
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.type === "string" &&
    BRIDGE_STREAM_EVENT_TYPES.has(candidate.type)
  );
}

/**
 * Plugin manifest id (spec §14). The sidebar uses it to link to the plugin
 * page; the worker's manifest must declare the same id.
 */
export const PIXEL_OFFICE_PLUGIN_ID = "paperclip-pixel-agents";

/** The route segment for the Pixel Office page (mirrors constant in plugin core). */
export const PIXEL_OFFICE_PAGE_ROUTE = "pixel-office";

/** Worker data keys consumed by this UI (spec §15). */
export const BRIDGE_DATA_KEYS = {
  snapshot: "bridge-snapshot",
  visualSettings: "visual-settings",
} as const;

/** Worker action keys consumed by this UI (spec §15, §17, §18). */
export const BRIDGE_ACTION_KEYS = {
  companySendMessage: "company.send-message",
  agentReplyToFeedback: "agent.reply-to-feedback",
  setAgentAppearance: "agent.set-pixel-appearance",
} as const;

/**
 * One character sheet offered by the visual-settings payload: catalog
 * metadata plus a base64 preview data URL so the picker can render
 * immediately (WS3: served by the worker from the package catalog).
 */
export interface PixelCharacterChoice {
  id: string;
  name: string;
  palette: number;
  previewDataUrl: string;
  source: string;
  license: string;
}

/**
 * FROZEN per-agent character assignment contract (WS3, spec
 * PAPERCLIP_PIXELS-2 FR-13). Keyed by Paperclip agent id; the Front-End
 * sibling builds against exactly this shape. Shaped to flow through the WS2
 * appearance API unchanged.
 */
export interface PixelAgentCharacterAssignment {
  /** Catalog id of the assigned character sheet. */
  characterId: string;
  /** Integer palette index of the assigned sheet. */
  palette: number;
  /** Hue rotation applied on top of the sheet, 0–360 degrees. */
  hueShift: number;
  /** ISO timestamp of the last explicit or defaulted assignment. */
  updatedAt: string;
}

/**
 * Payload served by the worker's `visual-settings` data handler. WS3: built
 * from plugin `ctx.state` (agent scope) plus the package catalog — no longer
 * proxied from the relay, which is only an applier of the assignments pushed
 * to it.
 */
export interface VisualSettingsData {
  schemaVersion: 1;
  configured: boolean;
  pixelAgentsUiUrl?: string;
  characters: PixelCharacterChoice[];
  /** agentId -> assignment (frozen contract above). */
  assignments: Record<string, PixelAgentCharacterAssignment>;
  error?: string;
}

/** Company-scoped stream channel (spec §16). */
/** Returns the company‑scoped behavior stream channel name. */
export function behaviorChannel(companyId: string): string {
  return `behavior:${companyId}`;
}
