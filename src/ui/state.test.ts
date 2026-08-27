/**
 * Pure bridge UI reducer tests (spec PAPERCLIP_PIXELS-1, §16, §29.3, §30,
 * NFR-3, FR-13).
 *
 * The UI must apply stream deltas incrementally but never invent state: any
 * delta that cannot be applied safely (unknown type, unknown entity, or a
 * delta before the first snapshot) must mark the state as gapped so the
 * consumer re-fetches a full snapshot.
 */

import {
  bridgeUiReducer,
  initialBridgeUiState,
  type BridgeUiState,
} from "./state";
import type { VersionedAgentBehaviorVector } from "../core/index.js";
import {
  makeAgentView,
  makeFeedback,
  makeMetrics,
  makeProjection,
  makeSnapshot,
  makeStreamEvent,
  makeSummary,
} from "./test-utils/fixtures";

function freshState(overrides: Partial<BridgeUiState> = {}): BridgeUiState {
  return { ...initialBridgeUiState, ...overrides };
}

describe("bridgeUiReducer — initialState", () => {
  it("starts empty with no gap/error/loading", () => {
    expect(initialBridgeUiState).toEqual({
      snapshot: null,
      loading: false,
      error: null,
      lastSyncedAt: null,
      gapDetected: false,
    });
  });

  it("ignores unknown actions (returns the same state)", () => {
    const state = freshState({ gapDetected: true });
    const next = bridgeUiReducer(state, { type: "nope" as never });
    expect(next).toBe(state);
  });
});

describe("bridgeUiReducer — snapshot-received", () => {
  it("stores the snapshot and syncs lastSyncedAt from observedAt", () => {
    const snapshot = makeSnapshot({ observedAt: "2026-08-22T12:00:00.000Z" });
    const next = bridgeUiReducer(
      freshState({ loading: true, error: "boom", gapDetected: true }),
      { type: "snapshot-received", snapshot },
    );
    expect(next.snapshot).toBe(snapshot);
    expect(next.lastSyncedAt).toBe("2026-08-22T12:00:00.000Z");
    expect(next.loading).toBe(false);
    expect(next.error).toBeNull();
    expect(next.gapDetected).toBe(false);
  });

  it("keeps lastSyncedAt when the snapshot has no observedAt", () => {
    const snapshot = makeSnapshot({ observedAt: undefined });
    const next = bridgeUiReducer(
      freshState({ lastSyncedAt: "2026-08-22T11:00:00.000Z" }),
      { type: "snapshot-received", snapshot },
    );
    expect(next.lastSyncedAt).toBe("2026-08-22T11:00:00.000Z");
    expect(next.snapshot).toBe(snapshot);
  });
});

describe("bridgeUiReducer — fetch lifecycle", () => {
  it("fetch-started sets loading and clears error", () => {
    const next = bridgeUiReducer(
      freshState({ error: "boom" }),
      { type: "fetch-started" },
    );
    expect(next.loading).toBe(true);
    expect(next.error).toBeNull();
  });

  it("fetch-failed clears loading and records the message", () => {
    const next = bridgeUiReducer(freshState({ loading: true }), {
      type: "fetch-failed",
      message: "worker offline",
    });
    expect(next.loading).toBe(false);
    expect(next.error).toBe("worker offline");
  });
});

describe("bridgeUiReducer — delta-received applies known types", () => {
  const base = makeSnapshot({
    agents: [
      makeAgentView({
        projection: makeProjection({ agentId: "agent-a" }),
        metrics: makeMetrics(),
      }),
      makeAgentView({
        projection: makeProjection({
          agentId: "agent-b",
          name: "Bob",
        }),
      }),
    ],
    feedback: [makeFeedback({ id: "fb-1" })],
  });

  it("company.summary.changed replaces the summary", () => {
    const summary = makeSummary({ agentCount: 7, activeRunCount: 3 });
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("company.summary.changed", summary),
    });
    expect(next.snapshot?.summary).toMatchObject({
      agentCount: 7,
      activeRunCount: 3,
    });
    expect(next.gapDetected).toBe(false);
  });

  it("agent.projection.changed updates only the targeted agent's projection", () => {
    const projection = makeProjection({ agentId: "agent-b", name: "Bobby" });
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("agent.projection.changed", projection),
    });
    expect(next.snapshot?.agents[1].projection.name).toBe("Bobby");
    expect(next.snapshot?.agents[0].projection.name).toBe("Alice");
  });

  it("agent.metrics.changed replaces the windowed metrics", () => {
    const metrics = makeMetrics();
    metrics["30m"].runStarts = 42;
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("agent.metrics.changed", {
        agentId: "agent-a",
        metrics,
      }),
    });
    expect(next.snapshot?.agents[0].metrics["30m"].runStarts).toBe(42);
    expect(next.snapshot?.agents[1].metrics["30m"].runStarts).toBe(0);
  });

  it("agent.behavior.changed replaces the behavior vector", () => {
    const behavior: VersionedAgentBehaviorVector = {
      schemaVersion: 1,
      agentId: "agent-a",
      companyId: "co",
      calculatedAt: "2026-08-22T13:00:00.000Z",
      load: { value: 0.9, confidence: 0.95, basis: ["observed:values"] },
      sustainedLoad: { value: 0.9, confidence: 0.95, basis: [] },
      burstiness: { value: 0.9, confidence: 0.95, basis: [] },
      friction: { value: 0.9, confidence: 0.95, basis: [] },
      failurePressure: { value: 0.9, confidence: 0.95, basis: [] },
      interruptionPressure: { value: 0.9, confidence: 0.95, basis: [] },
      collaboration: { value: 0.9, confidence: 0.95, basis: [] },
      waiting: { value: 0.9, confidence: 0.95, basis: [] },
      idleAvailability: { value: 0.9, confidence: 0.95, basis: [] },
      contextSwitching: { value: 0.9, confidence: 0.95, basis: [] },
      projectSpread: { value: 0.9, confidence: 0.95, basis: [] },
      momentum: { value: 0.9, confidence: 0.95, basis: [] },
    };
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("agent.behavior.changed", behavior),
    });
    expect(next.snapshot?.agents[0].behavior.load.value).toBe(0.9);
    expect(next.snapshot?.agents[1].behavior.load.value).toBe(0.5);
  });

  it("feedback.changed upserts a new feedback by id", () => {
    const feedback = makeFeedback({ id: "fb-new", summary: "hello" });
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("feedback.changed", { feedback }),
    });
    expect(next.snapshot?.feedback.map((f) => f.id)).toEqual([
      "fb-1",
      "fb-new",
    ]);
  });

  it("feedback.changed replaces an existing feedback by id", () => {
    const feedback = makeFeedback({
      id: "fb-1",
      summary: "replaced summary",
    });
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("feedback.changed", { feedback }),
    });
    expect(next.snapshot?.feedback).toHaveLength(1);
    expect(next.snapshot?.feedback[0].summary).toBe("replaced summary");
  });

  it("feedback.changed with removed=true drops the feedback", () => {
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("feedback.changed", {
        feedback: makeFeedback({ id: "fb-1", summary: "resolved" }),
        removed: true,
      }),
    });
    expect(next.snapshot?.feedback).toEqual([]);
  });

  it("applies a bridge.snapshot delta like a full snapshot", () => {
    const snapshot = makeSnapshot({
      observedAt: "2026-08-22T14:00:00.000Z",
    });
    const next = bridgeUiReducer(freshState({ gapDetected: true }), {
      type: "delta-received",
      event: makeStreamEvent("bridge.snapshot", snapshot),
    });
    expect(next.snapshot).toBe(snapshot);
    expect(next.gapDetected).toBe(false);
    expect(next.lastSyncedAt).toBe("2026-08-22T14:00:00.000Z");
  });
});

describe("bridgeUiReducer — gap detection (§29.3)", () => {
  const base = makeSnapshot({
    agents: [makeAgentView({ projection: makeProjection({ agentId: "agent-a" }) })],
  });

  it("flags an unknown/foreign event type as a gap", () => {
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: { schemaVersion: 1, type: "agency.everything.broke", payload: {} },
    });
    expect(next.gapDetected).toBe(true);
  });

  it("flags a non-object event as a gap", () => {
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: "garbage",
    });
    expect(next.gapDetected).toBe(true);
  });

  it("flags an agent delta for an agent absent from the snapshot", () => {
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent("agent.metrics.changed", {
        agentId: "ghost-agent",
        metrics: makeMetrics(),
      }),
    });
    expect(next.gapDetected).toBe(true);
    expect(next.snapshot).toBe(base);
  });

  it("flags a projection delta for an unknown agent without mutating", () => {
    const next = bridgeUiReducer(freshState({ snapshot: base }), {
      type: "delta-received",
      event: makeStreamEvent(
        "agent.projection.changed",
        makeProjection({ agentId: "ghost-agent", name: "Ghost", status: "running" }),
      ),
    });
    expect(next.gapDetected).toBe(true);
    expect(next.snapshot).toBe(base);
  });

  it("flags a delta before the first snapshot as a gap", () => {
    const next = bridgeUiReducer(freshState(), {
      type: "delta-received",
      event: makeStreamEvent("company.summary.changed", makeSummary()),
    });
    expect(next.gapDetected).toBe(true);
    expect(next.snapshot).toBeNull();
  });
});

describe("bridgeUiReducer — reset and gap-cleared", () => {
  it("reset clears snapshot/error/gap", () => {
    const snapshot = makeSnapshot();
    const next = bridgeUiReducer(
      freshState({ snapshot, error: "boom", gapDetected: true }),
      { type: "reset" },
    );
    expect(next.snapshot).toBeNull();
    expect(next.error).toBeNull();
    expect(next.gapDetected).toBe(false);
    expect(next.lastSyncedAt).toBeNull();
  });

  it("gap-cleared only flips the gap flag", () => {
    const snapshot = makeSnapshot();
    const next = bridgeUiReducer(
      freshState({ snapshot, gapDetected: true }),
      { type: "gap-cleared" },
    );
    expect(next.gapDetected).toBe(false);
    expect(next.snapshot).toBe(snapshot);
  });
});
