/**
 * Structural mirrors of the WS2-A1 plugin-host surfaces
 * (`pixel-agents/server/src/plugins/manifest.ts` + `pluginHost.ts`, spec
 * PAPERCLIP_PIXELS-2, WS2-C).
 *
 * The plugin host lives inside the Pixel Agents server process and the fork
 * ships no installable types package, so — exactly like the retired
 * `pixel-agents-types.ts` mirror of the provider contract — this file mirrors
 * only the public host surfaces the Paperclip plugin builds against. The
 * plugin package never imports the fork at runtime; the embedding surface
 * passes the real host, which is structurally assignable to
 * {@link PixelAgentsPluginHost}.
 *
 * Keep this mirror in sync with the landed A1 sources (read them before
 * changing anything here); any divergence is a source-verification gap.
 */

/** Verbatim shape of A1's `PluginAgentDeclaration` (pluginHost.ts). */
export interface PluginAgentDeclaration {
  /** Plugin-unique stable key for this agent (survives re-declaration). */
  key: string;
  /** Human-readable display name — becomes the office label. */
  name: string;
  teamName?: string;
  isTeamLead?: boolean;
  /** Key of this agent's team lead; resolved by the host after the batch. */
  leadKey?: string;
  teamUsesTmux?: boolean;
  /** Seat assignment fields — persisted by the host through the same adapter
   *  path the `saveAgentSeats` client message uses (A1 `applySeatAssignment`). */
  palette?: number;
  hueShift?: number;
  seatId?: string;
}

/** Verbatim shape of A1's `PluginAgentStatusUpdate` (pluginHost.ts). */
export interface PluginAgentStatusUpdate {
  /** 'active' drives the working animation; 'waiting' the idle one. */
  status: "active" | "waiting";
  /** Only meaningful with 'waiting': true when waiting on a human reply. */
  awaitingInput?: boolean;
}

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
export type LabelVisibilityMode = "always" | "never" | "hover" | "transient";

/**
 * Verbatim shape of A2's `PluginMenuItemDeclaration` (manifest.ts). `action`
 * must be one of the plugin's declared actions (cross-validated at
 * registration); `scope: "agent"` items appear only on this plugin's own
 * characters, `scope: "global"` items on every character menu.
 */
export interface PluginMenuItemDeclaration {
  id: string;
  label: string;
  action: string;
  scope: "agent" | "global";
  /** Sort key; the server assembles the menu by (order, pluginId, id). */
  order?: number;
  /** Rendered-but-disabled when false (default true). */
  enabled?: boolean;
  description?: string;
}

/** Verbatim shape of A2's `PluginLabelPolicyDeclaration` (manifest.ts): the
 *  plugin's default label policy for every agent it declares. */
export interface PluginLabelPolicyDeclaration {
  mode: LabelVisibilityMode;
  /** Show-for-N-milliseconds duration (100..3,600,000). */
  durationMs?: number;
}

/** Verbatim shape of A2's `PluginWidgetKind` (manifest.ts, Phase-1 set). */
export type PluginWidgetKind = "dom-overlay" | "shell-panel";

/** Verbatim shape of A2's `PluginWidgetBinding` (manifest.ts). */
export type PluginWidgetBinding = "character-position" | "global";

/** Verbatim shape of A2's `PluginWidgetDeclaration` (manifest.ts). */
export interface PluginWidgetDeclaration {
  id: string;
  kind: PluginWidgetKind;
  binding: PluginWidgetBinding;
  label?: string;
  description?: string;
  /** Manifest-declared message types that feed this widget. */
  messageTypes?: string[];
}

/**
 * Verbatim shape of A1+A2's `PluginContributions` (manifest.ts). The A2
 * sections are fully validated by the landed host: every menu item needs a
 * declared `action` and a `scope`, a present `labelPolicy` needs a valid
 * `mode`, and widget kinds/bindings come from the Phase-1 sets. A2 also
 * exposes the character behavior-hook source (`sources.characterEvents` /
 * `ctx.characterEvents`) — deliberately NOT mirrored here: this file mirrors
 * only the host surfaces the Paperclip plugin builds against, and the bridge
 * subscribes to none of it.
 */
export interface PluginContributions {
  messages?: PluginMessageDeclaration[];
  actions?: PluginActionDeclaration[];
  menuItems?: PluginMenuItemDeclaration[];
  labelPolicy?: PluginLabelPolicyDeclaration;
  widgets?: PluginWidgetDeclaration[];
}

/** Verbatim shape of WS4-A's `PluginCharacterSheetDeclaration`
 * (appearanceSource.ts). Array position (not the optional id) defines the
 * sheet's integer index; `file` must be absolute and inside an
 * operator-granted external asset directory. */
export interface PluginCharacterSheetDeclaration {
  /** Plugin-unique stable sheet id (optional; index is positional). */
  id?: string;
  /** Absolute path to a character sprite sheet PNG (112×96, 3 direction
   *  rows × 7 frames of 16×32 — the `char_N.png` layout). */
  file: string;
}

/** Verbatim shape of WS4-A's `PluginAppearanceSource` (appearanceSource.ts):
 * the first-class appearance path — declare an ordered sheet catalog, then
 * assign each declared agent an integer index into it. Manifest-gated by
 * `sources.appearance`; every call is refused fail-closed when undeclared
 * or when the embedding surface wired no asset gate. */
export interface PluginAppearanceSource {
  /** Idempotent replace of the plugin's whole catalog (all-or-nothing:
   *  one invalid or ungranted sheet refuses the call and keeps the previous
   *  catalog). Broadcasts `pluginCharactersLoaded` on success. */
  declareCharacterCatalog(sheets: PluginCharacterSheetDeclaration[]): void;
  /** Assign (or, with null, revert) one declared agent's appearance.
   *  Broadcasts `agentAppearance`; revert degrades the agent back to
   *  built-in palette rendering. */
  assignAgentAppearance(key: string, sheetIndex: number | null): void;
}

/** Verbatim shape of A1's `PluginSourceDeclarations` (manifest.ts). */
export interface PluginSourceDeclarations {
  /** The agent/team data source: declareAgents / updateAgentStatus /
   *  updateAgentActivity / removeAgents. Undeclared usage is refused. */
  agents?: boolean;
  /** WS4-A: the appearance source (declareCharacterCatalog /
   *  assignAgentAppearance). Undeclared usage is refused. */
  appearance?: boolean;
}

/**
 * Verbatim shape of the R2.5 Phase 2 arbitration manifest's
 * `CAPABILITY_IDS` (manifest.ts, board §5.1 + §7.1). Every stable capability
 * id the host resolves — the runtime capabilities (the original Claude/hook
 * runtime) plus the already-delivered contribution surfaces. The base/default
 * plugin declares each as `direct`; an override plugin (the Paperclip bridge,
 * R2.5 Phase 3) declares only the subset it specializes as `override` with
 * `overrides: 'pixel-agents-base'` and `fallback: 'base'`.
 */
export const CAPABILITY_IDS = [
  // Runtime capabilities (legacy Claude/hook runtime — board §5.1 list).
  "provider-selection",
  "hook-management",
  "session-lifecycle",
  "tool-activity",
  "transcript-parsing",
  "persistence",
  "ui-data",
  // Contribution surfaces (already delivered, WS2-A2 / WS4-A / WS2-A1).
  "menu",
  "label-policy",
  "widgets",
  "agents-source",
  "appearance-source",
  "action-routing",
] as const;

/** A single stable capability id (member of {@link CAPABILITY_IDS}). */
export type CapabilityId = (typeof CAPABILITY_IDS)[number];

/** How a plugin provides a capability (board §7.1). */
export type CapabilityImplementation = "direct" | "override";

/** Explicit fallback behavior when this plugin cannot satisfy a capability
 *  (board §5.2/§7.2). */
export type CapabilityFallback = "none" | "base";

/** A capability implementation: the delegation wrapper a plugin registers for
 *  one capability id (host `registerCapability`). */
export type BaseCapabilityImpl = (...args: unknown[]) => unknown;

/**
 * Verbatim shape of the R2.5 Phase 2 arbitration manifest's
 * `PluginCapabilityDeclaration` (manifest.ts, board §7.1: identity, version,
 * capabilities, override scope, fallback). A `direct` capability is the
 * canonical provider (the base/default plugin, or a plugin's own
 * implementation); an `override` capability names the plugin it overrides,
 * may fall back to the base, and declares the explicit priority used by the
 * host's arbitration layer (board §5.3).
 */
export interface PluginCapabilityDeclaration {
  /** A stable capability id (member of {@link CAPABILITY_IDS}). */
  id: CapabilityId;
  /** How this plugin provides the capability. */
  implementation: CapabilityImplementation;
  /** For `override`, the plugin id this overrides (the built-in base/default
   *  plugin `pixel-agents-base`). Declares the override *scope* — the host
   *  elects the highest-priority explicit override, fail-closed on ambiguity. */
  overrides?: string;
  /** Explicit fallback when this plugin cannot satisfy the capability. Direct
   *  implementations fall back to `none`; overrides may fall back to `base`. */
  fallback?: CapabilityFallback;
  /** Override precedence (board §5.3): higher wins; ties are ambiguous and are
   *  rejected fail-closed. Only meaningful for `override` capabilities. */
  priority?: number;
}

/** Verbatim shape of A1's `PluginManifest` (manifest.ts). */
export interface PixelAgentsPluginManifest {
  id: string;
  version: string;
  description?: string;
  contributes: PluginContributions;
  sources?: PluginSourceDeclarations;
  /** Override scope (board §7.1 + §5.2): the capabilities this plugin
   *  explicitly overrides; every unoverridden capability resolves to the
   *  base/default plugin. */
  capabilities?: PluginCapabilityDeclaration[];
}

/** Verbatim shape of A1+A2's `PluginAgentSource` (pluginHost.ts): the sanctioned
 *  replacement for the bridge's Claude-hook impersonation, synthetic
 *  team-metadata transcripts, and `saveAgentSeats` seat-driving. */
export interface PluginAgentSource {
  declareAgents(agents: PluginAgentDeclaration[]): void;
  removeAgents(keys: string[]): void;
  updateAgentStatus(key: string, status: PluginAgentStatusUpdate): void;
  updateAgentActivity(key: string, activity: string | null): void;
  /** A2: set (or, with null, revert) this agent's label visibility policy.
   *  Not used by the bridge — mirrored for source accuracy. */
  updateAgentLabelPolicy(
    key: string,
    policy: PluginLabelPolicyDeclaration | null,
  ): void;
}

/** Verbatim shape of A1's `PluginContext` (pluginHost.ts). */
export interface PixelAgentsPluginContext {
  readonly pluginId: string;
  readonly manifest: PixelAgentsPluginManifest;
  emit(messageType: string, payload: Record<string, unknown>): boolean;
  readonly agents: PluginAgentSource;
  /** WS4-A: present on every context; every call is refused fail-closed
   *  unless the manifest declares `sources.appearance`. */
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
 * The slice of A1's `PluginHost` the embedding surface hands to
 * {@link registerPaperclipPixelPlugin}: registration + lifecycle start. The
 * real host (pluginHost.ts) is structurally assignable, and because the
 * bridge realizes its R2.5 Phase 3 overrides through the manifest
 * contribution points (`contributes`) and the sanctioned `ctx.agents` /
 * `ctx.appearance` sources — NOT through registered capability-arbitration
 * implementations (the host aggregates which additively, board §5.5) — this
 * mirror documents only the surfaces the plugin builds against.
 */
export interface PixelAgentsPluginHost {
  registerPlugin(registration: PixelAgentsPluginRegistration): void;
  startPlugin(pluginId: string): void;
}
