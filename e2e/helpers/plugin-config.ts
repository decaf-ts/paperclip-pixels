/**
 * Idempotent bridge-plugin feed configuration for a company (FR-19 deployed
 * stack, SAA-694).
 *
 * The office iframe renders and the relay pushes only for companies whose
 * plugin config carries the feed wiring (`pixelAgentsUrl` + token secret +
 * `pixelAgentsUiUrl`). Deployment-time configuration is a manual operator
 * step (deploy/README §"After the first company exists"), so the FR-19 specs
 * apply it to the seed company through the same routes the settings UI uses
 * (POST /api/companies/:id/secrets + POST /api/plugins/:id/config) —
 * idempotently: a company that already has a config is left untouched.
 *
 * Required runner env (see e2e/helpers/env.ts):
 *   PAPERCLIP_PIXEL_E2E_FEED_TOKEN   the pixel-agents container's
 *                                    PAPERCLIP_PIXEL_FEED_TOKEN
 *   PAPERCLIP_PIXEL_E2E_WEBVIEW_URL  the tokened standalone webview URL the
 *                                    office iframe embeds
 * When the company is unconfigured and either value is missing, the specs
 * skip with a precise reason instead of failing on runner setup.
 */

import { PaperclipApi } from "./api-client";
import { PIXEL_FEED_TOKEN, PIXEL_FEED_URL, PIXEL_WEBVIEW_URL } from "./env";

/** Outcome of {@link ensureCompanyFeedConfigured}: whether the company's feed
 * wiring is in place, and — when it is not — the precise skip reason the spec
 * should surface (never a bare failure on runner setup). */
export interface FeedConfigResult {
  /** `true` when the company already had a config or this call applied one. */
  configured: boolean;
  /** Why the wiring could not be applied (specs `test.skip` on this). */
  skipReason?: string;
}

/** The seed company's bridge feed wiring, applied when absent. */
export async function ensureCompanyFeedConfigured(
  api: PaperclipApi,
  companyId: string,
): Promise<FeedConfigResult> {
  const plugin = await api.pixelPluginRecord();
  if (!plugin) {
    return { configured: false, skipReason: "pixel bridge plugin not registered on this stack" };
  }
  const existing = await api.pluginConfig(plugin.id, companyId);
  if (existing?.configJson && typeof existing.configJson.pixelAgentsUrl === "string") {
    return { configured: true };
  }
  if (!PIXEL_FEED_TOKEN || !PIXEL_WEBVIEW_URL) {
    return {
      configured: false,
      skipReason:
        "company has no bridge plugin config and the runner did not provide " +
        "PAPERCLIP_PIXEL_E2E_FEED_TOKEN / PAPERCLIP_PIXEL_E2E_WEBVIEW_URL " +
        "(deployed-stack feed wiring; see e2e/helpers/plugin-config.ts)",
    };
  }
  const secret = await api.createCompanySecret(companyId, {
    name: "pixel-agents-feed-token",
    key: "pixel-agents-feed-token",
    value: PIXEL_FEED_TOKEN,
  });
  // SAA-734 reconcile: the separate-container compose topology reaches the
  // feed at a non-loopback internal hostname (e.g. http://pixel-agents:8081),
  // which the https-when-token transport contract rejects by default. The
  // runner's PIXEL_FEED_URL host IS the operator-declared trusted internal
  // peer, so declare it explicitly in pixelAgentsAllowedHttpHosts — a
  // scoped carve-out, not a blanket relaxation (loopback URLs are already
  // allowed and are simply re-declared harmlessly).
  let allowedHttpHosts: string[] = [];
  try {
    const host = new URL(PIXEL_FEED_URL).hostname;
    if (host.length > 0) allowedHttpHosts = [host];
  } catch { /* non-URL feed value: leave the default fail-closed allowlist. */ }
  await api.savePluginConfig(plugin.id, companyId, {
    relayEnabled: true,
    pixelAgentsUrl: PIXEL_FEED_URL,
    pixelAgentsUiUrl: PIXEL_WEBVIEW_URL,
    pixelAgentsTokenRef: { type: "secret_ref", secretId: secret.id },
    ...(allowedHttpHosts.length > 0 ? { pixelAgentsAllowedHttpHosts: allowedHttpHosts } : {}),
  });
  return { configured: true };
}
