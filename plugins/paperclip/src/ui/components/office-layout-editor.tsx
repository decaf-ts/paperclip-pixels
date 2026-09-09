/**
 * Paperclip-hosted office-layout configuration editor (R3-WS4b,
 * PAPERCLIP_PIXELS-2). Consumes the worker's `office-layout` data handler
 * (`OfficeLayoutConfigResponse`) to read the current declarative layout and
 * the `office.set-layout` action to persist a validated one.
 *
 * The layout DTO (`OfficeLayout`) lives in `@decaf-ts/paperclip-pixels-common` and is
 * validated client-agnostically by the action handler (fail-closed: an
 * invalid layout is rejected with `INVALID_LAYOUT`). This editor edits the
 * host-neutral vocabulary — floors, seat positions in normalized 0..1 space —
 * and lets the operator restore a sane default.
 */

import { useCallback, useEffect, useState } from "react";
import { usePluginAction, usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { OfficeLayout, OfficeSeat } from "@decaf-ts/paperclip-pixels-common";
import {
  BRIDGE_ACTION_KEYS,
  BRIDGE_DATA_KEYS,
  type OfficeLayoutConfigResponse,
} from "../bridge-contract";

/**
 * Build a minimal, valid default layout (one floor, two seats — no walls or
 * furniture, which are optional). Coordinates are normalized to [0,1].
 */
export function createDefaultOfficeLayout(): OfficeLayout {
  return {
    schemaVersion: 1,
    name: "Default office",
    floors: [
      {
        id: "floor-1",
        name: "Main floor",
        walls: [],
        furniture: [],
        seats: [
          { id: "seat-1", agentId: null, position: { x: 0.25, y: 0.3 }, label: "Seat 1" },
          { id: "seat-2", agentId: null, position: { x: 0.75, y: 0.3 }, label: "Seat 2" },
        ],
      },
    ],
  };
}

type SetOfficeLayoutResult = {
  ok?: boolean;
  error?: string;
  errors?: string[];
};

function clampUnit(raw: number): number {
  if (!Number.isFinite(raw)) return 0;
  return Math.min(1, Math.max(0, raw));
}

export interface OfficeLayoutEditorProps {
  companyId: string;
  /** True while the bridge is stale — saving pauses (§30.1). */
  disabled?: boolean;
}

export function OfficeLayoutEditor({ companyId, disabled = false }: OfficeLayoutEditorProps) {
  const data = usePluginData<OfficeLayoutConfigResponse>(BRIDGE_DATA_KEYS.officeLayout, {
    companyId,
  });
  const saveLayout = usePluginAction(BRIDGE_ACTION_KEYS.setOfficeLayout);

  const [draft, setDraft] = useState<OfficeLayout | null>(null);
  const [saving, setSaving] = useState<boolean>(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Seed the draft from the served layout when a config first arrives, but
  // never clobber an in-progress edit (the draft guard keeps a local default
  // or a user's unsaved edits intact across refreshes).
  useEffect(() => {
    const served = data.data?.layout ?? null;
    if (served && draft === null) {
      setDraft(JSON.parse(JSON.stringify(served)));
    }
  }, [data.data, draft]);

  const configured = data.data?.configured ?? false;

  const updateFloorName = useCallback(
    (index: number, name: string) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const floors = prev.floors.map((floor, i) =>
          i === index ? { ...floor, name } : floor,
        );
        return { ...prev, floors };
      });
    },
    [],
  );

  const updateSeat = useCallback(
    (floorIndex: number, seatIndex: number, partial: Partial<OfficeSeat>) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const floors = prev.floors.map((floor, fi) => {
          if (fi !== floorIndex) return floor;
          const seats = floor.seats.map((seat, si) =>
            si === seatIndex ? { ...seat, ...partial } : seat,
          );
          return { ...floor, seats };
        });
        return { ...prev, floors };
      });
    },
    [],
  );

  const updateSeatPosition = useCallback(
    (floorIndex: number, seatIndex: number, axis: "x" | "y", raw: number) => {
      setDraft((prev) => {
        if (!prev) return prev;
        const floors = prev.floors.map((floor, fi) => {
          if (fi !== floorIndex) return floor;
          const seats = floor.seats.map((seat, si) => {
            if (si !== seatIndex) return seat;
            const position = { ...seat.position, [axis]: clampUnit(raw) };
            return { ...seat, position };
          });
          return { ...floor, seats };
        });
        return { ...prev, floors };
      });
    },
    [],
  );

  const handleSave = useCallback(async () => {
    if (!draft || saving || disabled) return;
    setSaving(true);
    setMessage(null);
    setError(null);
    try {
      const result = (await saveLayout({
        companyId,
        layout: draft,
      })) as SetOfficeLayoutResult | undefined;
      if (result && result.ok === false) {
        setError(result.error ?? "LAYOUT_SAVE_FAILED");
        return;
      }
      setMessage("Office layout saved.");
      data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [draft, saving, disabled, saveLayout, companyId, data]);

  const handleCreateDefault = useCallback(async () => {
    const next = createDefaultOfficeLayout();
    setDraft(next);
    setMessage(null);
    setError(null);
    if (saving || disabled) return;
    setSaving(true);
    try {
      const result = (await saveLayout({
        companyId,
        layout: next,
      })) as SetOfficeLayoutResult | undefined;
      if (result && result.ok === false) {
        setError(result.error ?? "LAYOUT_SAVE_FAILED");
        return;
      }
      setMessage("Default office layout created.");
      data.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }, [companyId, saveLayout, saving, disabled, data]);

  if (data.loading && !data.data) {
    return (
      <section data-testid="office-layout-editor" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Office layout</h2>
        <div data-testid="office-layout-loading">Loading office layout…</div>
      </section>
    );
  }

  if (data.error) {
    return (
      <section data-testid="office-layout-editor" style={{ display: "grid", gap: 8 }}>
        <h2 style={{ margin: 0 }}>Office layout</h2>
        <div role="alert" data-testid="office-layout-error">
          {data.error.message}
        </div>
      </section>
    );
  }

  return (
    <section data-testid="office-layout-editor" style={{ display: "grid", gap: 12 }}>
      <div>
        <h2 style={{ margin: 0 }}>Office layout</h2>
        <div style={{ opacity: 0.72, fontSize: 13 }}>
          Declarative office layout hosted by Paperclip and applied spatially by
          the Pixel Agents plugin.
        </div>
      </div>

      {!configured && !draft ? (
        <div data-testid="office-layout-empty" style={{ opacity: 0.85 }}>
          No office layout configured yet.
        </div>
      ) : null}

      {draft ? (
        <div style={{ display: "grid", gap: 12 }}>
          <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
            Layout name
            <input
              data-testid="office-layout-name"
              type="text"
              value={draft.name}
              disabled={saving}
              onChange={(event) =>
                setDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev))
              }
              style={{ minWidth: 220 }}
            />
          </label>

          {draft.floors.map((floor, floorIndex) => (
            <fieldset
              key={floor.id}
              data-testid="office-layout-floor"
              data-floor-id={floor.id}
              style={{ border: "1px solid #9994", borderRadius: 8, padding: 12, display: "grid", gap: 8 }}
            >
              <legend>
                <input
                  data-testid="office-layout-floor-name"
                  type="text"
                  value={floor.name}
                  disabled={saving}
                  onChange={(event) => updateFloorName(floorIndex, event.target.value)}
                  style={{ minWidth: 180 }}
                />
              </legend>
              {floor.seats.length === 0 ? (
                <span style={{ opacity: 0.7, fontSize: 13 }}>No seats on this floor.</span>
              ) : (
                floor.seats.map((seat, seatIndex) => (
                  <div
                    key={seat.id}
                    data-testid="office-layout-seat"
                    data-seat-id={seat.id}
                    style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}
                  >
                    <span style={{ fontSize: 13, minWidth: 72 }}>{seat.label ?? seat.id}</span>
                    <label style={{ display: "grid", gap: 2, fontSize: 12 }}>
                      x
                      <input
                        data-testid="office-layout-seat-x"
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        value={seat.position.x}
                        disabled={saving}
                        onChange={(event) =>
                          updateSeatPosition(floorIndex, seatIndex, "x", Number(event.target.value))
                        }
                        style={{ width: 72 }}
                      />
                    </label>
                    <label style={{ display: "grid", gap: 2, fontSize: 12 }}>
                      y
                      <input
                        data-testid="office-layout-seat-y"
                        type="number"
                        min={0}
                        max={1}
                        step={0.1}
                        value={seat.position.y}
                        disabled={saving}
                        onChange={(event) =>
                          updateSeatPosition(floorIndex, seatIndex, "y", Number(event.target.value))
                        }
                        style={{ width: 72 }}
                      />
                    </label>
                  </div>
                ))
              )}
            </fieldset>
          ))}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <button
          type="button"
          data-testid="office-layout-save"
          disabled={saving || disabled || !draft}
          onClick={() => handleSave()}
        >
          Save layout
        </button>
        <button
          type="button"
          data-testid="office-layout-create-default"
          disabled={saving || disabled}
          onClick={() => handleCreateDefault()}
        >
          Create default
        </button>
        {saving ? (
          <span data-testid="office-layout-saving" style={{ opacity: 0.7, fontSize: 13 }}>
            Saving…
          </span>
        ) : null}
        {disabled ? (
          <span data-testid="office-layout-paused" style={{ opacity: 0.75, fontSize: 13 }}>
            Paused while reconnecting — layout changes are unavailable until the bridge reconnects.
          </span>
        ) : null}
      </div>

      {message ? (
        <div role="status" data-testid="office-layout-message">
          {message}
        </div>
      ) : null}
      {error ? (
        <div role="alert" data-testid="office-layout-save-error">
          {error}
        </div>
      ) : null}
    </section>
  );
}
