/**
 * Scenario 2 flag — Stale / disconnect safety (spec PAPERCLIP_PIXELS-1, §30,
 * SAA-231; WS5-C SAA-757 re-anchor), + WS5-C new-surface assessment for the
 * click menu / dialog-pane feed while the bridge is down.
 *
 * AC: when the bridge is disconnected `pixel-office-stale-banner` appears and
 * state-changing actions are paused (§30.1); recovery on re-enable.
 *
 * REAL TIMING CONTRACT (deterministic — verified on the deployed stack
 * 2026-09-05, SAA-757; supersedes the old "default gap" claim from SAA-754):
 *
 *   - Staleness is `hasSnapshot && !streamConnected && (now - lastSyncedAt) > 90s`
 *     (`src/ui/use-bridge.ts:61-70`). On this host the SSE stream is
 *     permanently down (see the HOST GAP note below), so `stale` is driven by
 *     `state.lastSyncedAt` (= `snapshot.observedAt`, `src/ui/state.ts:85`).
 *   - `observedAt` refreshes ONLY when the worker actually rebuilds the
 *     snapshot (bootstrap/event/reconcile, `src/snapshot.ts:198`) — NOT on
 *     every successful poll. So on a quiet system the banner is already up at
 *     page load; on a freshly-active system it needs ≥90s of silence after
 *     disable.
 *   - `POST /api/plugins/:id/data/bridge-snapshot` is the worker's snapshot
 *     data handler. The host route short-circuits `502 WORKER_UNAVAILABLE`
 *     when `plugin.status !== "ready"` (`paperclip/server/src/routes/plugins.ts`,
 *     data-route guard ~line 1603) — disable transitions the plugin out of
 *     `ready`. So the probe returns 502 while disabled and 200 when ready.
 *   - The `Origin` header must be sent on probes / board mutations (the
 *     board-mutation guard answers 403 otherwise); the `api` fixture's client
 *     sends the deployment's own origin.
 *
 * This spec is OPT-IN behind `PAPERCLIP_PIXEL_E2E_STALE=1`: it is a ~4-minute
 * destructive test (it disables the shared stack's plugin worker for ~150s and
 * briefly pauses every state-changing action on the Pixel Office), so it must
 * not run in the default suite or during a concurrent workstream leg. It is
 * deterministic now — not gated because it is flaky.
 *
 * HOST GAP (documented, NOT the reason for the banner): `usePluginStream`'s
 * `GET /api/plugins/:id/bridge/stream/:channel` unconditionally 501s on hosts
 * that never construct `bridgeDeps.streamBus` at server bootstrap, so
 * `stream.connected` is permanently false (`src/ui/use-bridge.ts` doc comment).
 * The staleness path (driven purely by snapshot freshness) is implemented,
 * deterministic behavior — it is NOT an SAA-315 exception.
 *
 * WS5-C NEW-SURFACE (observed on the deployed stack, 2026-09-05): while the
 * Paperclip plugin worker is disabled/stale, the Pixel Office's office iframe
 * STAYS MOUNTED (the Pixel Agents webview is served by the pixel-agents relay,
 * which is independent of the Paperclip plugin worker), and no agent-menu
 * overlay is open (it only appears on a character click). Recorded behavior,
 * no invented expectation; the pixel-agents-side plugin host (click menu /
 * dialog-pane conversation feed) is decoupled from the Paperclip plugin worker,
 * so the state-changing gates that truly pause while stale are the Pixel Office
 * page's own (§30.1: company-intake-send, feedback-reply, character picker).
 */

import path from "node:path";

import { e2ePath, RECONCILE_WAIT_MS, SCREENSHOT_DIR, STATE_CHANGE_WAIT_MS } from "../helpers/env";
import { gotoPixelOffice, staleBanner } from "../helpers/pixel-office";
import { expect, gatePixelOffice, test } from "../fixtures";

const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

const STALE_ENABLED = process.env.PAPERCLIP_PIXEL_E2E_STALE === "1";

/**
 * Stale-specific wait: STALE_AFTER_MS (90s) + one 20s poll slot + margin. The
 * page's `stale` recomputes each render; a disabled worker stops refreshing
 * `observedAt`, so the banner appears once the retained snapshot passes the
 * 90s threshold plus up to one poll interval. 150s bounds the worst case.
 */
const STALE_WAIT_MS = 150_000;
/** A snapshot is "fresh" for the baseline if `observedAt` is within this window. */
const FRESH_WINDOW_MS = 30_000;

// Gate at collection time (module-level): this is a long destructive test that
// must be explicitly enabled, and gating in beforeEach would still pay the
// login + gate cost when skipped.
test.skip(!STALE_ENABLED, "stale/disconnect test is opt-in (PAPERCLIP_PIXEL_E2E_STALE=1)");

test.use({ viewport: { width: 1280, height: 1080 } });

test.describe("Scenario 2 — stale/disconnect safety (WS5-C)", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test(
    "stale banner appears, state-changing actions pause while disconnected, correct resume after reconnect",
    async ({ page, api, seed }) => {
      test.setTimeout(300_000);
      await gotoPixelOffice(page);

      const plugins = await api.listPlugins();
      const pixelPlugin = plugins.find((p) => p.pluginKey.includes("paperclip-pixel"));
      expect(pixelPlugin, "Pixel bridge plugin not found in registry").not.toBeNull();
      const pluginId = pixelPlugin!.id;

      // ── Establish a FRESH baseline. On a quiet system the snapshot's
      // `observedAt` is already >90s old, so the banner is up before we even
      // begin — the disable path would be vacuous. Force a worker rebuild via
      // disable->enable (restarts setupCompany -> bootstrapSnapshot -> fresh
      // `observedAt`), wait until the probe returns a fresh observedAt, then
      // reload the page so the office fetches that fresh snapshot. Assert the
      // banner is absent and state-changing actions are enabled.
      await api.enablePlugin(pluginId).catch(() => undefined);
      await api.disablePlugin(pluginId);
      await api.enablePlugin(pluginId);

      const baselineObservedAt = await waitForFreshSnapshot(api, seed.company.id);
      await page.reload({ waitUntil: "domcontentloaded" });
      await expect(staleBanner(page)).toBeHidden({ timeout: STATE_CHANGE_WAIT_MS });
      await expect(page.getByTestId("company-intake-send")).toBeEnabled();
      const baselineStatus = await bridgeStatus(page);
      expect(baselineStatus).toContain("last synchronized");

      // ── Disable the plugin worker. The snapshot data endpoint stops
      // answering (502 while `status !== "ready"`), so `observedAt` stops
      // advancing and the banner must appear after the 90s + poll slack.
      await api.disablePlugin(pluginId);

      try {
        // Supporting probe: HTTP 502 while disabled (the deployment's own
        // Origin header rides the api fixture client).
        await expectSnapshotProbe(api, seed.company.id, 502);

        // New-surface observation (record actual behavior while the bridge is
        // down — do not invent expected behavior): note whether the office
        // iframe / webview click-menu + dialog-pane surface stays mounted while
        // the Paperclip plugin worker is disabled.
        const officeIframeCount = await officeFrameCount(page);
        console.log(`[stale:new-surface] office iframes mounted while disabled: ${officeIframeCount}`);

        // The banner appears deterministically after the stale threshold.
        await expect(staleBanner(page)).toBeVisible({ timeout: STALE_WAIT_MS });

        // State-changing actions are paused while stale.
        await expect(page.getByTestId("company-intake-send")).toBeDisabled();
        const replyBtn = page.getByTestId("feedback-popup").first().getByTestId("feedback-reply");
        if (await replyBtn.count()) {
          await expect(replyBtn).toBeDisabled();
        }
        // Character picker is non-actionable: either the stale `paused` gate
        // is shown or the picker surfaced its data-unavailable error (the
        // visual-settings data endpoint also 502s while the worker is down).
        const paused = page.getByTestId("character-picker-paused");
        const pickerError = page.getByTestId("character-picker-error");
        const pickerNonActionable = paused.or(pickerError);
        if (await pickerNonActionable.count()) {
          await expect(pickerNonActionable.first()).toBeVisible();
        } else {
          const save = page.getByTestId("character-save");
          if (await save.count()) await expect(save).toBeDisabled();
        }

        await page.screenshot({ path: shot("stale-banner-disabled.png"), fullPage: true });
        // Capture the office webview while the bridge is down (record the
        // click-menu / dialog-pane surface behavior, no invented expectation).
        await captureOfficeFrame(page);
      } finally {
        // Always leave the plugin enabled for the resume leg + subsequent runs.
        await api.enablePlugin(pluginId).catch(() => undefined);
      }

      // ── Resume: re-enable rebuilds the snapshot (fresh observedAt), the
      // banner clears (~16s observed), state-changing actions re-enable.
      await expect(staleBanner(page)).toBeHidden({ timeout: STATE_CHANGE_WAIT_MS });
      await expect(page.getByTestId("company-intake-send")).toBeEnabled();
      const resumedObservedAt = await waitForFreshSnapshot(api, seed.company.id);
      expect(new Date(resumedObservedAt).getTime()).toBeGreaterThanOrEqual(
        new Date(baselineObservedAt).getTime(),
      );
      // Supporting probe: HTTP 200 once ready again.
      await expectSnapshotProbe(api, seed.company.id, 200);
      await page.screenshot({ path: shot("stale-banner-resumed.png"), fullPage: true });
    },
  );
});

/** Poll `api.bridgeSnapshot` until the worker serves a fresh `observedAt`. */
async function waitForFreshSnapshot(
  api: import("../helpers/api-client").PaperclipApi,
  companyId: string,
): Promise<string> {
  const deadline = Date.now() + RECONCILE_WAIT_MS;
  let lastObservedAt: string | null = null;
  for (;;) {
    try {
      const snap = await api.bridgeSnapshot(companyId);
      const observedAt = (snap as { observedAt?: string | null }).observedAt ?? null;
      if (observedAt && Date.now() - new Date(observedAt).getTime() < FRESH_WINDOW_MS) {
        return observedAt;
      }
      lastObservedAt = observedAt;
    } catch {
      // Worker not ready yet.
    }
    if (Date.now() > deadline) {
      throw new Error(
        `worker never served a fresh snapshot within ${RECONCILE_WAIT_MS}ms ` +
          `(last observedAt: ${lastObservedAt ?? "none"})`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
}

/** Assert the snapshot data endpoint returns exactly the expected HTTP status. */
async function expectSnapshotProbe(
  api: import("../helpers/api-client").PaperclipApi,
  companyId: string,
  expected: number,
): Promise<void> {
  let actual: number | null = null;
  try {
    await api.bridgeSnapshot(companyId);
    actual = 200;
  } catch (err) {
    actual = (err as { status?: number }).status ?? null;
  }
  expect(actual, `bridge-snapshot probe expected HTTP ${expected}`).toBe(expected);
}

/** Read the bridge status line ("Polling · last synchronized …" text). */
async function bridgeStatus(page: import("@playwright/test").Page): Promise<string> {
  const el = page.locator("text=/last synchronized/").first();
  return (await el.textContent()) ?? "";
}

/** Count the office iframe(s) currently mounted. */
async function officeFrameCount(page: import("@playwright/test").Page): Promise<number> {
  return page.locator('iframe[title="Pixel Agents office"]').count();
}

/** Record the office webview surface while the bridge is down (screenshot only). */
async function captureOfficeFrame(page: import("@playwright/test").Page): Promise<void> {
  const frame = page.frameLocator('iframe[title="Pixel Agents office"]');
  const menu = frame.locator('[data-testid="agent-menu"]');
  // No invented expectation: just observe whether the office's plugin panel /
  // agent-menu surface is still mounted while the bridge plugin is disabled.
  const menuPresent = await menu.count();
  console.log(`[stale:new-surface] office menu present while disabled: ${menuPresent}`);
  await page.screenshot({ path: shot("stale-office-iframe-disabled.png"), fullPage: true });
}
