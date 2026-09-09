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

import { PLUGIN_VERSION } from "./constants.js";
import type {
  CapabilityId,
  PixelAgentsPluginManifest,
  PluginCapabilityDeclaration,
} from "paperclip-pixels-common";

/** Plugin id in the Pixel Agents host registry (A1 id pattern: lowercase slug). */
export const PAPERCLIP_PIXEL_PLUGIN_ID = "paperclip";

/** The built-in base/default plugin id (board §4.1): the original Claude/hook
 *  runtime, registered first so every capability not overridden downstream
 *  resolves to it. Reserved by the host — an external module can never
 *  displace it. The Paperclip bridge names it as its `overrides` target. */
export const BASE_PIXEL_PLUGIN_ID = "pixel-agents-base";

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

/**
 * The base plugin id the Paperclip bridge names as its `overrides` target —
 * every capability it does NOT specialize resolves to this base plugin via
 * the host's explicit fallback (board §5.1/§5.2/§5.3).
 */
export const PAPERCLIP_OVERRIDE_TARGET = BASE_PIXEL_PLUGIN_ID;

/**
 * The declarative override scope (board §7.1 + §5.2): exactly the
 * capabilities the Paperclip bridge specializes, each declared as an explicit
 * override of the base/default plugin with fallback to base. The bridge may
 * override ONLY these (and may not silently replace baseline behavior or
 * mutate undeclared capabilities — board §5.2); every other capability
 * (provider-selection, hook-management, session-lifecycle, tool-activity,
 * transcript-parsing, persistence, ui-data — the original Claude/hook runtime)
 * is deliberately NOT declared here and resolves to the base plugin.
 *
 * These are the host's contribution/arity surfaces, declared as overrides to
 * state scope, NOT as replacement implementations: the bridge realizes its
 * specialization through the manifest contribution points (`contributes`) and
 * the sanctioned `ctx.agents`/`ctx.appearance` sources, which the host
 * aggregates additively (board §5.5 — no suppression of baseline surfaces).
 */
export const PAPERCLIP_OVERRIDE_CAPABILITIES: readonly PluginCapabilityDeclaration[] = [
  {
    id: "agents-source",
    implementation: "override",
    overrides: PAPERCLIP_OVERRIDE_TARGET,
    fallback: "base",
    priority: 0,
  },
  {
    id: "appearance-source",
    implementation: "override",
    overrides: PAPERCLIP_OVERRIDE_TARGET,
    fallback: "base",
    priority: 1,
  },
  {
    id: "label-policy",
    implementation: "override",
    overrides: PAPERCLIP_OVERRIDE_TARGET,
    fallback: "base",
    priority: 2,
  },
  {
    id: "menu",
    implementation: "override",
    overrides: PAPERCLIP_OVERRIDE_TARGET,
    fallback: "base",
    priority: 3,
  },
  {
    id: "widgets",
    implementation: "override",
    overrides: PAPERCLIP_OVERRIDE_TARGET,
    fallback: "base",
    priority: 4,
  },
  {
    id: "action-routing",
    implementation: "override",
    overrides: PAPERCLIP_OVERRIDE_TARGET,
    fallback: "base",
    priority: 5,
  },
];

/** The override-scope capability ids, for host arbitration and diagnostics. */
export const PAPERCLIP_OVERRIDE_CAPABILITY_IDS: readonly CapabilityId[] =
  PAPERCLIP_OVERRIDE_CAPABILITIES.map((c) => c.id);

/** The bridge plugin's manifest for the A1 host. */
export function createPaperclipPluginManifest(): PixelAgentsPluginManifest {
  return {
    id: PAPERCLIP_PIXEL_PLUGIN_ID,
    version: PLUGIN_VERSION,
    description:
      "Paperclip bridge: declares Paperclip agents (identity, seats, status, activity) through the sanctioned agent/team source and routes click-menu replies into Paperclip feedback. Loaded as the R2.5 override plugin — it overrides only the declared capabilities (agents-source, appearance-source, label-policy, menu, widgets, action-routing) and delegates everything else back to the base/default plugin (pixel-agents-base).",
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
    capabilities: [...PAPERCLIP_OVERRIDE_CAPABILITIES],
  };
}
