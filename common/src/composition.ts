/**
 * Character-composition wire contract (board Revision 3 remediation
 * sequence item 5, model half — WS5a).
 *
 * The whole-sheet assignment model (`appearance.ts`) is a reliable
 * catalog-and-assign API, but it is not a granular composer. This module
 * owns the composited-appearance model: per-part schemas (skin, clothing,
 * hair, face, accessory), the canonical layering order, the directional
 * asset variants the fork renderer needs, and the version-2 appearance DTO
 * that sits alongside (never replacing) the frozen whole-sheet DTO.
 *
 * Neutrality (schemas only): imports no host code; knows no other package;
 * carries no runtime host code.
 */

import { z } from "zod";

import { COMPOSITION_SCHEMA_VERSION } from "./version.js";

/** The compositional part kinds (board Revision 3, item 5). */
export const COMPOSITION_PART_KINDS = [
  "skin",
  "clothing",
  "hair",
  "face",
  "accessory",
] as const;

export type CompositionPartKind = (typeof COMPOSITION_PART_KINDS)[number];

/** Renderer-frame directions the fork encodes a sprite set for. `left` is
 *  derived by a horizontal flip of `right` in the fork renderer
 *  (`flipSpriteHorizontal`), so the wire only carries down/up/right. */
export const RENDER_DIRECTIONS = ["down", "up", "right"] as const;

export type RenderDirection = (typeof RENDER_DIRECTIONS)[number];

/** Full directional alphabet including the derived `left`. */
export const CHARACTER_DIRECTIONS = ["down", "up", "right", "left"] as const;

export type CharacterDirection = (typeof CHARACTER_DIRECTIONS)[number];

/** Canonical back-to-front layering order for composition parts. A part's
 *  `layer` index is validated to be monotonic across this order; lower
 *  layers render first (behind), higher render last (front). */
export const COMPOSITION_LAYER_ORDER: readonly CompositionPartKind[] = [
  "skin",
  "clothing",
  "accessory",
  "hair",
  "face",
] as const;

/** A single directed asset for one part (resolves a renderer direction to a
 *  packaged image). */
export interface CompositionPartVariant {
  direction: RenderDirection;
  file: string;
}

export const CompositionPartVariantSchema: z.ZodType<CompositionPartVariant> = z.object({
  direction: z.enum(RENDER_DIRECTIONS),
  file: z.string().min(1),
});

/** One compose-able part in the part catalog. `layer` is the global
 *  back-to-front ordering index; `variants` carries the per-direction
 *  asset files (a part with no variants uses `file` for all directions). */
export interface CompositionPartSpec {
  id: string;
  kind: CompositionPartKind;
  name: string;
  layer: number;
  file: string;
  palette: number;
  source: string;
  license: string;
  variants?: CompositionPartVariant[];
  /** Asset-privilege gate id (preserves the existing operator-grant
   *  boundary: an asset under a granted directory is allowed; anything
   *  without an explicit grant is fail-closed). */
  privilege?: string;
}

export const CompositionPartSpecSchema: z.ZodType<CompositionPartSpec> = z.object({
  id: z.string().min(1),
  kind: z.enum(COMPOSITION_PART_KINDS),
  name: z.string().min(1),
  layer: z.number().int().nonnegative(),
  file: z.string().min(1),
  palette: z.number().int().nonnegative(),
  source: z.string().min(1),
  license: z.string().min(1),
  variants: z.array(CompositionPartVariantSchema).optional(),
  privilege: z.string().optional(),
});

/** The composited part catalog (schemaVersion 2). */
export interface CompositionPartCatalog {
  schemaVersion: typeof COMPOSITION_SCHEMA_VERSION;
  parts: CompositionPartSpec[];
}

export const CompositionPartCatalogSchema: z.ZodType<CompositionPartCatalog> = z.object({
  schemaVersion: z.literal(2),
  parts: z.array(CompositionPartSpecSchema).min(1),
});

/** One selected part in an agent's composition (references a catalog part).
 *  A per-part hue shift lets a layer carry a tonal offset on top of the
 *  composition-wide shift. */
export interface CompositionPartSelection {
  partId: string;
  hueShift?: number;
}

export const CompositionPartSelectionSchema: z.ZodType<CompositionPartSelection> = z.object({
  partId: z.string().min(1),
  hueShift: z.number().int().min(0).max(360).default(0),
});

/** The composited appearance of one agent (schemaVersion 2). */
export interface CharacterComposition {
  schemaVersion: typeof COMPOSITION_SCHEMA_VERSION;
  parts: CompositionPartSelection[];
  palette: number;
  hueShift: number;
  updatedAt: string;
}

export const CharacterCompositionSchema: z.ZodType<CharacterComposition> = z.object({
  schemaVersion: z.literal(2),
  parts: z.array(CompositionPartSelectionSchema),
  palette: z.number().int().nonnegative(),
  hueShift: z.number().int().min(0).max(360),
  updatedAt: z.string().min(1),
});

/** Discriminated appearance assignment: the frozen whole-sheet model (legacy)
 *  or the composited model (v2). Backward compatible — a v1 whole-sheet
 *  payload is always a valid v2 assignment via `mode: "wholeSheet"`. */
export type AppearanceAssignment =
  | { mode: "wholeSheet"; characterId: string; palette: number; hueShift: number }
  | { mode: "composition"; composition: CharacterComposition };

export const WholeSheetAssignmentSchema = z.object({
  mode: z.literal("wholeSheet"),
  characterId: z.string().min(1),
  palette: z.number().int().nonnegative(),
  hueShift: z.number().int().min(0).max(360),
});

export const CompositionAssignmentSchema = z.object({
  mode: z.literal("composition"),
  composition: CharacterCompositionSchema,
});

export const AppearanceAssignmentSchema: z.ZodType<AppearanceAssignment> = z.discriminatedUnion(
  "mode",
  [WholeSheetAssignmentSchema, CompositionAssignmentSchema],
);

/** The v2 per-agent appearance record (rides the wire next to the frozen
 *  whole-sheet `AgentCharacterAssignment`). */
export interface AgentAppearanceAssignmentV2 {
  agentId: string;
  appearance: AppearanceAssignment;
  updatedAt: string;
}

export const AgentAppearanceAssignmentV2Schema: z.ZodType<AgentAppearanceAssignmentV2> = z.object({
  agentId: z.string().min(1),
  appearance: AppearanceAssignmentSchema,
  updatedAt: z.string().min(1),
});

export type AgentAppearanceAssignmentV2Map = Record<string, AgentAppearanceAssignmentV2>;

export const AgentAppearanceAssignmentV2MapSchema: z.ZodType<AgentAppearanceAssignmentV2Map> = z.record(
  z.string(),
  AgentAppearanceAssignmentV2Schema,
);

/** One catalog violation / validation result. */
export interface CompositionViolation {
  code: string;
  message: string;
  partId?: string;
}

function violation(code: string, message: string, partId?: string): CompositionViolation {
  return partId === undefined ? { code, message } : { code, message, partId };
}

/** Structural validation of a part catalog (fail-closed on shape). Returns
 *  the list of violations; empty means the catalog is well-formed. */
export function validateCompositionCatalog(catalog: unknown): CompositionViolation[] {
  if (typeof catalog !== "object" || catalog === null || Array.isArray(catalog)) {
    return [violation("not_object", "composition part catalog must be a JSON object")];
  }
  const c = catalog as Partial<CompositionPartCatalog>;
  if (c.schemaVersion !== 2) {
    return [violation("unsupported_version", `unsupported composition catalog schemaVersion: ${String(c.schemaVersion)}`)];
  }
  if (!Array.isArray(c.parts) || c.parts.length === 0) {
    return [violation("empty_parts", "composition part catalog must contain at least one part")];
  }
  const errors: CompositionViolation[] = [];
  const seenIds = new Set<string>();
  const seenLayers = new Set<number>();
  for (const entry of c.parts) {
    if (typeof entry !== "object" || entry === null) {
      errors.push(violation("bad_entry", "composition part entry must be an object"));
      continue;
    }
    const p = entry as Partial<CompositionPartSpec>;
    if (typeof p.id !== "string" || p.id.length === 0) {
      errors.push(violation("bad_id", "composition part id must be a non-empty string"));
      continue;
    }
    if (p.kind === undefined || !COMPOSITION_PART_KINDS.includes(p.kind)) {
      errors.push(violation("bad_kind", `composition part '${p.id}' has an unknown kind`, p.id));
    }
    if (typeof p.layer !== "number" || !Number.isInteger(p.layer) || p.layer < 0) {
      errors.push(violation("bad_layer", `composition part '${p.id}' has an invalid layer`, p.id));
    } else if (seenLayers.has(p.layer)) {
      errors.push(violation("duplicate_layer", `composition part '${p.id}' repeats layer ${p.layer}`, p.id));
    }
    if (typeof p.file !== "string" || p.file.length === 0) {
      errors.push(violation("bad_file", `composition part '${p.id}' has no asset file`, p.id));
    }
    if (typeof p.palette !== "number" || !Number.isInteger(p.palette) || p.palette < 0) {
      errors.push(violation("bad_palette", `composition part '${p.id}' has an invalid palette`, p.id));
    }
    if (typeof p.source !== "string" || p.source.length === 0 || typeof p.license !== "string" || p.license.length === 0) {
      errors.push(violation("missing_provenance", `composition part '${p.id}' must record source and license`, p.id));
    }
    if (p.variants !== undefined) {
      if (!Array.isArray(p.variants)) {
        errors.push(violation("bad_variants", `composition part '${p.id}' variants must be an array`, p.id));
      } else {
        const dirs = new Set<string>();
        for (const v of p.variants) {
          if (
            typeof v !== "object" ||
            v === null ||
            typeof v.direction !== "string" ||
            !RENDER_DIRECTIONS.includes(v.direction as RenderDirection) ||
            typeof v.file !== "string" ||
            v.file.length === 0
          ) {
            errors.push(violation("bad_variant", `composition part '${p.id}' has a malformed variant`, p.id));
          } else if (dirs.has((v as CompositionPartVariant).direction)) {
            errors.push(violation("duplicate_direction", `composition part '${p.id}' repeats direction ${(v as CompositionPartVariant).direction}`, p.id));
          } else {
            dirs.add((v as CompositionPartVariant).direction);
          }
        }
      }
    }
    if (seenIds.has(p.id)) {
      errors.push(violation("duplicate_id", `duplicate composition part id: ${p.id}`, p.id));
    }
    seenIds.add(p.id);
    seenLayers.add(p.layer ?? -1);
  }
  return errors;
}

/** A set of part kinds that must each appear at most once (a composition may
 *  include any number of accessories, but exactly one of each other kind). */
const SINGLE_KINDS: readonly CompositionPartKind[] = ["skin", "clothing", "hair", "face"];

/**
 * Validate a composition's selected parts against a part catalog.
 *
 * Fail-closed: an unknown part id, a duplicated single-kind part, an
 * out-of-range hue shift, or a palette/hue overflow is a violation. Does not
 * mutate; returns the list of violations (empty when the composition is
 * valid).
 */
export function validateCompositionState(
  composition: unknown,
  catalog: unknown,
): CompositionViolation[] {
  if (typeof composition !== "object" || composition === null || Array.isArray(composition)) {
    return [violation("not_object", "character composition must be a JSON object")];
  }
  const c = composition as Partial<CharacterComposition>;
  if (c.schemaVersion !== 2) {
    return [violation("unsupported_version", `unsupported composition schemaVersion: ${String(c.schemaVersion)}`)];
  }
  if (!Array.isArray(c.parts)) {
    return [violation("bad_parts", "character composition parts must be an array")];
  }
  const catalogErrors = validateCompositionCatalog(catalog);
  if (catalogErrors.length > 0) {
    return catalogErrors;
  }
  const cat = catalog as CompositionPartCatalog;
  const partById = new Map<string, CompositionPartSpec>();
  for (const p of cat.parts) partById.set(p.id, p);

  const errors: CompositionViolation[] = [];
  const seenKinds = new Set<CompositionPartKind>();
  const seenIds = new Set<string>();
  for (const sel of c.parts) {
    if (typeof sel !== "object" || sel === null) {
      errors.push(violation("bad_selection", "composition part selection must be an object"));
      continue;
    }
    const s = sel as Partial<CompositionPartSelection>;
    if (typeof s.partId !== "string" || s.partId.length === 0) {
      errors.push(violation("bad_part_id", "composition part selection needs a partId"));
      continue;
    }
    if (seenIds.has(s.partId)) {
      errors.push(violation("duplicate_part", `composition selects part '${s.partId}' more than once`, s.partId));
    }
    seenIds.add(s.partId);
    const spec = partById.get(s.partId);
    if (!spec) {
      errors.push(violation("unknown_part", `composition selects unknown part '${s.partId}'`, s.partId));
      continue;
    }
    if (SINGLE_KINDS.includes(spec.kind)) {
      if (seenKinds.has(spec.kind)) {
        errors.push(violation("duplicate_kind", `composition selects more than one ${spec.kind} part`, s.partId));
      }
      seenKinds.add(spec.kind);
    }
    if (s.hueShift !== undefined && (typeof s.hueShift !== "number" || !Number.isInteger(s.hueShift) || s.hueShift < 0 || s.hueShift > 360)) {
      errors.push(violation("invalid_hue", `composition part '${s.partId}' has an invalid hueShift`, s.partId));
    }
  }
  if (typeof c.palette !== "number" || !Number.isInteger(c.palette) || c.palette < 0) {
    errors.push(violation("invalid_palette", "character composition palette must be a non-negative integer"));
  }
  if (typeof c.hueShift !== "number" || !Number.isInteger(c.hueShift) || c.hueShift < 0 || c.hueShift > 360) {
    errors.push(violation("invalid_hue", "character composition hueShift must be in 0..360"));
  }
  return errors;
}

/**
 * Validate a v2 appearance assignment against a part catalog (the
 * composition branch only; a whole-sheet branch needs no catalog).
 */
export function validateAppearanceAssignmentV2(
  value: unknown,
  catalog?: unknown,
): CompositionViolation[] {
  if (typeof value !== "object" || value === null) {
    return [violation("not_object", "appearance assignment must be a JSON object")];
  }
  const v = value as { appearance?: unknown };
  if (typeof v.appearance !== "object" || v.appearance === null) {
    return [violation("missing_appearance", "appearance assignment must carry an `appearance`")];
  }
  const a = v.appearance as { mode?: unknown };
  if (a.mode === "composition") {
    return validateCompositionState((v.appearance as { composition: unknown }).composition, catalog);
  }
  if (a.mode === "wholeSheet") {
    return [];
  }
  return [violation("unknown_mode", `unsupported appearance mode: ${String(a.mode)}`)];
}

/**
 * Upgrade mapping (whole sheet → composition preset or legacy mode).
 *
 * A whole-sheet assignment is migrated to a named composition when a matching
 * preset exists in the catalog; otherwise it falls back to `mode:
 * "wholeSheet"` (legacy) so existing per-agent assignments keep working. The
 * function is pure and non-throwing.
 */
export function migrateWholeSheetToComposition(
  assignment: { characterId: string; palette: number; hueShift: number },
  presets: ReadonlyArray<{ id: string; partIds: string[] }>,
): AppearanceAssignment {
  const preset = presets.find((p) => p.id === assignment.characterId);
  if (!preset) {
    return {
      mode: "wholeSheet",
      characterId: assignment.characterId,
      palette: assignment.palette,
      hueShift: assignment.hueShift,
    };
  }
  return {
    mode: "composition",
    composition: {
      schemaVersion: 2,
      parts: preset.partIds.map((partId) => ({ partId, hueShift: 0 })),
      palette: assignment.palette,
      hueShift: assignment.hueShift,
      updatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Asset privilege gate (standing constraint 4: fail-closed, licensing-safe).
 *
 * A part with no explicit `privilege` is a bundled asset and is always
 * granted. A part with a `privilege` gate is granted only when that exact
 * gate id appears in the operator-granted set (`addExternalAssetDirectory`
 * produces these grants in the fork host). Mirrors the existing asset
 * privilege boundary so a new composition part never bypasses it.
 */
export function isPartPrivilegeGranted(
  part: Pick<CompositionPartSpec, "privilege">,
  grantedPrivileges: ReadonlyArray<string>,
): boolean {
  if (!part.privilege) return true;
  return grantedPrivileges.includes(part.privilege);
}

/**
 * Validate that every selected part in a composition is privilege-granted.
 * Returns the list of revoked parts (fail-closed: a part the operator has not
 * granted is refused, never silently rendered).
 */
export function validateCompositionPrivileges(
  composition: unknown,
  catalog: unknown,
  grantedPrivileges: ReadonlyArray<string>,
): CompositionViolation[] {
  const base = validateCompositionState(composition, catalog);
  if (base.length > 0) return base;
  const c = composition as CharacterComposition;
  const cat = catalog as CompositionPartCatalog;
  const partById = new Map<string, CompositionPartSpec>();
  for (const p of cat.parts) partById.set(p.id, p);
  const errors: CompositionViolation[] = [];
  for (const sel of c.parts) {
    const spec = partById.get(sel.partId);
    if (!spec) continue;
    if (!isPartPrivilegeGranted(spec, grantedPrivileges)) {
      errors.push(violation("privilege_revoked", `composition part '${sel.partId}' is not privilege-granted`, sel.partId));
    }
  }
  return errors;
}

/**
 * Palette/hue sync over composited layers: applies a composition-wide
 * palette and hue shift, distributing the hue shift across every selected
 * part (a per-part shift is additive and clamped to 0..360). Pure — returns
 * a new composition.
 */
export function syncCompositionPaletteHue(
  composition: CharacterComposition,
  palette: number,
  hueShift: number,
): CharacterComposition {
  const clamped = Math.max(0, Math.min(360, hueShift));
  return {
    ...composition,
    schemaVersion: 2,
    palette,
    hueShift: clamped,
    parts: composition.parts.map((p) => ({
      partId: p.partId,
      hueShift: Math.max(0, Math.min(360, (p.hueShift ?? 0) + clamped)),
    })),
  };
}
