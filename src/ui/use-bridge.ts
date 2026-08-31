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
 *
 * HOST GAP (found 2026-08-31): `usePluginStream`'s `GET
 * /api/plugins/:pluginId/bridge/stream/:channel` route unconditionally
 * 501s ("Plugin stream bridge is not enabled") on Paperclip hosts that never
 * construct `bridgeDeps.streamBus` at server bootstrap — confirmed by reading
 * `server/src/routes/plugins.ts` directly: `createPluginStreamBus()` exists
 * but nothing in the server entrypoint ever calls it in this host build, so
 * `bridgeDeps.streamBus` is always undefined. That's the host's own gap, not
 * a plugin bug and not fixable from plugin code. Its effect, though, is that
 * `stream.connected` is permanently false, so a `stale` computed purely from
 * `!stream.connected` (the original design) is permanently true forever —
 * the "stale" banner never clears no matter how fresh the actual data is,
 * and clicking Refresh (which only re-fetches the snapshot, never touches
 * stream state) visibly does nothing to it.
 *
 * Fix: (1) poll `refresh()` on an interval as a fallback live-update
 * mechanism for hosts where the stream never connects, so data keeps moving
 * without relying on SSE at all; (2) compute `stale` from how long it's
 * actually been since the last successful snapshot, not from stream
 * connectivity alone. A host that DOES support the stream still gets
 * `stale = false` immediately (connected short-circuits the freshness
 * check); this degrades gracefully into a "poll every REFRESH_INTERVAL_MS,
 * flag stale only after STALE_AFTER_MS of genuine silence" mode otherwise.
 */

import { useCallback, useEffect, useReducer, useRef } from "react";
import { usePluginData, usePluginStream } from "@paperclipai/plugin-sdk/ui";
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

/** How often to re-fetch a full snapshot when the SSE stream isn't carrying live deltas (host gap above, or simply between them). */
export const REFRESH_INTERVAL_MS = 20_000;
/** How long without a successful sync before genuinely flagging stale — several missed polls' worth of slack for a transient network hiccup, not a single one. */
export const STALE_AFTER_MS = 90_000;

/**
 * Pure staleness computation (kept React-free, like state.ts, so it's
 * directly testable). `now` is injectable so tests don't depend on the real
 * clock racing a fixed fixture timestamp.
 */
export function isBridgeStale(
  hasSnapshot: boolean,
  streamConnected: boolean,
  lastSyncedAt: string | null,
  now: number = Date.now(),
): boolean {
  if (!hasSnapshot || streamConnected) return false;
  if (lastSyncedAt === null) return true;
  return now - new Date(lastSyncedAt).getTime() > STALE_AFTER_MS;
}

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

  // Fallback live-update polling for hosts where the SSE stream never
  // connects (see this file's HOST GAP doc comment). Harmless, if redundant,
  // on a host where the stream does work: a real delta already keeps state
  // fresher than any poll interval, so this just adds an occasional no-op
  // refetch alongside it. Restarts whenever companyId changes so a company
  // switch doesn't inherit a stale interval closure.
  useEffect(() => {
    const id = setInterval(() => {
      refreshRef.current();
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(id);
  }, [companyId]);

  // stream.connected alone would make `stale` permanently true on a host
  // that never wires up the SSE stream bridge (see HOST GAP above), even
  // though the polling fallback keeps data genuinely fresh. Prefer the
  // stream's own signal when it works (connected => never stale); otherwise
  // fall back to actual data freshness, so "stale" reflects reality on
  // either kind of host.
  const stale = isBridgeStale(state.snapshot !== null, stream.connected, state.lastSyncedAt);

  return { state, connected: stream.connected, stale, refresh };
}
