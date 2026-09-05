/**
 * Pixel Office page navigation and selector helpers (spec PAPERCLIP_PIXELS-1,
 * §26/§27, SAA-231).
 *
 * The Pixel Office is a plugin UI page wired into the Paperclip host by SAA-230
 * (manifest `ui.slots`). Its URL is discovered at runtime from the sidebar link
 * (`data-testid="pixel-office-sidebar-link"`) or `GET /api/plugins/ui-contributions`,
 * never hardcoded.
 */

import type { Locator, Page } from "@playwright/test";

import { HOST_BASE_URL, PIXEL_OFFICE_PAGE_TESTID, PIXEL_OFFICE_SIDEBAR_TESTID, STATE_CHANGE_WAIT_MS } from "./env";

export async function gotoPixelOffice(page: Page): Promise<void> {
  // The Pixel Office appears on the board's company dashboard. Landing on "/"
  // redirects to the dashboard, where the SPA mounts the sidebar link
  // asynchronously — wait for it rather than sampling immediately.
  await page.goto(`${HOST_BASE_URL}/`, { waitUntil: "domcontentloaded" });
  const sidebarLink = page.getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID).first();
  try {
    await sidebarLink.waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
  } catch {
    throw new Error(
      `Pixel Office sidebar link (${PIXEL_OFFICE_SIDEBAR_TESTID}) not found — ` +
        "SAA-230 (manifest ui.slots wiring) is likely not done.",
    );
  }
  await sidebarLink.click();
  await page.getByTestId(PIXEL_OFFICE_PAGE_TESTID).waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
}

/** Navigate directly to a discovered plugin route (from ui-contributions). */
export async function gotoPixelOfficeByPath(page: Page, pluginPath: string): Promise<void> {
  await page.goto(`${HOST_BASE_URL}${pluginPath}`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(PIXEL_OFFICE_PAGE_TESTID).waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
}

export function companyOverview(page: Page): Locator {
  return page.getByTestId("company-overview");
}

export function refreshButton(page: Page): Locator {
  return page.getByTestId("pixel-office-refresh");
}

export function agentCards(page: Page): Locator {
  return page.getByTestId("agent-card");
}

export function agentCard(page: Page, agentId: string): Locator {
  return page.locator(`[data-testid="agent-card"][data-agent-id="${agentId}"]`);
}

export async function openDetail(page: Page, agentId: string): Promise<Locator> {
  await agentCard(page, agentId).getByTestId("agent-open-detail").click();
  await page.getByTestId("agent-detail").waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
  return page.getByTestId("agent-detail");
}

export function feedbackPopups(page: Page): Locator {
  return page.getByTestId("feedback-popup");
}

export function feedbackPopup(page: Page, feedbackId: string): Locator {
  return page.locator(`[data-testid="feedback-popup"][data-feedback-id="${feedbackId}"]`);
}

export function behaviorSignals(page: Page): Locator {
  return page.getByTestId("behavior-signal");
}

export function staleBanner(page: Page): Locator {
  return page.getByTestId("pixel-office-stale-banner");
}

/**
 * App-gap marker for the known host defect SAA-315 (filed under SAA-231):
 * the deployed host never wires the plugin stream bus, so every
 * `GET /api/plugins/:id/bridge/stream/*` returns 501 and `useBridge.connected`
 * is permanently false — the stream-connected live-update path never runs. The
 * stale banner is NOT driven by stream connectivity alone, though: `stale` is
 * `hasSnapshot && !streamConnected && (now - snapshot.observedAt) > STALE_AFTER_MS`
 * (`src/ui/use-bridge.ts`), so the Pixel Office is only marked stale after 90s
 * of genuine snapshot silence and clears again on the next actual snapshot
 * rebuild (bootstrap/event/reconcile, e.g. plugin re-enable). It is NOT
 * permanently stale because the stream is down (corrected per SAA-757 — that
 * was the SAA-754 finding-1 claim). Many stream-dependent scenarios still
 * cannot be driven until the host wires the stream bus; the suite probes
 * stream connectivity at runtime and skips only the steps that genuinely
 * require it; rendering, refresh, and staleness-cycle steps still run.
 */
export const APP_GAP_STREAM_SKIP_REASON =
  "app gap SAA-315: plugin stream bridge not enabled in the deployed host (GET /api/plugins/:id/bridge/stream/* -> 501); " +
  "the stream live-update path is unavailable so stream-dependent steps skip. " +
  "The stale banner itself is deterministic freshness-based (90s of snapshot silence), not permanently on " +
  "(corrected per SAA-757).";

/**
 * Probe whether the bridge's `behavior:<companyId>` SSE channel is connected
 * from a browser context (same origin + session cookie as the UI). Uses the
 * exact endpoint the UI subscribes through (`GET /api/plugins/:pluginId/bridge/stream/:channel`).
 * Resolves true when the stream opens; false on 501/error/timeout.
 */
export async function pixelBridgeStreamConnected(page: Page, pluginId: string, companyId: string): Promise<boolean> {
  return page.evaluate(
    async ({ pluginId, companyId }) => {
      const channel = `behavior:${encodeURIComponent(companyId)}`;
      const url = `/api/plugins/${pluginId}/bridge/stream/${channel}?companyId=${encodeURIComponent(companyId)}`;
      return await new Promise<boolean>((resolve) => {
        let es: EventSource | null = null;
        let settled = false;
        const finish = (ok: boolean): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          try {
            es?.close();
          } catch {
            /* noop */
          }
          es = null;
          resolve(ok);
        };
        const timer = setTimeout(() => finish(false), 8_000);
        try {
          es = new EventSource(url, { withCredentials: true });
        } catch {
          finish(false);
          return;
        }
        es.onopen = () => finish(true);
        es.onmessage = () => finish(true);
        es.onerror = () => finish(false);
      });
    },
    { pluginId, companyId },
  );
}
