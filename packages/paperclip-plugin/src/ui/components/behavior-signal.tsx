/**
 * BehavioralSignal display (spec PAPERCLIP_PIXELS-1, §9.3, §11.11–11.12,
 * FR-15).
 *
 * Renders value + confidence + basis as an operational proxy. Never renders
 * emotion labels: stress/satisfaction/engagement are shown only as
 * operational estimates with an explicit disclaimer.
 */

import type { BehavioralSignal } from "@paperclip-pixel/core";
import { bandLabel, formatPercent } from "../format";

export interface BehaviorSignalProps {
  label: string;
  signal: BehavioralSignal;
  /** Optional disclaimer for higher-level proxies (stress/engagement). */
  note?: string;
}

export function BehaviorSignal({ label, signal, note }: BehaviorSignalProps) {
  const basis =
    signal.basis.length > 0 ? signal.basis.join(", ") : "no recorded basis";

  return (
    <li data-testid="behavior-signal" data-signal-label={label}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <span>{label}</span>
        <strong>
          {bandLabel(signal.value)} · {formatPercent(signal.value)}
        </strong>
      </div>
      <div style={{ opacity: 0.75, fontSize: "0.9em" }}>
        confidence {formatPercent(signal.confidence)} · basis: {basis}
      </div>
      {note ? (
        <div style={{ opacity: 0.75, fontSize: "0.9em", fontStyle: "italic" }}>
          {note}
        </div>
      ) : null}
    </li>
  );
}
