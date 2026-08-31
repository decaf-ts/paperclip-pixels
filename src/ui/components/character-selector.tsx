import { useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  BRIDGE_ACTION_KEYS,
  BRIDGE_DATA_KEYS,
  type BridgeAgentView,
  type VisualSettingsData,
} from "../bridge-contract";

export function CharacterSelector({ companyId, agents }: { companyId: string; agents: BridgeAgentView[] }) {
  const visual = usePluginData<VisualSettingsData>(BRIDGE_DATA_KEYS.visualSettings, { companyId });
  const saveAppearance = usePluginAction(BRIDGE_ACTION_KEYS.setAgentAppearance);
  const [saving, setSaving] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  if (visual.loading) return <div>Loading character catalog…</div>;
  if (visual.error || visual.data?.error) {
    return <div role="alert">Pixel Agents relay unavailable: {visual.error?.message ?? visual.data?.error}</div>;
  }
  if (!visual.data?.configured) return <div>Configure the Pixel Agents relay to assign characters.</div>;

  return (
    <section data-testid="character-selector" style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>Agent characters</h2>
        <div style={{ opacity: 0.72, fontSize: 13 }}>
          Complete Pixel Agents sheets only: walking, typing, and reading frames are preserved unchanged.
        </div>
      </div>
      {agents.map(({ projection }) => {
        const selected = visual.data?.assignments[projection.agentId]?.characterId ?? "";
        return (
          <div key={projection.agentId} style={{ display: "grid", gap: 8 }}>
            <strong>{projection.name}</strong>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {visual.data?.characters.map((character) => {
                const active = selected === character.id;
                return (
                  <button
                    key={character.id}
                    type="button"
                    title={`${character.name} — ${character.source}, ${character.license}`}
                    disabled={saving === projection.agentId}
                    onClick={async () => {
                      setSaving(projection.agentId);
                      setMessage(null);
                      try {
                        await saveAppearance({
                          companyId,
                          agentId: projection.agentId,
                          characterId: character.id,
                          palette: character.palette,
                          hueShift: 0,
                        });
                        setMessage(`${projection.name} now uses ${character.name}.`);
                        visual.refresh();
                      } catch (err) {
                        setMessage(err instanceof Error ? err.message : String(err));
                      } finally {
                        setSaving(null);
                      }
                    }}
                    style={{
                      display: "grid",
                      gap: 4,
                      padding: 6,
                      borderRadius: 8,
                      border: active ? "2px solid #4f7cff" : "1px solid #9995",
                      background: active ? "#4f7cff18" : "transparent",
                    }}
                  >
                    <img
                      src={character.previewDataUrl}
                      alt={character.name}
                      width={112}
                      height={96}
                      style={{ imageRendering: "pixelated", objectFit: "contain" }}
                    />
                    <span>{character.name}</span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}
      {message ? <div role="status">{message}</div> : null}
    </section>
  );
}
