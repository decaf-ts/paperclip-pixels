/**
 * Paperclip bridge provider (spec §7.3, §21, §39.1; spike SAA-175 §5/§6).
 *
 * An additive `HookProvider` implementation that consumes the canonical bridge
 * contract (`@paperclip-pixel/core`, `schemaVersion: 1`) and normalizes bridge
 * events into the *current* `AgentEvent` semantics via {@link EventMapper}.
 *
 * Integration boundary (spike §5/§6): the provider is additive — it implements
 * the existing public `HookProvider` interface and needs NO Pixel Agents core
 * changes to exist. It is push-based (the bridge pushes events; it does not
 * install CLI hooks), carries `protocolVersion: 1`, has no `team`, and no-op
 * hook install/uninstall. Registration/coexistence in a running Pixel Agents
 * office requires the upstream per-`providerId` dispatch change recommended by
 * the spike; until that lands this provider is consumed directly (e.g. by the
 * transport) and is structurally assignable to the real `HookProvider`.
 *
 * FR-14: it never emits `toolStart`/`toolEnd`/`subagent*` — there is no genuine
 * Paperclip tool/subagent correspondence. Non-mappable events return null here
 * and are carried by the sidecar (see {@link BehaviorSidecar}).
 */

import type { BridgeInputEvent } from "@paperclip-pixel/core";

import {
  EventMapper,
  parseBridgeEvent,
  type MappingResult,
} from "./event-mapper";
import type { HookProvider } from "./pixel-agents-types";

/** Provider id used as the synthetic-id namespace and (future) registry key. */
export const PAPERCLIP_BRIDGE_PROVIDER_ID = "paperclip-bridge";

/** Consent disclosure: the bridge installs nothing and only receives pushes. */
export const PAPERCLIP_BRIDGE_CONSENT = {
  headline: "Paperclip Bridge does not install anything",
  disclosure:
    "The Paperclip Bridge provider is push-based: it receives Paperclip " +
    "operational events over the bridge and translates them into character " +
    "activity. It writes no hook scripts, touches no CLI config, and sends no " +
    "data outbound from this machine. You can disable it at any time.",
} as const;

/**
 * `HookProvider` implementation for the Paperclip bridge.
 *
 * Owns an {@link EventMapper} for stateful translation. Two entry points:
 *   - {@link normalizeHookEvent}: the `HookProvider` contract method, returning
 *     the primary mapped `AgentEvent` (or null). Used by the Pixel Agents
 *     runtime once the upstream dispatch change lands.
 *   - {@link mapBridgeEvent}: the full mapping result (all AgentEvents + the
 *     sidecar entry), used by the transport / embedded UI today.
 */
export class PaperclipBridgeProvider implements HookProvider {
  readonly kind = "hook" as const;
  readonly id = PAPERCLIP_BRIDGE_PROVIDER_ID;
  readonly displayName = "Paperclip Bridge";
  readonly protocolVersion = 1;
  readonly permissionExemptTools: ReadonlySet<string> = new Set();
  readonly subagentToolNames: ReadonlySet<string> = new Set();
  readonly readingTools: ReadonlySet<string> = new Set();
  readonly team = undefined;

  private readonly mapper: EventMapper;

  constructor(mapper: EventMapper = new EventMapper()) {
    this.mapper = mapper;
  }

  /** The underlying mapper (the transport may share or own its own). */
  get eventMapper(): EventMapper {
    return this.mapper;
  }

  /**
   * `HookProvider` contract: normalize one raw envelope into one AgentEvent.
   * Returns null for non-mappable events (handled by the sidecar) or invalid
   * input. When a `sessionStart` precedes the primary event, only the primary
   * is returned here; the transport's multi-emit path preserves both.
   */
  normalizeHookEvent(
    raw: Record<string, unknown>,
  ): { sessionId: string; event: import("./pixel-agents-types").AgentEvent } | null {
    const event = parseBridgeEvent(raw);
    if (!event) return null;
    const { agentEvents } = this.mapper.mapEvent(event);
    if (agentEvents.length === 0) return null;
    return agentEvents[agentEvents.length - 1];
  }

  /**
   * Full mapping result for the transport / embedded UI: every AgentEvent
   * (including a leading `sessionStart`) plus the sidecar entry.
   */
  mapBridgeEvent(
    event: BridgeInputEvent,
  ): MappingResult {
    return this.mapper.mapEvent(event);
  }

  /** Parse a raw envelope and return the full mapping result, or null. */
  mapRawBridgeEvent(raw: Record<string, unknown>): MappingResult | null {
    const event = parseBridgeEvent(raw);
    if (!event) return null;
    return this.mapper.mapEvent(event);
  }

  // -- push-based provider: no CLI hooks are installed ---------------------

  async installHooks(): Promise<void> {
    // The bridge is push-based; it does not install CLI hook scripts.
  }

  async uninstallHooks(): Promise<void> {
    // Nothing was installed.
  }

  async areHooksInstalled(): Promise<boolean> {
    return false;
  }

  consentDisclosure(): { headline: string; disclosure: string } {
    return { ...PAPERCLIP_BRIDGE_CONSENT };
  }

  formatToolStatus(toolName: string, _input?: unknown): string {
    // The bridge emits no tool events; provide a benign fallback.
    return toolName;
  }
}
