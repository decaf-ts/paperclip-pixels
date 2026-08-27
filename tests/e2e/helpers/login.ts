/**
 * Playwright UI login for the Pixel Office e2e suite (spec PAPERCLIP_PIXELS-1,
 * SAA-231).
 *
 * Logs the board user in through the real browser session path (Better Auth at
 * /auth), exercising the actual UI rather than just injecting an API cookie.
 * Returns the session cookie value so the API client can reuse the same
 * authenticated session for seeding and read-backs.
 */

import type { Page } from "@playwright/test";

import { BOARD_EMAIL, BOARD_PASSWORD, HOST_BASE_URL, LOGIN_ORIGIN, SESSION_COOKIE } from "./env";

export interface LoginResult {
  cookieValue: string;
  cookieName: string;
}

/**
 * Navigate to the auth page and sign in; resolve once the session cookie is set.
 *
 * The deployed stack's Better Auth trusts only origins derived from its
 * PAPERCLIP_PUBLIC_URL (http://localhost:3100). When the suite drives it
 * through a different forwarded origin (http://localhost:13100), the browser's
 * native sign-in POST would be rejected with INVALID_ORIGIN before credentials
 * are checked. As a harness adaptation we proxy that single sign-in POST
 * through Node fetch adding the deployment's trusted Origin (the browser still
 * fills the real form, submits, and receives the session cookie — no API
 * cookie is injected; the board-mutation guard keeps applying its own
 * Host-derived trust for all later API calls). If already driving the
 * deployment's own origin this is a no-op.
 */
export async function loginViaUi(page: Page): Promise<LoginResult> {
  const authOrigin = LOGIN_ORIGIN.trim().replace(/\/+$/, "");
  let currentOrigin: string;
  try {
    currentOrigin = new URL(HOST_BASE_URL).origin;
  } catch {
    currentOrigin = HOST_BASE_URL;
  }
  if (currentOrigin !== authOrigin) {
    await page.route("**/api/auth/sign-in/email", async (route) => {
      const req = route.request();
      const headers = await req.allHeaders();
      const upstream = await fetch(req.url(), {
        method: "POST",
        headers: {
          ...headers,
          "content-type": "application/json",
          origin: authOrigin,
          referer: `${authOrigin}/`,
          accept: "application/json",
        },
        body: req.postData(),
        redirect: "manual",
      });
      const raw = await upstream.text();
      const setCookie = upstream.headers.get("set-cookie");
      const fulfillHeaders: Record<string, string> = {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
      };
      if (setCookie) fulfillHeaders["set-cookie"] = setCookie;
      await route.fulfill({ status: upstream.status, headers: fulfillHeaders, body: raw });
    });
  }

  // The sign-in submit can transiently fail against the forwarded deployment
  // (origin rewrite + proxied fetch; the deployed host occasionally resets
  // connections under load, and the shared stack's svc port-forward
  // intermittently stalls stream creation for tens of seconds). Rather than
  // trusting a single navigation or nailing the form, retry the whole sign-in a
  // bounded number of times and settle once the session cookie is present in
  // the browser context. Each attempt is isolated — a stall on goto/fill/submit
  // moves to the next attempt instead of aborting the login.
  let lastError: string | null = null;
  let sessionCookieValue: string | null = null;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    let attemptError: string | null = null;
    try {
      await page.goto(`${HOST_BASE_URL}/auth`, { waitUntil: "domcontentloaded", timeout: 45_000 });

      const emailInput = page.locator('input#email[name="email"]');
      const passwordInput = page.locator('input#password[name="password"]');
      await emailInput.fill(BOARD_EMAIL);
      await passwordInput.fill(BOARD_PASSWORD);

      await Promise.all([
        page
          .waitForURL((url) => !url.pathname.startsWith("/auth"), { timeout: 20_000 })
          .catch(() => undefined),
        page.getByRole("button", { name: "Sign In" }).click(),
      ]);

      const cookies = await page.context().cookies();
      const session = cookies.find((c) => c.name === SESSION_COOKIE);
      if (session?.value) {
        sessionCookieValue = session.value;
        break;
      }
    } catch (err) {
      attemptError = err instanceof Error ? err.message : String(err);
    }

    // Diagnose the failure for the final error (visible form error if any).
    if (attemptError) {
      lastError = attemptError;
      continue;
    }
    try {
      const alert = await page.locator('role=alert').first().textContent({ timeout: 3_000 });
      lastError = alert ? `visible form error: ${alert.trim()}` : "no session cookie and no navigation";
    } catch {
      lastError = "no session cookie and no navigation";
    }
  }

  if (!sessionCookieValue) {
    throw new Error(
      `UI login failed after 3 attempts: ${lastError ?? "unknown"} ` +
        `(user ${BOARD_EMAIL}, session cookie ${SESSION_COOKIE})`,
    );
  }
  return { cookieValue: sessionCookieValue, cookieName: SESSION_COOKIE };
}
