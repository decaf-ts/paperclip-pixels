/**
 * Scenario 4 (bonus) — Stale/disconnect safety (spec PAPERCLIP_PIXELS-1, §30,
 * SAA-231).
 *
 * AC (bonus): when the bridge is disconnected, `pixel-office-stale-banner`
 * appears and state-changing actions are paused; recovery on re-enable.
 *
 * This is gated behind PAPERCLIP_PIXEL_E2E_STALE=1 because disabling the plugin
 * worker (POST /api/plugins/:id/disable) or killing a pod is disruptive and can
 * be flaky. It is OFF by default; if it cannot be made stable, it stays a
 * documented gap rather than eroding the suite.
 */

import path from "node:path";

import { e2ePath, SCREENSHOT_DIR, STATE_CHANGE_WAIT_MS } from "../helpers/env";
import { gotoPixelOffice, staleBanner } from "../helpers/pixel-office";
import { expect, gatePixelOffice, test } from "../fixtures";

const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

const STALE_ENABLED = process.env.PAPERCLIP_PIXEL_E2E_STALE === "1";

// Gate at collection time (not beforeEach): the seeded/stale scenarios use the
// shared `api` fixture, which performs a real UI login BEFORE beforeEach runs.
// Gating in beforeEach meant the (default-off) bonus test still paid a full
// login per run — and could fail on a transient host blip while loading /auth
// even though it should skip. Module-level test.skip(condition) short-circuits
// the file before any fixture work.
test.skip(!STALE_ENABLED, "stale/disconnect test is opt-in (PAPERCLIP_PIXEL_E2E_STALE=1); default gap");

test.describe("Scenario 4 (bonus) — stale/disconnect safety", () => {
  test.beforeEach(async ({ api, seed }) => {
    // `seed` must resolve first: it creates the company that grants the
    // actor org access, which the ui-contributions call inside the gate
    // requires (assertBoardOrgAccess 403s for a company-less actor).
    void seed;
    await gatePixelOffice(api);
  });

  test("stale banner appears and state-changing actions pause while disconnected", async ({ page, api }) => {
    await gotoPixelOffice(page);

    const plugins = await api.listPlugins();
    const pixelPlugin = plugins.find((p) => p.pluginKey.includes("paperclip-pixel"));
    expect(pixelPlugin, "Pixel bridge plugin not found in registry").not.toBeNull();
    const pluginId = pixelPlugin!.id;

    await api.disablePlugin(pluginId);

    try {
      await expect(staleBanner(page)).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
      // State-changing actions are paused while stale.
      await expect(page.getByTestId("company-intake-send")).toBeDisabled();
      const replyBtn = page.getByTestId("feedback-popup").first().getByTestId("feedback-reply");
      if (await replyBtn.count()) {
        await expect(replyBtn).toBeDisabled();
      }
      await page.screenshot({ path: shot("04-stale-banner.png"), fullPage: true });

      // Recovery on re-enable.
      await api.enablePlugin(pluginId);
      await expect(staleBanner(page)).toBeHidden({ timeout: STATE_CHANGE_WAIT_MS });
    } finally {
      // Always leave the plugin enabled.
      await api.enablePlugin(pluginId).catch(() => undefined);
    }
  });
});
