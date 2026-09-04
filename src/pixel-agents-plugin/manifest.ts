/**
 * The Paperclip bridge's first-class Pixel Agents plugin manifest (spec
 * PAPERCLIP_PIXELS-2, WS2-C).
 *
 * Declares exactly what the bridge uses on the WS2-A1/A2 + WS4-A host: the
 * sanctioned agent/team data source (`sources.agents`), the WS4-A appearance
 * source (`sources.appearance` — the first-class per-agent character path),
 * the two reply actions the contributed click-menu item routes through (A2
 * cross-validates the item's `action` against these declarations), the
 * dialog-pane shell-panel widget with its conversation-extract message type
 * (WS4-C), and the start-announcement message. Validated at registration
 * time by the host's
 * `validatePluginManifest` — keep every field inside the landed A1+A2
 * schema (unknown keys are rejected fail-closed; a present `labelPolicy`
 * needs a valid `mode`, so the bridge omits it entirely to keep the default
 * label behavior).
 */

import { PLUGIN_VERSION } from "../constants.js";
import type { PixelAgentsPluginManifest } from "./types.js";

/** Plugin id in the Pixel Agents host registry (A1 id pattern: lowercase slug). */
export const PAPERCLIP_PIXEL_PLUGIN_ID = "paperclip";

/** The contributed message type announced once on plugin start. */
export const PAPERCLIP_PLUGIN_STARTED_MESSAGE = "paperclip.bridge.started";

/**
 * The conversation-extract message type feeding the dialog-pane widget
 * (WS4-C). Each emitted payload is `{ text }` — the one field the webview's
 * Phase-1 widget renderer reads. The worker composes and redacts/truncates
 * every line plugin-side before it rides the feed; the embedding surface
 * only re-emits what arrived.
 */
export const PAPERCLIP_DIALOG_LINES_MESSAGE = "paperclip.dialog.lines";

/** Action ids (A1 pattern `^[a-z0-9][a-z0-9-]{0,63}$`). */
export const PAPERCLIP_PLUGIN_ACTIONS = {
  /** Routes a click-menu reply into the Paperclip plugin's existing
   *  `agent.reply-to-feedback` action (fail-closed: no issue creation). */
  replyToFeedback: "reply-to-feedback",
  /** Routes a general message into `company.send-message`. */
  sendMessage: "send-message",
} as const;

/**
 * The click-menu item the bridge contributes, in the landed WS2-A2
 * contribution shape: `action` names the declared reply action (the host
 * cross-validates at registration), `scope: "agent"` makes it appear only on
 * this plugin's own characters, and selecting it routes through the existing
 * privileged `invokePluginAction` path to the reply handler — fail-closed,
 * no issue creation anywhere on the path.
 */
export const PAPERCLIP_REPLY_MENU_ITEM = {
  id: "reply-to-feedback",
  label: "Reply…",
  description: "Reply to this agent through Paperclip feedback (never creates new work).",
  action: PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback,
  scope: "agent",
  order: 100,
} as const;

/** The bridge plugin's manifest for the A1 host. */
export function createPaperclipPluginManifest(): PixelAgentsPluginManifest {
  return {
    id: PAPERCLIP_PIXEL_PLUGIN_ID,
    version: PLUGIN_VERSION,
    description:
      "Paperclip bridge: declares Paperclip agents (identity, seats, status, activity) through the sanctioned agent/team source and routes click-menu replies into Paperclip feedback.",
    contributes: {
      messages: [
        {
          type: PAPERCLIP_PLUGIN_STARTED_MESSAGE,
          description: "Announced once on plugin start; payload carries the plugin id and version.",
        },
        {
          type: PAPERCLIP_DIALOG_LINES_MESSAGE,
          description:
            "One redacted/truncated conversation-extract line for the dialog pane. Privacy-guarded plugin-side (per-company dialogPanePrivacyOptIn, default OFF).",
        },
      ],
      actions: [
        {
          id: PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback,
          description:
            "Reply to a stuck/requesting agent. Routes through Paperclip's existing agent.reply-to-feedback action; never creates issues.",
        },
        {
          id: PAPERCLIP_PLUGIN_ACTIONS.sendMessage,
          description:
            "Send a message to the company. Routes through Paperclip's existing company.send-message action; never creates issues.",
        },
      ],
      menuItems: [{ ...PAPERCLIP_REPLY_MENU_ITEM }],
      widgets: [
        {
          id: "dialog-pane",
          kind: "shell-panel",
          binding: "global",
          label: "Paperclip conversation",
          description:
            "Conversation extracts from Paperclip issue comments and run activity. Content is redacted/truncated plugin-side; fuller extracts require the per-company privacy opt-in.",
          messageTypes: [PAPERCLIP_DIALOG_LINES_MESSAGE],
        },
      ],
    },
    sources: { agents: true, appearance: true },
  };
}
