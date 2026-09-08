/**
 * Bounded rolling relay-communications log (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * Consumes the `relay-comms` data handler's `RelayCommsPage` (newest-first,
 * strictly bounded paging via `beforeSeq`). The store keeps the last N
 * communications per company (operator-configured, default 100) and a query
 * never returns more than the requested page size, so the log cannot grow or
 * page without bound. "Load more" advances the cursor until the log is
 * exhausted (`nextBeforeSeq === null`).
 *
 * The browsing page size is configurable here; the underlying rolling
 * capacity is operator config (`relayCommsLimit`), shown as copy.
 */

import { useEffect, useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import {
  BRIDGE_DATA_KEYS,
  type RelayCommsEntry,
  type RelayCommsPage,
} from "../bridge-contract";
import { formatTimestamp } from "../format";

/** Error envelope the worker can return for an unknown company. */
type RelayCommsError = { schemaVersion: 1; error: string };
type RelayCommsPayload = RelayCommsPage | RelayCommsError;

export interface RelayCommLogProps {
  companyId: string;
  /** Default rolling capacity documented by the store (R3-WS4a). */
  defaultCapacity?: number;
}

const PAGE_SIZES = [10, 25, 50] as const;
const DEFAULT_PAGE_SIZE = 25;

export function RelayCommLog({
  companyId,
  defaultCapacity = 100,
}: RelayCommLogProps) {
  const [pageSize, setPageSize] = useState<number>(DEFAULT_PAGE_SIZE);
  const [beforeSeq, setBeforeSeq] = useState<number | undefined>(undefined);
  const [entries, setEntries] = useState<RelayCommsEntry[]>([]);
  const [nextBeforeSeq, setNextBeforeSeq] = useState<number | null>(null);

  const data = usePluginData<RelayCommsPage>(BRIDGE_DATA_KEYS.relayComms, {
    companyId,
    limit: pageSize,
    beforeSeq,
  });

  const page = data.data as RelayCommsPayload | null;

  // Merge each freshly served page into the accumulated log. When the query
  // is invalid (company-not-found error envelope), leave the log empty and
  // surface the error.
  useEffect(() => {
    if (!page) return;
    if ("error" in page) return;
    setEntries((prev) => {
      const seen = new Set(prev.map((entry) => entry.seq));
      const merged = [...prev];
      for (const entry of page.entries) {
        if (!seen.has(entry.seq)) merged.push(entry);
      }
      return merged;
    });
    setNextBeforeSeq(page.nextBeforeSeq);
  }, [page]);

  const invalid = page && "error" in page ? page.error : null;
  const loading = data.loading;
  const exhausted = nextBeforeSeq === null && entries.length > 0;

  const handleMore = () => {
    if (nextBeforeSeq !== null) setBeforeSeq(nextBeforeSeq);
  };

  const reset = () => {
    setBeforeSeq(undefined);
    setEntries([]);
    setNextBeforeSeq(null);
  };

  return (
    <section data-testid="relay-comm-log" style={{ display: "grid", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
        <div>
          <h2 style={{ margin: 0 }}>Relay communications</h2>
          <div style={{ opacity: 0.72, fontSize: 13 }}>
            Bounded rolling log (operator capacity, default {defaultCapacity}).
            Latest first.
          </div>
        </div>
        <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
          Page size
          <select
            data-testid="relay-comm-page-size"
            value={pageSize}
            onChange={(event) => {
              setPageSize(Number(event.target.value));
              reset();
            }}
          >
            {PAGE_SIZES.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </label>
      </div>

      {invalid ? (
        <div role="alert" data-testid="relay-comm-log-error">
          {invalid}
        </div>
      ) : null}

      {entries.length === 0 && !loading && !invalid ? (
        <div data-testid="relay-comm-log-empty" style={{ opacity: 0.7 }}>
          No relay communications recorded yet.
        </div>
      ) : null}

      {entries.length > 0 ? (
        <table
          data-testid="relay-comm-table"
          style={{ borderCollapse: "collapse", fontSize: "0.9em" }}
        >
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>seq</th>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>time</th>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>kind</th>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>agent</th>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>detail</th>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>status</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.seq} data-testid="relay-comm-row" data-seq={entry.seq}>
                <td style={{ padding: "2px 8px 2px 0" }}>{entry.seq}</td>
                <td style={{ padding: "2px 8px 2px 0" }}>{formatTimestamp(entry.occurredAt)}</td>
                <td style={{ padding: "2px 8px 2px 0" }}>{entry.kind}</td>
                <td style={{ padding: "2px 8px 2px 0" }}>
                  {entry.agentId ? entry.agentId : "—"}
                </td>
                <td style={{ padding: "2px 8px 2px 0" }}>
                  {entry.kind === "feed-push"
                    ? `${entry.operations?.length ?? 0} operations`
                    : (entry.text ?? "—")}
                </td>
                <td style={{ padding: "2px 8px 2px 0" }}>{entry.status}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          data-testid="relay-comm-load-more"
          disabled={loading || nextBeforeSeq === null}
          onClick={handleMore}
        >
          Load more
        </button>
        {exhausted ? (
          <span data-testid="relay-comm-exhausted" style={{ opacity: 0.7, fontSize: 13 }}>
            End of log.
          </span>
        ) : null}
        {loading ? (
          <span data-testid="relay-comm-loading" style={{ opacity: 0.7, fontSize: 13 }}>
            Loading…
          </span>
        ) : null}
      </div>
    </section>
  );
}
