/**
 * Per-agent character composer tests (spec PAPERCLIP_PIXELS-2, R3-WS5b).
 *
 * Mirrors the worker bridge contract: `visual-settings` reads into
 * `VisualSettingsData` (composition part catalog + per-agent v2 appearance
 * map) and writes go through `agent.set-pixel-composition` with the
 * canonical payload `{ companyId, agentId, appearance: { mode: "composition",
 * composition } }`, resolving `{ ok, error }`. Drafts are keyed per agent and
 * dirty state compares a draft only against that same agent's persisted
 * appearance record.
 *
 * NOTE: the pinned react commits asynchronously; renders and async effects
 * are awaited before assertions.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentCharacterComposer } from "./character-composer";
import {
  BRIDGE_ACTION_KEYS,
  BRIDGE_DATA_KEYS,
  type CompositionPartChoice,
  type VisualSettingsData,
} from "../bridge-contract";
import {
  COMPOSITION_SCHEMA_VERSION,
  type AgentAppearanceAssignmentV2,
  type AppearanceAssignment,
  type CharacterComposition,
  type CompositionPartKind,
} from "paperclip-pixels-common";
import { PixelOfficePage } from "../PixelOfficePage";
import { makeAgentView, makeProjection, makeSnapshot } from "../test-utils/fixtures";
import {
  makeDataResult,
  makeStreamResult,
  usePluginActionImpl,
  usePluginDataImpl,
  usePluginStreamImpl,
} from "../test-utils/sdk-ui";

function makeAgent(agentId: string, name: string) {
  return makeAgentView({
    projection: makeProjection({ companyId: "co", agentId, name }),
  });
}

function makePart(
  id: string,
  kind: CompositionPartKind,
  overrides: Partial<CompositionPartChoice> = {},
): CompositionPartChoice {
  return {
    id,
    kind,
    name: `${id} name`,
    layer: 0,
    palette: 0,
    previewDataUrl: `data:image/svg+xml;base64,${id}`,
    source: "builtin",
    license: "CC0",
    ...overrides,
  };
}

const SKIN = makePart("skin-1", "skin", { name: "Skin A", layer: 10 });
const CLOTHING_A = makePart("clothing-1", "clothing", { name: "Clothing A", layer: 20 });
const CLOTHING_B = makePart("clothing-2", "clothing", { name: "Clothing B", layer: 21 });
const ACCESSORY = makePart("accessory-1", "accessory", { name: "Accessory A", layer: 40 });
const HAIR = makePart("hair-1", "hair", { name: "Hair A", layer: 50 });
const FACE = makePart("face-1", "face", { name: "Face A", layer: 60 });
const DEFAULT_PARTS = [SKIN, CLOTHING_A, CLOTHING_B, ACCESSORY, HAIR, FACE];

function makeComposition(
  parts: Array<{ partId: string; hueShift?: number }>,
  palette = 0,
  hueShift = 0,
): CharacterComposition {
  return {
    schemaVersion: COMPOSITION_SCHEMA_VERSION,
    parts,
    palette,
    hueShift,
    updatedAt: "2026-08-22T10:00:00.000Z",
  };
}

function makeCompositionAssignment(
  agentId: string,
  appearance: AppearanceAssignment,
  updatedAt = "2026-08-22T10:00:00.000Z",
): AgentAppearanceAssignmentV2 {
  return { agentId, appearance, updatedAt };
}

function makeVisual(
  overrides: Partial<Pick<VisualSettingsData, "configured" | "compositionParts" | "compositions" | "characters" | "assignments">> = {},
): VisualSettingsData {
  return {
    schemaVersion: 1,
    configured: true,
    characters: [],
    assignments: {},
    compositionParts: DEFAULT_PARTS,
    compositions: {},
    ...overrides,
  };
}

const baseComposerProps = {
  companyId: "co",
  agents: [makeAgent("agent-aaaa", "Alice"), makeAgent("agent-bbbb", "Bob")],
  visual: makeVisual(),
  visualLoading: false,
  visualError: null,
  disabled: false,
  onSaved: undefined as unknown as () => void,
};

type ComposerProps = React.ComponentProps<typeof AgentCharacterComposer>;

/**
 * Installs the action mock before the first render (the composer resolves
 * `usePluginAction` while mounting) and renders with a controlled action
 * result. Default: a persisting success.
 */
function renderComposer(
  props: Partial<ComposerProps> = {},
  actionOverride?: ReturnType<typeof jest.fn>,
) {
  const saveAction =
    actionOverride ?? jest.fn().mockResolvedValue({ ok: true });
  usePluginActionImpl.mockReturnValue(saveAction);
  const onSaved = jest.fn();
  const view = render(
    <AgentCharacterComposer {...{ ...baseComposerProps, onSaved, ...props }} />,
  );
  return { view, saveAction, onSaved };
}

function agentOption(agentId: string): HTMLElement {
  const found = screen
    .getAllByTestId("character-composer-agent-option")
    .find((option) => option.getAttribute("data-agent-id") === agentId);
  if (!found) throw new Error(`missing agent option ${agentId}`);
  return found;
}

function kindOption(kind: CompositionPartKind, partId: string): HTMLElement {
  const found = screen
    .getAllByTestId(`character-composer-${kind}-option`)
    .find((option) => option.getAttribute("data-part-id") === partId);
  if (!found) throw new Error(`missing ${kind} option ${partId}`);
  return found;
}

function previewSrcs(): (string | null)[] {
  const stage = screen.getByTestId("character-composer-preview-stage");
  return Array.from(stage.querySelectorAll("img")).map((img) =>
    img.getAttribute("src"),
  );
}

const ready = () =>
  waitFor(() =>
    expect(screen.getByTestId("character-composer")).toBeInTheDocument(),
  );

describe("AgentCharacterComposer — guarded states", () => {
  it("renders the loading row while the visual catalog loads", async () => {
    renderComposer({ visualLoading: true });
    await ready();
    expect(screen.getByTestId("character-composer-loading")).toHaveTextContent(
      "Loading composition catalog",
    );
    expect(
      screen.queryByTestId("character-composer-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the relay error as an alert row", async () => {
    renderComposer({ visualError: "relay down" });
    await ready();
    const row = screen.getByTestId("character-composer-error");
    expect(row).toHaveAttribute("role", "alert");
    expect(row).toHaveTextContent("Composition unavailable: relay down");
    expect(
      screen.queryByTestId("character-composer-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the not-configured row for an unconfigured relay", async () => {
    renderComposer({ visual: makeVisual({ configured: false }) });
    await ready();
    expect(
      screen.getByTestId("character-composer-not-configured"),
    ).toHaveTextContent("Configure the Pixel Agents relay to compose characters.");
    expect(
      screen.queryByTestId("character-composer-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the empty-catalog row when no composition parts are available", async () => {
    renderComposer({ visual: makeVisual({ compositionParts: [] }) });
    await ready();
    expect(
      screen.getByTestId("character-composer-empty-catalog"),
    ).toHaveTextContent("No composition parts available.");
    expect(
      screen.queryByTestId("character-composer-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the empty row when no agents are observed", async () => {
    renderComposer({ agents: [] });
    await ready();
    expect(screen.getByTestId("character-composer-empty")).toHaveTextContent(
      "No agents observed.",
    );
  });
});

describe("AgentCharacterComposer — per-agent selection", () => {
  it("preselects the first agent and renders each agent's appearance mode", async () => {
    renderComposer({
      visual: makeVisual({
        compositions: {
          "agent-aaaa": makeCompositionAssignment("agent-aaaa", {
            mode: "composition",
            composition: makeComposition([{ partId: "skin-1" }], 2, 30),
          }),
          "agent-bbbb": makeCompositionAssignment("agent-bbbb", {
            mode: "wholeSheet",
            characterId: "sheet-x",
            palette: 1,
            hueShift: 8,
          }),
        },
      }),
    });
    await ready();

    const alice = agentOption("agent-aaaa");
    const bob = agentOption("agent-bbbb");
    expect(alice).toHaveAttribute("aria-pressed", "true");
    expect(bob).toHaveAttribute("aria-pressed", "false");
    expect(alice).toHaveTextContent("composed");
    expect(bob).toHaveTextContent("whole sheet");
  });

  it("switches the pressed agent and swaps the editor to the picked agent", async () => {
    renderComposer({
      visual: makeVisual({
        compositions: {
          "agent-bbbb": makeCompositionAssignment("agent-bbbb", {
            mode: "composition",
            composition: makeComposition(
              [{ partId: "hair-1" }, { partId: "face-1" }],
              5,
              180,
            ),
          }),
        },
      }),
    });
    await ready();

    fireEvent.click(agentOption("agent-bbbb"));
    await waitFor(() =>
      expect(agentOption("agent-bbbb")).toHaveAttribute("aria-pressed", "true"),
    );
    // The editor follows the picked agent: its persisted composition drives
    // the pressed layer options and the preview caption.
    expect(kindOption("hair", "hair-1")).toHaveAttribute("aria-pressed", "true");
    expect(kindOption("face", "face-1")).toHaveAttribute("aria-pressed", "true");
    expect(kindOption("skin", "skin-1")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("character-composer-hue-value")).toHaveTextContent(
      "180°",
    );
    expect(screen.getByTestId("character-composer-preview-caption")).toHaveTextContent(
      "Composed preview: 2 layers · palette 5 · hue 180°",
    );
    // A clean agent (no draft) has nothing to save.
    expect(screen.getByTestId("character-composer-save")).toBeDisabled();
  });
});

describe("AgentCharacterComposer — per-kind pickers and layered preview", () => {
  it("renders a picker fieldset per kind and selects the chosen part", async () => {
    renderComposer();
    await ready();

    for (const kind of ["skin", "clothing", "accessory", "hair", "face"] as const) {
      expect(screen.getByTestId(`character-composer-${kind}`)).toBeInTheDocument();
    }

    fireEvent.click(kindOption("clothing", "clothing-2"));
    await waitFor(() =>
      expect(kindOption("clothing", "clothing-2")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(kindOption("clothing", "clothing-1")).toHaveAttribute("aria-pressed", "false");
  });

  it("orders the composited preview layers back-to-front by layer index", async () => {
    renderComposer({
      visual: makeVisual({
        compositions: {
          "agent-aaaa": makeCompositionAssignment("agent-aaaa", {
            mode: "composition",
            composition: makeComposition(
              [{ partId: "face-1" }, { partId: "hair-1" }, { partId: "skin-1" }],
              0,
              0,
            ),
          }),
        },
      }),
    });
    await ready();

    // Ascending layer: skin(10) then hair(50) then face(60), regardless of the
    // order the parts were recorded in the persisted composition.
    expect(previewSrcs()).toEqual([
      SKIN.previewDataUrl,
      HAIR.previewDataUrl,
      FACE.previewDataUrl,
    ]);
  });

  it("exposes the per-layer hue input for a persisted part hue and updates the selection", async () => {
    renderComposer({
      visual: makeVisual({
        compositions: {
          "agent-aaaa": makeCompositionAssignment("agent-aaaa", {
            mode: "composition",
            composition: makeComposition(
              [{ partId: "hair-1", hueShift: 12 }],
              3,
              20,
            ),
          }),
        },
      }),
    });
    await ready();

    // No per-layer input for a part without a hue shift, and none for kinds
    // whose selected part carries a 0 shift.
    expect(screen.queryByTestId("character-composer-skin-hue")).not.toBeInTheDocument();
    const layerHue = screen.getByTestId("character-composer-hair-hue") as HTMLInputElement;
    expect(layerHue).toHaveValue(12);
    fireEvent.change(layerHue, { target: { value: "90" } });
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-hair-hue") as HTMLInputElement).toHaveValue(90),
    );
  });
});

describe("AgentCharacterComposer — palette and hue controls", () => {
  it("reflects a palette change on the caption and clamps negative values to zero", async () => {
    renderComposer();
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeEnabled(),
    );
    const palette = screen.getByTestId("character-composer-palette") as HTMLInputElement;

    fireEvent.change(palette, { target: { value: "7" } });
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-preview-caption")).toHaveTextContent("palette 7"),
    );

    fireEvent.change(palette, { target: { value: "-3" } });
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-preview-caption")).toHaveTextContent("palette 0"),
    );
  });

  it("reflects a hue shift on the output, caption, and composited preview filter", async () => {
    renderComposer();
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeEnabled(),
    );
    const hue = screen.getByTestId("character-composer-hue") as HTMLInputElement;
    fireEvent.change(hue, { target: { value: "45" } });

    await waitFor(() =>
      expect(screen.getByTestId("character-composer-hue-value")).toHaveTextContent("45°"),
    );
    expect(screen.getByTestId("character-composer-preview-caption")).toHaveTextContent("hue 45°");
    const img = screen
      .getByTestId("character-composer-preview-stage")
      .querySelector("img");
    expect(img).toHaveStyle({ filter: "hue-rotate(45deg)" });
  });
});

describe("AgentCharacterComposer — whole-sheet migration", () => {
  it("shows the legacy banner and converts to a composed appearance preserving palette and hue", async () => {
    renderComposer({
      visual: makeVisual({
        characters: [
          {
            id: "sheet-alpha",
            name: "Sheet Alpha",
            palette: 4,
            previewDataUrl: "data:image/png;base64,AAAA",
            source: "builtin",
            license: "CC0",
          },
        ],
        assignments: {
          "agent-aaaa": {
            characterId: "sheet-alpha",
            palette: 4,
            hueShift: 199,
            updatedAt: "2026-08-22T10:00:00.000Z",
          },
        },
        compositions: {
          "agent-aaaa": makeCompositionAssignment("agent-aaaa", {
            mode: "wholeSheet",
            characterId: "sheet-alpha",
            palette: 4,
            hueShift: 199,
          }),
        },
      }),
    });
    await ready();

    const banner = screen.getByTestId("character-composer-legacy-banner");
    expect(banner).toHaveTextContent("currently uses the whole sheet Sheet Alpha");
    // Before converting the agent has no layers selected, so nothing to save.
    expect(screen.getByTestId("character-composer-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("character-composer-convert"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-dirty-hint")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("character-composer-save")).toBeEnabled();
    // The migration seeds one layer per kind (skin, clothing, hair, face,
    // accessory) and carries the palette + hue shift over (data-loss-free).
    expect(screen.getByTestId("character-composer-preview-caption")).toHaveTextContent(
      "Composed preview: 5 layers · palette 4 · hue 199°",
    );
    expect(screen.getByTestId("character-composer-palette") as HTMLInputElement).toHaveValue(4);
    expect(screen.getByTestId("character-composer-hue-value")).toHaveTextContent("199°");
  });
});

describe("AgentCharacterComposer — dirty/save/disabled states", () => {
  it("is inert before any part is selected", async () => {
    const { saveAction } = renderComposer();
    await ready();

    expect(screen.getByTestId("character-composer-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("character-composer-save"));
    await waitFor(() => expect(saveAction).not.toHaveBeenCalled());
  });

  it("selecting a part marks the draft dirty and enables Save", async () => {
    renderComposer();
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeEnabled(),
    );
    expect(screen.getByTestId("character-composer-dirty-hint")).toHaveTextContent(
      "Unsaved changes",
    );
    expect(screen.getByTestId("character-composer-preview-caption")).toHaveTextContent(
      "Composed preview: 1 layer",
    );
  });

  it("pauses the composer behind the stale-bridge gate", async () => {
    renderComposer({ disabled: true });
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    await waitFor(() =>
      expect(kindOption("skin", "skin-1")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("character-composer-save")).toBeDisabled();
    expect(screen.getByTestId("character-composer-dirty-hint")).toBeInTheDocument();
    expect(screen.getByTestId("character-composer-paused")).toHaveTextContent(
      "Paused while reconnecting",
    );
  });
});

describe("AgentCharacterComposer — save", () => {
  it("saves the canonical composition payload once over the set-composition action", async () => {
    const { saveAction, onSaved } = renderComposer();
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    fireEvent.click(kindOption("hair", "hair-1"));
    fireEvent.change(
      screen.getByTestId("character-composer-palette") as HTMLInputElement,
      { target: { value: "4" } },
    );
    fireEvent.change(
      screen.getByTestId("character-composer-hue") as HTMLInputElement,
      { target: { value: "199" } },
    );
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("character-composer-save"));

    await waitFor(() => expect(saveAction).toHaveBeenCalledTimes(1));
    expect(usePluginActionImpl).toHaveBeenCalledWith(
      BRIDGE_ACTION_KEYS.setAgentComposition,
    );
    const call = saveAction.mock.calls[0][0];
    expect(call.companyId).toBe("co");
    expect(call.agentId).toBe("agent-aaaa");
    expect(call.appearance).toEqual({
      mode: "composition",
      composition: expect.objectContaining({
        schemaVersion: COMPOSITION_SCHEMA_VERSION,
        parts: [
          { partId: "skin-1", hueShift: 0 },
          { partId: "hair-1", hueShift: 0 },
        ],
        palette: 4,
        hueShift: 199,
      }),
    });
    expect(typeof call.appearance.composition.updatedAt).toBe("string");

    // Success note + page refresh, draft discarded.
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-message")).toHaveTextContent(
        "Saved a composed appearance for Alice",
      ),
    );
    expect(screen.getByTestId("character-composer-message")).toHaveAttribute(
      "role",
      "status",
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(screen.queryByTestId("character-composer-dirty-hint")).not.toBeInTheDocument();
    expect(screen.getByTestId("character-composer-save")).toBeDisabled();
  });

  it("keeps the draft and surfaces the contract error when the action resolves ok:false", async () => {
    const { saveAction, onSaved } = renderComposer(
      {},
      jest.fn().mockResolvedValue({ ok: false, error: "INVALID_COMPOSITION" }),
    );
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("character-composer-save"));

    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save-error")).toHaveTextContent(
        "INVALID_COMPOSITION",
      ),
    );
    expect(screen.getByTestId("character-composer-save-error")).toHaveAttribute(
      "role",
      "alert",
    );
    // Draft survives a rejected write: dirty state and the save path hold.
    expect(screen.getByTestId("character-composer-dirty-hint")).toBeInTheDocument();
    expect(screen.getByTestId("character-composer-save")).toBeEnabled();
    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("character-composer-message")).not.toBeInTheDocument();
    expect(kindOption("skin", "skin-1")).toHaveAttribute("aria-pressed", "true");
  });

  it("surfaces thrown bridge failures as the save error", async () => {
    const { saveAction, onSaved } = renderComposer({}, undefined);
    saveAction.mockRejectedValue(new Error("bridge crashed"));
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    fireEvent.click(screen.getByTestId("character-composer-save"));

    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save-error")).toHaveTextContent(
        "bridge crashed",
      ),
    );
    expect(screen.getByTestId("character-composer-dirty-hint")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("character-composer-message")).not.toBeInTheDocument();
  });

  it("disables the controls while a save is in flight, then recovers", async () => {
    let resolveSave!: (value: unknown) => void;
    const saveAction = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderComposer({}, saveAction);
    await ready();

    fireEvent.click(kindOption("skin", "skin-1"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeEnabled(),
    );
    fireEvent.click(screen.getByTestId("character-composer-save"));

    // In-flight: save and all controls are disabled, and the dirty hint gives
    // way to the saving state.
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-save")).toBeDisabled(),
    );
    expect((screen.getByTestId("character-composer-palette") as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByTestId("character-composer-hue") as HTMLInputElement).disabled).toBe(true);
    expect(kindOption("skin", "skin-1")).toBeDisabled();
    expect(agentOption("agent-bbbb")).toBeDisabled();
    expect(screen.queryByTestId("character-composer-dirty-hint")).not.toBeInTheDocument();

    resolveSave({ ok: true });
    await waitFor(() =>
      expect(screen.getByTestId("character-composer-message")).toBeInTheDocument(),
    );
    expect((screen.getByTestId("character-composer-palette") as HTMLInputElement).disabled).toBe(false);
    expect(kindOption("skin", "skin-1")).toBeEnabled();
    expect(agentOption("agent-bbbb")).toBeEnabled();
  });
});

describe("PixelOfficePage — Whole-sheet/Composer appearance-mode toggle", () => {
  it("defaults to the whole-sheet picker and toggles to the composer", async () => {
    usePluginDataImpl.mockImplementation((...args: unknown[]) => {
      const key = String(args[0]);
      if (key === BRIDGE_DATA_KEYS.snapshot) {
        return makeDataResult({
          data: makeSnapshot({
            agents: [makeAgent("agent-aaaa", "Alice")],
            observedAt: new Date().toISOString(),
          }),
          loading: false,
          error: null,
        });
      }
      return makeDataResult({ data: makeVisual(), loading: false, error: null });
    });
    usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: false }));

    render(<PixelOfficePage context={{ companyId: "co" } as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("pixel-office-page")).toBeInTheDocument(),
    );

    // Default: the whole-sheet picker is the active appearance surface.
    expect(screen.getByTestId("character-picker")).toBeInTheDocument();
    expect(screen.getByTestId("appearance-mode-whole-sheet")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("appearance-mode-composer")).toHaveAttribute(
      "aria-pressed",
      "false",
    );

    fireEvent.click(screen.getByTestId("appearance-mode-composer"));
    await waitFor(() =>
      expect(screen.getByTestId("character-composer")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("appearance-mode-composer")).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByTestId("appearance-mode-whole-sheet")).toHaveAttribute(
      "aria-pressed",
      "false",
    );
    expect(screen.queryByTestId("character-picker")).not.toBeInTheDocument();

    // And back to the whole-sheet bullet.
    fireEvent.click(screen.getByTestId("appearance-mode-whole-sheet"));
    await waitFor(() =>
      expect(screen.getByTestId("character-picker")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("character-composer")).not.toBeInTheDocument();
  });
});
