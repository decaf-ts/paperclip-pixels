/**
 * Embedding surface glue (spec PAPERCLIP_PIXELS-2, WS2-D): the module the
 * deployed Pixel Agents server loads through the fork's generic
 * `--plugin <module>` startup loader.
 *
 * One `register(host, context)` call composes the delivered WS2-C pieces into
 * the live bridge endpoint inside the Pixel Agents server process:
 *
 * 1. registers the Paperclip plugin through the real WS2-A1 host API
 *    (`createPaperclipPluginRegistration` — manifest, reply actions, roster
 *    re-declaration on start), capturing the plugin's sanctioned agent/team
 *    source off its {@link PixelAgentsPluginContext} at onStart;
 * 2. mounts the framework-agnostic feed handler ({@link createPluginFeedHandler})
 *    on its own sidecar HTTP listener at `POST /api/plugin-feed`, so the
 *    Paperclip worker's relay (`src/relay.ts` → `PluginFeedHttpSink`) can push
 *    feed batches into the process;
 * 3. wires click-menu replies into the plugin's EXISTING Paperclip actions
 *    through the performAction proxy (`HttpReplyForwarder` →
 *    `agent.reply-to-feedback` / `company.send-message`) — fail-closed, zero
 *    issue-creation code anywhere on this path;
 * 4. adopts the WS4-A first-class appearance path (WS4-C): declares the
 *    plugin's WS3 character catalog at onStart and applies per-agent
 *    `assignAgentAppearance` feed operations; and re-emits the worker's
 *    pre-redacted `dialogLines` feed operations through the plugin's
 *    declared `paperclip.dialog.lines` message type, feeding the
 *    dialog-pane shell-panel widget.
 *
 * Auth is fail-closed by construction: the feed endpoint requires a
 * shared-secret bearer token (constant-time compare), rejects unauthenticated
 * pushes with 401, never accepts a token in the URL, and refuses to start at
 * all without a configured secret. The token is never logged.
 *
 * Configuration is environment variables (the embedding surface runs in the
 * Pixel Agents server process, which has no Paperclip plugin-config channel):
 *   - `PAPERCLIP_PIXEL_FEED_HOST`   bind host   (default `127.0.0.1`)
 *   - `PAPERCLIP_PIXEL_FEED_PORT`   bind port   (default `8081` — the
 *     companion bind the relay's `pixelAgentsUrl` already defaults to)
 *   - `PAPERCLIP_PIXEL_FEED_TOKEN`  REQUIRED shared secret for the feed
 *     endpoint; the Paperclip side configures the same value as its
 *     `pixelAgentsTokenRef` secret. Missing → register() throws (fail-closed
 *     startup — an unauthenticated feed endpoint must never come up).
 *   - `PAPERCLIP_PIXEL_API_BASE_URL` Paperclip API base URL for the reply
 *     forwarder (default `http://127.0.0.1:3100`)
 *   - `PAPERCLIP_PIXEL_API_TOKEN`   board API key for the reply forwarder.
 *     Optional; without it the plugin still registers and the feed still
 *     applies, but every click-menu reply fails closed with
 *     `forwarderNotConfigured` (never forwards unauthenticated).
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { PLUGIN_ID } from "./constants.js";
import {
  createFeedAppearanceApplier,
  loadPluginCharacterSheets,
  type PluginCharacterSheets,
} from "./appearance.js";
import { PAPERCLIP_DIALOG_LINES_MESSAGE, PAPERCLIP_PIXEL_PLUGIN_ID } from "./manifest.js";
import { createPluginFeedHandler, type PluginFeedHandlerResult } from "./feed-server.js";
import { createPaperclipPluginRegistration } from "./plugin.js";
import { HttpReplyForwarder, type ReplyFetchLike, type ReplyForwarder } from "./reply-forwarder.js";
import type {
  PixelAgentsPluginContext,
  PixelAgentsPluginHost,
  PluginAgentSource,
  PluginAppearanceSource,
} from "@decaf-ts/paperclip-pixels-common";

/** Feed endpoint path served by the embedding surface's sidecar listener. */
export const PLUGIN_FEED_PATH = "/api/plugin-feed";

/** Hard cap on one feed request body (the relay's batches are small JSON). */
const MAX_FEED_BODY_BYTES = 1024 * 1024;

/** Default feed bind: the companion sidecar port `pixelAgentsUrl` already
 *  defaults to on the Paperclip side (src/relay.ts). */
const DEFAULT_FEED_HOST = "127.0.0.1";
const DEFAULT_FEED_PORT = 8081;

/** Default Paperclip API base (same loopback default as the relay's
 *  tool-activity poller, `DEFAULT_PAPERCLIP_API_BASE_URL` in src/relay.ts). */
const DEFAULT_API_BASE_URL = "http://127.0.0.1:3100";

/** Fully-resolved embedding configuration. */
export interface EmbeddingConfig {
  feedHost: string;
  feedPort: number;
  feedToken: string;
  apiBaseUrl: string;
  /** Undefined → replies fail closed with `forwarderNotConfigured`. */
  apiToken?: string;
}

/**
 * Parse the embedding environment. Pure (env passed in) so the fail-closed
 * gates are unit-testable without process globals. Throws on a missing feed
 * token or an unusable port — the fork's plugin loader turns that into an
 * aborted startup, which is exactly the intended fail-closed behavior.
 */
export function parseEmbeddingEnv(env: Record<string, string | undefined>): EmbeddingConfig {
  const feedToken = env.PAPERCLIP_PIXEL_FEED_TOKEN?.trim() ?? "";
  if (feedToken.length === 0) {
    throw new Error(
      "PAPERCLIP_PIXEL_FEED_TOKEN is required: the plugin feed endpoint is fail-closed "
        + "and refuses to start without a shared-secret bearer token. Set it to the same "
        + "value the Paperclip side resolves from its pixelAgentsTokenRef secret.",
    );
  }
  const rawPort = env.PAPERCLIP_PIXEL_FEED_PORT?.trim() ?? "";
  let feedPort = DEFAULT_FEED_PORT;
  if (rawPort.length > 0) {
    const parsed = Number(rawPort);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
      throw new Error(`Invalid PAPERCLIP_PIXEL_FEED_PORT "${rawPort}": must be an integer 1-65535.`);
    }
    feedPort = parsed;
  }
  const apiToken = env.PAPERCLIP_PIXEL_API_TOKEN?.trim();
  return {
    feedHost: env.PAPERCLIP_PIXEL_FEED_HOST?.trim() || DEFAULT_FEED_HOST,
    feedPort,
    feedToken,
    apiBaseUrl: (env.PAPERCLIP_PIXEL_API_BASE_URL?.trim() || DEFAULT_API_BASE_URL).replace(/\/$/, ""),
    ...(apiToken ? { apiToken } : {}),
  };
}

/** Constant-time bearer-token compare (compare fixed-length digests, never
 *  the raw secrets, so both length and content stay out of the timing
 *  channel — same discipline as the fork's privilege-token gate). */
export function bearerTokenMatches(expected: string, actual: string): boolean {
  const expectedDigest = createHash("sha256").update(expected).digest();
  const actualDigest = createHash("sha256").update(actual).digest();
  return timingSafeEqual(expectedDigest, actualDigest);
}

/** Extract the bearer token from an Authorization header, or undefined. */
function bearerTokenOf(header: string | undefined): string | undefined {
  const match = /^Bearer\s+(.+)$/.exec(header ?? "");
  return match?.[1] ?? undefined;
}

function sendJson(res: ServerResponse, status: number, body: Record<string, unknown>): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    // No reason for a browser to cache or sniff a machine endpoint.
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(payload);
}

/** Read one request body with a hard size cap. Resolves the parsed UTF-8
 *  string; rejects with a status + machine error on overflow/abort. */
function readBody(
  req: IncomingMessage,
): Promise<{ status: number; body: string } | { status: number; error: string }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_FEED_BODY_BYTES) {
        req.destroy();
        resolve({ status: 413, error: "bodyTooLarge" });
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve({ status: 200, body: Buffer.concat(chunks).toString("utf8") }));
    req.on("error", () => resolve({ status: 400, error: "bodyUnreadable" }));
  });
}

/** Structured log event (ids/counts only — never tokens, never payloads). */
function logEvent(event: string, fields?: Record<string, unknown>): void {
  console.log(`[paperclip-pixel-embedding] ${event}${fields ? ` ${JSON.stringify(fields)}` : ""}`);
}

/**
 * The feed endpoint's HTTP request handler: `POST /api/plugin-feed` only,
 * shared-secret bearer auth, JSON body, everything else a flat 404/405/401.
 * Exposed so the wire contract is testable without a real listener.
 */
export function createEmbeddingRequestHandler(
  config: EmbeddingConfig,
  handleFeed: (rawBody: unknown) => Promise<PluginFeedHandlerResult>,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    // Path first (query string ignored — a token must never ride the URL):
    // unknown paths get an opaque 404 regardless of auth, so the endpoint
    // does not advertise itself to scanners.
    const path = (req.url ?? "").split("?")[0];
    if (path !== PLUGIN_FEED_PATH) {
      sendJson(res, 404, { ok: false, error: "notFound" });
      return;
    }
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "methodNotAllowed" });
      return;
    }
    const token = bearerTokenOf(req.headers.authorization);
    if (token === undefined || !bearerTokenMatches(config.feedToken, token)) {
      logEvent("paperclip_feed_unauthorized");
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    void (async () => {
      const read = await readBody(req);
      if (!("body" in read)) {
        sendJson(res, read.status, { ok: false, error: read.error });
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(read.body);
      } catch {
        sendJson(res, 400, { ok: false, error: "invalidJson" });
        return;
      }
      try {
        const result = await handleFeed(parsed);
        sendJson(res, result.status, result.body);
      } catch {
        // The feed handler validates fail-closed; this is a last-resort
        // boundary (e.g. the plugin was stopped mid-request). No detail
        // leaks to the pusher.
        sendJson(res, 500, { ok: false, error: "internalError" });
      }
    })();
  };
}

/** Node-global fetch adapted to the forwarder's injectable shape. */
function globalReplyFetch(): ReplyFetchLike {
  return async (url, init) => fetch(url, init);
}

/**
 * Register + start the Paperclip plugin and serve its feed endpoint — the
 * one-call integration for the fork's generic `--plugin` loader.
 *
 * Composition detail: the feed handler applies operations through the
 * plugin's sanctioned agent/team source, which the host only hands out in
 * the plugin's onStart context. The glue therefore wraps the registration's
 * onStart (after the delivered re-declare logic runs, the captured source
 * becomes the feed's apply target). Until then the feed's proxy source
 * refuses — fail-closed — and since registration + start happen here,
 * before the listener accepts anything, the race is structurally closed.
 */
export async function register(
  host: PixelAgentsPluginHost,
  _context: { store?: unknown },
): Promise<void> {
  const config = parseEmbeddingEnv(process.env);

  // The plugin's agent/team + appearance sources, captured at onStart.
  let pluginSource: PluginAgentSource | undefined;
  let pluginAppearance: PluginAppearanceSource | undefined;
  let pluginCtx: PixelAgentsPluginContext | undefined;
  const sourceProxy: PluginAgentSource = {
    declareAgents: (agents) => {
      if (!pluginSource) throw new Error("pluginNotStarted");
      pluginSource.declareAgents(agents);
    },
    removeAgents: (keys) => {
      if (!pluginSource) throw new Error("pluginNotStarted");
      pluginSource.removeAgents(keys);
    },
    updateAgentStatus: (key, status) => {
      if (!pluginSource) throw new Error("pluginNotStarted");
      pluginSource.updateAgentStatus(key, status);
    },
    updateAgentActivity: (key, activity) => {
      if (!pluginSource) throw new Error("pluginNotStarted");
      pluginSource.updateAgentActivity(key, activity);
    },
    updateAgentLabelPolicy: (key, policy) => {
      if (!pluginSource) throw new Error("pluginNotStarted");
      pluginSource.updateAgentLabelPolicy(key, policy);
    },
  };

  // WS4-C: the plugin's WS3 character catalog as WS4-A sheet declarations.
  // Load best-effort — a missing/malformed catalog degrades to built-in
  // palette rendering (the host's own fail-closed fallback) and never
  // aborts the bridge: names, rooms, statuses, replies, and the dialog
  // pane all keep working.
  let characterSheets: PluginCharacterSheets | undefined;
  try {
    characterSheets = loadPluginCharacterSheets();
  } catch (err) {
    logEvent("paperclip_appearance_catalog_unavailable", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const appearanceApplier = createFeedAppearanceApplier({
    getSource: () => pluginAppearance,
    getSheets: () => characterSheets,
    log: logEvent,
  });

  const feed = createPluginFeedHandler({
    source: sourceProxy,
    appearance: appearanceApplier,
    dialog: {
      // WS4-C: re-emit pre-redacted conversation lines through the
      // plugin's declared message type. ctx is captured at onStart; the
      // feed refuses (fail-closed, like the agent source) before that.
      emitLines: (lines) => {
        if (!pluginCtx) throw new Error("pluginNotStarted");
        for (const line of lines) {
          pluginCtx.emit(PAPERCLIP_DIALOG_LINES_MESSAGE, { text: line.text });
        }
      },
    },
    log: logEvent,
  });

  const forwarder = config.apiToken
    ? new HttpReplyForwarder({
        apiBaseUrl: config.apiBaseUrl,
        apiToken: config.apiToken,
        pluginId: PLUGIN_ID,
        fetch: globalReplyFetch(),
      })
    : undefined;
  const forwardReply: ReplyForwarder = forwarder
    ? async (request) => forwarder.forward(request)
    : async () => ({ ok: false, error: "forwarderNotConfigured" });

  const registration = createPaperclipPluginRegistration({
    getDeclaredAgents: () => feed.cache.getDeclaredAgents(),
    forwardReply,
    log: logEvent,
  });

  const innerOnStart = registration.handlers.onStart;
  registration.handlers.onStart = (ctx: PixelAgentsPluginContext) => {
    const result = innerOnStart?.(ctx);
    pluginSource = ctx.agents;
    pluginCtx = ctx;
    pluginAppearance = ctx.appearance;
    // WS4-C: declare the plugin's character catalog through the first-class
    // appearance path. The host privilege-gates every sheet against the
    // operator-granted external asset directories (WS1 grants, unwidened)
    // and refuses the whole declaration fail-closed when the catalog dir is
    // not granted — agents then keep built-in palette rendering, and a
    // plugin restart re-declares once the grant exists.
    if (characterSheets) {
      try {
        ctx.appearance.declareCharacterCatalog(characterSheets.sheets);
        logEvent("paperclip_appearance_catalog_declared", {
          plugin: PAPERCLIP_PIXEL_PLUGIN_ID,
          sheets: characterSheets.sheets.length,
        });
      } catch (error) {
        // Best-effort contract: a host refusal (e.g. the asset gate rejecting
        // an ungranted catalog directory) must never propagate out of
        // onStart. Agents keep built-in palette rendering; a plugin restart
        // re-declares once the grant exists.
        logEvent("paperclip_appearance_catalog_refused", {
          plugin: PAPERCLIP_PIXEL_PLUGIN_ID,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  };

  const server = createServer(
    createEmbeddingRequestHandler(config, (rawBody) => feed.handle(rawBody)),
  );
  registration.handlers.onStop = () => {
    server.close();
  };

  host.registerPlugin(registration);
  host.startPlugin(registration.id);

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.feedPort, config.feedHost, () => resolve());
  });
  logEvent("paperclip_feed_listening", { host: config.feedHost, port: config.feedPort });
}

// `default` is also exported so the module works with the fork loader's
// default-export fallback as well as the named `register` export.
export default register;
