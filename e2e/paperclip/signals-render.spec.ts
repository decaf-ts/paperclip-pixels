/**
 * Scenario 1 — Signals render in response to real state changes (spec
 * PAPERCLIP_PIXELS-1, §26/§27, SAA-231).
 *
 * AC: "Agent activity/behavior signals render in Pixel Agents in response to
 * real Paperclip state changes."
 *
 * - Test A (always runs): `pixel-office-page` + `company-overview` render with
 *   the seeded company's REAL counts. The counts rendered by the UI come
 *   straight from the worker's `bridge-snapshot` summary (the UI's own vantage,
 *   SAA-306 BridgeCompanySnapshot), so read back from that rather than the raw
 *   core agent list — the bridge counts only observed agents. Trigger a real
 *   state change (new issue assigned to the seeded agent), assert the bridge
 *   reconciles it (openIssueCount +1), then assert the UI reflects it through
 *   the Refresh button path; also assert agent-detail behavior signals render.
 * - Test B (stream-gated): the live stream path — the count updates with NO
 *   manual refresh — plus an in-flight active-run row require the host's plugin
 *   stream bridge (SSE). That is permanently 501 on the deployed stack
 *   (SAA-315, filed under SAA-231), so Test B is skipped with a precise reason
 *   when the stream is not connected.
 *
 * Screenshots at each stage.
 */

import path from "node:path";

import { e2ePath, RECONCILE_WAIT_MS, SCREENSHOT_DIR, STATE_CHANGE_WAIT_MS } from "../helpers/env";
import {
  APP_GAP_STREAM_SKIP_REASON,
  behaviorSignals,
  companyOverview,
  gotoPixelOffice,
  openDetail,
  pixelBridgeStreamConnected,
  refreshButton,
} from "../helpers/pixel-office";
import { triggerNewAssignedIssue, tryTriggerAgentRun } from "../helpers/trigger";
import { expect, gatePixelOffice, test } from "../fixtures";

const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

test.describe("Scenario 1 — signals render on real state changes", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test("company overview matches the bridge's real state and updates via Refresh after a real state change", async ({ page, api, seed }) => {
    await gotoPixelOffice(page);

    const overview = companyOverview(page);
    await expect(overview).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });

    // Read-back assertion against the UI's own vantage (bridge summary), not
    // the raw core agent list — the bridge counts only observed agents.
    const summary = (await api.bridgeSnapshot(seed.company.id)).summary ?? {};
    const agentCount = Number(summary.agentCount);
    const openIssueCount = Number(summary.openIssueCount);
    expect(agentCount).toBeGreaterThan(0);
    await expect(overview).toContainText(`${agentCount} agents`);
    await expect(overview).toContainText(`${openIssueCount} open issues`);

    // The seeded agent card renders, keyed by its canonical id.
    const card = page.locator(`[data-testid="agent-card"][data-agent-id="${seed.agent.id}"]`);
    await expect(card).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    await page.screenshot({ path: shot("01-pixel-office-live.png"), fullPage: true });

    // Trigger a real state change: a new issue assigned to the seeded agent.
    await triggerNewAssignedIssue(api, seed, "E2E trigger: new assigned issue");

    // The bridge reconciles the new issue into its store within a bounded
    // window; poll the real snapshot until the summary reflects it.
    await expect
      .poll(() => api.bridgeSnapshot(seed.company.id).then((s) => Number(s.summary?.openIssueCount)), {
        timeout: RECONCILE_WAIT_MS,
      })
      .toBe(openIssueCount + 1);

    // Refresh button path: a manual refresh refetches the full snapshot and
    // the UI's open-issue count follows the reconciled state.
    await refreshButton(page).click();
    await expect(overview).toContainText(`${openIssueCount + 1} open issues`, { timeout: STATE_CHANGE_WAIT_MS });
    await page.screenshot({ path: shot("01-pixel-office-after-change.png"), fullPage: true });

    // Agent detail renders behavior signals (operational proxies) where computed.
    await openDetail(page, seed.agent.id);
    const signals = behaviorSignals(page);
    const signalCount = await signals.count();
    // Signals may be all-zero on a freshly observed agent, but the section must
    // render at least one signal row (the vector is always present).
    expect(signalCount).toBeGreaterThan(0);
    await page.screenshot({ path: shot("01-pixel-office-agent-detail.png"), fullPage: true });
  });

  test("live stream path: the count updates without manual refresh and active runs surface (bridge connected)", async ({ page, api, seed }) => {
    const plugin = await api.pixelPluginRecord();
    expect(plugin, "Pixel bridge plugin not registered").not.toBeNull();
    const streamConnected = await pixelBridgeStreamConnected(page, plugin!.id, seed.company.id);
    test.skip(!streamConnected, APP_GAP_STREAM_SKIP_REASON);

    await gotoPixelOffice(page);
    const overview = companyOverview(page);
    await expect(overview).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    const openIssueCount = Number((await api.bridgeSnapshot(seed.company.id)).summary?.openIssueCount);

    // Live path: the open-issue count updates without a manual refresh.
    await triggerNewAssignedIssue(api, seed, "E2E trigger: live-path new issue");
    await expect(overview).toContainText(`${openIssueCount + 1} open issues`, { timeout: RECONCILE_WAIT_MS });

    // In-flight active run rows. The worker's stream bridge emits summary and
    // behavior deltas only — never `agent.projection.changed` — so the card's
    // active-run ROW is surfaced by a full snapshot refetch (Refresh), not by
    // the live deltas. tryTriggerAgentRun therefore requires a run to persist a
    // steady window to count as started; on this stack the seeded agent's
    // adapter is unauthenticated and runs die in ~1-3s, so the step skips with
    // a precise reason instead of 90s-failing on a fixture defect.
    await test.step("active run surfaces an active-run row", async () => {
      const result = await tryTriggerAgentRun(api, seed);
      test.skip(!result.started, result.reason ?? "agent run did not go live");

      // The run is live ≥ LIVE_STEADY_MS: surface it via a full snapshot
      // refetch (Refresh), which is the deterministic way the UI row renders,
      // then assert the row.
      await refreshButton(page).click();
      await expect(
        page.getByTestId("agent-card").getByTestId("active-run").or(page.getByTestId("detail-run")),
      ).toBeVisible({ timeout: RECONCILE_WAIT_MS });
    });
  });
});
