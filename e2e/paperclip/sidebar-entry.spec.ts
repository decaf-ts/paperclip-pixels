/**
 * WS0 — Pixel Office sidebar entry as a native single-line row (spec
 * PAPERCLIP_PIXELS-2, WS0 task 1; UI implementation SAA-461, test-side spec
 * SAA-481).
 *
 * AC ("Plugin chrome"): the plugin's sidebar entry renders as a single-line
 * native-style menu entry — one `Pixel Office` text line (no nested
 * two-line block), the same pill geometry/typography/hover highlight classes
 * as the host's own `SidebarNavItem` rows, and a plugin-owned inline SVG icon —
 * sits inside the host sidebar, and clicking it navigates to the plugin page
 * (`pixel-office-page`). The obsolete SAA-231 chrome (two-line entry with a
 * `<strong>` headline and a secondary text line about other plugin pages) must
 * not render again.
 *
 * Settings-page coverage lives in settings-editable.spec.ts; per-agent
 * hue-shift coverage in hue-shift.spec.ts.
 */

import path from "node:path";

import {
  e2ePath,
  HOST_BASE_URL,
  PIXEL_OFFICE_PAGE_TESTID,
  PIXEL_OFFICE_SIDEBAR_ENTRY_TESTID,
  PIXEL_OFFICE_SIDEBAR_TESTID,
  SCREENSHOT_DIR,
  STATE_CHANGE_WAIT_MS,
} from "../helpers/env";
import { expect, gatePixelOffice, test } from "../fixtures";

const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

/** Classes of the host `SidebarNavItem` pill row the plugin entry replicates. */
const HOST_ROW_CLASS_PARTS = [
  "flex items-center",
  "gap-2.5",
  "mx-2",
  "rounded-lg",
  "px-2",
  "py-1.5",
  "text-(length:--text-compact)",
  "font-medium",
  "transition-colors",
] as const;

test.describe("WS0 — Pixel Office sidebar entry is a native single-line row", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test("renders one testid-anchored native row with the WS0 label inside the host sidebar", async ({ page }) => {
    await page.goto(`${HOST_BASE_URL}/`, { waitUntil: "domcontentloaded" });

    // The dashboard SPA mounts the sidebar asynchronously; sample with a
    // bounded visible wait (an instant isVisible probe rides the pre-mount
    // skeleton and reports a false "not rendered").
    const wrapper = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_ENTRY_TESTID);
    await expect(
      wrapper,
      "Pixel Office sidebar entry wrapper is not rendered inside the host sidebar (SAA-461 WS0 UI not served)",
    ).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });

    const link = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID);
    await expect(link).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
    await expect(wrapper.getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID)).toHaveCount(1);

    // Single text line with the WS0 label only. The obsolete SAA-231 two-line
    // entry (`<strong>` headline + a secondary plugin-pages text line) must
    // not render again.
    const linkText = await link.innerText();
    expect(linkText.trim()).toBe("Pixel Office");
    await expect(link.locator("strong")).toHaveCount(0);
    await expect(link.locator("svg")).toBeVisible();

    // Host SidebarNavItem row classes are replicated verbatim on the plugin row.
    const className = (await link.getAttribute("class")) ?? "";
    for (const part of HOST_ROW_CLASS_PARTS) {
      expect(className).toContain(part);
    }

    await page.screenshot({ path: shot("05-sidebar-entry-native-row.png"), fullPage: true });
  });

  test("clicking the entry navigates to the Pixel Office page and marks the row active", async ({ page }) => {
    await page.goto(`${HOST_BASE_URL}/`, { waitUntil: "domcontentloaded" });
    const link = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID);
    await link.waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });

    // Before navigation the entry must not be marked current.
    await expect(link).not.toHaveAttribute("aria-current");

    const href = await link.getAttribute("href");
    expect(href).toMatch(/pixel-office/);
    const resolvedPath = new URL(href ?? "", page.url()).pathname;

    await link.click();
    const officePage = page.getByTestId(PIXEL_OFFICE_PAGE_TESTID);
    await officePage.waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });

    // The URL landed on the plugin page's resolved route — the plugin's own
    // navigation (linkProps/resolveHref), not a host reimplementation.
    expect(new URL(page.url()).pathname).toBe(resolvedPath);

    // After navigation the row is the active row (host aria-current + the
    // pristine active class tail).
    const afterLink = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID);
    await expect(afterLink).toHaveAttribute("aria-current", "page");
    const className = (await afterLink.getAttribute("class")) ?? "";
    expect(className).toContain("bg-accent text-foreground");
    expect(className).not.toContain("text-foreground/80");
    await expect(officePage).toBeVisible();

    await page.screenshot({ path: shot("05-sidebar-entry-active.png"), fullPage: true });
  });

  test("the entry stays non-active on unrelated host routes", async ({ page }) => {
    await page.goto(`${HOST_BASE_URL}/issues`, { waitUntil: "domcontentloaded" });
    // The host SPA mounts the sidebar asynchronously on a client-side route
    // change too; sample with a bounded visible wait.
    const link = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID);
    await expect(
      link,
      "Pixel Office sidebar entry (pixel-office-sidebar-link) must render on /issues so its non-active state is assertion-defensible",
    ).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });

    await expect(link).not.toHaveAttribute("aria-current");
    const className = (await link.getAttribute("class")) ?? "";
    expect(className).toContain("text-foreground/80");
    expect(className).toContain("hover:bg-accent/50");
    expect(className).not.toContain("bg-accent text-foreground");
    await page.screenshot({ path: shot("05-sidebar-entry-inactive.png"), fullPage: true });
  });
});
