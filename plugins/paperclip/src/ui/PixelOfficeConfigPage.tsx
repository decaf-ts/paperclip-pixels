/**
 * Pixel Office Configuration page (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The dedicated Configuration screen of the native Office menu. It exposes:
 *  - a red/green bridge/feed connection indicator;
 *  - the bounded, paged rolling relay-communications log (default capacity
 *    100, from the R3-WS4a store);
 *  - agent communication / operational metrics plotted as native,
 *    host-styled charts from the `metrics-series` query shape; and
 *  - the Paperclip-hosted office-layout configuration editor.
 *
 * Trust boundary (FR-9, §28.2): every read/write goes through the plugin
 * worker via `ctx.data` / `ctx.actions` — never Paperclip HTTP routes.
 */

import { useState } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import type { TimeWindow } from "../core/index.js";
import { TIME_WINDOWS } from "../core/index.js";
import {
  BRIDGE_DATA_KEYS,
  type MetricsSeriesQuery,
  type MetricsSeriesResult,
} from "./bridge-contract";
import { useBridge } from "./use-bridge";

/** Error envelope the worker's `metrics-series` handler can return. */
type MetricsSeriesError = { schemaVersion: 1; error: string };
type MetricsSeriesPayload = MetricsSeriesResult | MetricsSeriesError;
import { ConnectionIndicator } from "./components/connection-indicator";
import { MetricsChart, type ChartableMetric } from "./components/metrics-chart";
import { OfficeLayoutEditor } from "./components/office-layout-editor";
import { RelayCommLog } from "./components/relay-comm-log";

export function PixelOfficeConfigPage({ context }: PluginPageProps) {
  if (!context.companyId) {
    return (
      <div data-testid="pixel-office-config-no-company">
        Select a company to view the Pixel Office Configuration.
      </div>
    );
  }
  return <PixelOfficeConfigPageInner companyId={context.companyId} />;
}

function PixelOfficeConfigPageInner({ companyId }: { companyId: string }) {
  const [window, setWindow] = useState<TimeWindow>("24h");
  const { state: bridgeState, connected, stale } = useBridge(companyId);
  const query: MetricsSeriesQuery = { companyId, window };
  const metrics = usePluginData<MetricsSeriesResult>(BRIDGE_DATA_KEYS.metricsSeries, query);

  const series = metrics.data as MetricsSeriesPayload | null;
  const invalid = series && "error" in series ? series.error : null;

  return (
    <div data-testid="pixel-office-config-page" style={{ display: "grid", gap: 20 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0 }}>Pixel Office Configuration</h1>
          <div style={{ opacity: 0.75, fontSize: "0.9em" }}>
            Operational metrics, relay communications, and office layout.
          </div>
        </div>
        <ConnectionIndicator
          connected={connected}
          stale={stale}
          lastSyncedAt={bridgeState.lastSyncedAt}
        />
      </header>

      <RelayCommLog companyId={companyId} />

      <section data-testid="metrics-section" style={{ display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <h2 style={{ margin: 0 }}>Operational metrics</h2>
            <div style={{ opacity: 0.72, fontSize: 13 }}>
              Communication and operational proxies over the selected window.
            </div>
          </div>
          <label style={{ display: "grid", gap: 2, fontSize: 13 }}>
            Window
            <select
              data-testid="metrics-window-select"
              value={window}
              onChange={(event) => setWindow(event.target.value as TimeWindow)}
            >
              {TIME_WINDOWS.map((w) => (
                <option key={w} value={w}>
                  {w}
                </option>
              ))}
            </select>
          </label>
        </div>

        {invalid ? (
          <div role="alert" data-testid="metrics-error">
            {invalid}
          </div>
        ) : null}

        {metrics.loading && !series ? (
          <div data-testid="metrics-loading" style={{ opacity: 0.7 }}>
            Loading metrics…
          </div>
        ) : null}

        {series && !("error" in series) ? (
          <div style={{ display: "grid", gap: 16 }}>
            <MetricsSection
              companyName="Company-wide"
              buckets={series.company}
              metric="runStarts"
            />
            <MetricsSection
              companyName="Company-wide"
              buckets={series.company}
              metric="runFailures"
            />
            {series.agents.map((agent) => (
              <MetricsSection
                key={agent.agentId}
                companyName={agent.agentId}
                buckets={agent.buckets}
                metric="runStarts"
              />
            ))}
          </div>
        ) : null}
      </section>

      <OfficeLayoutEditor companyId={companyId} disabled={stale} />
    </div>
  );
}

/** One chart block with a metric legend. */
function MetricsSection({
  companyName,
  buckets,
  metric,
  agentName,
}: {
  companyName: string;
  buckets: MetricsSeriesResult["company"];
  metric: ChartableMetric;
  agentName?: string;
}) {
  return (
    <MetricsChart
      title={`${metricLabel(metric)} — ${companyName}`}
      buckets={buckets}
      metric={metric}
      agentName={agentName}
      height={96}
    />
  );
}

/** Human label for a chartable bucket metric. */
function metricLabel(metric: ChartableMetric): string {
  const labels: Record<ChartableMetric, string> = {
    runStarts: "Runs started",
    runFinishes: "Runs finished",
    runFailures: "Runs failed",
    runCancellations: "Runs cancelled",
    issueTransitions: "Issue transitions",
    projectSwitches: "Project switches",
    commentEvents: "Comments",
    questionEvents: "Questions",
    blockedEvents: "Blocked events",
    approvalWaitEvents: "Approval waits",
    costCents: "Cost (¢)",
    inputTokens: "Input tokens",
    outputTokens: "Output tokens",
  };
  return labels[metric];
}
