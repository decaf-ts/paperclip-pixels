/**
 * Pixel Agents plugin-host surface mirrors (WS2-A1/A2, WS4-A).
 *
 * These are structural mirrors of the framework-typed fork host surfaces
 * (`pixel-agents/server/src/plugins/manifest.ts` + `pluginHost.ts` +
 * `appearanceSource.ts`). The fork ships no installable types package, so the
 * Paperclip plugin builds against these mirrors and the embedding surface
 * passes the real host, which is structurally assignable.
 *
 * This package never imports the fork at runtime; it only declares the shared
 * wire shapes. Keep each mirror in sync with the landed fork sources.
 */

import { z } from "zod";

/** Verbatim shape of A1's `PluginAgentDeclaration` (pluginHost.ts). */
export interface PluginAgentDeclaration {
  key: string;
  name: string;
  teamName?: string;
  isTeamLead?: boolean;
  leadKey?: string;
  teamUsesTmux?: boolean;
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

export const PluginAgentDeclarationSchema: z.ZodType<PluginAgentDeclaration> = z.object({
  key: z.string().min(1),
  name: z.string().min(1),
  teamName: z.string().optional(),
  isTeamLead: z.boolean().optional(),
  leadKey: z.string().optional(),
  teamUsesTmux: z.boolean().optional(),
  palette: z.number().int().nonnegative().optional(),
  hueShift: z.number().int().min(0).max(360).optional(),
  seatId: z.string().optional(),
});

/** Verbatim shape of A1's `PluginAgentStatusUpdate` (pluginHost.ts). */
export interface PluginAgentStatusUpdate {
  status: "active" | "waiting";
  awaitingInput?: boolean;
}

export const PluginAgentStatusUpdateSchema: z.ZodType<PluginAgentStatusUpdate> = z.object({
  status: z.enum(["active", "waiting"]),
  awaitingInput: z.boolean().optional(),
});

/** Verbatim shape of A1's `PluginMessageDeclaration` (manifest.ts). */
export interface PluginMessageDeclaration {
  type: string;
  description?: string;
}

/** Verbatim shape of A1's `PluginActionDeclaration` (manifest.ts). */
export interface PluginActionDeclaration {
  id: string;
  description?: string;
}

/** Verbatim shape of A2's `LabelVisibilityMode` (manifest.ts wire enum). */
export const LABEL_VISIBILITY_MODES = ["always", "never", "hover", "transient"] as const;
export type LabelVisibilityMode = (typeof LABEL_VISIBILITY_MODES)[number];

/** Verbatim shape of A2's `PluginMenuItemDeclaration` (manifest.ts). */
export interface PluginMenuItemDeclaration {
  id: string;
  label: string;
  action: string;
  scope: "agent" | "global";
  order?: number;
  enabled?: boolean;
  description?: string;
}

/** Verbatim shape of A2's `PluginLabelPolicyDeclaration` (manifest.ts). */
export interface PluginLabelPolicyDeclaration {
  mode: LabelVisibilityMode;
  durationMs?: number;
}

/** Verbatim shape of A2's `PluginWidgetKind` (manifest.ts, Phase-1 set). */
export const PLUGIN_WIDGET_KINDS = ["dom-overlay", "shell-panel"] as const;
export type PluginWidgetKind = (typeof PLUGIN_WIDGET_KINDS)[number];

/** Verbatim shape of A2's `PluginWidgetBinding` (manifest.ts). */
export const PLUGIN_WIDGET_BINDINGS = ["character-position", "global"] as const;
export type PluginWidgetBinding = (typeof PLUGIN_WIDGET_BINDINGS)[number];

/** Verbatim shape of A2's `PluginWidgetDeclaration` (manifest.ts). */
export interface PluginWidgetDeclaration {
  id: string;
  kind: PluginWidgetKind;
  binding: PluginWidgetBinding;
  label?: string;
  description?: string;
  messageTypes?: string[];
}

/** Verbatim shape of A1+A2's `PluginContributions` (manifest.ts). */
export interface PluginContributions {
  messages?: PluginMessageDeclaration[];
  actions?: PluginActionDeclaration[];
  menuItems?: PluginMenuItemDeclaration[];
  labelPolicy?: PluginLabelPolicyDeclaration;
  widgets?: PluginWidgetDeclaration[];
}

/** Verbatim shape of WS4-A's `PluginCharacterSheetDeclaration` (appearanceSource.ts). */
export interface PluginCharacterSheetDeclaration {
  id?: string;
  file: string;
}

/** Verbatim shape of WS4-A's `PluginAppearanceSource` (appearanceSource.ts). */
export interface PluginAppearanceSource {
  declareCharacterCatalog(sheets: PluginCharacterSheetDeclaration[]): void;
  assignAgentAppearance(key: string, sheetIndex: number | null): void;
}

/** Verbatim shape of A1's `PluginSourceDeclarations` (manifest.ts). */
export interface PluginSourceDeclarations {
  agents?: boolean;
  appearance?: boolean;
}

/**
 * Verbatim shape of the R2.5 Phase 2 arbitration manifest's `CAPABILITY_IDS`.
 */
export const CAPABILITY_IDS = [
  "provider-selection",
  "hook-management",
  "session-lifecycle",
  "tool-activity",
  "transcript-parsing",
  "persistence",
  "ui-data",
  "menu",
  "label-policy",
  "widgets",
  "agents-source",
  "appearance-source",
  "action-routing",
] as const;

export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** How a plugin provides a capability (board §7.1). */
export type CapabilityImplementation = "direct" | "override";

/** Explicit fallback behavior when this plugin cannot satisfy a capability. */
export type CapabilityFallback = "none" | "base";

/** A capability implementation: the delegation wrapper a plugin registers for
 *  one capability id (host `registerCapability`). */
export type BaseCapabilityImpl = (...args: unknown[]) => unknown;

/** Verbatim shape of the R2.5 Phase 2 arbitration manifest's
 *  `PluginCapabilityDeclaration` (manifest.ts, board §7.1). */
export interface PluginCapabilityDeclaration {
  id: CapabilityId;
  implementation: CapabilityImplementation;
  overrides?: string;
  fallback?: CapabilityFallback;
  priority?: number;
}

/** Verbatim shape of A1's `PluginManifest` (manifest.ts). */
export interface PixelAgentsPluginManifest {
  id: string;
  version: string;
  description?: string;
  contributes: PluginContributions;
  sources?: PluginSourceDeclarations;
  capabilities?: PluginCapabilityDeclaration[];
}

/** Verbatim shape of A1+A2's `PluginAgentSource` (pluginHost.ts). */
export interface PluginAgentSource {
  declareAgents(agents: PluginAgentDeclaration[]): void;
  removeAgents(keys: string[]): void;
  updateAgentStatus(key: string, status: PluginAgentStatusUpdate): void;
  updateAgentActivity(key: string, activity: string | null): void;
  updateAgentLabelPolicy(key: string, policy: PluginLabelPolicyDeclaration | null): void;
}

/** Verbatim shape of A1's `PluginContext` (pluginHost.ts). */
export interface PixelAgentsPluginContext {
  readonly pluginId: string;
  readonly manifest: PixelAgentsPluginManifest;
  emit(messageType: string, payload: Record<string, unknown>): boolean;
  readonly agents: PluginAgentSource;
  readonly appearance: PluginAppearanceSource;
}

/** Verbatim shape of A1's `PluginActionHandler` (pluginHost.ts). */
export type PluginActionHandler = (payload: unknown) => unknown | Promise<unknown>;

/** Verbatim shape of A1's `PluginHandlers` (pluginHost.ts). */
export interface PixelAgentsPluginHandlers {
  onStart?: (ctx: PixelAgentsPluginContext) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  actions?: Record<string, PluginActionHandler>;
}

/** Verbatim shape of A1's `PluginRegistration` (pluginHost.ts). */
export interface PixelAgentsPluginRegistration {
  id: string;
  version: string;
  manifest: PixelAgentsPluginManifest;
  handlers: PixelAgentsPluginHandlers;
}

/**
 * The slice of A1's `PluginHost` the embedding surface hands to the plugin
 * registration: registration + lifecycle start.
 */
export interface PixelAgentsPluginHost {
  registerPlugin(registration: PixelAgentsPluginRegistration): void;
  startPlugin(pluginId: string): void;
}
