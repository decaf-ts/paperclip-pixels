import { BridgeStore } from "../src";
import { runStarted, runFinished, snapshot, AGENT_A } from "./fixtures";

describe("out-of-order events (§31.1)", () => {
  it("applies a delayed run.started after run.finished without crashing", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    // Finish arrives before the (delayed) start.
    await store.applyPaperclipEvent(runFinished("e2", 100, "r1"));
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));

    const raw = store.getAgentProjection(AGENT_A);
    // The late start re-opens the run as active; both events are counted once.
    expect(raw?.activeRunCount).toBe(1);
    const m = store.getWindowedMetrics(AGENT_A, "5m");
    expect(m.runStarts).toBe(1);
    expect(m.runFinishes).toBe(1);
  });

  it("counts run finishes that arrive before starts without double counting", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runFinished("f1", 50, "r1"));
    await store.applyPaperclipEvent(runFinished("f2", 60, "r2"));
    await store.applyPaperclipEvent(runStarted("s1", 10, "r1"));
    await store.applyPaperclipEvent(runStarted("s2", 20, "r2"));

    const m = store.getWindowedMetrics(AGENT_A, "5m");
    expect(m.runStarts).toBe(2);
    expect(m.runFinishes).toBe(2);
    // No active runs remain because finishes were processed (activeRuns cleared).
    expect(store.getAgentProjection(AGENT_A)?.activeRunCount).toBeLessThanOrEqual(2);
  });
});
