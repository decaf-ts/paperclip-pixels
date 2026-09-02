/**
 * Reply forwarding: the transport boundary between the Paperclip plugin's
 * Pixel-Agents-side action handlers and the plugin's EXISTING Paperclip
 * intake/feedback actions (spec PAPERCLIP_PIXELS-2, WS2-C, fail-closed
 * invariant).
 *
 * The click-menu "reply" path must route through
 * `agent.reply-to-feedback` / `company.send-message` and can never create
 * issues directly. This forwarder enforces that structurally: its only two
 * routes are the existing action keys, invoked through Paperclip's sanctioned
 * performAction proxy (`POST /api/plugins/:pluginId/actions/:key`,
 * paperclip/server/src/routes/plugins.ts), where the real handlers run with
 * the host's server-side company scoping, feedback resolution, and
 * human-attribution gates. There is no issue-creation code anywhere on this
 * path.
 */

import { ACTION_KEYS } from "../constants.js";
import { PAPERCLIP_PLUGIN_ACTIONS } from "./manifest.js";

/** Fetch shape used by the forwarder (injectable; mirrors LogFetchLike). */
export type ReplyFetchLike = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

export interface HttpReplyForwarderOptions {
  /** Base URL of the Paperclip API (the server hosting the plugin). */
  apiBaseUrl: string;
  /** Bearer token for the Paperclip API (a board API key). */
  apiToken: string;
  /** The Paperclip plugin id whose actions are invoked (manifest id). */
  pluginId: string;
  /** Injected fetch (keeps the module free of node globals). */
  fetch: ReplyFetchLike;
}

/** What the Pixel-Agents-side handler hands the forwarder. */
export interface ReplyForwardRequest {
  action: typeof PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback | typeof PAPERCLIP_PLUGIN_ACTIONS.sendMessage;
  companyId: string;
  /** feedbackId is required for reply-to-feedback and rejected otherwise. */
  feedbackId?: string;
  text: string;
}

/** Result of a forwarded reply: the Paperclip action handler's own return
 *  value, or a fail-closed error. */
export interface ReplyForwardResult {
  ok: boolean;
  /** The Paperclip action's verbatim result body (its own ok/error shape). */
  result?: Record<string, unknown>;
  /** Machine-readable forwarding failure (never the action's business error,
   *  which rides `result`). */
  error?: string;
}

/** The allowlist mapping plugin action ids to the existing Paperclip action
 *  keys — the single place the fail-closed routing is defined. */
const FORWARD_TARGETS: Record<ReplyForwardRequest["action"], string> = {
  [PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback]: ACTION_KEYS.agentReplyToFeedback,
  [PAPERCLIP_PLUGIN_ACTIONS.sendMessage]: ACTION_KEYS.companySendMessage,
};

/** Validate the invocation payload before anything is forwarded. Returns a
 *  normalized request or a machine-readable error (fail-closed). */
export function parseReplyPayload(
  action: ReplyForwardRequest["action"],
  payload: unknown,
): { request?: ReplyForwardRequest; error?: string } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { error: "invalidPayload" };
  }
  const raw = payload as Record<string, unknown>;
  if (typeof raw.companyId !== "string" || raw.companyId.length === 0) {
    return { error: "invalidPayload" };
  }
  if (typeof raw.text !== "string" || raw.text.trim().length === 0) {
    return { error: "invalidPayload" };
  }
  if (action === PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback) {
    if (typeof raw.feedbackId !== "string" || raw.feedbackId.length === 0) {
      return { error: "invalidPayload" };
    }
    return {
      request: { action, companyId: raw.companyId, feedbackId: raw.feedbackId, text: raw.text },
    };
  }
  // send-message takes text only; a stray feedbackId is rejected so the
  // routing stays unambiguous.
  if (raw.feedbackId !== undefined) {
    return { error: "invalidPayload" };
  }
  return { request: { action, companyId: raw.companyId, text: raw.text } };
}

/** Forwards replies into the plugin's existing Paperclip actions over the
 *  sanctioned performAction proxy route. */
export class HttpReplyForwarder {
  private readonly options: HttpReplyForwarderOptions;

  constructor(options: HttpReplyForwarderOptions) {
    this.options = options;
  }

  async forward(request: ReplyForwardRequest): Promise<ReplyForwardResult> {
    const key = FORWARD_TARGETS[request.action];
    if (!key) {
      return { ok: false, error: "unknownAction" };
    }
    const url =
      `${this.options.apiBaseUrl.replace(/\/$/, "")}/api/plugins/` +
      `${encodeURIComponent(this.options.pluginId)}/actions/${encodeURIComponent(key)}`;
    const params: Record<string, unknown> = {
      companyId: request.companyId,
      text: request.text,
    };
    if (request.feedbackId !== undefined) {
      params.feedbackId = request.feedbackId;
    }
    try {
      const res = await this.options.fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.options.apiToken}`,
        },
        body: JSON.stringify({ companyId: request.companyId, params }),
      });
      if (!res.ok) {
        return { ok: false, error: `forwardFailed:${res.status}` };
      }
      const body = (await res.json()) as { data?: unknown };
      if (
        typeof body !== "object"
        || body === null
        || typeof (body as { data?: unknown }).data !== "object"
        || (body as { data: unknown }).data === null
      ) {
        return { ok: false, error: "invalidResponse" };
      }
      return { ok: true, result: body.data as Record<string, unknown> };
    } catch {
      return { ok: false, error: "forwardFailed" };
    }
  }
}

/** Injectable forwarder contract (the embedding surface wires the HTTP
 *  implementation; tests can substitute). */
export type ReplyForwarder = (request: ReplyForwardRequest) => Promise<ReplyForwardResult>;
