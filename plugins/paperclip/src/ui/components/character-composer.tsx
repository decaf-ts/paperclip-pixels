/**
 * Per-agent character composer (spec PAPERCLIP_PIXELS-2, R3-WS5b).
 *
 * Builds on the R3-WS5a composition model: per-layer pickers (face, hair,
 * skin, clothing, accessory) with a live composited preview (layered, all the
 * directional variants the fork renderer knows), palette/hue control over the
 * composited layers, and a migration path that turns a legacy whole-sheet
 * assignment into a composed appearance without dropping the agent's palette
 * and hue shift.
 *
 * Boundary (board Revision 3): this UI owns the Paperclip-plugin side of
 * character selection — preference + persistence through the existing
 * assignment surface. Rendering and asset validation stay the Pixel Agents
 * plugin's job; the preview here is an approximation, exactly like the
 * whole-sheet picker's. Save flows through the `agent.set-pixel-composition`
 * bridge action using the canonical byte-exact v2 appearance payload.
 */

import { useCallback, useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  BRIDGE_ACTION_KEYS,
  type BridgeAgentView,
  type CompositionPartChoice,
  type VisualSettingsData,
} from "../bridge-contract";
import {
  COMPOSITION_LAYER_ORDER,
  COMPOSITION_SCHEMA_VERSION,
  type CharacterComposition,
  type CompositionPartKind,
  type AppearanceAssignment,
} from "@decaf-ts/paperclip-pixels-common";

/** Editable working composition for one agent, not yet persisted. */
interface WorkingComposition {
  parts: Array<{ partId: string; hueShift: number }>;
  palette: number;
  hueShift: number;
}

/** A v2 appearance record per agent (whole-sheet or composition). */
type AgentAppearanceRecord = {
  agentId: string;
  appearance: AppearanceAssignment;
  updatedAt: string;
};

const EMPTY_COMPOSITION: WorkingComposition = {
  parts: [],
  palette: 0,
  hueShift: 0,
};

function emptyComposition(): WorkingComposition {
  return { parts: [], palette: 0, hueShift: 0 };
}

/** Clamp a raw hue input to the domain contract's integer range [0, 360]. */
function clampHue(raw: number): number {
  return Math.min(360, Math.max(0, Math.trunc(raw)));
}

/** Clamp a palette index to the non-negative integer domain. */
function clampPalette(raw: number): number {
  return Math.max(0, Math.trunc(raw));
}

/** Group catalog parts by kind (one array per composition part kind). */
function groupByKind(parts: CompositionPartChoice[]): Partial<Record<CompositionPartKind, CompositionPartChoice[]>> {
  const grouped: Partial<Record<CompositionPartKind, CompositionPartChoice[]>> = {};
  for (const part of parts) {
    (grouped[part.kind] ??= []).push(part);
  }
  return grouped;
}

/** The selected part id for a kind in a working composition (one per kind). */
function selectedPartIdFor(composition: WorkingComposition, kind: CompositionPartKind, partsByKind: Partial<Record<CompositionPartKind, CompositionPartChoice[]>>): string {
  for (const sel of composition.parts) {
    const spec = partsByKind[kind]?.find((p) => p.id === sel.partId);
    if (spec) return sel.partId;
  }
  return "";
}

/** Resolve a working composition's selected part specs in back-to-front layer order. */
function orderedLayers(composition: WorkingComposition, parts: CompositionPartChoice[]): CompositionPartChoice[] {
  const byId = new Map(parts.map((p) => [p.id, p]));
  const selected = composition.parts
    .map((sel) => byId.get(sel.partId))
    .filter((p): p is CompositionPartChoice => p !== undefined);
  return selected.sort((a, b) => a.layer - b.layer);
}

/** True when the working composition differs from a persisted record. */
function isDirty(composition: WorkingComposition, record: AgentAppearanceRecord | undefined): boolean {
  if (!record) return composition.parts.length > 0;
  if (record.appearance.mode !== "composition") return true;
  const persisted = record.appearance.composition;
  const sameParts =
    persisted.parts.length === composition.parts.length &&
    persisted.parts.every((p, i) => composition.parts[i]?.partId === p.partId && (composition.parts[i]?.hueShift ?? 0) === (p.hueShift ?? 0));
  return !sameParts || persisted.palette !== composition.palette || persisted.hueShift !== composition.hueShift;
}

/** Build a default composition from a legacy whole-sheet assignment, preserving
 *  palette and hue shift (data-loss-free migration). */
function compositionFromWholeSheet(
  assignment: { characterId: string; palette: number; hueShift: number },
  parts: CompositionPartChoice[],
): WorkingComposition {
  const byKind = groupByKind(parts);
  const pick = (kind: CompositionPartKind): string => byKind[kind]?.[0]?.id ?? "";
  const paletteIndex = assignment.palette;
  const pickCyclic = (kind: CompositionPartKind): string => {
    const options = byKind[kind];
    return options?.[paletteIndex % options.length]?.id ?? "";
  };
  return {
    parts: [
      { partId: pick("skin"), hueShift: 0 },
      { partId: pickCyclic("clothing"), hueShift: 0 },
      { partId: pick("hair"), hueShift: 0 },
      { partId: pick("face"), hueShift: 0 },
    ]
      .filter((p) => p.partId.length > 0)
      .concat(pick("accessory") ? [{ partId: pick("accessory"), hueShift: 0 }] : []),
    palette: paletteIndex,
    hueShift: assignment.hueShift,
  };
}

/** The subset of the `agent.set-pixel-composition` result consumed here. */
interface SetCompositionResponse {
  ok?: boolean;
  error?: string;
  violations?: unknown[];
}

export interface AgentCharacterComposerProps {
  companyId: string;
  agents: BridgeAgentView[];
  visual: VisualSettingsData | null;
  visualLoading: boolean;
  visualError?: string | null;
  disabled?: boolean;
  onSaved?: () => void;
}

/**
 * Per-agent character composer section. Derives the composition part catalog
 * and per-agent v2 appearance map from the visual-settings payload, tracks one
 * working composition per agent, and saves through the bridge action. Renders
 * a loading / error / not-configured placeholder when the catalog is
 * unavailable.
 */
export function AgentCharacterComposer({
  companyId,
  agents,
  visual,
  visualLoading,
  visualError = null,
  disabled = false,
  onSaved,
}: AgentCharacterComposerProps) {
  const parts = useMemo(() => visual?.compositionParts ?? [], [visual]);
  const compositions = useMemo(() => visual?.compositions ?? {}, [visual]);

  const [workingAgentId, setWorkingAgentId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WorkingComposition>>({});
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveComposition = usePluginAction(BRIDGE_ACTION_KEYS.setAgentComposition);

  const selectedAgent = agents.find((agent) => agent.projection.agentId === workingAgentId) ?? agents[0];
  const selectedAgentId = selectedAgent?.projection.agentId ?? null;

  const record: AgentAppearanceRecord | undefined = selectedAgentId ? compositions[selectedAgentId] : undefined;
  const base = useMemo<WorkingComposition>(() => {
    if (!selectedAgentId) return EMPTY_COMPOSITION;
    const r = compositions[selectedAgentId];
    if (r?.appearance.mode === "composition") {
      const c = r.appearance.composition;
      return { parts: c.parts.map((p) => ({ partId: p.partId, hueShift: p.hueShift ?? 0 })), palette: c.palette, hueShift: c.hueShift };
    }
    return EMPTY_COMPOSITION;
  }, [selectedAgentId, compositions]);

  const draft = selectedAgentId ? drafts[selectedAgentId] : undefined;
  const current = draft ?? base;
  const dirty = draft !== undefined && isDirty(draft, record);
  const saving = savingAgentId !== null;

  const partsByKind = useMemo(() => groupByKind(parts), [parts]);

  const setDraft = useCallback(
    (next: (existing: WorkingComposition) => WorkingComposition) => {
      if (!selectedAgentId) return;
      setDrafts((prev) => {
        const existing = prev[selectedAgentId] ?? base;
        return { ...prev, [selectedAgentId]: next(existing) };
      });
    },
    [selectedAgentId, base],
  );

  const selectPart = useCallback(
    (kind: CompositionPartKind, partId: string) => {
      setDraft((existing) => {
        const retained = existing.parts.filter((sel) => {
          const spec = partsByKind[kind]?.find((p) => p.id === sel.partId);
          return !spec;
        });
        return { ...existing, parts: [...retained, { partId, hueShift: 0 }] };
      });
    },
    [setDraft, partsByKind],
  );

  const applyHue = useCallback((raw: number) => {
    setDraft((existing) => ({ ...existing, hueShift: clampHue(raw) }));
  }, [setDraft]);

  const applyPalette = useCallback((raw: number) => {
    setDraft((existing) => ({ ...existing, palette: clampPalette(raw) }));
  }, [setDraft]);

  const applyPartHue = useCallback((partId: string, raw: number) => {
    const hue = clampHue(raw);
    setDraft((existing) => ({
      ...existing,
      parts: existing.parts.map((sel) => (sel.partId === partId ? { ...sel, hueShift: hue } : sel)),
    }));
  }, [setDraft]);

  const migrateFromWholeSheet = useCallback(() => {
    if (!selectedAgentId) return;
    const legacyAssignment = visual?.assignments?.[selectedAgentId];
    if (!legacyAssignment) {
      setDraft(() => ({ ...emptyComposition() }));
      return;
    }
    const seeded = compositionFromWholeSheet(legacyAssignment, parts);
    setDraft(() => seeded);
  }, [selectedAgentId, visual, parts, setDraft]);

  const discardDraft = useCallback(() => {
    if (!selectedAgentId) return;
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[selectedAgentId];
      return next;
    });
  }, [selectedAgentId]);

  const handleSave = useCallback(async () => {
    if (!selectedAgent || !selectedAgentId) return;
    if (saving || disabled) return;
    if (current.parts.length === 0) return;
    setSavingAgentId(selectedAgentId);
    setSavedNote(null);
    setSaveError(null);
    const composition: CharacterComposition = {
      schemaVersion: COMPOSITION_SCHEMA_VERSION,
      parts: current.parts.map((sel) => ({ partId: sel.partId, hueShift: sel.hueShift })),
      palette: current.palette,
      hueShift: current.hueShift,
      updatedAt: new Date().toISOString(),
    };
    try {
      const result = (await saveComposition({
        companyId,
        agentId: selectedAgentId,
        appearance: { mode: "composition", composition },
      })) as SetCompositionResponse | undefined;
      if (result && result.ok === false) {
        setSaveError(result.error ?? "COMPOSITION_SAVE_FAILED");
        return;
      }
      discardDraft();
      setSavedNote(
        `Saved a composed appearance for ${selectedAgent.projection.name} (${current.parts.length} layer${current.parts.length === 1 ? "" : "s"}, palette ${current.palette}, hue ${current.hueShift}°).`,
      );
      onSaved?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAgentId(null);
    }
  }, [selectedAgent, selectedAgentId, current, saving, disabled, saveComposition, companyId, discardDraft, onSaved]);

  if (visualLoading) {
    return (
      <section data-testid="character-composer" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Character composer</h2>
        <div data-testid="character-composer-loading">Loading composition catalog…</div>
      </section>
    );
  }
  if (visualError) {
    return (
      <section data-testid="character-composer" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Character composer</h2>
        <div role="alert" data-testid="character-composer-error">
          Composition unavailable: {visualError}
        </div>
      </section>
    );
  }
  if (!visual?.configured) {
    return (
      <section data-testid="character-composer" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Character composer</h2>
        <div data-testid="character-composer-not-configured">
          Configure the Pixel Agents relay to compose characters.
        </div>
      </section>
    );
  }
  if (parts.length === 0) {
    return (
      <section data-testid="character-composer" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Character composer</h2>
        <div data-testid="character-composer-empty-catalog">
          No composition parts available.
        </div>
      </section>
    );
  }

  const agentOptions = agents.map((agent) => {
    const agentId = agent.projection.agentId;
    const r = compositions[agentId];
    const mode = r?.appearance.mode ?? null;
    return {
      agentId,
      name: agent.projection.name,
      mode,
    };
  });

  const isLegacy = record?.appearance.mode === "wholeSheet";
  const legacyName = isLegacy
    ? (visual?.characters.find((c) => c.id === (record!.appearance as { characterId: string }).characterId)?.name ?? "whole sheet")
    : null;

  const layers = orderedLayers(current, parts);
  const selectedCount = current.parts.length;

  return (
    <section data-testid="character-composer" style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>Character composer</h2>
        <div style={{ opacity: 0.72, fontSize: 13 }}>
          Compose an appearance by stacking face, hair, skin, clothing and
          accessory layers. Save persists the composition in plugin state.
        </div>
      </div>

      {agents.length === 0 ? (
        <div data-testid="character-composer-empty" style={{ opacity: 0.7 }}>
          No agents observed.
        </div>
      ) : null}

      {selectedAgent && selectedAgentId ? (
        <div style={{ display: "grid", gap: 12 }}>
          <fieldset
            data-testid="character-composer-agent-selection"
            style={{ border: "1px solid #9994", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}
          >
            <legend>Pick an agent</legend>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {agentOptions.map((option) => {
                const isWorking = option.agentId === selectedAgentId;
                return (
                  <button
                    key={option.agentId}
                    type="button"
                    data-testid="character-composer-agent-option"
                    data-agent-id={option.agentId}
                    aria-pressed={isWorking}
                    disabled={saving}
                    onClick={() => setWorkingAgentId(option.agentId)}
                    style={{
                      display: "grid",
                      gap: 2,
                      padding: "6px 10px",
                      borderRadius: 8,
                      border: isWorking ? "2px solid #4f7cff" : "1px solid #9995",
                      background: isWorking ? "#4f7cff18" : "transparent",
                      cursor: "pointer",
                    }}
                  >
                    <strong>{option.name}</strong>
                    <span style={{ opacity: 0.75, fontSize: "0.85em" }}>
                      {option.mode === "composition"
                        ? "composed"
                        : option.mode === "wholeSheet"
                          ? "whole sheet"
                          : "not yet assigned"}
                    </span>
                  </button>
                );
              })}
            </div>
          </fieldset>

          {isLegacy ? (
            <div
              data-testid="character-composer-legacy-banner"
              style={{ border: "1px solid #8a6d00", borderRadius: 8, padding: 8, background: "#fff8e1", display: "grid", gap: 8 }}
            >
              <span>
                {selectedAgent.projection.name} currently uses the whole sheet{" "}
                {legacyName ?? ""}. You can keep it, or convert it to a composed
                appearance (palette and hue shift carry over).
              </span>
              <button
                type="button"
                data-testid="character-composer-convert"
                disabled={saving}
                onClick={migrateFromWholeSheet}
              >
                Convert to composer
              </button>
            </div>
          ) : null}

          <div style={{ display: "grid", gap: 12 }}>
            {COMPOSITION_LAYER_ORDER.filter((kind) => partsByKind[kind]).map((kind) => (
              <FieldsetRow
                key={kind}
                kind={kind}
                options={partsByKind[kind] ?? []}
                selectedId={selectedPartIdFor(current, kind, partsByKind)}
                hueShift={current.parts.find((sel) => {
                  const spec = partsByKind[kind]?.find((p) => p.id === sel.partId);
                  return spec;
                })?.hueShift ?? 0}
                disabled={saving}
                onSelect={(partId) => selectPart(kind, partId)}
                onHue={(partId, raw) => applyPartHue(partId, raw)}
              />
            ))}
          </div>

          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <figure
              data-testid="character-composer-preview"
              style={{ margin: 0, display: "grid", gap: 4, justifyItems: "start" }}
            >
              <div
                data-testid="character-composer-preview-stage"
                style={{ position: "relative", width: 96, height: 128, border: "1px solid #9994", borderRadius: 8, overflow: "hidden", background: "#10131a", imageRendering: "pixelated" }}
              >
                {layers.map((part) => (
                  <img
                    key={part.id}
                    src={part.previewDataUrl}
                    alt=""
                    style={{
                      position: "absolute",
                      inset: 0,
                      width: "100%",
                      height: "100%",
                      objectFit: "contain",
                      imageRendering: "pixelated",
                      filter: `hue-rotate(${current.hueShift}deg)`,
                    }}
                  />
                ))}
                {layers.length === 0 ? (
                  <span style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", color: "#ffffff66", fontSize: 12 }}>
                    No layers
                  </span>
                ) : null}
              </div>
              <figcaption data-testid="character-composer-preview-caption" style={{ opacity: 0.78, fontSize: 13 }}>
                Composed preview: {selectedCount} layer{selectedCount === 1 ? "" : "s"} · palette {current.palette} · hue {current.hueShift}°
              </figcaption>
            </figure>

            <div style={{ display: "grid", gap: 8, alignContent: "start" }}>
              <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
                Palette
                <input
                  type="number"
                  data-testid="character-composer-palette"
                  min={0}
                  step={1}
                  value={current.palette}
                  disabled={saving}
                  onChange={(e) => applyPalette(Number(e.target.value))}
                  style={{ width: 84 }}
                />
              </label>
              <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
                Hue shift
                <input
                  type="range"
                  data-testid="character-composer-hue"
                  min={0}
                  max={360}
                  step={1}
                  value={current.hueShift}
                  disabled={saving}
                  onChange={(e) => applyHue(Number(e.target.value))}
                  style={{ width: 260 }}
                />
              </label>
              <output data-testid="character-composer-hue-value" style={{ minWidth: 64, fontWeight: 600 }}>
                {current.hueShift}°
              </output>
              {disabled ? (
                <span data-testid="character-composer-paused" style={{ opacity: 0.75, fontSize: 13 }}>
                  Paused while reconnecting — save is unavailable until the bridge reconnects.
                </span>
              ) : null}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
            <button
              type="button"
              data-testid="character-composer-save"
              disabled={saving || disabled || !dirty || selectedCount === 0}
              onClick={() => handleSave()}
            >
              Save composed appearance for {selectedAgent.projection.name}
            </button>
            {dirty && !saving ? (
              <span data-testid="character-composer-dirty-hint" style={{ opacity: 0.9, fontSize: 12, fontWeight: 600 }}>
                Unsaved changes
              </span>
            ) : null}
          </div>

          {savedNote ? (
            <div role="status" data-testid="character-composer-message">
              {savedNote}
            </div>
          ) : null}
          {saveError ? (
            <div role="alert" data-testid="character-composer-save-error">
              {saveError}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

/** Look up the currently selected part specs (helper for the preview). */
function FieldsetRow({
  kind,
  options,
  selectedId,
  hueShift,
  disabled,
  onSelect,
  onHue,
}: {
  kind: CompositionPartKind;
  options: CompositionPartChoice[];
  selectedId: string;
  hueShift: number;
  disabled: boolean;
  onSelect: (partId: string) => void;
  onHue: (partId: string, raw: number) => void;
}) {
  return (
    <fieldset
      data-testid={`character-composer-${kind}`}
      style={{ border: "1px solid #9994", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}
    >
      <legend style={{ textTransform: "capitalize" }}>{kind}</legend>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {options.map((option) => {
          const active = option.id === selectedId;
          return (
            <button
              key={option.id}
              type="button"
              data-testid={`character-composer-${kind}-option`}
              data-part-id={option.id}
              aria-pressed={active}
              disabled={disabled}
              title={`${option.name} — ${option.source}, ${option.license}`}
              onClick={() => onSelect(option.id)}
              style={{
                display: "grid",
                gap: 4,
                padding: 6,
                borderRadius: 8,
                border: active ? "2px solid #4f7cff" : "1px solid #9995",
                background: active ? "#4f7cff18" : "transparent",
                cursor: "pointer",
              }}
            >
              <img src={option.previewDataUrl} alt="" width={72} height={96} style={{ imageRendering: "pixelated", objectFit: "contain" }} />
              <span>{option.name}</span>
            </button>
          );
        })}
      </div>
      {hueShift > 0 ? (
        <label style={{ display: "grid", gap: 2, fontSize: 12 }}>
          Layer hue
          <input
            type="number"
            data-testid={`character-composer-${kind}-hue`}
            min={0}
            max={360}
            step={1}
            value={hueShift}
            disabled={disabled}
            onChange={(e) => onHue(selectedId, Number(e.target.value))}
            style={{ width: 84 }}
          />
        </label>
      ) : null}
    </fieldset>
  );
}
