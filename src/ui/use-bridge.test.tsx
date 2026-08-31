/**
 * `useBridge` snapshot+delta hook tests (spec PAPERCLIP_PIXELS-1, §16, §29.3,
 * §30, NFR-3, FR-13). Components are mounted through a DOM probe harness
 * because the suite drives real commits; renderHook's effect-completion path
 * is not dependable in this environment.
 *
 * The host SDK hooks are mocked; this suite proves the UI orchestration: full
 * snapshot on mount / company switch / reconnect / sequence gap, incremental
 * delta application with channel isolation, and stale-state computation.
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { REFRESH_INTERVAL_MS, useBridge } from "./use-bridge";
import { BRIDGE_DATA_KEYS, behaviorChannel } from "./bridge-contract";
import {
  makeDataResult,
  makeStreamResult,
  usePluginDataImpl,
  usePluginStreamImpl,
} from "./test-utils/sdk-ui";
import {
  makeAgentView,
  makeMetrics,
  makeProjection,
  makeSnapshot,
  makeStreamEvent,
} from "./test-utils/fixtures";

const snapshotWithAgent = () =>
  makeSnapshot({
    agents: [
      makeAgentView({
        projection: makeProjection({ agentId: "agent-a" }),
        metrics: makeMetrics(),
      }),
    ],
  });

function BridgeProbe({ companyId }: { companyId: string }) {
  const bridge = useBridge(companyId);
  const runStarts = bridge.state.snapshot?.agents[0]?.metrics["30m"]?.runStarts;
  return (
    <section data-testid="bridge-probe">
      <span data-testid="bp-conn">{String(bridge.connected)}</span>
      <span data-testid="bp-stale">{String(bridge.stale)}</span>
      <span data-testid="bp-snap">
        {bridge.state.snapshot ? "loaded" : "none"}
      </span>
      <span data-testid="bp-error">{bridge.state.error ?? "none"}</span>
      <span data-testid="bp-gap">{String(bridge.state.gapDetected)}</span>
      <span data-testid="bp-lastSynced">{bridge.state.lastSyncedAt ?? "none"}</span>
      <span data-testid="bp-runStarts">{String(runStarts ?? "none")}</span>
      <button data-testid="bp-refresh" onClick={() => bridge.refresh()}>
        refresh
      </button>
    </section>
  );
}

const loaded = async () =>
  expect(screen.getByTestId("bp-snap").textContent).toBe("loaded");

describe("useBridge — full snapshot fetch", () => {
  it("fetches the full snapshot with the companyId on mount", async () => {
    usePluginDataImpl.mockReturnValue(makeDataResult({ data: snapshotWithAgent() }));
    render(<BridgeProbe companyId="c1" />);

    await waitFor(loaded);
    expect(screen.getByTestId("bp-lastSynced").textContent).toBe(
      "2026-08-22T10:00:00.000Z",
    );
    await waitFor(() =>
      expect(usePluginDataImpl).toHaveBeenCalledWith(BRIDGE_DATA_KEYS.snapshot, {
        companyId: "c1",
      }),
    );
    await waitFor(() =>
      expect(usePluginStreamImpl).toHaveBeenCalledWith(behaviorChannel("c1"), {
        companyId: "c1",
      }),
    );
  });

  it("surfaces a fetch error in state", async () => {
    usePluginDataImpl.mockReturnValue(
      makeDataResult({
        error: { code: "WORKER_UNAVAILABLE", message: "worker offline" },
      }),
    );
    render(<BridgeProbe companyId="c1" />);

    await waitFor(() =>
      expect(screen.getByTestId("bp-error").textContent).toBe("worker offline"),
    );
  });

  it("refresh() delegates to the host data hook's refresh", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);

    fireEvent.click(screen.getByTestId("bp-refresh"));
    await waitFor(() => expect(dataResult.refresh).toHaveBeenCalledTimes(1));
  });
});

describe("useBridge — company switch (§29.3)", () => {
  it("resets state and re-fetches with the new company params", async () => {
    usePluginDataImpl.mockReturnValue(makeDataResult({ data: snapshotWithAgent() }));
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);
    await waitFor(() =>
      expect(usePluginDataImpl).toHaveBeenLastCalledWith(BRIDGE_DATA_KEYS.snapshot, {
        companyId: "c1",
      }),
    );

    // New fetch in flight for c2 → no new snapshot yet.
    usePluginDataImpl.mockReturnValue(makeDataResult(null));
    rerender(<BridgeProbe companyId="c2" />);

    await waitFor(() =>
      expect(usePluginDataImpl).toHaveBeenLastCalledWith(BRIDGE_DATA_KEYS.snapshot, {
        companyId: "c2",
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("bp-snap").textContent).toBe("none"),
    );
    expect(screen.getByTestId("bp-lastSynced").textContent).toBe("none");
    expect(screen.getByTestId("bp-gap").textContent).toBe("false");
  });
});

describe("useBridge — stale computation (§30.1)", () => {
  it("is stale while a snapshot is loaded but the stream is disconnected", async () => {
    usePluginDataImpl.mockReturnValue(makeDataResult({ data: snapshotWithAgent() }));
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);
    expect(screen.getByTestId("bp-stale").textContent).toBe("true");

    usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: true }));
    rerender(<BridgeProbe companyId="c1" />);
    await waitFor(() =>
      expect(screen.getByTestId("bp-stale").textContent).toBe("false"),
    );
    expect(screen.getByTestId("bp-conn").textContent).toBe("true");
  });

  it("is never stale while no snapshot is loaded", async () => {
    usePluginDataImpl.mockReturnValue(makeDataResult(null));
    render(<BridgeProbe companyId="c1" />);
    await waitFor(() =>
      expect(screen.getByTestId("bp-snap").textContent).toBe("none"),
    );
    expect(screen.getByTestId("bp-stale").textContent).toBe("false");
  });
});

describe("useBridge — polling fallback for hosts where the stream never connects", () => {
  // See use-bridge.ts's HOST GAP doc comment: on a Paperclip host that never
  // wires up bridgeDeps.streamBus, stream.connected is permanently false, so
  // this polling loop is the only thing keeping data moving at all.
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it("calls refresh() again after REFRESH_INTERVAL_MS even though the stream never connects", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);
    expect(screen.getByTestId("bp-conn").textContent).toBe("false");

    const callsBefore = (dataResult.refresh as jest.Mock).mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(REFRESH_INTERVAL_MS);
    });
    expect((dataResult.refresh as jest.Mock).mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it("stops polling on unmount", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    const { unmount } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);
    unmount();

    const callsAtUnmount = (dataResult.refresh as jest.Mock).mock.calls.length;
    await act(async () => {
      jest.advanceTimersByTime(REFRESH_INTERVAL_MS * 3);
    });
    expect((dataResult.refresh as jest.Mock).mock.calls.length).toBe(callsAtUnmount);
  });
});

describe("useBridge — reconnect re-fetches a full snapshot", () => {
  it("calls refresh() on a reconnect after having been connected once", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);

    // Connect (first time — no refresh).
    usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: true }));
    rerender(<BridgeProbe companyId="c1" />);
    await waitFor(() =>
      expect(screen.getByTestId("bp-conn").textContent).toBe("true"),
    );
    expect(dataResult.refresh).not.toHaveBeenCalled();

    // Disconnect.
    usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: false }));
    rerender(<BridgeProbe companyId="c1" />);
    await waitFor(() =>
      expect(screen.getByTestId("bp-conn").textContent).toBe("false"),
    );
    expect(dataResult.refresh).not.toHaveBeenCalled();

    // Reconnect → full snapshot re-fetch.
    usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: true }));
    rerender(<BridgeProbe companyId="c1" />);
    await waitFor(() => expect(dataResult.refresh).toHaveBeenCalledTimes(1));
  });

  it("does not refresh on the very first connection", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);

    usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: true }));
    rerender(<BridgeProbe companyId="c1" />);
    await waitFor(() =>
      expect(screen.getByTestId("bp-conn").textContent).toBe("true"),
    );
    expect(dataResult.refresh).not.toHaveBeenCalled();
  });
});

describe("useBridge — sequence gap triggers re-fetch (§29.3)", () => {
  it("calls refresh() and clears the gap flag when an unknown delta arrives", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);

    usePluginStreamImpl.mockReturnValue(
      makeStreamResult({ events: [{ schemaVersion: 1, type: "mystery.event" }] }),
    );
    rerender(<BridgeProbe companyId="c1" />);

    await waitFor(() => expect(dataResult.refresh).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.getByTestId("bp-gap").textContent).toBe("false"),
    );
    expect(screen.getByTestId("bp-snap").textContent).toBe("loaded");
  });

  it("calls refresh() when a delta targets an unknown agent", async () => {
    const dataResult = makeDataResult({ data: snapshotWithAgent() });
    usePluginDataImpl.mockReturnValue(dataResult);
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);

    usePluginStreamImpl.mockReturnValue(
      makeStreamResult({
        events: [
          makeStreamEvent("agent.metrics.changed", {
            agentId: "ghost-agent",
            metrics: makeMetrics(),
          }),
        ],
      }),
    );
    rerender(<BridgeProbe companyId="c1" />);

    await waitFor(() => expect(dataResult.refresh).toHaveBeenCalledTimes(1));
  });
});

describe("useBridge — incremental delta application", () => {
  it("applies known deltas to the loaded snapshot", async () => {
    const metrics = makeMetrics();
    metrics["30m"].runStarts = 77;
    usePluginDataImpl.mockReturnValue(makeDataResult({ data: snapshotWithAgent() }));
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(loaded);

    usePluginStreamImpl.mockReturnValue(
      makeStreamResult({
        events: [
          makeStreamEvent("agent.metrics.changed", {
            agentId: "agent-a",
            metrics,
          }),
        ],
      }),
    );
    rerender(<BridgeProbe companyId="c1" />);

    await waitFor(() =>
      expect(screen.getByTestId("bp-runStarts").textContent).toBe("77"),
    );
  });

  it("does not re-process old channel events after a company switch", async () => {
    const deltaMetrics = makeMetrics();
    deltaMetrics["30m"].runStarts = 77;
    const snapshot1 = snapshotWithAgent();
    const snapshot2 = snapshotWithAgent();
    const buffered = [
      makeStreamEvent("agent.metrics.changed", {
        agentId: "agent-a",
        metrics: deltaMetrics,
      }),
    ];

    usePluginDataImpl.mockReturnValue(makeDataResult({ data: snapshot1 }));
    usePluginStreamImpl.mockReturnValue(makeStreamResult({ events: buffered }));
    const { rerender } = render(<BridgeProbe companyId="c1" />);
    await waitFor(() =>
      expect(screen.getByTestId("bp-runStarts").textContent).toBe("77"),
    );

    // Switch company: the same buffered event must NOT be re-applied to the
    // new company's snapshot (it is skipped on channel change).
    usePluginDataImpl.mockReturnValue(makeDataResult({ data: snapshot2 }));
    rerender(<BridgeProbe companyId="c2" />);

    await waitFor(() =>
      expect(screen.getByTestId("bp-snap").textContent).toBe("loaded"),
    );
    await waitFor(() =>
      expect(screen.getByTestId("bp-runStarts").textContent).toBe("0"),
    );
    expect(screen.getByTestId("bp-gap").textContent).toBe("false");
  });
});
