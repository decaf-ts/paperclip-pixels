import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import { BRIDGE_DATA_KEYS, type VisualSettingsData } from "./bridge-contract";

export function PixelOfficeSettingsPage({ context }: { context: { companyId: string | null } }) {
  const visual = usePluginData<VisualSettingsData>(BRIDGE_DATA_KEYS.visualSettings, {
    companyId: context.companyId,
  });
  return (
    <div style={{ display: "grid", gap: 16 }}>
      <h2 style={{ margin: 0 }}>Pixel Office settings</h2>
      <p style={{ margin: 0 }}>
        Connection values are managed by the plugin configuration form. Character choices are company-scoped
        and stored by the companion relay; office layout and furniture remain owned by Pixel Agents.
      </p>
      <div style={{ display: "grid", gap: 6, padding: 12, border: "1px solid #9994", borderRadius: 8 }}>
        <strong>Connection</strong>
        <span>Relay: {visual.data?.configured ? "connected" : "not connected"}</span>
        <span>Embedded office: {visual.data?.pixelAgentsUiUrl ?? "not configured"}</span>
        <span>Characters available: {visual.data?.characters.length ?? 0}</span>
        {visual.error || visual.data?.error ? (
          <span role="alert">{visual.error?.message ?? visual.data?.error}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 13, opacity: 0.75 }}>
        The bundled catalog contains only complete 112×96 character sheets. No MetroCity typing or reading
        frames are generated. Redistributable furniture packs and their licenses are baked into the image.
      </div>
    </div>
  );
}
