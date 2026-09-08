/**
 * Metrics chart tests (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The chart is a native SVG bar chart that plots the `metrics-series` bucket
 * shape oldest-first, with a total shown in the heading, an empty state, and a
 * per-bar value/depth for the UI suite to assert against.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { MetricsChart } from "./metrics-chart";
import type { MetricsBucket } from "../../core/index.js";

function bucket(start: string, overrides: Partial<MetricsBucket> = {}): MetricsBucket {
  return {
    bucketStart: start,
    runStarts: 0,
    runFinishes: 0,
    runFailures: 0,
    runCancellations: 0,
    issueTransitions: 0,
    projectSwitches: 0,
    commentEvents: 0,
    questionEvents: 0,
    blockedEvents: 0,
    approvalWaitEvents: 0,
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    samples: 0,
    ...overrides,
  };
}

async function renderChart(props: Parameters<typeof MetricsChart>[0]) {
  render(<MetricsChart {...props} />);
  await waitFor(() => expect(screen.getByTestId("metrics-chart")).toBeTruthy());
  return screen.getByTestId("metrics-chart");
}

describe("MetricsChart", () => {
  it("renders a data-metric section with the title and the total", async () => {
    const buckets = [
      bucket("2026-09-08T10:00:00.000Z", { runStarts: 2 }),
      bucket("2026-09-08T10:05:00.000Z", { runStarts: 3 }),
    ];
    const chart = await renderChart({ title: "Runs started", buckets, metric: "runStarts" });
    expect(chart).toHaveAttribute("data-metric", "runStarts");
    expect(chart).toHaveTextContent("Runs started");
    expect(chart).toHaveTextContent("total 5");
    expect(screen.getByTestId("metrics-chart-bars")).toBeTruthy();
  });

  it("renders one bar per bucket with the plotted value", async () => {
    const buckets = [
      bucket("2026-09-08T10:00:00.000Z", { runFailures: 1 }),
      bucket("2026-09-08T10:05:00.000Z", { runFailures: 4 }),
    ];
    await renderChart({ title: "Runs failed", buckets, metric: "runFailures" });
    const bars = screen.getAllByTestId("metrics-chart-bar");
    expect(bars).toHaveLength(2);
    expect(bars[0]).toHaveAttribute("data-value", "1");
    expect(bars[1]).toHaveAttribute("data-value", "4");
  });

  it("shows an empty state and no bars when there are no buckets", async () => {
    await renderChart({ title: "Runs started", buckets: [], metric: "runStarts" });
    expect(screen.getByTestId("metrics-chart-empty")).toBeTruthy();
    expect(screen.queryByTestId("metrics-chart-bars")).toBeNull();
  });

  it("appends an agent name to the heading when supplied", async () => {
    const buckets = [bucket("2026-09-08T10:00:00.000Z", { runStarts: 1 })];
    const chart = await renderChart({
      title: "Runs started",
      buckets,
      metric: "runStarts",
      agentName: "Alice",
    });
    expect(chart).toHaveTextContent("Runs started — Alice");
  });

  it("scales bar heights by the max value in the series", async () => {
    const buckets = [
      bucket("2026-09-08T10:00:00.000Z", { commentEvents: 2 }),
      bucket("2026-09-08T10:05:00.000Z", { commentEvents: 10 }),
    ];
    await renderChart({ title: "Comments", buckets, metric: "commentEvents" });
    const bars = screen.getAllByTestId("metrics-chart-bar");
    const h0 = Number(bars[0].getAttribute("height"));
    const h1 = Number(bars[1].getAttribute("height"));
    expect(h1).toBeGreaterThan(h0);
  });
});
