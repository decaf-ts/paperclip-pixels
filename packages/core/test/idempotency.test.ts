import { BridgeStore } from "../src";
import { runStarted, runFinished, snapshot, AGENT_A } from "./fixtures";

describe("event dedupe (§31.1, §31.5 policy 6)", () => {
  it("does not double-count a duplicate run.started event", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1")); // duplicate eventId

    const raw = store.getAgentProjection(AGENT_A);
    expect(raw?.activeRunCount).toBe(1);
    expect(raw?.activeRuns).toHaveLength(1);

    const m = store.getWindowedMetrics(AGENT_A, "5m");
    expect(m.runStarts).toBe(1);
  });

  it("ignores a duplicate with the same eventId but different payload", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    // Same eventId, different runId — must be deduped.
    await store.applyPaperclipEvent(runStarted("e1", 1, "r2"));

    expect(store.getAgentProjection(AGENT_A)?.activeRunCount).toBe(1);
  });

  it("processes distinct eventIds independently", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    await store.applyPaperclipEvent(runStarted("e2", 10, "r2"));
    await store.applyPaperclipEvent(runFinished("e3", 20, "r1"));

    expect(store.getAgentProjection(AGENT_A)?.activeRunCount).toBe(1);
    expect(store.getWindowedMetrics(AGENT_A, "5m").runStarts).toBe(2);
    expect(store.getWindowedMetrics(AGENT_A, "5m").runFinishes).toBe(1);
  });
});
