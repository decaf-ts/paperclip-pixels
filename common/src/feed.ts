/**
 * Plugin feed wire contract (WS2-C).
 *
 * The Paperclip worker pushes **feed operations** — thin, honest wrappers
 * around the WS2-A1 agent/team data source — to the embedding surface's
 * `POST /api/plugin-feed` endpoint, which applies them through the registered
 * plugin's `PluginContext.agents`.
 *
 * There is no Claude-hook vocabulary on this wire. This module owns the
 * canonical envelope + operation DTOs, their Zod validation, and the
 * all-or-nothing batch validator shared by both sides.
 */

import { z } from "zod";

import { PLUGIN_FEED_SCHEMA_VERSION } from "./version.js";
import { FEED_OP } from "./constants.js";
import type { PluginAgentDeclaration } from "./pluginHost.js";

/** One agent-status operation. */
export interface PluginFeedStatusOperation {
  op: "updateAgentStatus";
  key: string;
  status: "active" | "waiting";
  awaitingInput?: boolean;
}

export const PluginFeedStatusOperationSchema = z.object({
  op: z.literal(FEED_OP.updateAgentStatus),
  key: z.string().min(1),
  status: z.enum(["active", "waiting"]),
  awaitingInput: z.boolean().optional(),
});

/** One activity-caption operation. */
export interface PluginFeedActivityOperation {
  op: "updateAgentActivity";
  key: string;
  activity: string | null;
}

export const PluginFeedActivityOperationSchema = z.object({
  op: z.literal(FEED_OP.updateAgentActivity),
  key: z.string().min(1),
  activity: z.string().nullable(),
});

/** One first-class appearance assignment (WS4-C). */
export interface PluginFeedAppearanceAssignmentOperation {
  op: "assignAgentAppearance";
  key: string;
  characterId: string | null;
}

export const PluginFeedAppearanceAssignmentOperationSchema = z.object({
  op: z.literal(FEED_OP.assignAgentAppearance),
  key: z.string().min(1),
  characterId: z.string().nullable(),
});

/** One dialog-pane line (WS4-C): pre-redacted/truncated plugin-side. */
export interface PluginFeedDialogLine {
  text: string;
}

export const PluginFeedDialogLineSchema = z.object({
  text: z.string().min(1),
});

/** One dialog-pane conversation-extract push (WS4-C). */
export interface PluginFeedDialogLinesOperation {
  op: "dialogLines";
  lines: PluginFeedDialogLine[];
}

export const PluginFeedDialogLinesOperationSchema = z.object({
  op: z.literal(FEED_OP.dialogLines),
  lines: z.array(PluginFeedDialogLineSchema).min(1),
});

export interface PluginFeedDeclareAgentsOperation {
  op: "declareAgents";
  agents: PluginAgentDeclaration[];
}

export const PluginFeedDeclareAgentsOperationSchema = z.object({
  op: z.literal(FEED_OP.declareAgents),
  agents: z.array(z.custom<PluginAgentDeclaration>()).min(1),
});

export interface PluginFeedRemoveAgentsOperation {
  op: "removeAgents";
  keys: string[];
}

export const PluginFeedRemoveAgentsOperationSchema = z.object({
  op: z.literal(FEED_OP.removeAgents),
  keys: z.array(z.string().min(1)).min(1),
});

/** All operations the feed carries. */
export type PluginFeedOperation =
  | PluginFeedDeclareAgentsOperation
  | PluginFeedRemoveAgentsOperation
  | PluginFeedStatusOperation
  | PluginFeedActivityOperation
  | PluginFeedAppearanceAssignmentOperation
  | PluginFeedDialogLinesOperation;

export const PluginFeedOperationSchema: z.ZodType<PluginFeedOperation> = z.discriminatedUnion(
  "op",
  [
    PluginFeedDeclareAgentsOperationSchema,
    PluginFeedRemoveAgentsOperationSchema,
    PluginFeedStatusOperationSchema,
    PluginFeedActivityOperationSchema,
    PluginFeedAppearanceAssignmentOperationSchema,
    PluginFeedDialogLinesOperationSchema,
  ],
);

/** One pushed batch. Applied in order; a batch with any invalid operation is
 *  rejected whole (all-or-nothing). */
export interface PluginFeedBatch {
  schemaVersion: 1;
  companyId: string;
  operations: PluginFeedOperation[];
}

/** Current wire schema version. */
export { PLUGIN_FEED_SCHEMA_VERSION };

export const PluginFeedBatchSchema: z.ZodType<PluginFeedBatch> = z.object({
  schemaVersion: z.literal(PLUGIN_FEED_SCHEMA_VERSION),
  companyId: z.string().min(1),
  operations: z.array(PluginFeedOperationSchema),
});

export type PluginFeedBatchParseResult =
  | { ok: true; batch: PluginFeedBatch }
  | { ok: false; errors: string[] };

/** Validate an untrusted batch shape. Returns every violation (the host's
 *  manifest-validator precedent: name all causes, accept nothing partial). */
export function validatePluginFeedBatch(input: unknown): PluginFeedBatchParseResult {
  const parsed = PluginFeedBatchSchema.safeParse(input);
  if (parsed.success) return { ok: true, batch: parsed.data };
  return {
    ok: false,
    errors: parsed.error.issues.map((issue) => {
      const path = issue.path.join(".");
      const loc = path.length > 0 ? `${path}: ` : "";
      return `${loc}${issue.message}`;
    }),
  };
}

/** Backwards-compatible shape: returns `{ errors, batch }` mirroring the
 *  original in-repo validator contract (the apply side consumes this). */
export function validatePluginFeedBatchLegacy(input: unknown): {
  errors: string[];
  batch?: PluginFeedBatch;
} {
  const result = validatePluginFeedBatch(input);
  if (result.ok) return { errors: [], batch: result.batch };
  return { errors: result.errors };
}
