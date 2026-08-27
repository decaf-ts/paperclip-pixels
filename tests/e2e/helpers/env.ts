/**
 * Environment configuration for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * The suite drives the deployed SAA-212 minikube bridge stack through
 * port-forwards. Endpoints can be overridden via env vars so a runner who
 * already has port-forwards up (the common QA/DevOps handoff) can point the
 * suite straight at them without re-forwarding.
 */

function int(env: string | undefined, fallback: number): number {
  const raw = env ? process.env[env] : undefined;
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function str(env: string | undefined, fallback: string): string {
  const raw = env ? process.env[env] : undefined;
  return raw === undefined || raw === "" ? fallback : raw;
}

/** Paperclip host UI + API base URL (already-forwarded local port). */
export const HOST_BASE_URL = str(
  "PAPERCLIP_PIXEL_E2E_HOST_URL",
  "http://localhost:13100",
);

/** Standalone Pixel Agents base URL (phase 2; not driven by this suite). */
export const PIXEL_AGENTS_BASE_URL = str(
  "PAPERCLIP_PIXEL_E2E_PIXEL_AGENTS_URL",
  "http://localhost:18080",
);

/** Postgres read-back connection (already-forwarded local port). */
export const DB_PORT = int("PAPERCLIP_PIXEL_E2E_DB_PORT", 15432);
export const DB_HOST = str("PAPERCLIP_PIXEL_E2E_DB_HOST", "localhost");
export const DB_USER = str("PAPERCLIP_PIXEL_E2E_DB_USER", "paperclip");
export const DB_PASSWORD = str("PAPERCLIP_PIXEL_E2E_DB_PASSWORD", "paperclip");
export const DB_NAME = str("PAPERCLIP_PIXEL_E2E_DB_NAME", "paperclip");

/** Disposable test-stack board credentials (dev secrets committed in deploy/k8s). */
export const BOARD_EMAIL = str("PAPERCLIP_PIXEL_E2E_BOARD_EMAIL", "qa-e2e@pixel.local");
export const BOARD_PASSWORD = str("PAPERCLIP_PIXEL_E2E_BOARD_PASSWORD", "QaE2e-Pixel-2026!");

/** Better Auth session cookie name on the default instance. */
export const SESSION_COOKIE = str("PAPERCLIP_PIXEL_E2E_SESSION_COOKIE", "paperclip-default.session_token");

/**
 * The deployed stack's trusted auth origin. The bridge pod runs with
 * PAPERCLIP_PUBLIC_URL=http://localhost:3100, so its Better Auth instance only
 * trusts the `http://localhost:3100` origin. Driven through a port-forward
 * (HOST_BASE_URL=http://localhost:13100) the browser's native Origin header is
 * `http://localhost:13100`, which Better Auth rejects (INVALID_ORIGIN) before
 * checking credentials. The login helper rewrites the sign-in POST's
 * Origin/Referer to this value so the real UI login path is exercised; the
 * board-mutation guard continues to apply its own Host-derived trust for all
 * later API calls. Override only if the deployment's PUBLIC_URL changes.
 */
export const LOGIN_ORIGIN = str("PAPERCLIP_PIXEL_E2E_LOGIN_ORIGIN", "http://localhost:3100");

/** Deterministic seed data (idempotent — reused if present). */
export const SEED_COMPANY_NAME = str("PAPERCLIP_PIXEL_E2E_SEED_COMPANY", "E2E Pixel Test Co");
export const SEED_AGENT_NAME = str("PAPERCLIP_PIXEL_E2E_SEED_AGENT", "E2E Pixel Agent");
export const SEED_ISSUE_TITLE = str("PAPERCLIP_PIXEL_E2E_SEED_ISSUE", "E2E Pixel seeded issue");

/** Plugin identifiers (discovered at runtime; these are fallbacks/known values). */
export const PIXEL_OFFICE_PLUGIN_ID = "paperclip-pixel-agents";
export const PIXEL_OFFICE_SIDEBAR_TESTID = "pixel-office-sidebar-link";
export const PIXEL_OFFICE_PAGE_TESTID = "pixel-office-page";

/** Bounded-wait defaults (ms). */
export const SHORT_WAIT_MS = 5_000;
export const STATE_CHANGE_WAIT_MS = 30_000;
export const RECONCILE_WAIT_MS = 90_000;

/** Screenshot output dir (relative to e2e/). */
export const SCREENSHOT_DIR = "screenshots";

/**
 * Gate: when true, the suite skips gracefully if the Pixel Office UI slot is
 * not yet wired (SAA-230 not done). Set PAPERCLIP_PIXEL_E2E_NO_GATE=1 to force
 * the suite to run (fail rather than skip) — used after SAA-230 lands.
 */
export const SKIP_WHEN_UNWIRED = process.env.PAPERCLIP_PIXEL_E2E_NO_GATE !== "1";

/** Resolve a path relative to the e2e/ directory. */
export function e2ePath(relative: string): string {
  return `${import.meta.dirname}/../${relative}`;
}
