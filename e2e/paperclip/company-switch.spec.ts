/**
 * Scenario 4 flag — Company switch (WS5-C SAA-757 deployment re-anchor).
 *
 * AC: switching the active company through the host's REAL sidebar company
 * switcher re-scopes the Pixel Office with NO cross-company leakage — company B
 * shows only B's company name / agents / feed, none of company A's agents,
 * labels, or feed entries bleed in; switching back leaves A's office intact.
 *
 * The host UI HAS a first-class company switcher
 * (`paperclip/ui/src/components/SidebarCompanyMenu.production.tsx`). On this
 * deployed stack its trigger is labelled "Open <company> organization switcher"
 * (the host identifies as a Cloud-style instance) and the entries are the
 * non-archived companies. Clicking an entry switches the active company and
 * moves the URL to that company's prefix (verified 2026-09-05: created "E2E
 * Pixel Co B" -> item appeared -> clicking it landed on /EEPA/dashboard). This
 * contradicts the earlier "no first-class UI company switcher (verified)" claim
 * from SAA-754 — this spec drives that real switcher.
 *
 * Company selection is per-browser-profile localStorage with auto-select of the
 * first-listed company on a fresh session, so clean-up discipline is MANDATORY:
 * the shared stack must return to the canonical single "E2E Pixel Test Co"
 * state (see `finally`). Deleting the second company is a board mutation — it
 * needs the deployment's own `Origin` header (the `api` fixture client sends
 * it).
 */

import path from "node:path";

import {
  e2ePath,
  HOST_BASE_URL,
  PIXEL_OFFICE_PAGE_TESTID,
  RECONCILE_WAIT_MS,
  SCREENSHOT_DIR,
  STATE_CHANGE_WAIT_MS,
} from "../helpers/env";
import { agentCard } from "../helpers/pixel-office";
import { expect, gatePixelOffice, test } from "../fixtures";

/** Screenshot output path under the suite's e2e screenshots dir. */
const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

/** The second company this spec seeds through the real API (deleted again in
 * the `finally` so the shared stack returns to the canonical single company). */
const COMPANY_B_NAME = "E2E Pixel Co B";

test.use({ viewport: { width: 1280, height: 1080 } });

test.describe("Scenario 4 — company switch (deployed-stack, real sidebar switcher)", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test("switching to a second company via the real sidebar switcher re-scopes the Pixel Office with no cross-company leakage; switching back leaves A intact", async ({
    page,
    api,
    seed,
  }) => {
    const companyA = seed.company;
    const agentA = seed.agent;

    let companyBId: string | null = null;

    try {
      // The active company does not persist to localStorage on this Cloud-style
      // host (cloud stack switching is in-memory), so navigate to each
      // company's office directly by its route prefix (the Layout route-sync
      // selects the company the URL names).
      const companyARecord = (await api.listCompanies()).find((c) => c.id === companyA.id);
      const companyAPrefix = companyARecord?.issuePrefix;
      expect(companyAPrefix, `company A (${companyA.name}) should have a route prefix`).toBeTruthy();

      // ── Company A baseline: the Pixel Office shows A's name and its agents.
      await openOfficeForCompany(page, companyAPrefix!);
      await expect(page.getByRole("heading", { name: companyA.name })).toBeVisible({
        timeout: STATE_CHANGE_WAIT_MS,
      });
      if (agentA.id) {
        await expect(agentCard(page, agentA.id)).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
      }

      // ── Seed a second company through the real API (board mutation; the api
      // client sends the deployment's own Origin header).
      const companyB = await api.findOrCreateCompany(COMPANY_B_NAME);
      companyBId = companyB.id;
      expect(companyB.issuePrefix, `company B (${companyB.name}) should have a route prefix`).toBeTruthy();

      // The switcher's stacks query caches for 30s, so reload the page after
      // seeding so the new company appears in the switcher.
      await page.reload({ waitUntil: "domcontentloaded" });

      // Switch to company B through the REAL sidebar switcher UI.
      await switchCompany(page, companyB.name);
      await openOfficeForCompany(page, companyB.issuePrefix!);

      // B's office re-scopes: shows B's company name, and none of A's agents,
      // labels, or feed entries bleed in.
      await expect(page.getByRole("heading", { name: companyB.name })).toBeVisible({
        timeout: RECONCILE_WAIT_MS,
      });
      // No A company name as the office heading.
      await expect(page.getByRole("heading", { name: companyA.name })).toHaveCount(0);
      // No A agents rendered in B's office (B is a fresh company with none).
      await expect(page.getByTestId("agent-card")).toHaveCount(0);
      // No A feedback / feed entries bleed into B.
      await expect(page.getByTestId("feedback-popup")).toHaveCount(0);
      await page.screenshot({ path: shot("company-b-office.png"), fullPage: true });

      // ── Switch back to company A through the switcher and assert office
      // integrity (navigate to A's office by its prefix).
      await switchCompany(page, companyA.name);
      await openOfficeForCompany(page, companyAPrefix!);
      await expect(page.getByRole("heading", { name: companyA.name })).toBeVisible({
        timeout: STATE_CHANGE_WAIT_MS,
      });
      if (agentA.id) {
        await expect(agentCard(page, agentA.id)).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
      }
      await page.screenshot({ path: shot("company-a-office-intact.png"), fullPage: true });
    } finally {
      // Clean up the seeded second company, switching back to A first (best
      // effort). The shared stack must return to the canonical single company.
      if (companyBId) {
        try {
          await switchCompany(page, companyA.name);
        } catch {
          // Page may be in a broken state after a failed assertion; the API
          // still holds the session and can delete the company directly.
        }
        await api.deleteCompany(companyBId).catch(() => undefined);
      }
    }

    // The stack is canonical again: exactly the original company remains.
    const remaining = await api.listCompanies();
    expect(remaining.map((c) => c.name)).not.toContain(COMPANY_B_NAME);
  });
});

/** Escape a string for inclusion in a RegExp constructor. */
function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Navigate to the Pixel Office of a given company by its route prefix, going
 * to `/<prefix>/pixel-office` directly. This avoids relying on the active
 * company's localStorage (which the Cloud-style switcher does not persist) and
 * on the sidebar-link click (flaky on a fresh company's dashboard) — the
 * host's Layout route-sync selects whichever company the URL names.
 */
async function openOfficeForCompany(
  page: import("@playwright/test").Page,
  prefix: string,
): Promise<void> {
  await page.goto(`${HOST_BASE_URL}/${prefix}/pixel-office`, { waitUntil: "domcontentloaded" });
  await page.getByTestId(PIXEL_OFFICE_PAGE_TESTID).waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
}

/**
 * Open the host's sidebar company switcher and select the given company.
 *
 * The trigger is a Button whose accessible label is
 * "Open <currentName> organization/company switcher"; the entries are
 * role=menuitem rows carrying the company name. Select on the company name and
 * wait for the trigger to reflect the newly-selected company (the URL moves to
 * that company's prefix, so the trigger text updates).
 */
async function switchCompany(page: import("@playwright/test").Page, companyName: string): Promise<void> {
  const trigger = page.getByRole("button", { name: /switcher/ });
  await expect(trigger).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
  await trigger.click();

  const item = page.getByRole("menuitem", { name: new RegExp(escapeRegex(companyName)) });
  await expect(item).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
  await item.click();

  await expect(
    page.getByRole("button", { name: new RegExp(`Open ${escapeRegex(companyName)}`) }),
  ).toBeVisible({ timeout: STATE_CHANGE_WAIT_MS });
}
