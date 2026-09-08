import { describe, expect, it } from "vitest";

import {
  buildAgentAppearanceAssignmentV2,
  buildCharacterComposition,
  buildCompositionPartCatalog,
  buildCompositionPartSpec,
} from "../fixtures.js";
import {
  AgentAppearanceAssignmentV2Schema,
  AppearanceAssignmentSchema,
  CharacterCompositionSchema,
  CompositionPartCatalogSchema,
  CompositionAssignmentSchema,
  WholeSheetAssignmentSchema,
  RENDER_DIRECTIONS,
  migrateWholeSheetToComposition,
  syncCompositionPaletteHue,
  validateAppearanceAssignmentV2,
  validateCompositionCatalog,
  validateCompositionPrivileges,
  validateCompositionState,
  isPartPrivilegeGranted,
} from "../composition.js";
import { COMPOSITION_SCHEMA_VERSION } from "../version.js";

describe("composition part catalog", () => {
  it("accepts a valid part catalog fixture", () => {
    const catalog = buildCompositionPartCatalog();
    expect(CompositionPartCatalogSchema.safeParse(catalog).success).toBe(true);
    expect(validateCompositionCatalog(catalog)).toEqual([]);
  });

  it("rejects an unsupported catalog schemaVersion", () => {
    const catalog = buildCompositionPartCatalog();
    const errors = validateCompositionCatalog({ ...catalog, schemaVersion: 1 });
    expect(errors.some((e) => e.code === "unsupported_version")).toBe(true);
  });

  it("rejects a catalog with no parts", () => {
    expect(validateCompositionCatalog({ schemaVersion: 2, parts: [] }).some((e) => e.code === "empty_parts")).toBe(true);
  });

  it("rejects a duplicate part id", () => {
    const catalog = buildCompositionPartCatalog(2);
    const errors = validateCompositionCatalog({ ...catalog, parts: [catalog.parts[0], catalog.parts[0]] });
    expect(errors.some((e) => e.code === "duplicate_id")).toBe(true);
  });

  it("rejects a duplicate layer index", () => {
    const catalog = buildCompositionPartCatalog(2);
    const errors = validateCompositionCatalog({
      ...catalog,
      parts: [catalog.parts[0], { ...catalog.parts[1], id: "part-x", layer: catalog.parts[0].layer }],
    });
    expect(errors.some((e) => e.code === "duplicate_layer")).toBe(true);
  });

  it("rejects a part that omits source/license provenance", () => {
    const part = buildCompositionPartSpec({ source: "", license: "" }) as unknown as Record<string, unknown>;
    const catalog = buildCompositionPartCatalog(1);
    const errors = validateCompositionCatalog({ ...catalog, parts: [{ ...catalog.parts[0], ...part }] });
    expect(errors.some((e) => e.code === "missing_provenance")).toBe(true);
  });

  it("rejects a malformed directional variant", () => {
    const catalog = buildCompositionPartCatalog(1);
    const errors = validateCompositionCatalog({
      ...catalog,
      parts: [{ ...catalog.parts[0], variants: [{ direction: "north", file: "x.png" }] }],
    });
    expect(errors.some((e) => e.code === "bad_variant")).toBe(true);
  });

  it("rejects a duplicated directional variant", () => {
    const catalog = buildCompositionPartCatalog(1);
    const errors = validateCompositionCatalog({
      ...catalog,
      parts: [
        {
          ...catalog.parts[0],
          variants: [
            { direction: "down", file: "a.png" },
            { direction: "down", file: "b.png" },
          ],
        },
      ],
    });
    expect(errors.some((e) => e.code === "duplicate_direction")).toBe(true);
  });

  it("accepts an unknown-kind part? no — rejects unknown kind", () => {
    const catalog = buildCompositionPartCatalog(1);
    const errors = validateCompositionCatalog({
      ...catalog,
      parts: [{ ...catalog.parts[0], kind: "hat" }],
    });
    expect(errors.some((e) => e.code === "bad_kind")).toBe(true);
  });

  it("carries only the renderer directions down/up/right", () => {
    expect(RENDER_DIRECTIONS).toEqual(["down", "up", "right"]);
  });
});

describe("composition state validation", () => {
  it("accepts a valid composition against its catalog", () => {
    const catalog = buildCompositionPartCatalog();
    const composition = buildCharacterComposition({ parts: [{ partId: "part-0", hueShift: 0 }] });
    expect(CharacterCompositionSchema.safeParse(composition).success).toBe(true);
    expect(validateCompositionState(composition, catalog)).toEqual([]);
  });

  it("rejects an unknown part id", () => {
    const catalog = buildCompositionPartCatalog();
    const composition = buildCharacterComposition({ parts: [{ partId: "missing-part" }] });
    const errors = validateCompositionState(composition, catalog);
    expect(errors.some((e) => e.code === "unknown_part")).toBe(true);
  });

  it("rejects more than one single-kind part", () => {
    const catalog = {
      schemaVersion: 2,
      parts: [
        buildCompositionPartSpec({ id: "part-0", kind: "clothing", layer: 0 }),
        buildCompositionPartSpec({ id: "part-1", kind: "clothing", layer: 1 }),
      ],
    };
    const composition = buildCharacterComposition({
      parts: [{ partId: "part-0", hueShift: 0 }, { partId: "part-1", hueShift: 0 }],
    });
    const errors = validateCompositionState(composition, catalog);
    expect(errors.some((e) => e.code === "duplicate_kind")).toBe(true);
  });

  it("rejects a duplicate part selection", () => {
    const catalog = buildCompositionPartCatalog();
    const composition = buildCharacterComposition({
      parts: [{ partId: "part-0", hueShift: 0 }, { partId: "part-0", hueShift: 0 }],
    });
    const errors = validateCompositionState(composition, catalog);
    expect(errors.some((e) => e.code === "duplicate_part")).toBe(true);
  });

  it("rejects an out-of-range composition hueShift", () => {
    const catalog = buildCompositionPartCatalog();
    const composition = buildCharacterComposition({ hueShift: 361 });
    const errors = validateCompositionState(composition, catalog);
    expect(errors.some((e) => e.code === "invalid_hue")).toBe(true);
  });

  it("rejects a composition against an invalid catalog", () => {
    const composition = buildCharacterComposition();
    const errors = validateCompositionState(composition, { schemaVersion: 2, parts: [] });
    expect(errors.some((e) => e.code === "empty_parts")).toBe(true);
  });
});

describe("appearance DTO v2 compatibility", () => {
  it("accepts a whole-sheet (v1) assignment inside the v2 envelope", () => {
    const v2 = buildAgentAppearanceAssignmentV2({
      appearance: { mode: "wholeSheet", characterId: "pixel-agents:char-0", palette: 0, hueShift: 0 },
    });
    expect(AgentAppearanceAssignmentV2Schema.safeParse(v2).success).toBe(true);
    expect(WholeSheetAssignmentSchema.safeParse(v2.appearance).success).toBe(true);
  });

  it("accepts a composition-mode assignment inside the v2 envelope", () => {
    const v2 = buildAgentAppearanceAssignmentV2();
    expect(AgentAppearanceAssignmentV2Schema.safeParse(v2).success).toBe(true);
    expect(CompositionAssignmentSchema.safeParse(v2.appearance).success).toBe(true);
  });

  it("rejects an unknown appearance mode", () => {
    const v2 = buildAgentAppearanceAssignmentV2();
    // @ts-expect-error deliberate invalid mode
    expect(AppearanceAssignmentSchema.safeParse({ ...v2.appearance, mode: "sprites" }).success).toBe(false);
  });

  it("validates a whole-sheet payload without needing a catalog", () => {
    expect(validateAppearanceAssignmentV2({ appearance: { mode: "wholeSheet", characterId: "c", palette: 0, hueShift: 0 } })).toEqual([]);
  });

  it("validates a composition payload only against a catalog", () => {
    const catalog = buildCompositionPartCatalog();
    const v2 = buildAgentAppearanceAssignmentV2();
    expect(validateAppearanceAssignmentV2(v2, catalog)).toEqual([]);
  });

  it("rejects a composition payload with no catalog (fail-closed)", () => {
    const v2 = buildAgentAppearanceAssignmentV2();
    expect(validateAppearanceAssignmentV2(v2, undefined).length).toBeGreaterThan(0);
  });

  it("exposes the composition schema version", () => {
    expect(COMPOSITION_SCHEMA_VERSION).toBe(2);
  });
});

describe("whole-sheet → composition migration", () => {
  const presets = [{ id: "preset:studio", partIds: ["part-0", "part-1"] }];

  it("maps a whole sheet to a matching composition preset", () => {
    const migrated = migrateWholeSheetToComposition(
      { characterId: "preset:studio", palette: 2, hueShift: 10 },
      presets,
    );
    expect(migrated.mode).toBe("composition");
    if (migrated.mode === "composition") {
      expect(migrated.composition.parts.map((p) => p.partId)).toEqual(["part-0", "part-1"]);
      expect(migrated.composition.palette).toBe(2);
      expect(migrated.composition.hueShift).toBe(10);
    }
  });

  it("falls back to legacy whole-sheet mode when no preset matches", () => {
    const migrated = migrateWholeSheetToComposition(
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: 0 },
      presets,
    );
    expect(migrated.mode).toBe("wholeSheet");
  });
});

describe("palette/hue sync over composited layers", () => {
  it("distributes the composition hue shift across every selected part", () => {
    const composition = buildCharacterComposition({
      parts: [
        { partId: "part-0", hueShift: 0 },
        { partId: "part-1", hueShift: 5 },
      ],
      palette: 1,
      hueShift: 3,
    });
    const synced = syncCompositionPaletteHue(composition, 2, 12);
    expect(synced.palette).toBe(2);
    expect(synced.hueShift).toBe(12);
    expect(synced.parts[0].hueShift).toBe(12);
    expect(synced.parts[1].hueShift).toBe(17);
  });

  it("clamps the composition-wide hue shift to 0..360", () => {
    const composition = buildCharacterComposition();
    const synced = syncCompositionPaletteHue(composition, 0, 400);
    expect(synced.hueShift).toBe(360);
    expect(synced.parts[0].hueShift).toBe(360);
  });

  it("is pure (does not mutate the input)", () => {
    const composition = buildCharacterComposition();
    syncCompositionPaletteHue(composition, 5, 50);
    expect(composition.palette).toBe(0);
    expect(composition.hueShift).toBe(0);
  });
});

describe("asset privilege gate", () => {
  it("treats a bundled part (no privilege) as always granted", () => {
    expect(isPartPrivilegeGranted({}, [])).toBe(true);
  });

  it("grants a gated part only when its privilege is in the granted set", () => {
    expect(isPartPrivilegeGranted({ privilege: "granted:assets/office" }, ["granted:assets/office"])).toBe(true);
    expect(isPartPrivilegeGranted({ privilege: "granted:assets/office" }, ["granted:assets/characters"])).toBe(false);
  });

  it("fails closed on a revoked composition part", () => {
    const catalog = {
      schemaVersion: 2,
      parts: [
        buildCompositionPartSpec({ id: "part-0", kind: "clothing", layer: 0, privilege: "granted:assets/office" }),
      ],
    };
    const composition = buildCharacterComposition({ parts: [{ partId: "part-0", hueShift: 0 }] });
    expect(validateCompositionPrivileges(composition, catalog, ["granted:assets/characters"]).some((e) => e.code === "privilege_revoked")).toBe(true);
    expect(validateCompositionPrivileges(composition, catalog, ["granted:assets/office"])).toEqual([]);
  });
});
