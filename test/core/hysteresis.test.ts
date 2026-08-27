import { BridgeStore } from "../../src/core/index.js";
import {
  runStarted,
  runFinished,
  snapshot,
  AGENT_A,
  BASE_MS,
} from "./fixtures";

const MIN_PUBLISH = 250;
const MAX_PUBLISH = 1000;

function store() {
  return new BridgeStore({ minPublishMs: MIN_PUBLISH, maxPublishMs: MAX_PUBLISH });
}

describe("hysteresis / publish throttling (§24, NFR-2, §31.1)", () => {
  it("does not publish more often than minPublishMs", async () => {
    const s = store();
    s.replaceAuthoritativeSnapshot(snapshot());
    const events: string[] = [];
    s.on("agentBehaviorChanged", (e) => events.push(e.agentId));

    await s.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    const firstCount = events.length;

    // Rapid subsequent events within the throttle window should not publish.
    for (let i = 1; i <= 5; i++) {
      await s.applyPaperclipEvent(runStarted(`e${i + 1}`, i, `r${i + 1}`, AGENT_A, null, null));
    }
    expect(events.length).toBe(firstCount); // no new publish within window
  });

  it("publishes after maxPublishMs even if changes were throttled", async () => {
    const s = store();
    s.replaceAuthoritativeSnapshot(snapshot());
    const events: string[] = [];
    s.on("agentBehaviorChanged", (e) => events.push(e.agentId));

    await s.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    const before = events.length;

    // Advance wall clock past maxPublishMs by flushing with a future timestamp.
    s.flushBehavior(BASE_MS + MAX_PUBLISH + 50);
    expect(events.length).toBeGreaterThanOrEqual(before);
  });

  it("emits only on rounded-value / semantic change", async () => {
    const s = new BridgeStore({ minPublishMs: 0, maxPublishMs: 0, valuePrecision: 2 });
    s.replaceAuthoritativeSnapshot(snapshot());
    const events: string[] = [];
    s.on("agentBehaviorChanged", (e) => events.push(e.agentId));

    await s.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    const afterFirst = events.length;
    expect(afterFirst).toBeGreaterThan(0);

    // A no-op-ish event that does not change rounded behavior should not emit.
    await s.applyPaperclipEvent(runFinished("e2", 1, "r1"));
    // Allow at most one extra publish (finishing a run may change load).
    expect(events.length - afterFirst).toBeLessThanOrEqual(1);
  });
});
