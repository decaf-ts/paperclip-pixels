import { AgentWindowStore } from "../../src/core/index.js";
import { BUCKET_INTERVAL_MS } from "../../src/core/index.js";
import { AGENT_A } from "./fixtures";

const NOW = 1_700_000_000_000;

describe("rolling-window expiration (§31.1)", () => {
  it("expires 5m observations after the 5m window passes", () => {
    const store = new AgentWindowStore();
    store.recordRunStart(AGENT_A, "r1", NOW - 4 * 60 * 1000);

    const within = store.getWindowedMetrics(AGENT_A, "5m", NOW);
    expect(within.runStarts).toBe(1);

    // 6 minutes later the 5m bucket has aged out.
    const after = store.getWindowedMetrics(AGENT_A, "5m", NOW + 6 * 60 * 1000);
    expect(after.runStarts).toBe(0);
    expect(after.coverageMs).toBe(0);
  });

  it("retains 30m observations across multiple 5m buckets", () => {
    const store = new AgentWindowStore();
    for (let i = 0; i < 6; i++) {
      store.recordRunStart(AGENT_A, `r${i}`, NOW - (5 - i) * 60 * 1000);
    }
    const m = store.getWindowedMetrics(AGENT_A, "30m", NOW);
    expect(m.runStarts).toBe(6);
  });

  it("retains only 288 buckets per agent (24h ring buffer)", () => {
    const store = new AgentWindowStore();
    // Record 300 buckets worth of events (one per 5m).
    for (let i = 0; i < 300; i++) {
      store.recordRunStart(AGENT_A, `r${i}`, NOW - (299 - i) * BUCKET_INTERVAL_MS);
    }
    const m24 = store.getWindowedMetrics(AGENT_A, "24h", NOW);
    // Only the last 288 buckets are retained.
    expect(m24.runStarts).toBe(288);
  });

  it("reports coverageMs bounded by the window", () => {
    const store = new AgentWindowStore();
    store.recordRunStart(AGENT_A, "r1", NOW - 10 * 60 * 1000);
    const m = store.getWindowedMetrics(AGENT_A, "30m", NOW);
    expect(m.coverageMs).toBeGreaterThan(0);
    expect(m.coverageMs).toBeLessThanOrEqual(30 * 60 * 1000);
  });
});
