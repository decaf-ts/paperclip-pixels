/**
 * Shared Playwright fixtures for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * - `api`: a PaperclipApi authenticated with the board user's UI-login session
 *   cookie (the real browser session path is exercised).
 * - `seed`: idempotent test company + agent + assigned issue.
 *
 * Each spec gates itself on the Pixel Office UI being wired (SAA-230 done) via
 * `gatePixelOffice(api)` in `test.beforeAll`.
 */

import { test as base, expect } from "@playwright/test";

import { PaperclipApi } from "./helpers/api-client";
import { loginViaUi } from "./helpers/login";
import { seedCompanyAgentIssue, type SeedResult } from "./helpers/seed";

export interface SuiteFixtures {
  api: PaperclipApi;
  seed: SeedResult;
}

export const test = base.extend<SuiteFixtures>({
  api: async ({ page }, use) => {
    const { cookieValue } = await loginViaUi(page);
    const api = new PaperclipApi(cookieValue);
    await use(api);
  },
  seed: async ({ api }, use) => {
    const seed = await seedCompanyAgentIssue(api);
    await use(seed);
  },
});

export { expect };

import { SKIP_WHEN_UNWIRED } from "./helpers/env";

/**
 * Gate: skip the suite gracefully when the Pixel Office UI slot is not wired
 * (SAA-230 not done). Set PAPERCLIP_PIXEL_E2E_NO_GATE=1 to force a real run
 * (fail rather than skip) — used after SAA-230 lands.
 */
export async function gatePixelOffice(api: PaperclipApi): Promise<void> {
  const contribution = await api.pixelOfficeContribution();
  const wired = Boolean(contribution && contribution.slots.length > 0);
  if (!wired && SKIP_WHEN_UNWIRED) {
    // eslint-disable-next-line no-console
    console.log("[e2e:gate] Pixel Office UI not wired (SAA-230 not done) — skipping suite.");
  }
  base.skip(!wired && SKIP_WHEN_UNWIRED, "Pixel Office UI not wired (SAA-230 not done)");
}
