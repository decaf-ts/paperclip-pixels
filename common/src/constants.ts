/**
 * Wire-level operation ids, plugin/action/data/stream keys, and error codes.
 *
 * These are the stable strings that travel on the wire and are shared by both
 * the Paperclip plugin (producer) and the Pixel Agents plugin (consumer). The
 * consumer must never hold a hardcoded copy that can drift from the producer.
 */

import { PLUGIN_FEED_SCHEMA_VERSION } from "./version.js";

/** Unique id of the Paperclip ↔ Pixel Agents Paperclip plugin. */
export const PAPERCLIP_PIXEL_PLUGIN_ID = "paperclip-pixel.paperclip-plugin";

/** Pixel Agents override plugin id (the Paperclip plugin's fork-side mirror). */
export const PIXEL_OFFICE_PLUGIN_ID = "paperclip-pixel-agents";

/** Built-in base/default plugin id (fork host, board §5.1). */
export const BASE_PLUGIN_ID = "pixel-agents-base";

/** Feed operation ids (single source of truth for the `op` discriminator). */
export const FEED_OP = {
  declareAgents: "declareAgents",
  removeAgents: "removeAgents",
  updateAgentStatus: "updateAgentStatus",
  updateAgentActivity: "updateAgentActivity",
  assignAgentAppearance: "assignAgentAppearance",
  dialogLines: "dialogLines",
} as const;

export type FeedOpId = (typeof FEED_OP)[keyof typeof FEED_OP];

/** Paperclip action ids (the reverse-action surface: Pixel Agents → Paperclip). */
export const ACTION_KEYS = {
  companySendMessage: "company.send-message",
  agentReplyToFeedback: "agent.reply-to-feedback",
  setAgentAppearance: "agent.set-pixel-appearance",
} as const;

/** Paperclip data endpoint keys consumed by the UI / fork. */
export const DATA_KEYS = {
  bridgeSnapshot: "bridge-snapshot",
  companySummary: "company-summary",
  agentBehavior: "agent-behavior",
  outstandingFeedback: "outstanding-feedback",
  visualSettings: "visual-settings",
} as const;

/** Stream channel names (worker → UI deltas). */
export const STREAM_CHANNELS = {
  bridge: "bridge",
  behavior: "behavior",
} as const;

/** Returns the company-scoped behavior stream channel name. */
export function behaviorChannel(companyId: string): string {
  return `behavior:${companyId}`;
}

/**
 * Wire error codes. These are the stable machine-readable `error` strings an
 * action handler or feed endpoint returns; a consumer keys off them, never off
 * a prose message.
 */
export const ERROR_CODES = {
  invalidParams: "INVALID_PARAMS",
  companyScopeMismatch: "COMPANY_SCOPE_MISMATCH",
  feedbackNotFound: "FEEDBACK_NOT_FOUND",
  routeToCompany: "ROUTE_TO_COMPANY",
  catalogUnavailable: "CATALOG_UNAVAILABLE",
  agentNotFound: "AGENT_NOT_FOUND",
  assignmentApplierUnavailable: "ASSIGNMENT_APPLIER_UNAVAILABLE",
  unknownCharacter: "UNKNOWN_CHARACTER",
  paletteMismatch: "PALETTE_MISMATCH",
  invalidHueShift: "INVALID_HUE_SHIFT",
  noLeadershipAgent: "no-leadership-agent",
  invalidFeedBatch: "invalidFeedBatch",
  invalidFeedOperations: "invalidFeedOperations",
  pluginNotStarted: "pluginNotStarted",
} as const;

export type WireErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** A uniform action/feed result envelope (the wire result shape). */
export interface WireResult<T = Record<string, unknown>> {
  ok: boolean;
  error?: string;
  details?: unknown;
  result?: T;
}

/** Helper to build a guarded wire result. */
export function wireOk<T = Record<string, unknown>>(result?: T): WireResult<T> {
  return result === undefined ? { ok: true } : { ok: true, result };
}

/** Helper to build a rejected wire result with a stable error code. */
export function wireErr(error: string, details?: unknown): WireResult {
  return details === undefined ? { ok: false, error } : { ok: false, error, details };
}

/** Re-export for consumers that reference the feed schema version constant. */
export { PLUGIN_FEED_SCHEMA_VERSION };
