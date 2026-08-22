import { BridgeStore } from "../src";
import {
  runStarted,
  runFinished,
  snapshot,
  AGENT_A,
  BASE_MS,
} from "./fixtures";

const NOW = BASE_MS + 2 * 60 * 1000;

describe("restart / restore (§31.1, §39.3)", () => {
  it("restores compact buckets so 24h history survives a restart", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    await store.applyPaperclipEvent(runFinished("e2", 60_000, "r1"));

    const before = store.getWindowedMetrics(AGENT_A, "5m", NOW);
    expect(before.runStarts).toBe(1);
    const compact = store.exportCompactBuckets();
    expect(compact[AGENT_A]).toBeDefined();
    expect(compact[AGENT_A].buckets.length).toBeGreaterThan(0);

    // Simulate a restart: new store with restored buckets.
    const restored = new BridgeStore({ restoredBuckets: compact });
    const after = restored.getWindowedMetrics(AGENT_A, "5m", NOW);
    expect(after.runStarts).toBe(1);
    expect(after.runFinishes).toBe(1);
  });

  it("restored active runs are reflected in the window store", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));

    const compact = store.exportCompactBuckets();
    expect(compact[AGENT_A].activeRuns).toHaveLength(1);

    const restored = new BridgeStore({ restoredBuckets: compact });
    // The restored run is tracked as active (no bucket runStart re-counted).
    expect(restored.getAgentProjection(AGENT_A)).toBeUndefined();
    // Agent projection only exists after a snapshot; windows still track the run.
    const m = restored.getWindowedMetrics(AGENT_A, "5m", NOW);
    expect(m.runStarts).toBe(1);
  });
});
