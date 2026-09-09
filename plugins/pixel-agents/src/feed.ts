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

import type {
  PluginFeedActivityOperation,
  PluginFeedAppearanceAssignmentOperation,
  PluginFeedBatch,
  PluginFeedDialogLine,
  PluginFeedDialogLinesOperation,
  PluginFeedOperation,
  PluginFeedStatusOperation,
} from "@decaf-ts/paperclip-pixels-common";
import { PLUGIN_FEED_SCHEMA_VERSION } from "@decaf-ts/paperclip-pixels-common";

// The feed wire contract (operation DTOs, batch envelope, schema version) is
// owned by `@decaf-ts/paperclip-pixels-common`; this module re-exports those shared
// shapes and carries the re-implemented fail-closed batch validator whose
// exact diagnostic strings the plugin's own tests pin (the common package
// ships a `validatePluginFeedBatchLegacy` with a different, zod-derived
// wording — the plugin keeps its own for parity with the landed contract).
export {
  PLUGIN_FEED_SCHEMA_VERSION,
  type PluginFeedActivityOperation,
  type PluginFeedAppearanceAssignmentOperation,
  type PluginFeedBatch,
  type PluginFeedDialogLine,
  type PluginFeedDialogLinesOperation,
  type PluginFeedOperation,
  type PluginFeedStatusOperation,
};

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
