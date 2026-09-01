/**
 * Global teardown for the Pixel Office e2e suite (spec PAPERCLIP_PIXELS-1,
 * SAA-231). Tears down any port-forwards started by global-setup.
 */

import { teardownPortForwards } from "./helpers/port-forward";

export default async function globalTeardown(): Promise<void> {
  teardownPortForwards();
}
