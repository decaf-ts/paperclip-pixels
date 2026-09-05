/**
 * FR-19 — character behavior vs lifecycle on the DEPLOYED stack (spec
 * PAPERCLIP_PIXELS_2 WS5-B, delegation SAA-692 -> SAA-694).
 *
 * AC (spec §FR-19): "character behavior is consistent with the agent's
 * Paperclip activity" — a run going live seats the character in the typing
 * state with the run caption, the run ending returns it to idle with the
 * caption closed; the blue name label renders the agent's real name under
 * the no-policy fallback gate (the bridge plugin's manifest deliberately
 * declares no labelPolicy — the full WS2 policy matrix is proven in the
 * pixel-agents fork's standalone suite, e2e/tests/standalone/
 * pluginActivity.spec.ts); and the reading/typing frame-set input
 * (`currentTool`) is asserted through the same office state the renderer
 * consumes (`window.__pixelAgentsTestHooks`, installed because the spec
 * flags the page with `__PIXEL_AGENTS_E2E` before load — never pixel-exact
 * screenshots).
 *
 * Everything is driven through real surfaces only: the Paperclip API for
 * state changes, the real office iframe embedded in the Pixel Office page,
 * and the pixel-agents WebSocket for the privileged plugin-action path.
 */

import path from "node:path";
// @ts-expect-error -- ws ships no bundled types and the repo has no @types/ws;
// the spec only uses the imperative connect/send/message surface below.
import WebSocket from "ws";

import { e2ePath, RECONCILE_WAIT_MS, SCREENSHOT_DIR } from "../helpers/env";
import { gotoPixelOffice } from "../helpers/pixel-office";
import { ensureCompanyFeedConfigured } from "../helpers/plugin-config";
import { expect, gatePixelOffice, test } from "../fixtures";

/** Screenshot output path under the suite's e2e screenshots dir. */
const shot = (name: string) => e2ePath(path.join(SCREENSHOT_DIR, name));

/** The blue non-lead label color (pixel-agents webview-ui/src/constants.ts
 * TEAM_ROLE_COLOR '#66aaff' — every bridge agent is a one-agent team's only
 * member, never a lead, so the name always renders in the teammate blue). */
const TEAMMATE_BLUE = "rgb(102, 170, 255)";

/** The webview's reading-tools taxonomy (frame-set selection reads
 * `currentTool` first): a run caption must ride the typing frame set. */
const READING_TOOLS: ReadonlySet<string> = new Set(["Read", "Grep", "Glob", "WebFetch", "WebSearch"]);

/** One character's office state as exposed by the webview's test hooks —
 * the same values the renderer consumes, read for assertions instead of
 * pixel-hunting sprites. */
interface CharacterEvidence {
  /** Numeric AgentState id (used to target overlays and selection). */
  id: number;
  /** The declared agent's display name. */
  agentName?: string;
  /** Animation state machine value ('type' = seated typing frames). */
  state?: "idle" | "walk" | "type";
  /** Tool name driving the reading-vs-typing frame-set choice (null = none). */
  currentTool?: string | null;
  /** Whether the office currently considers this agent working. */
  isActive?: boolean;
  /** Team-lead flag (label rendering picks the lead vs teammate color). */
  isTeamLead?: boolean;
}

/** Flag the page for test-hook installation BEFORE any navigation — the
 * webview installs `window.__pixelAgentsTestHooks` at module load only when
 * `__PIXEL_AGENTS_E2E` is true, and Playwright init scripts apply to the
 * cross-origin office iframe too. */
async function preparePage(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript("window.__PIXEL_AGENTS_E2E = true");
}

/** The office iframe's frame (matched by the webview URL, never hardcoded
 * ports: the iframe src is the plugin's configured pixelAgentsUiUrl). The
 * Pixel Office page mounts the iframe once its async visual-settings load
 * resolves, so wait for it rather than sampling immediately. */
async function officeFrame(page: import("@playwright/test").Page): Promise<import("@playwright/test").Frame> {
  await page.waitForSelector('iframe[title="Pixel Agents office"]', { timeout: RECONCILE_WAIT_MS });
  const frame = page.frames().find((f) => f !== page.mainFrame() && /\/\?token=/.test(f.url()));
  if (!frame) throw new Error("office iframe not found on the Pixel Office page");
  return frame;
}

/** All characters' office state via `window.__pixelAgentsTestHooks`. */
async function getCharacters(frame: import("@playwright/test").Frame): Promise<CharacterEvidence[]> {
  return await frame.evaluate(() => {
    const hooks = (window as { __pixelAgentsTestHooks?: { getCharacters?: () => unknown[] } })
      .__pixelAgentsTestHooks;
    return (hooks?.getCharacters?.() ?? []) as CharacterEvidence[];
  });
}

/** The character evidence for one agent, looked up by its real name. */
async function characterByName(
  frame: import("@playwright/test").Frame,
  name: string,
): Promise<CharacterEvidence | undefined> {
  const characters = await getCharacters(frame);
  return characters.find((ch) => ch.agentName === name);
}

/** Select one agent through the test hooks (reveals its label panel). */
async function selectAgent(frame: import("@playwright/test").Frame, id: number): Promise<void> {
  await frame.evaluate((agentId) => {
    const hooks = (window as { __pixelAgentsTestHooks?: { selectAgent?: (id: number) => void } })
      .__pixelAgentsTestHooks;
    hooks?.selectAgent?.(agentId);
  }, id);
}

/** The character's name line in its label panel (the blue label), or null
 * when the panel is hidden. */
async function labelNameLine(
  frame: import("@playwright/test").Frame,
  id: number,
): Promise<{ text: string; color: string } | null> {
  return await frame.evaluate((agentId) => {
    const overlays = Array.from(
      document.querySelectorAll(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`),
    );
    for (const el of overlays) {
      for (const span of Array.from(el.querySelectorAll("span"))) {
        const text = span.textContent ?? "";
        // The name line: a short single-line label, not the activity caption
        // (which carries the "Task: …" prefix) and not the role line.
        if (text.length > 0 && text.length <= 48 && !text.startsWith("Task:")) {
          return { text, color: getComputedStyle(span).color };
        }
      }
    }
    return null;
  }, id);
}

/** Whether the character's label panel is currently rendered. */
async function hasLabelPanel(
  frame: import("@playwright/test").Frame,
  id: number,
): Promise<boolean> {
  return await frame.evaluate((agentId) => {
    const overlays = Array.from(
      document.querySelectorAll(`[data-testid="agent-overlay"][data-agent-id="${agentId}"]`),
    );
    return overlays.some((el) => el.querySelector(".pixel-panel") !== null);
  }, id);
}

/**
 * Dismiss the webview's first-run intro tour ("Welcome to Pixel Agents!" —
 * the IntroBubble).
 *
 * The tour is a dialog that overlays the canvas and would intercept real
 * character clicks (`Reply…` and the menu-opening sprite click), silently
 * turning the click-menu reply into a 90s timeout. It must be GONE before we
 * rely on a click — so this is deterministic, not best-effort: after the
 * bounded walk (Continue/Not Now/Let's Go/Close, else Escape) it HARD-FAILS
 * (a real assertion, not a swallowed error) if any tour dialog survives,
 * because a surviving tour means every subsequent canvas click is unreliable.
 *
 * The tour is consent-request-driven and can reappear on a fresh office mount
 * (and, on the deployed stack, when a replayed consent request lands after a
 * re-seeded feed) — so callers re-run this immediately before each critical
 * click window, not once at test start.
 */
async function dismissIntroBubble(frame: import("@playwright/test").Frame): Promise<void> {
  const TOUR_DISMISS_ATTEMPTS = 8;
  const TOUR_DISMISS_WAIT_MS = 400;
  const tour = () =>
    frame.locator("dialog, [role='dialog']").filter({ hasText: "Welcome to Pixel Agents!" });
  for (let attempt = 0; attempt < TOUR_DISMISS_ATTEMPTS; attempt += 1) {
    if ((await tour().count().catch(() => 0)) === 0) return;
    // Walk the tour to its end (Continue through the steps; decline/close on
    // the consent step) so the canvas is left unobstructed.
    const next = tour()
      .getByRole("button", { name: /continue|not now|let's go|close|dismiss/i })
      .first();
    if ((await next.count().catch(() => 0)) > 0) {
      await next.click({ force: true });
    } else {
      await frame.evaluate(() =>
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })),
      );
    }
    await frame.waitForTimeout(TOUR_DISMISS_WAIT_MS);
  }
  // Post-condition assertion: a hard-fail here beats a silent 90s timeout. If
  // the tour genuinely cannot be dismissed (e.g. it reappears faster than we
  // can walk it), fail the test with a real reason instead of leaving it to
  // swallow the Reply click and expire the whole 90s reconcile budget.
  expect(
    await tour().count(),
    "the first-run intro tour must be dismissible; a surviving tour overlays the canvas and eats real character clicks",
  ).toBe(0);
}

test.describe("FR-19 — character behavior vs Paperclip lifecycle (deployed stack)", () => {
  test.beforeEach(async ({ api }) => {
    await gatePixelOffice(api);
  });

  test("a live run seats the character with the run caption (typing frames); the run ending returns it to idle with the caption closed", async ({
    page,
    api,
    seed,
  }) => {
    const feed = await ensureCompanyFeedConfigured(api, seed.company.id);
    test.skip(!feed.configured, feed.skipReason ?? "feed not configured");
    const agentName = seed.agent.name ?? seed.agent.id;

    await preparePage(page);
    await gotoPixelOffice(page);
    const frame = await officeFrame(page);

    // The seeded agent's character is declared by the bridge relay and
    // identified by its real Paperclip name.
    await expect
      .poll(async () => (await characterByName(frame, agentName)) !== undefined, {
        timeout: RECONCILE_WAIT_MS,
      })
      .toBe(true);
    const baseline = (await characterByName(frame, agentName))!;

    // Baseline: no run live — the character is not working.
    await expect
      .poll(async () => {
        const ch = await characterByName(frame, agentName);
        return ch?.isActive === false;
      }, { timeout: RECONCILE_WAIT_MS })
      .toBe(true);

    // Fire a real run. On this stack the seeded agent's adapter is
    // unauthenticated, so runs go queued -> running -> failed within ~1-3s:
    // the live window is short, so poll the office state fast and retry the
    // wakeup a bounded number of times until the active window is caught.
    let sawActive = false;
    let sawTypingWithCaption = false;
    let sawToolName: string | null | undefined;
    const attemptDeadline = Date.now() + 90_000;
    while (Date.now() < attemptDeadline && !sawTypingWithCaption) {
      await api.wakeupAgent(seed.agent.id, { issueId: seed.issue.id, reason: "e2e: FR-19 activity window" });
      const windowDeadline = Date.now() + 12_000;
      while (Date.now() < windowDeadline) {
        const ch = await characterByName(frame, agentName);
        if (ch?.isActive === true) {
          sawActive = true;
          if (ch.state === "type" && ch.currentTool != null) {
            sawTypingWithCaption = true;
            sawToolName = ch.currentTool;
            break;
          }
        }
        await page.waitForTimeout(100);
      }
    }
    expect(sawActive, "a live run must mark the character active in the office").toBe(true);
    expect(sawTypingWithCaption, "a live run must seat the character with an open caption").toBe(true);
    // The run caption ("Task: <issue title>") is NOT reading work: the
    // typing frame set renders (frame-set input is a non-reading tool name —
    // the plugin id, never a subagent-creating name).
    expect(READING_TOOLS.has(String(sawToolName))).toBe(false);

    await page.screenshot({ path: shot("fr19-run-live.png"), fullPage: true });

    // Run end (the run fails on its own within seconds): the character stops
    // working AND the caption closes (turn-end agentToolsClear parity — the
    // stale currentTool would leave typing-frames input on an idle agent).
    await expect
      .poll(async () => {
        const ch = await characterByName(frame, agentName);
        return ch?.isActive === false && ch?.currentTool == null && ch?.state !== "type";
      }, { timeout: RECONCILE_WAIT_MS })
      .toBe(true);

    await page.screenshot({ path: shot("fr19-run-ended.png"), fullPage: true });
    void baseline;
  });

  test("the blue name label renders the agent's real name under the no-policy fallback gate", async ({
    page,
    api,
    seed,
  }) => {
    const feed = await ensureCompanyFeedConfigured(api, seed.company.id);
    test.skip(!feed.configured, feed.skipReason ?? "feed not configured");
    const agentName = seed.agent.name ?? seed.agent.id;

    await preparePage(page);
    await gotoPixelOffice(page);
    const frame = await officeFrame(page);

    await expect
      .poll(async () => (await characterByName(frame, agentName)) !== undefined, {
        timeout: RECONCILE_WAIT_MS,
      })
      .toBe(true);
    const ch = (await characterByName(frame, agentName))!;
    // Every bridge agent is its own one-agent team's only member: never a
    // lead, so its label renders the NAME (not the LEAD role line).
    expect(ch.isTeamLead).not.toBe(true);

    // The bridge manifest declares no labelPolicy, so the pre-policy global
    // fallback gate governs: hidden while nothing selects/hovers the agent.
    await expect
      .poll(async () => await hasLabelPanel(frame, ch.id), { timeout: RECONCILE_WAIT_MS })
      .toBe(false);

    // Selection reveals the label; the rendered name IS the Paperclip agent
    // name, in the blue teammate color.
    await selectAgent(frame, ch.id);
    await expect
      .poll(async () => await hasLabelPanel(frame, ch.id), { timeout: RECONCILE_WAIT_MS })
      .toBe(true);
    const nameLine = await labelNameLine(frame, ch.id);
    expect(nameLine?.text).toBe(seed.agent.name);
    expect(nameLine?.color).toBe(TEAMMATE_BLUE);

    await page.screenshot({ path: shot("fr19-blue-name-label.png"), fullPage: true });
  });

  // The Pixel Office page renders the office iframe below ~300px of page
  // chrome and the iframe is ~620px tall: at the suite's default 720px
  // viewport the iframe's lower third is below the fold, and a character
  // parked there is physically unclickable (mouse events never reach
  // outside the viewport). This test clicks the character for real, so it
  // needs the whole office in view.
  test.use({ viewport: { width: 1280, height: 1080 } });

  test("the click-menu reply fails closed through the real UI (invalid payload), and a well-formed privileged invocation round-trips into Paperclip", async ({
    page,
    api,
    seed,
  }) => {
    const feed = await ensureCompanyFeedConfigured(api, seed.company.id);
    test.skip(!feed.configured, feed.skipReason ?? "feed not configured");
    const agentName = seed.agent.name ?? seed.agent.id;

    await preparePage(page);
    await gotoPixelOffice(page);
    const frame = await officeFrame(page);
    await dismissIntroBubble(frame);

    await expect
      .poll(async () => (await characterByName(frame, agentName)) !== undefined, {
        timeout: RECONCILE_WAIT_MS,
      })
      .toBe(true);
    const ch = (await characterByName(frame, agentName))!;

    const { companyIssueCount, issueCommentCount, issueHasCommentContaining } = await import("../helpers/db");
    const issueCountBefore = await companyIssueCount(seed.company.id);
    const issueCommentCountBefore = await issueCommentCount(seed.company.id, seed.issue.id);

    // ── Fail-closed half: the real click-menu path. The webview's menu
    // invocation carries only {agentId} (App.tsx handleInvokeMenuItem) —
    // the reply action requires companyId + text + feedbackId, so the
    // plugin's payload validation must refuse it, the webview must surface
    // the refusal, and NOTHING may land in Paperclip (no comment, no new
    // issue) — the fail-closed contract ("never creates new work").
    //
    // Opening the menu through the real canvas click: a click that hits the
    // sprite toggles selection AND asks the server for the plugin menu, but
    // only when the character was NOT already selected (App.tsx handleClick
    // returns early on the deselect click) — so the click helper first
    // reveals the overlay panel via the test hooks (a DOM anchor that
    // follows the character), reads its box, deselects, and then clicks the
    // sprite. Sprite geometry: the panel is centered on the character
    // (`-translate-x-1/2`, so the sprite's center line is the panel box's
    // centerX — NOT its left edge) and sits 28px above
    // toScreenY(anchorY-32), while the sprite hit box spans
    // [panelTop+28+8α, panelTop+28+32α] in CSS px (α = zoom/dpr, deployment
    // dependent — the deployed office runs zoom 0.5). Instead of assuming α,
    // the helper sweeps the candidate band reading the canvas's own hover
    // cursor (`pointer` on a character hit — OfficeCanvas's mousemove hit
    // test) and clicks the first point the office itself says is a
    // character. Idle agents wander between the anchor read and the sweep,
    // so missed sweeps just retry with a fresh anchor.
    const menu = frame.locator('[data-testid="agent-menu"]');
    const clickCharacterForMenu = async (): Promise<boolean> => {
      // Deterministic precondition: the intro tour can reappear between the
      // start of the test and this menu-opening sprite click (a fresh office
      // mount, or a replayed consent request on the re-seeded feed). Re-dismiss
      // it here so this sweep's canvas click actually reaches the character.
      await dismissIntroBubble(frame);
      // Only anchor-and-sweep while the character is stationary: an idle
      // office character alternates desk/rest stops ('idle'/'type') with
      // wandering ('walk'), and an anchor read during a walk is stale
      // before the sweep reaches the sprite.
      await expect
        .poll(async () => {
          const chNow = await characterByName(frame, agentName);
          return chNow?.state !== undefined && chNow.state !== "walk";
        }, { timeout: 20_000 })
        .toBe(true);
      await selectAgent(frame, ch.id);
      const overlay = frame.locator(
        `[data-testid="agent-overlay"][data-agent-id="${ch.id}"]`,
      ).first();
      await expect(overlay).toBeVisible({ timeout: RECONCILE_WAIT_MS });
      const box = await overlay.boundingBox();
      expect(box).not.toBeNull();
      await selectAgent(frame, 0);
      const centerX = box!.x + box!.width / 2;
      // The plugin widget dock (PluginPanels: right-aligned, 360px wide,
      // top 56px) intercepts mouse events over the office's top-right
      // corner — a character parked behind it is unclickable until it
      // moves. Bail (the retry loop re-anchors) when the swept band would
      // run under the dock.
      const frameWidth = await frame.evaluate(() => window.innerWidth);
      if (centerX > frameWidth - 380 && box!.y + 26 < 130) return false;
      const readCursor = async (): Promise<string> =>
        frame.locator("canvas").first().evaluate(
          (el) => (el as HTMLCanvasElement).style.cursor || "",
        );
      // The band below the panel where the sprite can render across the
      // supported zoom range; swept fast so the anchor stays fresh while
      // the character is stationary (seated/idle-at-desk).
      for (let k = 26; k <= 94; k += 4) {
        await page.mouse.move(centerX, box!.y + k);
        await page.waitForTimeout(20);
        if ((await readCursor()) === "pointer") {
          await page.mouse.click(centerX, box!.y + k);
          return true;
        }
      }
      return false;
    };
    let opened = false;
    for (let attempt = 0; attempt < 10 && !opened; attempt += 1) {
      if (await clickCharacterForMenu()) {
        try {
          await menu.waitFor({ state: "visible", timeout: 5_000 });
          opened = true;
        } catch {
          // Wandered between sweep and click, or the click landed on a pet:
          // loop re-reads the anchor and sweeps again.
        }
      }
    }
    await expect(menu).toBeVisible({ timeout: RECONCILE_WAIT_MS });
    const replyItem = menu.getByRole("button", { name: "Reply…" });
    await expect(replyItem).toBeVisible({ timeout: RECONCILE_WAIT_MS });
    // The menu overlay re-anchors to the character every frame, and an idle
    // character can start wandering at any moment — a moving target never
    // passes Playwright's element-stability gate, so click at its current
    // position (the button is real; only its anchor moves).
    //
    // Deterministic precondition: re-dismiss the tour immediately before the
    // Reply click — a tour that survived or reappeared after the menu opened
    // would sit over the canvas and eat this click (no invocation → no toast
    // → the 90s reconcile timeout). Hard-fails if it cannot be dismissed.
    await dismissIntroBubble(frame);
    await replyItem.click({ force: true });

    // The server's refusal surfaces as the plugin toast.
    const toast = frame.locator('[data-testid="plugin-toast"]');
    await expect(toast).toBeVisible({ timeout: RECONCILE_WAIT_MS });
    await expect(toast).toContainText("Server refused:");
    await page.screenshot({ path: shot("fr19-click-menu-refused.png"), fullPage: true });

    // Fail-closed read-back: no new issue, and no comment landed on the
    // bound issue (comment COUNT unchanged — robust across reruns, whose
    // earlier legitimate replies stay in the persistent database).
    await page.waitForTimeout(3_000);
    expect(await companyIssueCount(seed.company.id)).toBe(issueCountBefore);
    expect(await issueCommentCount(seed.company.id, seed.issue.id)).toBe(issueCommentCountBefore);

    // ── Positive half: the SAME real path (privileged pixel-agents
    // WebSocket -> plugin host action -> reply forwarder -> Paperclip plugin
    // action) with a WELL-FORMED payload must deliver the reply onto the
    // bound issue as a comment — and still create no new issue.
    const { trySeedBoundFeedback } = await import("../helpers/seed");
    const boundFeed = await trySeedBoundFeedback(api, seed);
    test.skip(!boundFeed, "no deterministic bound feedback seed produced on the deployed stack (see helper)");

    // The webview's own transport connects to `${origin}/ws?token=…`
    // (webview-ui/src/transport/index.ts) — the page path has no websocket
    // handler, so the raw client must use the /ws route with the same
    // tokened query the office iframe was opened from (that query is what
    // privileges the handshake: httpServer standaloneTokenValid).
    const frameUrl = new URL(frame.url());
    const wsUrl = frameUrl.origin.replace(/^http/, "ws") + "/ws" + frameUrl.search;
    const replyText = `fr19 round-trip reply ${new Date().toISOString()}`;

    const result = await new Promise<{ ok: boolean; error?: string }>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.close();
        reject(new Error("pluginActionResult not received within 20s"));
      }, 20_000);
      ws.on("open", () => {
        ws.send(
          JSON.stringify({
            type: "invokePluginAction",
            pluginId: "paperclip",
            actionId: "reply-to-feedback",
            payload: {
              companyId: seed.company.id,
              feedbackId: boundFeed!.id,
              text: replyText,
            },
          }),
        );
      });
      ws.on("message", (data: WebSocket.RawData) => {
        const msg = JSON.parse(String(data)) as { type?: string; ok?: boolean; error?: string };
        if (msg.type === "pluginActionResult") {
          clearTimeout(timeout);
          ws.close();
          resolve({ ok: msg.ok === true, error: msg.error });
        }
      });
      ws.on("error", (err: Error) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
    expect(result, `reply round-trip refused: ${result.error ?? "?"}`).toEqual({ ok: true });

    // The reply landed on the bound issue as a comment (API/DB read-back),
    // and no new issue was created anywhere in the company.
    await expect
      .poll(async () => issueHasCommentContaining(seed.company.id, seed.issue.id, replyText), {
        timeout: RECONCILE_WAIT_MS,
      })
      .toBe(true);
    expect(await companyIssueCount(seed.company.id)).toBe(issueCountBefore);
    await page.screenshot({ path: shot("fr19-reply-round-trip.png"), fullPage: true });
  });
});
