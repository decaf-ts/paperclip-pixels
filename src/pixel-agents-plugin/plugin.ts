/**
 * The Paperclip bridge as a first-class WS2-A1 plugin (spec
 * PAPERCLIP_PIXELS-2, WS2-C): manifest handlers + registration through the
 * real host API.
 *
 * The plugin host is in-process to the Pixel Agents server, so this module is
 * consumed by the EMBEDDING SURFACE — whatever owns the Pixel Agents server
 * process calls {@link registerPaperclipPixelPlugin} at startup, before the
 * HTTP server accepts its first webviewReady handshake (A1's cli.ts comment
 * names this exact integration path). The plugin itself is stateless beyond
 * its injected dependencies:
 *
 * - `getDeclaredAgents()` supplies the last-known agent roster so a plugin
 *   restart re-declares every agent (A1 semantics: plugin agents are never
 *   persisted; their plugin re-declares them on start). The embedding
 *   surface backs this with the feed's write-through cache.
 * - `forwardReply` routes click-menu replies into the plugin's EXISTING
 *   Paperclip intake/feedback actions (see reply-forwarder.ts) — the
 *   fail-closed invariant: this plugin has no issue-creation primitive.
 */

import {
  PAPERCLIP_PIXEL_PLUGIN_ID,
  PAPERCLIP_PLUGIN_ACTIONS,
  PAPERCLIP_PLUGIN_STARTED_MESSAGE,
  createPaperclipPluginManifest,
} from "./manifest.js";
import type { ReplyForwarder, ReplyForwardRequest, ReplyForwardResult } from "./reply-forwarder.js";
import { parseReplyPayload } from "./reply-forwarder.js";
import type {
  PixelAgentsPluginContext,
  PixelAgentsPluginHandlers,
  PixelAgentsPluginHost,
  PixelAgentsPluginRegistration,
  PluginAgentDeclaration,
} from "./types.js";

/** Dependencies the embedding surface injects into the plugin. */
export interface PaperclipPluginDeps {
  /** Last-known agent roster (feed write-through cache) — re-declared on
   *  every plugin start so characters survive a host restart. */
  getDeclaredAgents(): PluginAgentDeclaration[];
  /** Routes reply actions into the existing Paperclip actions. */
  forwardReply: ReplyForwarder;
  /** Optional structured logger (ids/counts only, per the host's log rule). */
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Build the plugin's handlers around the injected dependencies. */
export function createPaperclipPluginHandlers(deps: PaperclipPluginDeps): PixelAgentsPluginHandlers {
  const replyAction =
    (action: ReplyForwardRequest["action"]) =>
    async (payload: unknown): Promise<ReplyForwardResult> => {
      const parsed = parseReplyPayload(action, payload);
      if (!parsed.request || parsed.error) {
        // Fail-closed: a malformed invocation never reaches Paperclip.
        deps.log?.("paperclip_reply_rejected", { action, reason: parsed.error ?? "invalidPayload" });
        return { ok: false, error: parsed.error ?? "invalidPayload" };
      }
      const result = await deps.forwardReply(parsed.request);
      if (!result.ok) {
        deps.log?.("paperclip_reply_forward_failed", { action, reason: result.error });
      }
      return result;
    };

  return {
    onStart: (ctx: PixelAgentsPluginContext) => {
      // Re-declare the known roster through the sanctioned agent/team source.
      const agents = deps.getDeclaredAgents();
      if (agents.length > 0) {
        ctx.agents.declareAgents(agents);
      }
      ctx.emit(PAPERCLIP_PLUGIN_STARTED_MESSAGE, {
        plugin: PAPERCLIP_PIXEL_PLUGIN_ID,
        agents: agents.length,
      });
      deps.log?.("paperclip_plugin_started", { agents: agents.length });
    },
    actions: {
      [PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback]: replyAction(
        PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback,
      ),
      [PAPERCLIP_PLUGIN_ACTIONS.sendMessage]: replyAction(PAPERCLIP_PLUGIN_ACTIONS.sendMessage),
    },
  };
}

/** Build the complete registration (id + version + manifest + handlers),
 *  validated shapes matching A1's `registerPlugin` contract. */
export function createPaperclipPluginRegistration(
  deps: PaperclipPluginDeps,
): PixelAgentsPluginRegistration {
  const manifest = createPaperclipPluginManifest();
  return {
    id: PAPERCLIP_PIXEL_PLUGIN_ID,
    version: manifest.version,
    manifest,
    handlers: createPaperclipPluginHandlers(deps),
  };
}

/**
 * Register and start the Paperclip plugin through the WS2-A1 host API — the
 * one-call integration for the embedding surface. `host` is the real A1
 * `PluginHost` (structurally assignable). Fail-closed: a registration error
 * (invalid manifest, live duplicate, uncovered action) is returned, never
 * swallowed.
 */
export function registerPaperclipPixelPlugin(
  host: PixelAgentsPluginHost,
  deps: PaperclipPluginDeps,
): { ok: true } | { ok: false; error: string } {
  try {
    const registration = createPaperclipPluginRegistration(deps);
    host.registerPlugin(registration);
    host.startPlugin(registration.id);
    return { ok: true };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.log?.("paperclip_plugin_register_failed", { error });
    return { ok: false, error };
  }
}
