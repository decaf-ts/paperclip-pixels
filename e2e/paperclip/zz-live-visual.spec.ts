/**
 * Browser QA live visual re-verification (SAA-1044). Temporary file — removed
 * after the run. Evidence + screenshots land in $PAPERCLIP_SCRATCH_DIR/artifacts/live-visual.
 */
import fs from "node:fs";
import path from "node:path";

import { test, type Page, type Frame } from "@playwright/test";

import {
  HOST_BASE_URL,
  PIXEL_OFFICE_PAGE_TESTID,
  PIXEL_OFFICE_SIDEBAR_TESTID,
  PIXEL_OFFICE_SIDEBAR_ENTRY_TESTID,
  RECONCILE_WAIT_MS,
  STATE_CHANGE_WAIT_MS,
} from "../helpers/env";
import { loginViaUi } from "../helpers/login";
import { gotoPixelOffice, agentCards, openDetail } from "../helpers/pixel-office";
import { PaperclipApi, type Agent } from "../helpers/api-client";

const SCRATCH = process.env.PAPERCLIP_SCRATCH_DIR ?? "/tmp";
const ART = path.join(SCRATCH, "artifacts", "live-visual");
fs.mkdirSync(ART, { recursive: true });

const evidence: Record<string, unknown> = {};
const record = (step: string, data: unknown) => { evidence[step] = data; };
// Playwright re-evaluates this module per test, so module state does not
// survive across tests — each test dumps its own tagged evidence file.
function dumpEvidence(tag: string): void {
  fs.writeFileSync(path.join(ART, `evidence-${tag}.json`), JSON.stringify(evidence, null, 2));
}

interface CharacterEvidence {
  id: number;
  agentName?: string;
  state?: string;
  currentTool?: string | null;
  isActive?: boolean;
  isTeamLead?: boolean;
}

async function officeFrame(page: Page): Promise<Frame> {
  await page.waitForSelector('iframe[title="Pixel Agents office"]', { timeout: RECONCILE_WAIT_MS });
  const frame = page.frames().find((f) => f !== page.mainFrame() && /\/\?token=/.test(f.url()));
  if (!frame) throw new Error("office iframe not found on the Pixel Office page");
  return frame;
}

async function characterStates(page: Page): Promise<CharacterEvidence[] | null> {
  const frame = await officeFrame(page);
  return frame.evaluate(() => {
    const hooks = (window as { __pixelAgentsTestHooks?: { getCharacters?: () => unknown[] } })
      .__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? null) as CharacterEvidence[] | null;
  });
}

function spriteRequests(page: Page): string[] {
  const urls: string[] = [];
  page.on("request", (req) => {
    const t = req.resourceType();
    if ((t === "image" || /sprite|sheet|character|\.png|\.webp|\.atlas/i.test(req.url())) && !/favicon/i.test(req.url())) {
      urls.push(`${req.method()} ${req.url()}`);
    }
  });
  return urls;
}

function wireTelemetry(page: Page, tag: string): void {
  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("console", (msg) => { if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300)); });
  page.on("pageerror", (err) => consoleErrors.push(`pageerror: ${String(err).slice(0, 300)}`));
  page.on("response", (res) => {
    if (res.status() >= 400 && !res.url().includes("favicon")) failedRequests.push(`${res.status()} ${res.request().method()} ${res.url()}`);
  });
  page.on("requestfailed", (req) => {
    const err = req.failure()?.errorText ?? "unknown";
    if (!/favicon/i.test(req.url())) failedRequests.push(`FAILED ${req.method()} ${req.url()} (${err})`);
  });
  record(`telemetry-${tag}`, {consoleErrors: consoleErrors.slice(0,40), failedRequests: failedRequests.slice(0,40)});
}

async function companyAgents(api: PaperclipApi, companyId: string): Promise<Agent[]> {
  return api.listAgents(companyId);
}

test.describe("Browser QA live visual re-verification (SAA-1044)", () => {
  test("desktop 1440x900 — sidebar entry, office journey, statuses, names, character state", async ({ browser }, testInfo) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    wireTelemetry(page, "desktop");
    const reqLog = spriteRequests(page);

    await loginViaUi(page);
    const api = new PaperclipApi((await page.context().cookies()).find((c) => c.name.endsWith("session_token"))?.value ?? "");
    const companies = await api.listCompanies();
    const company = companies.find((c) => c.name === "E2E Pixel Test Co") ?? companies[0];

    await page.goto(`${HOST_BASE_URL}/`, { waitUntil: "domcontentloaded" });
    const wrapper = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_ENTRY_TESTID);
    await wrapper.waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
    const link = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID);
    record("desktop-sidebar", {
      officeLabel: await wrapper.getByTestId("pixel-office-menu-label").textContent(),
      linkText: (await link.innerText()).trim(),
      linkCount: await wrapper.getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID).count(),
      hasStrong: await link.locator("strong").count(),
      configHref: await wrapper.getByTestId("pixel-office-sidebar-config-link").getAttribute("href"),
      rowClasses: (await link.getAttribute("class")) ?? "",
    });
    const box = await link.boundingBox();
    record("desktop-sidebar-geometry", { heightPx: box?.height, widthPx: box?.width });
    await page.screenshot({ path: path.join(ART, "desktop-01-sidebar.png") });

    // Keyboard path: focus the entry, verify focus visibility, Enter navigates.
    await page.keyboard.press("Tab");
    let focusHit = false;
    for (let i = 0; i < 40 && !focusHit; i += 1) {
      const active = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? "");
      if (active === PIXEL_OFFICE_SIDEBAR_TESTID) { focusHit = true; break; }
      await page.keyboard.press("Tab");
    }
    const focusState = focusHit
      ? await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        const s = el ? getComputedStyle(el) : null;
        return {
          testid: el?.getAttribute("data-testid") ?? null,
          outline: s?.outlineStyle, outlineWidth: s?.outlineWidth, boxShadow: s?.boxShadow,
        };
      })
      : { testid: null, note: "sidebar link not reached within 40 Tabs" };
    record("desktop-keyboard-focus", focusState);
    await page.screenshot({ path: path.join(ART, "desktop-02-focus.png") });
    if (focusHit) {
      await page.keyboard.press("Enter");
      await page.getByTestId(PIXEL_OFFICE_PAGE_TESTID).waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
      record("desktop-keyboard-nav", "navigated via Enter");
    } else {
      await gotoPixelOffice(page);
      record("desktop-keyboard-nav", "fallback: clicked sidebar link");
    }

    const frame = await officeFrame(page);
    await page.waitForTimeout(5_000);
    const chars = await characterStates(page);
    const agents = await companyAgents(api, company.id);
    const uiNames = (chars ?? []).map((c) => c.agentName).filter(Boolean) as string[];
    record("desktop-office", {
      url: page.url(),
      iframeUrl: frame.url(),
      agentCardsVisible: await agentCards(page).count(),
      characters: chars,
      companyAgents: agents,
      uiAgentNames: uiNames,
      namesMatch: agents.every((a) => (a.name && uiNames.includes(a.name))) && uiNames.every((n) => agents.some((a) => a.name === n)),
    });

    // Statuses reaching the UI: open the first agent detail and scan for issue status text.
    const cardCount = await agentCards(page).count();
    if (cardCount > 0) {
      const firstCard = agentCards(page).first();
      const agentId = (await firstCard.getAttribute("data-agent-id")) ?? "";
      try {
        await openDetail(page, agentId);
        const detailText = (await page.getByTestId("agent-detail").innerText()).slice(0, 1_500);
        record("desktop-agent-detail", { agentId, detailText });
        await page.screenshot({ path: path.join(ART, "desktop-03-agent-detail.png") });
      } catch (err) {
        record("desktop-agent-detail", { agentId, error: String(err).slice(0, 200) });
      }
    }
    await page.screenshot({ path: path.join(ART, "desktop-04-office.png") });
    record("desktop-sprite-requests", reqLog.slice(0, 30));

    // Browser back/forward.
    await page.goBack({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
    const backUrl = page.url();
    await page.goForward({ waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2_000);
    record("desktop-back-forward", { backUrl, forwardUrl: page.url() });

    await context.close();
    void testInfo;
    dumpEvidence("desktop");
  });

  test("mobile 390x844 — office journey, layout integrity", async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
      deviceScaleFactor: 3,
    });
    const page = await context.newPage();
    wireTelemetry(page, "mobile");

    await loginViaUi(page);
    const api = new PaperclipApi((await page.context().cookies()).find((c) => c.name.endsWith("session_token"))?.value ?? "");
    const companies = await api.listCompanies();
    const company = companies.find((c) => c.name === "E2E Pixel Test Co") ?? companies[0];
    await page.goto(`${HOST_BASE_URL}/`, { waitUntil: "domcontentloaded" });
    const wrapper = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_ENTRY_TESTID);
    let sidebarVisible = false;
    try {
      await wrapper.waitFor({ state: "visible", timeout: 15_000 });
      sidebarVisible = true;
    } catch { /* sidebar may be collapsed at this viewport */ }
    const link = page.locator("aside").first().getByTestId(PIXEL_OFFICE_SIDEBAR_TESTID);
    let viaDrawer = false;
    if (sidebarVisible) {
      // Host mobile pattern: below md the sidebar is a drawer behind the
      // hamburger (button[aria-label="Open sidebar", BreadcrumbBar). When the
      // entry row sits outside the viewport at 390px, opening the drawer is
      // the real user path — do that before clicking.
      const box = await link.boundingBox();
      const vp = page.viewportSize() ?? { width: 390, height: 844 };
      const inViewport =
        !!box && box.x >= 0 && box.y >= 0 &&
        box.x + box.width <= vp.width && box.y + box.height <= vp.height;
      if (!inViewport) {
        const burger = page.locator('button[aria-label="Open sidebar"]');
        if (await burger.count() > 0) {
          await burger.first().click();
          await link.waitFor({ state: "visible", timeout: 15_000 });
          viaDrawer = true;
        }
      }
      record("mobile-sidebar", {
        viaDrawer,
        officeLabel: await wrapper.getByTestId("pixel-office-menu-label").textContent(),
        linkText: (await link.innerText()).trim(),
        hasStrong: await link.locator("strong").count(),
      });
      await link.click();
    } else {
      record("mobile-sidebar", { visible: false, note: "sidebar entry not reachable at 390px; navigating via direct route" });
      await page.goto(`${HOST_BASE_URL}/${company.issuePrefix ?? "EEP"}/pixel-office`, { waitUntil: "domcontentloaded" });
    }
    await page.screenshot({ path: path.join(ART, "mobile-01-entry.png") });
    await page.getByTestId(PIXEL_OFFICE_PAGE_TESTID).waitFor({ state: "visible", timeout: STATE_CHANGE_WAIT_MS });
    await page.waitForTimeout(4_000);
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    record("mobile-layout", overflow);
    const chars = await characterStates(page);
    record("mobile-office", { url: page.url(), characters: chars });
    await page.screenshot({ path: path.join(ART, "mobile-02-office.png") });

    // Character picker on mobile (per-agent character UI tab).
    const picker = page.getByTestId("character-picker");
    try {
      await picker.waitFor({ state: "visible", timeout: 15_000 });
      record("mobile-character-picker", { visible: true, text: (await picker.innerText()).slice(0, 500) });
      await page.screenshot({ path: path.join(ART, "mobile-03-character-picker.png") });
    } catch {
      record("mobile-character-picker", { visible: false });
    }
    dumpEvidence("mobile");
    await context.close();
  });

  test("desktop — settings page global-only + standalone webview sprite loading", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    wireTelemetry(page, "settings");

    await loginViaUi(page);
    const session = (await page.context().cookies()).find((c) => c.name.endsWith("session_token"))?.value ?? "";
    const api = new PaperclipApi(session);

    // Settings page (global-only operator form).
    const companies = await api.listCompanies();
    const company = companies.find((c) => c.name === "E2E Pixel Test Co") ?? companies[0];
    const plugin = await api.pixelPluginRecord();
    if (!company || !plugin) throw new Error("seed company or pixel plugin missing");
    const prefix = company.issuePrefix ?? "EEP";
    const settingsUrl = `${HOST_BASE_URL}/${prefix}/company/settings/instance/plugins/${plugin.id}`;
    await page.goto(settingsUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(3_000);
    const labels = await page.locator('label[data-slot="label"]').allInnerTexts();
    const text = (await page.innerText("body")).slice(0, 2_000);
    record("settings", {
      url: settingsUrl,
      labels,
      mentionsAgents: /per-agent|per agent|E2E Pixel Agent/i.test(text),
      agentNamesInPage: ["E2E Pixel Agent", "E2E Pixel Agent 2"].filter((n) => text.includes(n)),
    });
    await page.screenshot({ path: path.join(ART, "desktop-05-settings.png"), fullPage: true });

    // Standalone webview (tokened URL from plugin config) — sprite/asset loading.
    const config = await api.pluginConfig(plugin.id, company.id);
    const uiUrl = config?.configJson?.pixelAgentsUiUrl as string | undefined;
    if (!uiUrl) throw new Error("plugin config has no pixelAgentsUiUrl");
    const spriteLog: string[] = [];
    page.on("request", (req) => {
      const t = req.resourceType();
      if (t === "image" || /sprite|sheet|character|catalog|\.png|\.webp/i.test(req.url())) {
        spriteLog.push(`${req.method()} ${req.url()}`);
      }
    });
    await page.goto(uiUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(6_000);
    const standaloneChars = await page.evaluate(() => {
      const hooks = (window as { __pixelAgentsTestHooks?: { getCharacters?: () => unknown[] } })
        .__pixelAgentsTestHooks;
      return (hooks?.getCharacters?.() ?? null) as CharacterEvidence[] | null;
    });
    record("standalone-webview", {
      url: uiUrl,
      characters: standaloneChars,
      spriteAssetRequests: spriteLog.slice(0, 40),
    });
    await page.screenshot({ path: path.join(ART, "desktop-06-standalone-office.png") });
    dumpEvidence("settings");
    await context.close();
  });
});
