/**
 * Plugin feed wire contract (spec PAPERCLIP_PIXELS-2, WS2-C).
 *
 * The sanctioned replacement for the retired impersonation wire formats: the
 * Paperclip worker pushes **feed operations** — thin, honest wrappers around
 * the WS2-A1 agent/team data source — to the embedding surface's
 * `POST /api/plugin-feed` endpoint, which applies them through the registered
 * plugin's `PluginContext.agents` (see feed-server.ts).
 *
 * There is no Claude-hook vocabulary on this wire: no `hook_event_name`, no
 * `session_id`, no synthetic transcripts, no `saveAgentSeats`. Seat
 * assignment rides `declareAgents` (palette/hueShift — the host persists it
 * through its own sanctioned seat path), status and activity captions ride
 * their dedicated operations.
 */

import type { PluginAgentDeclaration } from "./types.js";

/** One agent-status operation (mirrors A1's `PluginAgentStatusUpdate`). */
export interface PluginFeedStatusOperation {
  op: "updateAgentStatus";
  key: string;
  status: "active" | "waiting";
  awaitingInput?: boolean;
}

/** One activity-caption operation: `string` shows the caption (one per
 * agent — a new one replaces the previous), `null` clears it. */
export interface PluginFeedActivityOperation {
  op: "updateAgentActivity";
  key: string;
  activity: string | null;
}

/** One first-class appearance assignment (WS4-C): `characterId` is the WS3
 * frozen catalog id; the embedding surface resolves it to a positional
 * sheet index in the catalog it declared through the WS4-A appearance
 * source. `null` reverts the agent to built-in palette rendering. */
export interface PluginFeedAppearanceAssignmentOperation {
  op: "assignAgentAppearance";
  key: string;
  characterId: string | null;
}

/** One dialog-pane line (WS4-C): pre-redacted/truncated plugin-side. The
 * webview's Phase-1 widget renderer reads only `text`. */
export interface PluginFeedDialogLine {
  text: string;
}

/** One dialog-pane conversation-extract push (WS4-C): emitted through the
 * plugin's declared `paperclip.dialog.lines` message type. */
export interface PluginFeedDialogLinesOperation {
  op: "dialogLines";
  lines: PluginFeedDialogLine[];
}

/** All operations the feed carries. */
export type PluginFeedOperation =
  | { op: "declareAgents"; agents: PluginAgentDeclaration[] }
  | { op: "removeAgents"; keys: string[] }
  | PluginFeedStatusOperation
  | PluginFeedActivityOperation
  | PluginFeedAppearanceAssignmentOperation
  | PluginFeedDialogLinesOperation;

/** One pushed batch. Applied in order; a batch with any invalid operation is
 *  rejected whole (all-or-nothing, mirroring the host's declareAgents). */
export interface PluginFeedBatch {
  schemaVersion: 1;
  companyId: string;
  operations: PluginFeedOperation[];
}

/** Current wire schema version. */
export const PLUGIN_FEED_SCHEMA_VERSION = 1;

/** Validate an untrusted batch shape. Returns every violation (the host's
 *  manifest-validator precedent: name all causes, accept nothing partial). */
export function validatePluginFeedBatch(input: unknown): { errors: string[]; batch?: PluginFeedBatch } {
  const errors: string[] = [];
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { errors: ["batch must be an object"] };
  }
  const raw = input as Record<string, unknown>;
  if (raw.schemaVersion !== PLUGIN_FEED_SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${PLUGIN_FEED_SCHEMA_VERSION}`);
  }
  if (typeof raw.companyId !== "string" || raw.companyId.length === 0) {
    errors.push("companyId must be a non-empty string");
  }
  if (!Array.isArray(raw.operations)) {
    errors.push("operations must be an array");
  } else {
    raw.operations.forEach((op, index) => {
      if (typeof op !== "object" || op === null || Array.isArray(op)) {
        errors.push(`operations[${index}] must be an object`);
        return;
      }
      const kind = (op as Record<string, unknown>).op;
      switch (kind) {
        case "declareAgents":
          if (!Array.isArray((op as Record<string, unknown>).agents)) {
            errors.push(`operations[${index}].agents must be an array`);
          }
          break;
        case "removeAgents":
          if (!Array.isArray((op as Record<string, unknown>).keys)) {
            errors.push(`operations[${index}].keys must be an array`);
          }
          break;
        case "updateAgentStatus":
        case "updateAgentActivity":
          if (typeof (op as Record<string, unknown>).key !== "string") {
            errors.push(`operations[${index}].key must be a string`);
          }
          break;
        case "assignAgentAppearance": {
          const entry = op as Record<string, unknown>;
          if (typeof entry.key !== "string") {
            errors.push(`operations[${index}].key must be a string`);
          }
          if (entry.characterId !== null && typeof entry.characterId !== "string") {
            errors.push(`operations[${index}].characterId must be a string or null`);
          }
          break;
        }
        case "dialogLines":
          if (!Array.isArray((op as Record<string, unknown>).lines)) {
            errors.push(`operations[${index}].lines must be an array`);
          }
          break;
        default:
          errors.push(`operations[${index}] has unknown op: ${JSON.stringify(kind)}`);
      }
    });
  }
  if (errors.length > 0) {
    return { errors };
  }
  return { errors: [], batch: raw as unknown as PluginFeedBatch };
}
