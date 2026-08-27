/**
 * Global setup for the Pixel Office e2e suite (spec PAPERCLIP_PIXELS-1,
 * SAA-231).
 *
 * Ensures the deployed bridge stack endpoints are reachable (reusing existing
 * port-forwards or starting them via kubectl) and prepares the screenshot
 * output directory. Login + seeding happen per browser context in the fixtures
 * so each run starts from a clean authenticated session. Port-forwards started
 * here are torn down by global-teardown.ts.
 */

import fs from "node:fs";

import { e2ePath, SCREENSHOT_DIR } from "./helpers/env";
import { ensureReachable, readinessReport } from "./helpers/port-forward";

export default async function globalSetup(): Promise<void> {
  fs.mkdirSync(e2ePath(SCREENSHOT_DIR), { recursive: true });

  await ensureReachable();

  const readiness = await readinessReport();
  // eslint-disable-next-line no-console
  console.log(`[e2e:global-setup] readiness: ${JSON.stringify(readiness)}`);
  if (!readiness.host) {
    throw new Error(
      "Paperclip host is not reachable. Start the port-forward to svc/paperclip " +
        "(see deploy/README.md) or run on the shared daemon host.",
    );
  }
}
