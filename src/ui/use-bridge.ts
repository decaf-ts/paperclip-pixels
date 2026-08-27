/**
 * Snapshot + delta bridge hook (spec PAPERCLIP_PIXELS-1, §16, §29.3, §30,
 * NFR-3/NFR-4, FR-13).
 *
 * - Full snapshot via the worker `bridge.snapshot` data handler on mount,
 *   company switch, reconnect, detected sequence gap, and explicit refresh.
 * - Stream deltas from the worker's `behavior:<companyId>` channel otherwise.
 * - While the stream is disconnected, state is marked visibly stale and the
 *   UI blocks state-changing actions (§30.1).
 *
 * Trust boundary (FR-9, §28.2): this hook only talks to the plugin worker
 * through the SDK bridge hooks — never Paperclip HTTP routes.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";import { usePluginData, usePluginStream } from "@paperclipai/plugin-sdk/ui";
import {
  behaviorChannel,
  BRIDGE_DATA_KEYS,
  type BridgeCompanySnapshot,
} from "./bridge-contract";
import {
  bridgeUiReducer,
  initialBridgeUiState,
  type BridgeUiState,
} from "./state";

export interface UseBridgeResult {
  state: BridgeUiState;
  /** True while the SSE stream is connected. */
  connected: boolean;
  /**
   * True when a snapshot is loaded but the stream is not connected (§30.1).
   * State-changing actions must be blocked while stale.
   */
  stale: boolean;
  /** Re-fetch a full snapshot (spec §29.3). */
  refresh(): void;
}

export function useBridge(companyId: string): UseBridgeResult {
  const [state, dispatch] = useReducer(bridgeUiReducer, initialBridgeUiState);

  const data = usePluginData<BridgeCompanySnapshot>(BRIDGE_DATA_KEYS.snapshot, {
    companyId,
  });
  const stream = usePluginStream<unknown>(behaviorChannel(companyId), { companyId });

  // Company switch: clear the previous company's state (the data hook
  // re-fetches a full snapshot because its params changed — §29.3).
  const prevCompanyId = useRef(companyId);
  useEffect(() => {
    if (prevCompanyId.current !== companyId) {
      prevCompanyId.current = companyId;
      dispatch({ type: "reset" });
    }
  }, [companyId]);

  // Full snapshots from the data bridge.
  useEffect(() => {
    if (data.loading) dispatch({ type: "fetch-started" });
    if (data.data) dispatch({ type: "snapshot-received", snapshot: data.data });
    if (data.error) dispatch({ type: "fetch-failed", message: data.error.message });
  }, [data.data, data.error, data.loading]);

  // Apply stream deltas incrementally (at-least-once delivery; the reducer is
  // idempotent per event).
  const processedCount = useRef(0);
  const prevChannel = useRef(behaviorChannel(companyId));
  useEffect(() => {
    const channel = behaviorChannel(companyId);
    if (prevChannel.current !== channel) {
      // Skip any events still buffered from the previous channel.
      prevChannel.current = channel;
      processedCount.current = stream.events.length;
    }
    const events = stream.events;
    for (let i = processedCount.current; i < events.length; i += 1) {
      dispatch({ type: "delta-received", event: events[i] });
    }
    processedCount.current = events.length;
  }, [stream.events, companyId]);

  // The host hook's `refresh` identity may change; keep the latest in a ref.
  const refreshRef = useRef(data.refresh);
  useEffect(() => {
    refreshRef.current = data.refresh;
  }, [data.refresh]);

  const refresh = useCallback(() => {
    refreshRef.current();
  }, []);

  // Reconnect: re-fetch a full snapshot (spec §29.3, FR-13).
  const wasConnected = useRef(false);
  const prevConnected = useRef(false);
  useEffect(() => {
    if (stream.connected && !prevConnected.current && wasConnected.current) {
      refreshRef.current();
    }
    if (stream.connected) wasConnected.current = true;
    prevConnected.current = stream.connected;
  }, [stream.connected]);

  // Sequence gap (unknown delta type / unknown entity / delta before first
  // snapshot): re-fetch a full snapshot (§29.3).
  useEffect(() => {
    if (state.gapDetected) {
      refreshRef.current();
      dispatch({ type: "gap-cleared" });
    }
  }, [state.gapDetected]);

  const stale = state.snapshot !== null && !stream.connected;

  return { state, connected: stream.connected, stale, refresh };
}
