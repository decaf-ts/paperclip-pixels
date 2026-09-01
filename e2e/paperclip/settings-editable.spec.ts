/**
 * WS0 — Pixel Office plugin settings: editable global-only config form (spec
 * PAPERCLIP_PIXELS-2, WS0 task 2; UI implementation SAA-461, test-side spec
 * SAA-481).
 *
 * AC: the plugin's Company Settings → Plugins → Paperclip Pixel Bridge page
 * auto-renders an EDITABLE host form from `instanceConfigSchema` containing
 * all 7 operator fields (each editable/enabled); the obsolete custom
 * read-only "Pixel Office settings" block (which suppressed the auto form) is
 * gone; the settings surface is global-only (no per-agent values); and the
 * plugin contribution no longer declares a custom `settingsPage` slot.
 *
 * The host's PluginConfigForm renders no data-testids, so fields are located
 * by their `instanceConfigSchema.title` labels from src/manifest.ts. The
 * plugin id and company prefix are discovered at runtime, never hardcoded.
 * Edits are browser-local only — the suite never saves operator config.
 */

import path from "node:path";

import type { Locator, Page } from "@playwright/test";

import type { Company, PaperclipApi } from "../helpers/api-client";
import type { SeedResult } from "../helpers/seed";
import { e2ePath, HOST_BASE_URL, SCREENSHOT_DIR, STATE_CHANGE_WAIT_MS } from "../helpers/env";
import { expect, gatePixelOffice, test } from "../fixtures";

const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

interface OperatorField {
  key: string;
  label: string;
  kind: "string" | "secret" | "boolean";
}

/** The 7 operator fields from src/manifest.ts instanceConfigSchema. */
const OPERATOR_FIELDS: ReadonlyArray<OperatorField> = [
  { key: "pixelAgentsUrl", label: "Pixel Agents server URL", kind: "string" },
  { key: "pixelAgentsUiUrl", label: "Pixel Agents browser URL", kind: "string" },
  { key: "pixelAgentsTokenRef", label: "Pixel Agents bearer token", kind: "secret" },
  { key: "pixelAgentsProviderId", label: "Provider id", kind: "string" },
  { key: "pixelAgentsRelayEnabled", label: "Relay enabled", kind: "boolean" },
  {
    key: "paperclipApiBaseUrl",
    label: "Paperclip API base URL (for real tool descriptions)",
    kind: "string",
  },
  {
    key: "paperclipApiTokenRef",
    label: "Paperclip API bearer token (for real tool descriptions)",
    kind: "secret",
  },
];

test.describe("WS0 — plugin settings screen is the host auto-form (editable, global-only)", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test("the plugin contribution no longer declares a custom settingsPage slot", async ({ api }) => {
    const contribution = await api.pixelOfficeContribution();
    expect(contribution, "Pixel Office UI contribution not found").not.toBeNull();

    const slotTypes = ((contribution!.slots ?? []) as Array<{ type?: string; [k: string]: unknown }>)
      .map((slot) => slot.type)
      .filter((value): value is string => typeof value === "string");
    // WS0 dropped the custom settingsPage slot so the host auto-form applies.
    expect(slotTypes).not.toContain("settingsPage");
    expect(slotTypes).toEqual(expect.arrayContaining(["page", "sidebar"]));
  });

  test("the settings screen auto-renders the editable 7-field operator form (global-only)", async ({ page, api, seed }) => {
    await page.goto(await pluginSettingsUrl(api, seed), { waitUntil: "domcontentloaded" });

    await assertSettingsScreenLoaded(page);
    await assertObsoleteCustomBlockGone(page);

    for (const field of OPERATOR_FIELDS) {
      await assertFieldPresentAndEditable(page, field);
    }
    await page.screenshot({ path: shot("06-settings-global-form.png"), fullPage: true });
  });

  test("editing an operator field tracks dirty state in place and reloads unchanged", async ({ page, api, seed }) => {
    await page.goto(await pluginSettingsUrl(api, seed), { waitUntil: "domcontentloaded" });

    await assertSettingsScreenLoaded(page);

    const saveButton = page.getByRole("button", { name: "Save Configuration", exact: true });
    await expect(saveButton).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    // A fresh form load starts clean (no spurious mutation path).
    await expect(saveButton).toBeDisabled();

    // Browser-local, never-saved edit: the save affordance turns on when an
    // operator field changes, and the reload discards the draft so the saved
    // config on this stack stays untouched.
    const providerField: OperatorField = {
      key: "pixelAgentsProviderId",
      label: "Provider id",
      kind: "string",
    };
    const input = fieldControl(page, providerField);
    const before = await input.inputValue();
    await input.fill(`${before}-e2e-probe`);
    await expect(page.getByRole("button", { name: "Save Configuration", exact: true })).toBeEnabled();

    // The boolean control is editable too; toggling it is also never saved.
    const relayEnabled = page.getByRole("checkbox", { name: "Relay enabled" });
    await expect(relayEnabled).toBeEnabled();
    const checkedBefore = await relayEnabled.getAttribute("aria-checked");
    await relayEnabled.click();
    await expect(relayEnabled).toHaveAttribute("aria-checked", checkedBefore === "true" ? "false" : "true");
    await page.screenshot({ path: shot("06-settings-dirty-probe.png"), fullPage: true });

    // Reload discards the browser-local draft; the saved config value restores.
    await page.reload({ waitUntil: "domcontentloaded" });
    await assertSettingsScreenLoaded(page);
    const restored = await fieldControl(page, providerField).inputValue();
    expect(restored, "an unsaved operator field edit must not persist").toBe(before);
  });
});

// ---------------------------------------------------------------------------
// Settings-screen helpers (spec-local; the host form has no data-testids, so
// the assertions anchor on the auto-form's title labels and control kinds).
// ---------------------------------------------------------------------------

async function pluginSettingsUrl(api: PaperclipApi, seed: SeedResult): Promise<string> {
  const plugin = await api.pixelPluginRecord();
  expect(plugin, "Paperclip Pixel Bridge plugin not registered").not.toBeNull();
  const companies = (await api.listCompanies()) as Array<Company & { issuePrefix?: string | null }>;
  const company = companies.find((row) => row.id === seed.company.id) ?? companies[0];
  const prefix = (company?.issuePrefix ?? "").trim().toUpperCase();
  expect(
    prefix,
    "seed company has no usable issue prefix for the company-scoped settings route",
  ).toMatch(/^[A-Z]+$/);
  return `${HOST_BASE_URL}/${prefix}/company/settings/instance/plugins/${plugin!.id}`;
}

/** The PluginSettings screen with its self-verifying Configuration tab active. */
async function assertSettingsScreenLoaded(page: Page): Promise<void> {
  const heading = page.getByRole("heading", { name: "Paperclip Pixel Bridge", exact: true });
  await expect(heading).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });

  const triggerEl = page
    .locator('[data-slot="tabs-trigger"]')
    .filter({ hasText: "Configuration" });
  await expect(triggerEl).toHaveAttribute("data-state", "active");
  await expect(triggerEl).toBeVisible();
}

/** The obsolete custom read-only surface (which suppressed the auto form) must be gone. */
async function assertObsoleteCustomBlockGone(page: Page): Promise<void> {
  await expect(page.getByText("Pixel Office settings", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Connection values are managed by", { exact: false })).toHaveCount(0);
  // Global-only: no per-agent surface on the settings screen.
  await expect(page.getByTestId("character-picker")).toHaveCount(0);
  await expect(page.getByText("Per-agent characters", { exact: true })).toHaveCount(0);
}

/** Every operator field's title label must be present exactly once. */
async function assertFieldTitleOnce(page: Page, field: OperatorField): Promise<Locator> {
  const fieldTitle = page.locator('label[data-slot="label"]').filter({ hasText: field.label });
  await expect(fieldTitle, `operator field "${field.label}" title`).toHaveCount(1);
  return fieldTitle;
}

/** Every operator field must render as an editable control of the right kind. */
async function assertFieldPresentAndEditable(page: Page, field: OperatorField): Promise<Locator> {
  await assertFieldTitleOnce(page, field);
  const control = fieldControl(page, field);
  await expect(
    control,
    `operator field "${field.label}" (${field.kind}) control`,
  ).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
  await expect(control).toBeEnabled();
  return control;
}

/**
 * FieldWrapper renders `div.space-y-2 > div.flex (title) + control + description + error`.
 * Boolean fields are Radix checkboxes named by their linked title instead.
 */
function fieldControl(page: Page, field: OperatorField): Locator {
  switch (field.kind) {
    case "boolean":
      return page.getByRole("checkbox", { name: field.label });
    case "secret":
      // allowVersionSelector={false} → exactly the binding <select>.
      return fieldWrapper(page, field).locator("select").first();
    default:
      return fieldWrapper(page, field).locator("input, textarea").first();
  }
}

function fieldWrapper(page: Page, field: OperatorField): Locator {
  return page
    .locator("div.space-y-2")
    .filter({ has: page.locator('label[data-slot="label"]').filter({ hasText: field.label }) })
    .first();
}
