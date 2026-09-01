/**
 * Per-agent character picker tests (spec PAPERCLIP_PIXELS-2, WS3, FR-13;
 * backend contract delivered on SAA-469).
 *
 * Mirrors the worker bridge contract: `visual-settings` reads into
 * `VisualSettingsData` (character catalog + per-agent assignments) and writes
 * go through `agent.set-pixel-appearance` with the canonical payload
 * `{ companyId, agentId, characterId, palette, hueShift }`, resolving
 * `{ ok, applied, assignment }`. Drafts are keyed per agent and dirty state
 * compares a draft only against that same agent's persisted assignment.
 *
 * NOTE: the pinned react commits asynchronously; renders and async effects
 * are awaited before assertions.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentCharacterPicker } from "./character-picker";
import {
  BRIDGE_ACTION_KEYS,
  type PixelAgentCharacterAssignment,
  type PixelCharacterChoice,
  type VisualSettingsData,
} from "../bridge-contract";
import { makeAgentView, makeProjection } from "../test-utils/fixtures";
import { usePluginActionImpl } from "../test-utils/sdk-ui";

function makeAgent(agentId: string, name: string) {
  return makeAgentView({
    projection: makeProjection({ companyId: "co", agentId, name }),
  });
}

function makeCharacter(
  overrides: Partial<PixelCharacterChoice> = {},
): PixelCharacterChoice {
  return {
    id: "char-a",
    name: "Sheet Alpha",
    palette: 2,
    previewDataUrl: "data:image/png;base64,AAAA",
    source: "builtin",
    license: "CC0",
    ...overrides,
  };
}

function makeAssignment(
  overrides: Partial<PixelAgentCharacterAssignment> = {},
): PixelAgentCharacterAssignment {
  return {
    characterId: "char-a",
    palette: 2,
    hueShift: 45,
    updatedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

function makeDefaultCharacters(): PixelCharacterChoice[] {
  return [
    makeCharacter(),
    makeCharacter({ id: "char-b", name: "Sheet Beta", palette: 3 }),
  ];
}

function makeVisual(
  overrides: Partial<
    Pick<VisualSettingsData, "configured" | "characters" | "assignments">
  > = {},
): VisualSettingsData {
  return {
    schemaVersion: 1,
    configured: true,
    characters: makeDefaultCharacters(),
    assignments: {},
    ...overrides,
  };
}

const basePickerProps = {
  companyId: "co",
  agents: [makeAgent("agent-aaaa", "Alice"), makeAgent("agent-bbbb", "Bob")],
  visual: makeVisual(),
  visualLoading: false,
  visualError: null,
  disabled: false,
  onSaved: undefined as unknown as () => void,
};

type PickerProps = React.ComponentProps<typeof AgentCharacterPicker>;

/**
 * Installs the action mock before the first render (the picker resolves
 * `usePluginAction` while mounting) and renders with a controlled action
 * result. Default: a persisting, relay-applied success. `actionOverride`
 * replaces the default action altogether (e.g. a deferred in-flight write).
 */
function renderPicker(
  props: Partial<PickerProps> = {},
  actionOverride?: ReturnType<typeof jest.fn>,
) {
  const saveAction =
    actionOverride ?? jest.fn().mockResolvedValue({ ok: true, applied: true });
  usePluginActionImpl.mockReturnValue(saveAction);
  const onSaved = jest.fn();
  const view = render(
    <AgentCharacterPicker {...{ ...basePickerProps, onSaved, ...props }} />,
  );
  return { view, saveAction, onSaved };
}

function agentOption(agentId: string): HTMLElement {
  const found = screen
    .getAllByTestId("character-picker-agent-option")
    .find((option) => option.getAttribute("data-agent-id") === agentId);
  if (!found) throw new Error(`missing agent option ${agentId}`);
  return found;
}

function characterOption(characterId: string): HTMLElement {
  const found = screen
    .getAllByTestId("character-option")
    .find((option) => option.getAttribute("data-character-id") === characterId);
  if (!found) throw new Error(`missing character option ${characterId}`);
  return found;
}

function editorLegend(): HTMLElement {
  const legend = screen
    .getByTestId("character-picker-character-group")
    .getElementsByTagName("legend")[0];
  if (!legend) throw new Error("missing character-group legend");
  return legend;
}

function hueRangeValue(): string {
  return (screen.getByTestId("character-hue-shift") as HTMLInputElement)
    .value ?? "";
}

function hueExactValue(): string {
  return (screen.getByTestId("character-hue-shift-exact") as HTMLInputElement)
    .value ?? "";
}

function hueRangeDisabled(): boolean {
  return (screen.getByTestId("character-hue-shift") as HTMLInputElement)
    .disabled;
}

function hueExactDisabled(): boolean {
  return (screen.getByTestId("character-hue-shift-exact") as HTMLInputElement)
    .disabled;
}

function hueFilterOf(element: HTMLElement): string {
  const image = element.getElementsByTagName("img")[0];
  if (!image) throw new Error("missing preview image");
  return image.style.filter;
}

function previewFilter(): string {
  return (screen.getByTestId("character-preview") as HTMLImageElement).style
    .filter;
}

const ready = () =>
  waitFor(() =>
    expect(screen.getByTestId("character-picker")).toBeInTheDocument(),
  );

describe("AgentCharacterPicker — per-agent agent selection", () => {
  it("preselects the first agent and renders each agent's assigned summary", async () => {
    renderPicker({
      visual: makeVisual({
        assignments: {
          "agent-aaaa": makeAssignment({ characterId: "char-a", hueShift: 45 }),
        },
      }),
    });
    await ready();

    const alice = agentOption("agent-aaaa");
    const bob = agentOption("agent-bbbb");
    expect(alice).toHaveAttribute("aria-pressed", "true");
    expect(bob).toHaveAttribute("aria-pressed", "false");
    // Per-agent persisted summary: assigned sheet name + hue, or the
    // not-yet-assigned fallback.
    expect(alice).toHaveTextContent("Sheet Alpha · hue 45°");
    expect(bob).toHaveTextContent("not yet assigned");
    expect(bob).not.toHaveTextContent("hue");
    expect(editorLegend()).toHaveTextContent("Character for Alice");
    expect(screen.getByTestId("character-save")).toHaveTextContent(
      "Save for Alice",
    );
  });

  it("switches the pressed agent and swaps the editor to the picked agent", async () => {
    renderPicker({
      visual: makeVisual({
        assignments: {
          "agent-bbbb": makeAssignment({
            characterId: "char-b",
            hueShift: 180,
            updatedAt: "2026-08-23T11:00:00.000Z",
          }),
        },
      }),
    });
    await ready();

    fireEvent.click(agentOption("agent-bbbb"));
    await waitFor(() =>
      expect(agentOption("agent-bbbb")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(agentOption("agent-aaaa")).toHaveAttribute("aria-pressed", "false");
    expect(editorLegend()).toHaveTextContent("Character for Bob");
    // The editor follows the picked agent: its assigned sheet is pressed...
    expect(characterOption("char-b")).toHaveAttribute("aria-pressed", "true");
    expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "false");
    // ...its persisted hue drives the controls and the preview caption.
    expect(hueRangeValue()).toBe("180");
    expect(hueExactValue()).toBe("180");
    expect(screen.getByTestId("character-hue-shift-value")).toHaveTextContent(
      "180°",
    );
    expect(screen.getByTestId("character-preview-caption")).toHaveTextContent(
      "Sheet Beta · palette 3 · hue 180°",
    );
    expect(screen.getByTestId("character-persisted-state")).toHaveTextContent(
      "Now: Sheet Beta · hue 180° · updated 2026-08-23 11:00:00 UTC",
    );
  });

  it("keeps each agent's draft independent of the other agents", async () => {
    renderPicker({
      visual: makeVisual({
        assignments: {
          "agent-bbbb": makeAssignment({ characterId: "char-b", hueShift: 180 }),
        },
      }),
    });
    await ready();

    // Draft a selection for the first (unassigned) agent.
    fireEvent.click(characterOption("char-a"));
    await waitFor(() =>
      expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("character-save")).toBeEnabled();

    // Switching to the second agent edits the second agent: its persisted
    // selection is shown and stays clean — the first agent's draft is not
    // applied to it.
    fireEvent.click(agentOption("agent-bbbb"));
    await waitFor(() =>
      expect(characterOption("char-b")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("character-save")).toBeDisabled();

    // Switching back resumes the first agent's draft untouched.
    fireEvent.click(agentOption("agent-aaaa"));
    await waitFor(() =>
      expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(hueRangeValue()).toBe("0");
    expect(hueExactValue()).toBe("0");
    expect(screen.getByTestId("character-save")).toBeEnabled();
  });
});

describe("AgentCharacterPicker — selecting a character and saving", () => {
  it("is inert before any selection change", async () => {
    const { saveAction } = renderPicker();
    await ready();

    expect(screen.getByTestId("character-preview-none")).toHaveTextContent(
      "No character chosen yet.",
    );
    expect(screen.getByTestId("character-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("character-save"));
    await waitFor(() => expect(saveAction).not.toHaveBeenCalled());
  });

  it("selects the character, marks the draft dirty, and enables Save", async () => {
    renderPicker();
    await ready();

    fireEvent.click(characterOption("char-a"));
    await waitFor(() => expect(screen.getByTestId("character-save")).toBeEnabled());

    expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "true");
    expect(characterOption("char-b")).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("character-dirty-hint")).toHaveTextContent(
      "Unsaved changes",
    );
    expect(screen.getByTestId("character-save")).toHaveTextContent(
      "Save for Alice",
    );
    expect(screen.getByTestId("character-preview-caption")).toHaveTextContent(
      "Approximate preview: Sheet Alpha · palette 2 · hue 0°",
    );
    expect(previewFilter()).toBe("hue-rotate(0deg)");
  });

  it("saves the canonical payload once, notes success, and routes the page refresh", async () => {
    const { saveAction, onSaved, view } = renderPicker();
    await ready();

    fireEvent.click(characterOption("char-a"));
    fireEvent.click(screen.getByTestId("character-save"));

    await waitFor(() =>
      expect(saveAction).toHaveBeenCalledWith({
        companyId: "co",
        agentId: "agent-aaaa",
        characterId: "char-a",
        palette: 2,
        hueShift: 0,
      }),
    );
    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(usePluginActionImpl).toHaveBeenCalledWith(
      BRIDGE_ACTION_KEYS.setAgentAppearance,
    );
    await waitFor(() =>
      expect(screen.getByTestId("character-message")).toHaveTextContent(
        "Alice now uses Sheet Alpha at hue 0°.",
      ),
    );
    expect(screen.getByTestId("character-message")).toHaveAttribute(
      "role",
      "status",
    );
    // onSaved is the page's `visual.refresh` — new data flows in externally.
    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    // Draft discarded.
    expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.queryByTestId("character-dirty-hint"),
    ).not.toBeInTheDocument();
    // The persisted row reflects the served data, not the local write: this
    // render still carries the pre-save visual payload.
    expect(screen.getByTestId("character-persisted-state")).toHaveTextContent(
      "Now: not yet assigned",
    );

    // The page-driven refresh delivers the persisted assignment.
    view.rerender(
      <AgentCharacterPicker
        {...basePickerProps}
        onSaved={onSaved}
        visual={makeVisual({
          assignments: {
            "agent-aaaa": makeAssignment({
              characterId: "char-a",
              hueShift: 0,
              updatedAt: "2026-08-25T09:30:00.000Z",
            }),
          },
        })}
      />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("character-persisted-state")).toHaveTextContent(
        "Now: Sheet Alpha · hue 0° · updated 2026-08-25 09:30:00 UTC",
      ),
    );
    expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("character-save")).toBeDisabled();
  });
});

describe("AgentCharacterPicker — hue-shift adjustment", () => {
  it("reflects a draft hue shift on the range, output, exact input, and previews", async () => {
    renderPicker();
    await ready();

    fireEvent.click(characterOption("char-a"));
    fireEvent.change(
      screen.getByTestId("character-hue-shift") as HTMLInputElement,
      { target: { value: "45" } },
    );
    await waitFor(() =>
      expect(screen.getByTestId("character-hue-shift-value")).toHaveTextContent(
        "45°",
      ),
    );
    expect(hueExactValue()).toBe("45");
    expect(previewFilter()).toBe("hue-rotate(45deg)");
    // The option-grid preview images track the draft hue as well.
    expect(hueFilterOf(characterOption("char-a"))).toBe("hue-rotate(45deg)");
  });

  it("clamps exact-input values through clampHueShift: below 0, above 360, fractional", async () => {
    renderPicker();
    await ready();

    fireEvent.click(characterOption("char-a"));
    const exact = screen.getByTestId(
      "character-hue-shift-exact",
    ) as HTMLInputElement;

    fireEvent.change(exact, { target: { value: "372" } });
    await waitFor(() =>
      expect(screen.getByTestId("character-hue-shift-value")).toHaveTextContent(
        "360°",
      ),
    );
    expect(previewFilter()).toBe("hue-rotate(360deg)");

    fireEvent.change(exact, { target: { value: "-5" } });
    await waitFor(() =>
      expect(screen.getByTestId("character-hue-shift-value")).toHaveTextContent(
        "0°",
      ),
    );
    expect(previewFilter()).toBe("hue-rotate(0deg)");

    fireEvent.change(exact, { target: { value: "45.7" } });
    await waitFor(() =>
      expect(screen.getByTestId("character-hue-shift-value")).toHaveTextContent(
        "45°",
      ),
    );
    expect(hueExactValue()).toBe("45");
  });

  it("saves a draft hue that was typed before a character was chosen", async () => {
    const { saveAction } = renderPicker();
    await ready();

    fireEvent.change(
      screen.getByTestId("character-hue-shift-exact") as HTMLInputElement,
      { target: { value: "87" } },
    );
    await waitFor(() => expect(saveAction).not.toHaveBeenCalled());
    // No character chosen: the draft exists but the save gate stays closed.
    expect(screen.getByTestId("character-save")).toBeDisabled();
    expect(screen.getByTestId("character-preview-none")).toBeInTheDocument();

    fireEvent.click(characterOption("char-a"));
    fireEvent.click(screen.getByTestId("character-save"));
    await waitFor(() =>
      expect(saveAction).toHaveBeenCalledWith({
        companyId: "co",
        agentId: "agent-aaaa",
        characterId: "char-a",
        palette: 2,
        hueShift: 87,
      }),
    );
  });
});

describe("AgentCharacterPicker — persistence outcomes", () => {
  it("keeps the draft and surfaces the contract error when the action resolves ok:false", async () => {
    const { saveAction, onSaved } = renderPicker(
      {},
      jest.fn().mockResolvedValue({ ok: false, error: "INVALID_CHARACTER" }),
    );
    await ready();

    fireEvent.click(characterOption("char-a"));
    await waitFor(() => expect(screen.getByTestId("character-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("character-save"));

    await waitFor(() =>
      expect(screen.getByTestId("character-save-error")).toHaveTextContent(
        "INVALID_CHARACTER",
      ),
    );
    expect(screen.getByTestId("character-save-error")).toHaveAttribute(
      "role",
      "alert",
    );
    // Draft survives a rejected write: dirty state and the save path hold.
    expect(screen.getByTestId("character-dirty-hint")).toBeInTheDocument();
    expect(screen.getByTestId("character-save")).toBeEnabled();
    expect(saveAction).toHaveBeenCalledTimes(1);
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("character-message")).not.toBeInTheDocument();
    expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "true");
  });

  it("surfaces thrown bridge failures as the save error", async () => {
    const { saveAction, onSaved } = renderPicker({}, undefined);
    saveAction.mockRejectedValue(new Error("bridge crashed"));
    await ready();

    fireEvent.click(characterOption("char-a"));
    fireEvent.click(screen.getByTestId("character-save"));

    await waitFor(() =>
      expect(screen.getByTestId("character-save-error")).toHaveTextContent(
        "bridge crashed",
      ),
    );
    expect(screen.getByTestId("character-dirty-hint")).toBeInTheDocument();
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.queryByTestId("character-message")).not.toBeInTheDocument();
  });

  it("notes the relay-push failure and re-apply when the action resolves applied:false", async () => {
    const { saveAction, onSaved } = renderPicker(
      {},
      jest.fn().mockResolvedValue({ ok: true, applied: false }),
    );
    await ready();

    fireEvent.click(characterOption("char-a"));
    fireEvent.click(screen.getByTestId("character-save"));

    await waitFor(() =>
      expect(saveAction).toHaveBeenCalledTimes(1),
    );
    await waitFor(() =>
      expect(screen.getByTestId("character-message")).toHaveTextContent(
        "relay push failed",
      ),
    );
    expect(screen.getByTestId("character-message")).toHaveTextContent(
      "re-applies on the next sync",
    );
    // The write still persisted — the page refresh path runs.
    expect(onSaved).toHaveBeenCalled();
    // Draft discarded.
    expect(
      screen.queryByTestId("character-dirty-hint"),
    ).not.toBeInTheDocument();
  });

  it("disables the editor and the options while writing, then recovers", async () => {
    let resolveSave!: (value: unknown) => void;
    const saveAction = jest.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );
    renderPicker({}, saveAction);
    await ready();

    fireEvent.click(characterOption("char-a"));
    await waitFor(() => expect(screen.getByTestId("character-save")).toBeEnabled());
    fireEvent.click(screen.getByTestId("character-save"));

    // In-flight: only the saving affordance remains; controls and option
    // buttons are disabled and the dirty hint gives way to the saving one.
    await waitFor(() => expect(screen.getByTestId("character-saving-hint")).toBeInTheDocument());
    expect(screen.getByTestId("character-save")).toBeDisabled();
    expect(hueRangeDisabled()).toBe(true);
    expect(hueExactDisabled()).toBe(true);
    expect(characterOption("char-b")).toBeDisabled();
    expect(agentOption("agent-bbbb")).toBeDisabled();
    expect(screen.queryByTestId("character-dirty-hint")).not.toBeInTheDocument();

    resolveSave({ ok: true, applied: true });
    await waitFor(() =>
      expect(screen.getByTestId("character-message")).toBeInTheDocument(),
    );
    expect(hueRangeDisabled()).toBe(false);
    expect(hueExactDisabled()).toBe(false);
    expect(characterOption("char-b")).toBeEnabled();
    expect(
      screen.queryByTestId("character-saving-hint"),
    ).not.toBeInTheDocument();
  });

  it("pauses the editor behind the stale-bridge gate", async () => {
    renderPicker({ disabled: true });
    await ready();

    fireEvent.click(characterOption("char-a"));
    await waitFor(() =>
      expect(characterOption("char-a")).toHaveAttribute("aria-pressed", "true"),
    );
    expect(screen.getByTestId("character-save")).toBeDisabled();
    expect(screen.getByTestId("character-dirty-hint")).toBeInTheDocument();
    expect(screen.getByTestId("character-picker-paused")).toHaveTextContent(
      "Paused while reconnecting",
    );
  });
});

describe("AgentCharacterPicker — guarded states", () => {
  it("renders the loading row while the visual catalog loads", async () => {
    renderPicker({ visualLoading: true });
    await ready();
    expect(screen.getByTestId("character-picker-loading")).toHaveTextContent(
      "Loading character catalog",
    );
    expect(
      screen.queryByTestId("character-picker-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the relay error as an alert row", async () => {
    renderPicker({ visualError: "relay down" });
    await ready();
    const row = screen.getByTestId("character-picker-error");
    expect(row).toHaveAttribute("role", "alert");
    expect(row).toHaveTextContent("Pixel Agents relay unavailable: relay down");
    expect(
      screen.queryByTestId("character-picker-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the not-configured row for an unconfigured relay", async () => {
    renderPicker({ visual: makeVisual({ configured: false }) });
    await ready();
    expect(
      screen.getByTestId("character-picker-not-configured"),
    ).toHaveTextContent("Configure the Pixel Agents relay");
    expect(
      screen.queryByTestId("character-picker-agent-selection"),
    ).not.toBeInTheDocument();
  });

  it("renders the empty row when no agents are observed", async () => {
    renderPicker({ agents: [] });
    await ready();
    expect(screen.getByTestId("character-picker-empty")).toHaveTextContent(
      "No agents observed.",
    );
    expect(
      screen.queryByTestId("character-picker-agent-selection"),
    ).not.toBeInTheDocument();
  });
});
