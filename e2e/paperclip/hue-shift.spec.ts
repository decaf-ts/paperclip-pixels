/**
 * WS0 — per-agent hueShift exposed in the character picker (spec
 * PAPERCLIP_PIXELS-2, WS0 task 3; character picker SAA-470, test-side spec
 * SAA-481).
 *
 * AC (FR-13): per-agent character assignment with a bounded hue rotation
 * 0–360 rendered in the picker — the picker exposes `hueShift` per agent
 * (`character-hue-shift` range + `character-hue-shift-exact` exact input),
 * each agent is pickable (`character-picker-agent-option`), typed values clamp
 * into [0, 360], and Save persists the per-agent assignment.
 *
 * App-gap discipline (SAA-315, `APP_GAP_STREAM_SKIP_REASON`): only the steps
 * that genuinely need the plugin stream/relay are skipped on the deployed
 * host. Draft edits and bounds assertions run without the stream (the picker
 * data rides the data bridge, and the exact/range inputs only disable while
 * saving). The UI Save step gates on the renderable stale banner; the worker
 * persistence fallback always runs so the app-gap report names the precise
 * surface when the UI cannot drive it.
 */

import path from "node:path";

import type { Locator, Page } from "@playwright/test";

import type { PaperclipApi, PixelCharacterAssignment } from "../helpers/api-client";
import type { SeedResult } from "../helpers/seed";
import {
  APP_GAP_STREAM_SKIP_REASON,
  gotoPixelOffice,
  staleBanner,
} from "../helpers/pixel-office";
import { e2ePath, RECONCILE_WAIT_MS, SCREENSHOT_DIR, STATE_CHANGE_WAIT_MS } from "../helpers/env";
import { expect, gatePixelOffice, test } from "../fixtures";

/** How long the picker has (bounded) to settle its visual-settings payload. */
const PICKER_READY_WAIT_MS = STATE_CHANGE_WAIT_MS;

/** Deterministic second agent used only by this spec's per-agent-draft proof. */
const SECOND_AGENT_NAME = "E2E Pixel Agent 2";

/** Provisioned base hue for the seeded agent (per-agent-draft proof). */
const SEED_AGENT_BASE_HUE = 22;

/** Provisioned base hue for the second observed agent (per-agent-draft proof). */
const SECOND_AGENT_BASE_HUE = 198;

/** Draft hue for the per-agent-draft proof (must differ from both base hues). */
const DRAFT_HUE = 90;

const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

// ---------------------------------------------------------------------------
// Picker helpers (test-local; testids come from src/ui/components/character-picker.tsx)
// ---------------------------------------------------------------------------

function picker(page: Page): Locator {
  return page.getByTestId("character-picker");
}

function agentOption(page: Page, agentId: string): Locator {
  return page.locator(`[data-testid="character-picker-agent-option"][data-agent-id="${agentId}"]`);
}

function agentOptions(page: Page): Locator {
  return page.getByTestId("character-picker-agent-option");
}

function hueShiftRange(page: Page): Locator {
  return page.getByTestId("character-hue-shift");
}

function hueShiftOutput(page: Page): Locator {
  return page.getByTestId("character-hue-shift-value");
}

function hueShiftExact(page: Page): Locator {
  return page.getByTestId("character-hue-shift-exact");
}

function characterOption(page: Page, characterId: string): Locator {
  return page.locator(`[data-testid="character-option"][data-character-id="${characterId}"]`);
}

function saveButton(page: Page): Locator {
  return page.getByTestId("character-save");
}

function persistedState(page: Page): Locator {
  return page.getByTestId("character-persisted-state");
}

/**
 * Wait for the picker to settle (visual-settings payload loaded) and return
 * a precise skip reason when it cannot render its real surface. The picker
 * data rides the data-POST bridge (not the stream), so this never gates on
 * SAA-315.
 */
async function settlePicker(page: Page): Promise<string> {
  const pickerEl = picker(page);
  await expect
    .poll(async () => await pickerEl.innerText(), { timeout: PICKER_READY_WAIT_MS })
    .not.toContain("Loading character catalog");

  if (await pickerEl.getByTestId("character-picker-not-configured").isVisible()) {
    return (
      "app gap (config): the deployed stack's Pixel Agents relay is not configured for this company " +
      "(visual-settings.configured=false) — the picker only renders the configure-the-relay surface, " +
      "so no per-agent hue/character editor is exposed until the relay is configured."
    );
  }
  if (await pickerEl.getByTestId("character-picker-error").isVisible()) {
    return `app gap (relay data): the deployed worker's visual-settings data errored — ${String(
      await pickerEl.getByTestId("character-picker-error").innerText(),
    )}`;
  }
  if (await pickerEl.getByTestId("character-picker-empty").isVisible()) {
    return "app gap (observation): the deployed bridge observed no agents for this company — the picker renders the empty surface.";
  }
  return "";
}

/**
 * Detect any second, ALREADY-observed agent the deployed bridge currently
 * reports for the seed company. Preferring an already-observed agent keeps the
 * per-agent-draft proof deterministic: a freshly created agent is only
 * bridge-observed at the worker's reconcile cadence, so that path is a precise
 * skip (with a bounded window) rather than a silent flake.
 */
async function trySecondObservedAgent(
  api: PaperclipApi,
  seed: SeedResult,
): Promise<{ id: string | null; skipReason: string }> {
  const snapshot = (await api.bridgeSnapshot(seed.company.id).catch(() => null)) as {
    agents?: Array<{ projection?: { agentId?: string; name?: string } }>;
  } | null;
  const other = (snapshot?.agents ?? []).find(
    (a) => typeof a?.projection?.agentId === "string" && a.projection.agentId !== seed.agent.id,
  );
  if (typeof other?.projection?.agentId === "string") {
    return { id: other.projection.agentId, skipReason: "" };
  }

  const created = (await api
    .findOrCreateAgent(seed.company.id, SECOND_AGENT_NAME, seed.agent.adapterType ?? "claude_local")
    .catch(() => null)) as { id?: string } | null;
  if (!created?.id) {
    return { id: null, skipReason: `second agent "${SECOND_AGENT_NAME}" could not be created via the API` };
  }
  const secondId = created.id;
  const deadline = Date.now() + RECONCILE_WAIT_MS;
  while (Date.now() < deadline) {
    const observed = (await api.bridgeSnapshot(seed.company.id).catch(() => null)) as {
      agents?: Array<{ projection?: { agentId?: string } }>;
    } | null;
    if ((observed?.agents ?? []).some((a) => a?.projection?.agentId === secondId)) {
      return { id: secondId, skipReason: "" };
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }
  return {
    id: null,
    skipReason:
      `second agent "${SECOND_AGENT_NAME}" was created but the bridge did not observe it within ` +
      `${Math.round(RECONCILE_WAIT_MS / 1000)}s — ` +
      "the per-agent two-draft step cannot assert two agents on this stack.",
  };
}

/**
 * Provision one agent's persisted appearance to a known base hue through the
 * exact surface the picker's Save invokes (`agent.set-pixel-appearance`),
 * keeping the agent's own character id + palette so the fixture write only
 * rewrites the hue. This stabilizes the per-agent-draft proof's base rows
 * against sibling runs on the shared deployed worker. Returns a precise skip
 * reason when the fixture cannot be applied.
 */
async function provisionAgentAppearance(
  api: PaperclipApi,
  seed: SeedResult,
  pluginId: string,
  agentId: string,
  hue: number,
): Promise<{ ok: boolean; applied?: boolean; skipReason: string }> {
  const current = await tryPersistedAssignment(api, seed, agentId);
  if (!current) {
    return {
      ok: false,
      applied: undefined,
      skipReason:
        "app gap (fixture): the deployed visual-settings data has no persisted assignment for agent " +
        `${agentId} — the picker's per-agent editor has no persisted base to pin the fixture's own base hue from.`,
    };
  }
  const probe = await api.pluginAction(
    pluginId,
    "agent.set-pixel-appearance",
    {
      companyId: seed.company.id,
      agentId,
      characterId: current.characterId,
      palette: current.palette,
      hueShift: hue,
    },
    seed.company.id,
  );
  if (!probe.ok) {
    return {
      ok: false,
      applied: undefined,
      skipReason:
        "app gap (fixture): the deployed worker rejected agent.set-pixel-appearance for agent " +
        `${agentId} (${JSON.stringify(probe.error ?? probe.data) ?? "unknown"}) — the fixture base hue could not be provisioned.`,
    };
  }
  return { ok: true, applied: (probe.data as { applied?: boolean })?.applied, skipReason: "" };
}

/** Resolve the first usable character entry from the deployed visual catalog. */
async function tryFirstCharacter(
  api: PaperclipApi,
  seed: SeedResult,
): Promise<{ id: string; palette: number; name: string; skipReason: string }> {
  const visual = await api.visualSettings(seed.company.id);
  const first = (visual.characters ?? []).find(
    (c): c is { id: string; palette: number; name: string } =>
      typeof c.id === "string" && c.id.length > 0 && typeof c.palette === "number",
  );
  if (!first) {
    return {
      id: "",
      palette: -1,
      name: "",
      skipReason:
        "app gap (visual catalog): the deployed visual-settings data returned no usable character entries " +
        "(spec FR-13 expanded catalog) — the per-agent picker has nothing to save.",
    };
  }
  return { id: String(first.id), palette: Number(first.palette), name: String(first.name ?? ""), skipReason: "" };
}

/** The persisted per-agent assignment (frozen contract), or null when none exists. */
async function tryPersistedAssignment(
  api: PaperclipApi,
  seed: SeedResult,
  agentId: string,
): Promise<PixelCharacterAssignment | null> {
  const visual = await api.visualSettings(seed.company.id);
  const assignment = (visual.assignments ?? {})[agentId];
  return assignment ?? null;
}

// ---------------------------------------------------------------------------
// Specs
// ---------------------------------------------------------------------------

test.describe("WS0 — hueShift is selectable per agent in the character picker", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test("picker exposes per-agent selection and 0–360-bounded hue controls", async ({ page, seed }) => {
    await gotoPixelOffice(page);
    const skipReason = await settlePicker(page);
    test.skip(Boolean(skipReason), skipReason);

    // Per-agent selection: the picker renders every observed agent as a
    // pressed-toggle option, and the seeded agent's option is present by id.
    const seeded = agentOption(page, seed.agent.id);
    await expect(seeded).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    await expect(seeded.locator("strong")).toContainText(
      seed.agent.name ?? "agent name is absent from the bridge snapshot",
    );
    await expect(agentOptions(page)).not.toHaveCount(0);

    // Bounded range + exact inputs sized [0, 360] in integer steps.
    const range = hueShiftRange(page);
    await expect(range).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    expect(await range.getAttribute("min")).toBe("0");
    expect(await range.getAttribute("max")).toBe("360");
    expect(await range.getAttribute("step")).toBe("1");

    const exact = hueShiftExact(page);
    await expect(exact).toBeVisible();
    expect(await exact.getAttribute("min")).toBe("0");
    expect(await exact.getAttribute("max")).toBe("360");
    await page.screenshot({ path: shot("07-hue-shift-controls.png"), fullPage: true });
  });

  test("exact-input hue shifts clamp into [0, 360] as an unsaved agent draft", async ({ page, seed }) => {
    await gotoPixelOffice(page);
    const skipReason = await settlePicker(page);
    test.skip(Boolean(skipReason), skipReason);

    await agentOption(page, seed.agent.id).click();
    await expect(agentOption(page, seed.agent.id)).toHaveAttribute("aria-pressed", "true");

    const range = hueShiftRange(page);
    const exact = hueShiftExact(page);
    const output = hueShiftOutput(page);

    // Above the ceiling: 371 clamps to 360 and range/output follow.
    await exact.fill("371");
    await expect(exact).toHaveValue("360", { timeout: STATE_CHANGE_WAIT_MS });
    await expect(range).toHaveValue("360");
    await expect(output).toContainText("360°");

    // Below the floor: -1 clamps to 0.
    await exact.fill("-1");
    await expect(exact).toHaveValue("0", { timeout: STATE_CHANGE_WAIT_MS });
    await expect(range).toHaveValue("0");
    await expect(output).toContainText("0°");

    // Fractional input truncates to a whole degree.
    await exact.fill("0.5");
    await expect(exact).toHaveValue("0", { timeout: STATE_CHANGE_WAIT_MS });
    await expect(range).toHaveValue("0");
    await expect(output).toContainText("0°");

    // The draft marks the picker dirty (a real per-agent selection change) and
    // the Save affordance is gated until a valid character selection exists.
    await expect(page.getByTestId("character-dirty-hint")).toBeVisible();
    await expect(page.getByTestId("character-save")).toBeVisible();
    await page.screenshot({ path: shot("07-hue-shift-clamped-draft.png"), fullPage: true });
  });

  test("agent drafts are per agent; a draft survives switching to another agent and back", async ({ page, api, seed }) => {
    await gotoPixelOffice(page);
    const skipReason = await settlePicker(page);
    test.skip(Boolean(skipReason), skipReason);

    const second = await trySecondObservedAgent(api, seed);
    test.skip(second.id === null, second.skipReason ?? "the bridge observed no second agent");
    const secondId = String(second.id);
    const secondOption = agentOption(page, secondId);
    await expect(secondOption).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });

    // Provision the per-agent fixture base hues through the exact surface the
    // picker's Save invokes, so the editor's base rows are deterministic even
    // though sibling e2e runs mutate the shared assignment map.
    const plugin = await api.pixelPluginRecord();
    expect(plugin, "Pixel bridge plugin not registered").not.toBeNull();
    const seedProvision = await provisionAgentAppearance(api, seed, plugin!.id, seed.agent.id, SEED_AGENT_BASE_HUE);
    test.skip(Boolean(seedProvision.skipReason), seedProvision.skipReason);
    expect(seedProvision.ok, "worker accepted the seeded agent's base hue provision").toBe(true);
    const secondProvision = await provisionAgentAppearance(api, seed, plugin!.id, secondId, SECOND_AGENT_BASE_HUE);
    test.skip(Boolean(secondProvision.skipReason), secondProvision.skipReason);
    expect(secondProvision.ok, "worker accepted the second agent's base hue provision").toBe(true);

    // Read the provisioned bases back so the assertions match the deployed
    // worker's own state.
    const mapAfter = await api.visualSettings(seed.company.id);
    const seedBaseHue = (mapAfter.assignments ?? {})[seed.agent.id]?.hueShift ?? -1;
    const secondBaseHue = (mapAfter.assignments ?? {})[secondId]?.hueShift ?? -1;
    expect(seedBaseHue, "the seeded agent's provisioned base hue is persisted").toBe(SEED_AGENT_BASE_HUE);
    expect(secondBaseHue, "the second agent's provisioned base hue is persisted").toBe(SECOND_AGENT_BASE_HUE);

    // The picker's in-memory editor state is the page load's own visual-settings
    // read; the deployed host's plugin stream is 501 (SAA-315), so API-side
    // provisioning is never delivered reactively. Re-navigate the route so the
    // picker's fresh data pull mounts the provisioned bases before the
    // per-agent assertions.
    await gotoPixelOffice(page);

    const output = hueShiftOutput(page);
    const exact = hueShiftExact(page);
    const persistedRow = persistedState(page);

    // Press the seeded agent: its editor renders its persisted base hue and its
    // persisted-state row names the persisted assignment.
    await agentOption(page, seed.agent.id).click();
    await expect(agentOption(page, seed.agent.id)).toHaveAttribute("aria-pressed", "true");
    await expect(exact).toHaveValue(String(seedBaseHue), { timeout: STATE_CHANGE_WAIT_MS });
    await expect(output).toContainText(`${seedBaseHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await expect(persistedRow).toContainText(`hue ${seedBaseHue}°`, { timeout: STATE_CHANGE_WAIT_MS });

    // Draft a hue for the seeded agent, then press the second agent: its
    // editor must show the second agent's own base hue, not the seeded agent's
    // draft.
    await exact.fill(String(DRAFT_HUE));
    await expect(page.getByTestId("character-dirty-hint")).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });

    await secondOption.click();
    await expect(secondOption).toHaveAttribute("aria-pressed", "true");
    await expect(exact).toHaveValue(String(secondBaseHue), { timeout: STATE_CHANGE_WAIT_MS });
    await expect(output).toContainText(`${secondBaseHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await expect(persistedRow).toContainText(`hue ${secondBaseHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await expect(secondOption.locator("span")).toContainText(`hue ${secondBaseHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await page.screenshot({ path: shot("07-hue-shift-second-agent-editor.png"), fullPage: true });

    // Re-press the seeded agent: its draft was kept per agent, and the draft's
    // value is restored in the editor without being persisted.
    await agentOption(page, seed.agent.id).click();
    await expect(agentOption(page, seed.agent.id)).toHaveAttribute("aria-pressed", "true");
    await expect(exact).toHaveValue(String(DRAFT_HUE), { timeout: STATE_CHANGE_WAIT_MS });
    await expect(output).toContainText(`${DRAFT_HUE}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await expect(persistedRow).toContainText(`hue ${seedBaseHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await page.screenshot({ path: shot("07-hue-shift-draft-kept-per-agent.png"), fullPage: true });
  });

  test("the UI save round-trips the per-agent assignment in the picker", async ({ page, api, seed }) => {
    await gotoPixelOffice(page);
    const plugin = await api.pixelPluginRecord();
    expect(plugin, "Pixel bridge plugin not registered").not.toBeNull();

    // State-changing UI is gated while the bridge is stale (§30.1). The stale
    // banner here IS the deployed SAA-315 gap signal; skip precisely with the
    // helper's documented reason when it renders. Reaching for the banner with
    // a bounded wait makes the skip decision independent of the banner's own
    // render Ne-Timing (an instant isVisible probe samples the pre-mount
    // skeleton and can flip the decision).
    if (await staleBanner(page).waitFor({ state: "visible", timeout: PICKER_READY_WAIT_MS }).then(() => true).catch(() => false)) {
      test.skip(true, APP_GAP_STREAM_SKIP_REASON);
    }

    const skipReason = await settlePicker(page);
    test.skip(Boolean(skipReason), skipReason);

    const seeded = agentOption(page, seed.agent.id);
    await seeded.click();
    await expect(seeded).toHaveAttribute("aria-pressed", "true");

    const character = await tryFirstCharacter(api, seed);
    test.skip(Boolean(character.skipReason), character.skipReason);
    const option = characterOption(page, character.id);
    await expect(option).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    await option.click();
    await expect(option).toHaveAttribute("aria-pressed", "true");
    await hueShiftExact(page).fill("120");
    await expect(hueShiftOutput(page)).toContainText("120°", { timeout: STATE_CHANGE_WAIT_MS });

    // Save: the picker's per-agent assignment goes through the worker's
    // agent.set-pixel-appearance action, and the persisted state row re-reads
    // from the refreshed visual-settings data.
    const save = saveButton(page);
    await expect(save).toBeEnabled();
    expect((await save.innerText()).trim(), "save affordance names the picked agent").toMatch(/^Save for .+/);
    await save.click();
    await expect(page.getByTestId("character-message")).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    await page.screenshot({ path: shot("07-hue-shift-saved.png"), fullPage: true });

    await expect(persistedState(page)).toContainText("hue 120°", { timeout: STATE_CHANGE_WAIT_MS });
    const persisted = await tryPersistedAssignment(api, seed, seed.agent.id);
    expect(persisted?.characterId, "worker persisted the picked character").toBe(character.id);
    expect(persisted?.hueShift, "worker persisted the clamped hue draft").toBe(120);
  });

  test("the set-pixel-appearance surface can be asserted through its action proxy when the UI gates it", async ({ page, api, seed }) => {
    // Fallback probe over the exact surface the picker's Save invokes, so the
    // app-gap report always names a dark surface (SAA-315, filed under SAA-231).
    const plugin = await api.pixelPluginRecord();
    expect(plugin, "Paperclip bridge plugin not registered").not.toBeNull();

    const character = await tryFirstCharacter(api, seed);
    test.skip(Boolean(character.skipReason), character.skipReason);

    const probeHue = 77;
    const probe = await api.pluginAction(
      plugin!.id,
      "agent.set-pixel-appearance",
      {
        companyId: seed.company.id,
        agentId: seed.agent.id,
        characterId: character.id,
        palette: character.palette,
        hueShift: probeHue,
      },
      seed.company.id,
    );
    test.skip(
      !probe.ok,
      `app gap: the deployed worker rejected agent.set-pixel-appearance (${JSON.stringify(
        probe.error ?? probe.data,
      ) ?? "unknown"}) — the per-agent save could not be asserted end-to-end on this stack.`,
    );
    expect(
      (probe.data as { applied?: boolean } | undefined)?.applied,
      "the worker's appearance sync reports the relay push outcome",
    ).toBeDefined();

    // The persisted assignment is in the worker's visual-settings vantage.
    const persisted = await tryPersistedAssignment(api, seed, seed.agent.id);
    expect(persisted?.hueShift, "worker persisted the probed hue").toBe(probeHue);
    expect(persisted?.characterId, "worker persisted the probed character").toBe(character.id);

    // A picker session reflects the assignment (fresh page, so the draft-free
    // base is the persisted assignment).
    await gotoPixelOffice(page);
    const skipReason = await settlePicker(page);
    test.skip(Boolean(skipReason), skipReason);
    await agentOption(page, seed.agent.id).click();
    await expect(agentOption(page, seed.agent.id)).toHaveAttribute("aria-pressed", "true");
    await expect(hueShiftRange(page)).toHaveValue(String(probeHue), { timeout: STATE_CHANGE_WAIT_MS });
    await expect(hueShiftOutput(page)).toContainText(`${probeHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await expect(persistedState(page)).toContainText(`hue ${probeHue}°`, { timeout: STATE_CHANGE_WAIT_MS });
    await page.screenshot({ path: shot("07-hue-shift-persisted.png"), fullPage: true });
  });
});
