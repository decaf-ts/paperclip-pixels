/**
 * @paperclip-pixel/pixel-agents-provider
 *
 * Pixel Agents bridge adapter (spec PAPERCLIP_PIXELS-1, Phases 6-7, §7.3/§21).
 * Consumes the canonical bridge contract from `@paperclip-pixel/core` and maps
 * only semantically valid current bridge events into current Pixel Agents
 * `AgentEvent` semantics, retaining richer behavior in a sidecar. Fable is NOT
 * activated.
 *
 * Public, exposed APIs only (NFR-8): no invasive Pixel Agents core hacks, no
 * submodule runtime imports. The provider is additive and structurally
 * assignable to the upstream `HookProvider` (see `pixel-agents-types.ts`).
 */

export {
  EventMapper,
  ID_NAMESPACE,
  syntheticCwd,
  syntheticSessionId,
  parseBridgeEvent,
} from "./event-mapper.js";
export type {
  MappingResult,
  SnapshotMappingResult,
  SidecarEntry,
} from "./event-mapper.js";

export {
  BehaviorSidecar,
} from "./behavior-sidecar.js";
export type {
  SidecarAgent,
  SidecarSnapshot,
  BehaviorSidecarOptions,
} from "./behavior-sidecar.js";

export {
  PaperclipBridgeProvider,
  PAPERCLIP_BRIDGE_PROVIDER_ID,
  PAPERCLIP_BRIDGE_CONSENT,
} from "./paperclip-provider.js";

export {
  BridgeTransport,
  HttpPushSink,
  CLAUDE_WIRE_PROVIDER_ID,
  toClaudeHookBody,
} from "./transport.js";
export type {
  AgentEventSink,
  BridgeConnectionState,
  BridgeTransportOptions,
  HttpPushSinkOptions,
  FetchLike,
} from "./transport.js";

export type { AgentEvent, HookProvider, TeamProvider, SessionAgentEvent } from "./pixel-agents-types.js";
