/**
 * Native, host-styled operational chart for the bridge's metrics
 * (R3-WS4b, PAPERCLIP_PIXELS-2). Consumes the `metrics-series` query shape
 * served by the worker (`MetricsSeriesResult` -> `MetricsBucket[]`), plotted
 * left-to-right in the bucket order the store already guarantees
 * (oldest-first), so no re-sorting is needed.
 *
 * No external chart library: a lightweight inline-SVG bar chart with the
 * same visual language as the rest of the plugin (inline styles, a
 * `#4f7cff` accent), so it reads as native to the host without pulling a
 * dependency into the UI bundle.
 */

import type { MetricsBucket } from "../../core/index.js";

/** Numeric metric keys the chart can plot (a stable subset of MetricsBucket). */
export type ChartableMetric =
  | "runStarts"
  | "runFinishes"
  | "runFailures"
  | "runCancellations"
  | "issueTransitions"
  | "projectSwitches"
  | "commentEvents"
  | "questionEvents"
  | "blockedEvents"
  | "approvalWaitEvents"
  | "costCents"
  | "inputTokens"
  | "outputTokens";

export interface MetricsChartProps {
  /** Heading shown above the chart. */
  title: string;
  /** Time-bucketed points (oldest-first). */
  buckets: MetricsBucket[];
  /** Which bucket field to plot. */
  metric: ChartableMetric;
  /** Optional bar colour (defaults to the plugin accent). */
  color?: string;
  /** Rendered chart height in px. */
  height?: number;
  /** Optional per-agent label shown in the heading (e.g. "Alice"). */
  agentName?: string;
}

/** Format a bucket start ISO timestamp as a compact HH:MM label. */
function bucketLabel(bucketStart: string): string {
  const date = new Date(bucketStart);
  if (Number.isNaN(date.getTime())) return bucketStart;
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const CHART_WIDTH = 560;
const CHART_HEIGHT = 120;
const BAR_GAP = 2;

export function MetricsChart({
  title,
  buckets,
  metric,
  color = "#4f7cff",
  height = CHART_HEIGHT,
  agentName,
}: MetricsChartProps) {
  const values = buckets.map((bucket) => bucket[metric]);
  const max = Math.max(1, ...values.map((value) => value ?? 0));
  const barWidth = buckets.length > 0
    ? Math.max(2, Math.floor((CHART_WIDTH - buckets.length * BAR_GAP) / buckets.length))
    : 0;
  const total = values.reduce((sum, value) => sum + (value ?? 0), 0);

  return (
    <section
      data-testid="metrics-chart"
      data-metric={metric}
      style={{ display: "grid", gap: 6 }}
    >
      <div style={{ fontWeight: 600, fontSize: "0.95em" }}>
        {title}
        {agentName ? ` — ${agentName}` : ""}
        <span style={{ fontWeight: 400, opacity: 0.7, marginLeft: 6 }}>
          total {total}
        </span>
      </div>
      {buckets.length === 0 ? (
        <div data-testid="metrics-chart-empty" style={{ opacity: 0.7, fontSize: "0.9em" }}>
          No data in this window.
        </div>
      ) : (
        <svg
          data-testid="metrics-chart-bars"
          width={CHART_WIDTH}
          height={height}
          viewBox={`0 0 ${CHART_WIDTH} ${height}`}
          role="img"
          aria-label={title}
        >
          {values.map((value, index) => {
            const barHeight = ((value ?? 0) / max) * (height - 14);
            const x = index * (barWidth + BAR_GAP);
            const y = height - barHeight;
            return (
              <rect
                key={buckets[index]?.bucketStart ?? index}
                data-testid="metrics-chart-bar"
                data-value={(value ?? 0).toString()}
                x={x}
                y={y}
                width={barWidth}
                height={barHeight}
                fill={color}
                rx={1}
              >
                <title>
                  {bucketLabel(buckets[index].bucketStart)}: {value ?? 0}
                </title>
              </rect>
            );
          })}
          {buckets.length <= 8 ? (
            <g>
              {buckets.map((bucket, index) => {
                const x = index * (barWidth + BAR_GAP);
                return (
                  <text
                    key={`label-${bucket.bucketStart}`}
                    x={x + barWidth / 2}
                    y={height - 2}
                    textAnchor="middle"
                    fontSize={9}
                    fill="#888"
                  >
                    {bucketLabel(bucket.bucketStart)}
                  </text>
                );
              })}
            </g>
          ) : null}
        </svg>
      )}
    </section>
  );
}
