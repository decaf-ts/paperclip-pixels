/**
 * Per-agent character picker (spec PAPERCLIP_PIXELS-2, WS3, FR-13).
 *
 * Replaces the retired immediate-write `CharacterSelector`: each agent keeps
 * its own working draft (character sheet + hue shift) while editing, dirty
 * state compares a draft only against that same agent's persisted
 * assignment, and Save flows through the `agent.set-pixel-appearance`
 * bridge action. Plugin `ctx.state` is the single source of truth and the
 * relay applier is best-effort — an `applied: false` save still persisted
 * and re-applies on the next sync, which the saved note explains to the
 * user. State-changing actions pause while the bridge is stale (§30.1).
 */

import { useCallback, useMemo, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import {
  BRIDGE_ACTION_KEYS,
  type BridgeAgentView,
  type PixelAgentCharacterAssignment,
  type PixelCharacterChoice,
  type VisualSettingsData,
} from "../bridge-contract";
import { formatTimestamp } from "../format";

/** Editable draft for one agent: chosen sheet + hue shift, not yet persisted. */
interface WorkingSelection {
  characterId: string;
  hueShift: number;
}

/** Draft for an agent with nothing selected yet (empty id = no character). */
const EMPTY_SELECTION: WorkingSelection = { characterId: "", hueShift: 0 };

/**
 * Build the working draft from an agent's persisted assignment, falling back
 * to the empty selection when the agent has none (a fresh default is only
 * materialized worker-side; the UI just shows "not yet assigned").
 */
function selectionFromAssignment(
  agentId: string,
  assignments: Record<string, PixelAgentCharacterAssignment>,
): WorkingSelection {
  const persisted = assignments[agentId];
  if (!persisted) return { ...EMPTY_SELECTION };
  return { characterId: persisted.characterId, hueShift: persisted.hueShift };
}

/** Find a catalog character by id. */
function findCharacter(
  characters: PixelCharacterChoice[],
  characterId: string,
): PixelCharacterChoice | undefined {
  return characters.find((character) => character.id === characterId);
}

/** Clamp a raw hue input to the domain contract's integer range [0, 360]. */
function clampHueShift(raw: number): number {
  return Math.min(360, Math.max(0, Math.trunc(raw)));
}

/** The subset of the `agent.set-pixel-appearance` result the picker consumes. */
interface SetAppearanceResult {
  ok?: boolean;
  error?: string;
  applied?: boolean;
}

export interface AgentCharacterPickerProps {
  /** Company whose agents are being edited. */
  companyId: string;
  /** Bridge agent views offered for selection. */
  agents: BridgeAgentView[];
  /** Latest visual-settings payload (catalog + persisted assignments), or null while unavailable. */
  visual: VisualSettingsData | null;
  /** True while the visual-settings data is loading. */
  visualLoading: boolean;
  /** Hook-level or payload-level relay error, resolved by the page owner. */
  visualError?: string | null;
  /** True while the bridge is stale — state-changing actions pause (§30.1). */
  disabled?: boolean;
  /** Called after a successful save; the page refreshes the visual-settings data. */
  onSaved?: () => void;
}

/**
 * Per-agent character editor section. Derives the catalog and assignment map
 * from the visual-settings payload, tracks one working draft per agent, and
 * saves through the bridge action. Renders a loading / error /
 * not-configured placeholder instead of the editor while visual settings are
 * unavailable.
 */
export function AgentCharacterPicker({
  companyId,
  agents,
  visual,
  visualLoading,
  visualError = null,
  disabled = false,
  onSaved,
}: AgentCharacterPickerProps) {
  const characters = useMemo(() => visual?.characters ?? [], [visual]);
  const assignments = useMemo(() => visual?.assignments ?? {}, [visual]);

  const [workingAgentId, setWorkingAgentId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, WorkingSelection>>({});
  const [savingAgentId, setSavingAgentId] = useState<string | null>(null);
  const [savedNote, setSavedNote] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  const saveAppearance = usePluginAction(BRIDGE_ACTION_KEYS.setAgentAppearance);

  const selectedAgent = agents.find(
    (agent) => agent.projection.agentId === workingAgentId,
  ) ?? agents[0];
  const selectedAgentId = selectedAgent?.projection.agentId ?? null;

  const base = selectedAgentId ? selectionFromAssignment(selectedAgentId, assignments) : EMPTY_SELECTION;
  const draft = selectedAgentId ? drafts[selectedAgentId] : undefined;
  const current = draft ?? base;
  const dirty =
    draft !== undefined
    && (draft.characterId !== base.characterId || draft.hueShift !== base.hueShift);
  const saving = savingAgentId !== null;

  const setDraftForAgent = useCallback(
    (agentId: string, next: (existing: WorkingSelection) => WorkingSelection) => {
      setDrafts((prev) => {
        const existing = prev[agentId] ?? selectionFromAssignment(agentId, assignments);
        return { ...prev, [agentId]: next(existing) };
      });
    },
    [assignments],
  );

  const selectCharacter = useCallback(
    (agentId: string, characterId: string) => {
      setDraftForAgent(agentId, (existing) => ({ ...existing, characterId }));
    },
    [setDraftForAgent],
  );

  const applyHueShift = useCallback(
    (agentId: string, raw: number) => {
      const hueShift = clampHueShift(raw);
      setDraftForAgent(agentId, (existing) => ({ ...existing, hueShift }));
    },
    [setDraftForAgent],
  );

  const discardDraft = useCallback((agentId: string) => {
    setDrafts((prev) => {
      const next = { ...prev };
      delete next[agentId];
      return next;
    });
  }, []);

  const handleSave = useCallback(async () => {
    if (!selectedAgent || !selectedAgentId) return;
    const entry = findCharacter(characters, current.characterId);
    const hueShift = clampHueShift(current.hueShift);
    if (!entry || saving || disabled) return;
    setSavingAgentId(selectedAgentId);
    setSavedNote(null);
    setSaveError(null);
    try {
      const result = (await saveAppearance({
        companyId,
        agentId: selectedAgentId,
        characterId: entry.id,
        palette: entry.palette,
        hueShift,
      })) as SetAppearanceResult | undefined;
      if (result && result.ok === false) {
        setSaveError(result.error ?? "APPEARANCE_SAVE_FAILED");
        return;
      }
      discardDraft(selectedAgentId);
      setSavedNote(
        result?.applied === false
          ? `${selectedAgent.projection.name} now uses ${entry.name} at hue ${hueShift}°. The relay push failed — the assignment re-applies on the next sync.`
          : `${selectedAgent.projection.name} now uses ${entry.name} at hue ${hueShift}°.`,
      );
      onSaved?.();
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingAgentId(null);
    }
  }, [
    selectedAgent,
    selectedAgentId,
    characters,
    current.characterId,
    current.hueShift,
    saving,
    disabled,
    saveAppearance,
    companyId,
    discardDraft,
    onSaved,
  ]);

  if (visualLoading) {
    return (
      <section data-testid="character-picker" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Per-agent characters</h2>
        <div data-testid="character-picker-loading">Loading character catalog…</div>
      </section>
    );
  }
  if (visualError) {
    return (
      <section data-testid="character-picker" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Per-agent characters</h2>
        <div role="alert" data-testid="character-picker-error">
          Pixel Agents relay unavailable: {visualError}
        </div>
      </section>
    );
  }
  if (!visual?.configured) {
    return (
      <section data-testid="character-picker" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Per-agent characters</h2>
        <div data-testid="character-picker-not-configured">
          Configure the Pixel Agents relay to assign characters.
        </div>
      </section>
    );
  }

  const previewCharacter = findCharacter(characters, current.characterId);

  const agentOptions = agents.map((agent) => {
    const agentId = agent.projection.agentId;
    const assignment = assignments[agentId];
    const assignedName = assignment
      ? findCharacter(characters, assignment.characterId)?.name ?? assignment.characterId
      : null;
    return {
      agentId,
      name: agent.projection.name,
      assignedName,
      hueShift: assignment?.hueShift ?? null,
    };
  });

  const persisted = selectedAgentId ? assignments[selectedAgentId] : undefined;
  const persistedName = persisted
    ? findCharacter(characters, persisted.characterId)?.name ?? persisted.characterId
    : null;

  return (
    <section data-testid="character-picker" style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>Per-agent characters</h2>
        <div style={{ opacity: 0.72, fontSize: 13 }}>
          Each agent keeps its own character sheet and hue shift. Save persists it
          in plugin state and applies it in the Pixel Agents office.
        </div>
      </div>

      {agents.length === 0 ? (
        <div data-testid="character-picker-empty" style={{ opacity: 0.7 }}>
          No agents observed.
        </div>
      ) : null}

      {selectedAgent && selectedAgentId ? (
        <CharacterEditor
          agentName={selectedAgent.projection.name}
          selectedAgentId={selectedAgentId}
          agentOptions={agentOptions}
          characters={characters}
          selection={current}
          hasValidSelection={previewCharacter !== undefined}
          dirty={dirty}
          saving={saving}
          paused={disabled}
          persistedName={persistedName}
          persistedHueShift={persisted?.hueShift ?? null}
          persistedUpdatedAt={persisted?.updatedAt ?? null}
          savedNote={savedNote}
          saveError={saveError}
          onPickAgent={setWorkingAgentId}
          onSelectCharacter={(characterId) => selectCharacter(selectedAgentId, characterId)}
          onHueShift={(raw) => applyHueShift(selectedAgentId, raw)}
          onSave={handleSave}
        />
      ) : null}
    </section>
  );
}

/** One agent in the picker's agent-selection row, annotated with its persisted assignment. */
interface AgentOption {
  agentId: string;
  name: string;
  /** Catalog name of the agent's persisted character, or the raw id if it left the catalog. */
  assignedName: string | null;
  /** Persisted hue shift in degrees, or null when the agent has no assignment. */
  hueShift: number | null;
}

/** Props for {@link CharacterEditor} (the presentational half of the picker). */
interface CharacterEditorProps {
  /** Display name of the agent being edited (legend / save button label). */
  agentName: string;
  /** Agent id of the current working selection. */
  selectedAgentId: string;
  /** All agents, for the agent-selection row. */
  agentOptions: AgentOption[];
  /** Full character catalog (with preview data URLs). */
  characters: PixelCharacterChoice[];
  /** The working draft for the selected agent. */
  selection: WorkingSelection;
  /** False when the draft's character id is not in the catalog (save stays disabled). */
  hasValidSelection: boolean;
  /** True when the draft differs from the selected agent's persisted assignment. */
  dirty: boolean;
  /** True while a save is in flight (disables all controls). */
  saving: boolean;
  /** True while the bridge is stale — save pauses (§30.1). */
  paused: boolean;
  /** Catalog name of the persisted character, or null when unassigned. */
  persistedName: string | null;
  /** Persisted hue shift in degrees, or null when unassigned. */
  persistedHueShift: number | null;
  /** ISO timestamp of the persisted assignment, or null when unassigned. */
  persistedUpdatedAt: string | null;
  /** Success note from the last save (explains best-effort relay pushes). */
  savedNote: string | null;
  /** Error from the last save attempt. */
  saveError: string | null;
  onPickAgent: (agentId: string) => void;
  onSelectCharacter: (characterId: string) => void;
  onHueShift: (raw: number) => void;
  onSave: () => void;
}

/**
 * Presentational editor for the selected agent: agent-selection buttons, the
 * character grid with live hue-rotated previews (an approximation — the
 * Pixel Agents office applies the exact rotation), hue-shift controls, the
 * save button, and the persisted-state line. All state lives in
 * {@link AgentCharacterPicker}; this component only renders and calls back.
 */
function CharacterEditor({
  agentName,
  selectedAgentId,
  agentOptions,
  characters,
  selection,
  hasValidSelection,
  dirty,
  saving,
  paused,
  persistedName,
  persistedHueShift,
  persistedUpdatedAt,
  savedNote,
  saveError,
  onPickAgent,
  onSelectCharacter,
  onHueShift,
  onSave,
}: CharacterEditorProps) {
  const previewCharacter = characters.find(
    (character) => character.id === selection.characterId,
  );
  const saveDisabled = saving || paused || !dirty || !hasValidSelection;
  const controlsDisabled = saving;

  return (
    <div style={{ display: "grid", gap: 12 }}>
      <fieldset
        data-testid="character-picker-agent-selection"
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
                data-testid="character-picker-agent-option"
                data-agent-id={option.agentId}
                aria-pressed={isWorking}
                disabled={saving}
                onClick={() => onPickAgent(option.agentId)}
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
                  {option.assignedName ?? "not yet assigned"}
                  {option.hueShift !== null ? ` · hue ${option.hueShift}°` : ""}
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <fieldset
        data-testid="character-picker-character-group"
        style={{ border: "1px solid #9994", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}
      >
        <legend>Character for {agentName}</legend>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          {characters.map((character) => {
            const active = selection.characterId === character.id;
            return (
              <button
                key={character.id}
                type="button"
                data-testid="character-option"
                data-character-id={character.id}
                aria-pressed={active}
                disabled={controlsDisabled}
                title={`${character.name} — ${character.source}, ${character.license}`}
                onClick={() => onSelectCharacter(character.id)}
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
                <img
                  src={character.previewDataUrl}
                  alt=""
                  width={112}
                  height={96}
                  style={{
                    imageRendering: "pixelated",
                    objectFit: "contain",
                    filter: `hue-rotate(${selection.hueShift}deg)`,
                  }}
                />
                <span>{character.name}</span>
              </button>
            );
          })}
        </div>
      </fieldset>

      <figure
        data-testid="character-preview-stage"
        style={{ margin: 0, display: "grid", gap: 4, justifyItems: "start" }}
      >
        {previewCharacter ? (
          <>
            <img
              data-testid="character-preview"
              src={previewCharacter.previewDataUrl}
              alt={`Preview of ${previewCharacter.name}`}
              width={112}
              height={96}
              style={{
                imageRendering: "pixelated",
                objectFit: "contain",
                filter: `hue-rotate(${selection.hueShift}deg)`,
              }}
            />
            <figcaption
              data-testid="character-preview-caption"
              style={{ opacity: 0.78, fontSize: 13 }}
            >
              Approximate preview: {previewCharacter.name} · palette {previewCharacter.palette} ·
              hue {selection.hueShift}°
            </figcaption>
          </>
        ) : (
          <figcaption data-testid="character-preview-none" style={{ opacity: 0.7 }}>
            No character chosen yet.
          </figcaption>
        )}
        <span style={{ opacity: 0.6, fontSize: 12 }}>
          Approximate preview — the Pixel Agents office applies the exact hue rotation.
        </span>
      </figure>

      <div style={{ display: "flex", gap: 12, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
          Hue shift
          <input
            type="range"
            id="character-hue-shift-range"
            data-testid="character-hue-shift"
            min={0}
            max={360}
            step={1}
            value={selection.hueShift}
            disabled={controlsDisabled}
            onChange={(event) => onHueShift(Number(event.target.value))}
            style={{ width: 260 }}
          />
        </label>
        <output
          htmlFor="character-hue-shift-range"
          data-testid="character-hue-shift-value"
          style={{ minWidth: 64, fontWeight: 600 }}
        >
          {selection.hueShift}°
        </output>
        <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
          Exact value
          <input
            type="number"
            data-testid="character-hue-shift-exact"
            min={0}
            max={360}
            step={1}
            value={selection.hueShift}
            disabled={controlsDisabled}
            onChange={(event) => onHueShift(Number(event.target.value))}
            style={{ width: 84 }}
          />
        </label>
        {paused ? (
          <span data-testid="character-picker-paused" style={{ opacity: 0.75, fontSize: 13 }}>
            Paused while reconnecting — save is unavailable until the bridge reconnects.
          </span>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          data-testid="character-save"
          disabled={saveDisabled}
          onClick={() => onSave()}
        >
          Save for {agentName}
        </button>
        <span style={{ opacity: 0.8, fontSize: 13 }} data-testid="character-persisted-state">
          Now: {persistedName ?? "not yet assigned"}
          {persistedHueShift !== null ? ` · hue ${persistedHueShift}°` : ""}
          {persistedUpdatedAt ? ` · updated ${formatTimestamp(persistedUpdatedAt)}` : ""}
        </span>
        {dirty && !saving ? (
          <span data-testid="character-dirty-hint" style={{ opacity: 0.9, fontSize: 13, fontWeight: 600 }}>
            Unsaved changes
          </span>
        ) : null}
        {saving ? (
          <span data-testid="character-saving-hint" style={{ opacity: 0.7, fontSize: 13 }}>
            Saving…
          </span>
        ) : null}
      </div>

      {savedNote ? (
        <div role="status" data-testid="character-message">
          {savedNote}
        </div>
      ) : null}
      {saveError ? (
        <div role="alert" data-testid="character-save-error">
          {saveError}
        </div>
      ) : null}
    </div>
  );
}
