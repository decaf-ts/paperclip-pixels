/**
 * Pixel Office Configuration page tests (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The dedicated Configuration page exposes: the red/green connection indicator,
 * the bounded relay-communications log, native operational charts over the
 * `metrics-series` query shape, and the Paperclip-hosted office-layout editor.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PixelOfficeConfigPage } from "./PixelOfficeConfigPage";
import {
  makeDataResult,
  makeStreamResult,
  usePluginDataImpl,
  usePluginStreamImpl,
} from "./test-utils/sdk-ui";
import { makeSnapshot } from "./test-utils/fixtures";
import type { MetricsSeriesResult } from "../core/index.js";
import type { OfficeLayout } from "paperclip-pixels-common";
import type { RelayCommsPage } from "./bridge-contract";

function bucket(start: string, runStarts: number) {
  return {
    bucketStart: start,
    runStarts,
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
  };
}

const metricsResult: MetricsSeriesResult = {
  schemaVersion: 1,
  companyId: "co",
  window: "24h",
  bucketIntervalMs: 5 * 60 * 1000,
  company: [
    bucket("2026-09-08T10:00:00.000Z", 2),
    bucket("2026-09-08T10:05:00.000Z", 3),
  ],
  agents: [
    {
      agentId: "agent-a",
      buckets: [bucket("2026-09-08T10:00:00.000Z", 1), bucket("2026-09-08T10:05:00.000Z", 2)],
    },
  ],
};

const relayPage: RelayCommsPage = {
  schemaVersion: 1,
  companyId: "co",
  nextBeforeSeq: null,
  entries: [
    {
      seq: 5,
      companyId: "co",
      occurredAt: "2026-09-08T10:00:00.000Z",
      direction: "outbound",
      kind: "feed-push",
      status: "sent",
      operations: [],
    },
  ],
};

const layout: OfficeLayout = {
  schemaVersion: 1,
  name: "Main office",
  floors: [
    {
      id: "floor-1",
      name: "Ground",
      walls: [],
      furniture: [],
      seats: [{ id: "seat-1", agentId: null, position: { x: 0.25, y: 0.3 }, label: "Desk 1" }],
    },
  ],
};

function serveAll() {
  usePluginDataImpl.mockImplementation((...args: unknown[]) => {
    const key = args[0] as string;
    switch (key) {
      case "bridge-snapshot":
        return makeDataResult({ data: makeSnapshot() });
      case "metrics-series":
        return makeDataResult({ data: metricsResult });
      case "relay-comms":
        return makeDataResult({ data: relayPage });
      case "office-layout":
        return makeDataResult({ data: { schemaVersion: 1, companyId: "co", configured: true, layout } });
      default:
        return makeDataResult({ data: null });
    }
  });
  usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: false }));
}

async function renderConfigPage(context: Record<string, unknown> = { companyId: "co" }) {
  render(<PixelOfficeConfigPage context={context as never} />);
  await waitFor(() => expect(screen.getByTestId("pixel-office-config-page")).toBeTruthy());
}

describe("PixelOfficeConfigPage", () => {
  it("requires a company context before rendering", async () => {
    render(<PixelOfficeConfigPage context={{ companyId: null } as never} />);
    await waitFor(() =>
      expect(screen.getByTestId("pixel-office-config-no-company")).toBeTruthy(),
    );
  });

  it("renders the Configuration page with its header, relay log, metrics, and layout editor", async () => {
    serveAll();
    await renderConfigPage();
    expect(screen.getByText("Pixel Office Configuration")).toBeTruthy();
    expect(screen.getByTestId("relay-comm-log")).toBeTruthy();
    expect(screen.getByTestId("metrics-section")).toBeTruthy();
    expect(screen.getByTestId("office-layout-editor")).toBeTruthy();
  });

  it("shows the connection indicator as disconnected when the stream is down", async () => {
    serveAll();
    await renderConfigPage();
    await waitFor(() =>
      expect(screen.getByTestId("pixel-connection-indicator")).toHaveAttribute(
        "data-status",
        "disconnected",
      ),
    );
    // The snapshot finally arrives, marking the bridge stale (stream down).
    await waitFor(() =>
      expect(screen.getByTestId("pixel-connection-label")).toHaveTextContent(
        "Disconnected — state may be stale",
      ),
    );
  });

  it("renders the native operational charts for the company-wide and agent series", async () => {
    serveAll();
    await renderConfigPage();
    const charts = screen.getAllByTestId("metrics-chart");
    // At minimum: company-wide runs-started + runs-failed + the per-agent series.
    expect(charts.length).toBeGreaterThanOrEqual(3);
  });

  it("surfaces a metrics error envelope instead of charts", async () => {
    serveAll();
    usePluginDataImpl.mockImplementation((...args: unknown[]) => {
      const key = args[0] as string;
      if (key === "metrics-series") {
        return makeDataResult({ data: { schemaVersion: 1, error: "company-not-found" } });
      }
      if (key === "bridge-snapshot") return makeDataResult({ data: makeSnapshot() });
      return makeDataResult({ data: null });
    });
    render(<PixelOfficeConfigPage context={{ companyId: "co" } as never} />);
    await waitFor(() => expect(screen.getByTestId("metrics-error")).toBeTruthy());
    expect(screen.getByTestId("metrics-error")).toHaveTextContent("company-not-found");
  });

  it("renders the windows selector and switches the metrics window", async () => {
    serveAll();
    await renderConfigPage();
    fireEvent.change(screen.getByTestId("metrics-window-select"), {
      target: { value: "2h" },
    });
    await waitFor(() => expect(screen.getByTestId("metrics-window-select")).toHaveValue("2h"));
  });
});
