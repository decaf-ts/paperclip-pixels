/**
 * Bridge/feed connection indicator (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * A red/green dot + label that reflects the live connection state: green when
 * the bridge/feed is connected, red when disconnected (which includes the
 * "stale" fallback state where the snapshot is loaded but the stream is
 * silent — the acceptance criterion requires red on stale/disconnected).
 *
 * Host-styled: a small dot plus an inline status label, so it can sit in the
 * office page header, the Configuration page header, and the sidebar menu
 * without introducing a new visual pattern.
 */

import { formatTimestamp } from "../format";

export interface ConnectionIndicatorProps {
  /** True while the bridge stream is connected. */
  connected: boolean;
  /**
   * True when a snapshot is loaded but the stream is disconnected and the
   * data has gone stale (the acceptance criterion requires red here too).
   */
  stale: boolean;
  /** ISO timestamp of the last successful sync (for the tooltip/label). */
  lastSyncedAt?: string | null;
}

/** Status dot states asserted by the UI suites (red/green acceptance). */
export type ConnectionStatus = "connected" | "disconnected";

/** Resolve the abstract status from connected + stale. */
export function resolveConnectionStatus(
  connected: boolean,
  _stale: boolean,
): ConnectionStatus {
  return connected ? "connected" : "disconnected";
}

/** Human-readable status text. */
export function connectionStatusLabel(
  connected: boolean,
  stale: boolean,
): string {
  if (connected) return "Connected";
  if (stale) return "Disconnected — state may be stale";
  return "Disconnected";
}

export function ConnectionIndicator({
  connected,
  stale,
  lastSyncedAt,
}: ConnectionIndicatorProps) {
  const status = resolveConnectionStatus(connected, stale);
  const label = connectionStatusLabel(connected, stale);
  const dotColor = status === "connected" ? "#1f9d55" : "#c0392b";
  return (
    <span
      data-testid="pixel-connection-indicator"
      data-status={status}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: "0.85em" }}
    >
      <span
        data-testid="pixel-connection-dot"
        aria-hidden="true"
        style={{
          width: 10,
          height: 10,
          borderRadius: "50%",
          background: dotColor,
          display: "inline-block",
        }}
      />
      <span data-testid="pixel-connection-label">
        {label}
        {!connected && lastSyncedAt ? ` · last sync ${formatTimestamp(lastSyncedAt)}` : ""}
      </span>
    </span>
  );
}
