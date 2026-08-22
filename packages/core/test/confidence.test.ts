import {
  BridgeStore,
  confidenceForWindow,
  clamp01,
} from "../src";
import { runStarted, snapshot, AGENT_A, BASE_MS } from "./fixtures";

const NOW = BASE_MS + 5 * 60 * 1000;

describe("signal confidence (§25, §31.1)", () => {
  it("confidence rises with sample count and coverage", () => {
    const low = confidenceForWindow(1, 1000, 5 * 60 * 1000);
    const high = confidenceForWindow(50, 5 * 60 * 1000, 5 * 60 * 1000);
    expect(low).toBeGreaterThanOrEqual(0);
    expect(low).toBeLessThan(high);
    expect(high).toBeLessThanOrEqual(1);
    expect(clamp01(high)).toBe(high);
  });

  it("every behavioral signal carries value, confidence in [0,1], and basis[]", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));

    const v = store.getBehaviorVector(AGENT_A, NOW);
    const signals = [
      v.load,
      v.sustainedLoad,
      v.burstiness,
      v.friction,
      v.failurePressure,
      v.interruptionPressure,
      v.collaboration,
      v.waiting,
      v.idleAvailability,
      v.contextSwitching,
      v.projectSpread,
      v.momentum,
    ];
    for (const s of signals) {
      expect(s.value).toBeGreaterThanOrEqual(0);
      expect(s.value).toBeLessThanOrEqual(1);
      expect(s.confidence).toBeGreaterThanOrEqual(0);
      expect(s.confidence).toBeLessThanOrEqual(1);
      expect(Array.isArray(s.basis)).toBe(true);
      expect(s.basis.length).toBeGreaterThan(0);
    }
  });

  it("long-window confidence is lower when coverage is partial", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));

    const v = store.getBehaviorVector(AGENT_A, NOW);
    // 24h coverage is tiny right after start, so sustainedLoad confidence
    // (drawn from 2h/8h) should be modest.
    expect(v.sustainedLoad.confidence).toBeLessThanOrEqual(v.load.confidence + 0.0001);
  });
});
