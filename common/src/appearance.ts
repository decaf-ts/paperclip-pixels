/**
 * Appearance / character-assignment wire contract (WS3 + WS4-C).
 *
 * The Paperclip worker owns the ordered character catalog and the per-agent
 * assignment map (single source of truth). The Pixel Agents side resolves a
 * `characterId` to a positional sheet index against the catalog it declared
 * through the WS4-A appearance source. This module owns the serializable
 * shapes both sides share.
 */

import { z } from "zod";

/** Upper bound for a sheet's hue rotation, inclusive (degrees). */
export const HUE_SHIFT_MAX_DEG = 360;

/** One ordered catalog entry: a complete Pixel Agents character sheet. */
export interface CharacterCatalogEntry {
  id: string;
  name: string;
  palette: number;
  file: string;
  source: string;
  license: string;
}

export const CharacterCatalogEntrySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  palette: z.number().int().nonnegative(),
  file: z.string().min(1),
  source: z.string().min(1),
  license: z.string().min(1),
});

/** The ordered character catalog served to the UI and validated on writes. */
export interface CharacterCatalog {
  schemaVersion: 1;
  characters: CharacterCatalogEntry[];
}

export const CharacterCatalogSchema: z.ZodType<CharacterCatalog> = z.object({
  schemaVersion: z.literal(1),
  characters: z.array(CharacterCatalogEntrySchema).min(1),
});

/** FROZEN per-agent assignment record. */
export interface AgentCharacterAssignment {
  characterId: string;
  palette: number;
  hueShift: number;
  updatedAt: string;
}

export const AgentCharacterAssignmentSchema: z.ZodType<AgentCharacterAssignment> = z.object({
  characterId: z.string().min(1),
  palette: z.number().int().nonnegative(),
  hueShift: z.number().int().min(0).max(HUE_SHIFT_MAX_DEG),
  updatedAt: z.string().min(1),
});

/** Per-agent assignment map keyed by Paperclip agent id (frozen contract). */
export type AgentCharacterAssignmentMap = Record<string, AgentCharacterAssignment>;

export const AgentCharacterAssignmentMapSchema: z.ZodType<AgentCharacterAssignmentMap> =
  z.record(z.string(), AgentCharacterAssignmentSchema);

/** JSON Schema of a raw character catalog document (fail-closed on shape). */
export const RawCharacterCatalogSchema = z.object({
  schemaVersion: z.literal(1),
  characters: z.array(CharacterCatalogEntrySchema).min(1),
});

export type RawCharacterCatalog = z.infer<typeof RawCharacterCatalogSchema>;

/** One character sheet offered by the visual-settings payload. */
export interface PixelCharacterChoice {
  id: string;
  name: string;
  palette: number;
  previewDataUrl: string;
  source: string;
  license: string;
}

export const PixelCharacterChoiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  palette: z.number().int().nonnegative(),
  previewDataUrl: z.string().min(1),
  source: z.string().min(1),
  license: z.string().min(1),
});

/** Payload served by the worker's `visual-settings` data handler. */
export interface VisualSettingsData {
  schemaVersion: 1;
  configured: boolean;
  pixelAgentsUiUrl?: string;
  characters: PixelCharacterChoice[];
  assignments: Record<string, AgentCharacterAssignment>;
  error?: string;
}

export const VisualSettingsDataSchema: z.ZodType<VisualSettingsData> = z.object({
  schemaVersion: z.literal(1),
  configured: z.boolean(),
  pixelAgentsUiUrl: z.string().optional(),
  characters: z.array(PixelCharacterChoiceSchema),
  assignments: z.record(z.string(), AgentCharacterAssignmentSchema),
  error: z.string().optional(),
});

/** An agent's appearance as resolved by the worker (rides the feed wire). */
export interface FeedAppearanceEntry {
  agentId: string;
  agentName: string;
  characterId: string;
  palette: number;
  hueShift: number;
}

export const FeedAppearanceEntrySchema = z.object({
  agentId: z.string().min(1),
  agentName: z.string().min(1),
  characterId: z.string().min(1),
  palette: z.number().int().nonnegative(),
  hueShift: z.number().int().min(0).max(HUE_SHIFT_MAX_DEG),
});
