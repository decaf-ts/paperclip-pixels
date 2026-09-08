import { BridgeStore } from "../../src/core/index.js";
import { BUCKET_INTERVAL_MS } from "../../src/core/domain/metrics.js";
import { AGENT_A, AGENT_B, commentCreated, runFinished, runStarted, snapshot, COMPANY_ID } from "./fixtures";

const BASE_MS = 1_700_000_000_000;

async function seedAgentA(): Promise<BridgeStore> {
  const store = new BridgeStore();
  store.replaceAuthoritativeSnapshot(snapshot());
  await store.applyPaperclipEvent(runStarted("e-start", 0, "run-1", AGENT_A, "issue-1", "project-x"));
  await store.applyPaperclipEvent(runFinished("e-finish", 3000, "run-1", AGENT_A));
  await store.applyPaperclipEvent(commentCreated("e-comment", 1000, "thanks, looks good", { agentId: AGENT_A }));
  return store;
}

describe("BridgeStore.getMetricsSeries (§R3-WS4a)", () => {
  it("returns an empty result when there are no agents", () => {
    const store = new BridgeStore();
    const res = store.getMetricsSeries(undefined, "24h");
    expect(res.schemaVersion).toBe(1);
    expect(res.window).toBe("24h");
    expect(res.bucketIntervalMs).toBe(BUCKET_INTERVAL_MS);
    expect(res.agents).toEqual([]);
    expect(res.company).toEqual([]);
  });

  it("returns chartable buckets with run and comment counters for a populated agent", async () => {
    const store = await seedAgentA();
    const res = store.getMetricsSeries(AGENT_A, "24h");
    expect(res.companyId).toBe(COMPANY_ID);
    expect(res.bucketIntervalMs).toBe(5 * 60 * 1000);
    expect(res.agents).toHaveLength(1);
    expect(res.agents[0].agentId).toBe(AGENT_A);
    expect(res.agents[0].buckets.length).toBeGreaterThanOrEqual(1);

    const bucket = res.agents[0].buckets[0];
    const expectedStart = new Date(Math.floor(BASE_MS / BUCKET_INTERVAL_MS) * BUCKET_INTERVAL_MS).toISOString();
    expect(bucket.bucketStart).toBe(expectedStart);
    expect(bucket.runStarts).toBe(1);
    expect(bucket.runFinishes).toBe(1);
    expect(bucket.commentEvents).toBe(1);
  });

  it("narrows to one agent when an agentId is supplied", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "run-a", AGENT_A, "issue-1", "project-x"));
    await store.applyPaperclipEvent(runStarted("e2", 1000, "run-b", AGENT_B, "issue-1", "project-x"));

    const resA = store.getMetricsSeries(AGENT_A, "24h");
    expect(resA.agents).toHaveLength(1);
    expect(resA.agents[0].agentId).toBe(AGENT_A);
    expect(resA.agents[0].buckets.length).toBeGreaterThanOrEqual(1);

    const resB = store.getMetricsSeries(AGENT_B, "24h");
    expect(resB.agents).toHaveLength(1);
    expect(resB.agents[0].agentId).toBe(AGENT_B);

    const resUnknown = store.getMetricsSeries("does-not-exist", "24h");
    expect(resUnknown.agents).toEqual([]);
    expect(resUnknown.company).toEqual([]);
  });

  it("sums the company series across agents", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    // both run-starts land in the same 5-minute bucket
    await store.applyPaperclipEvent(runStarted("e1", 0, "run-a", AGENT_A, "issue-1", "project-x"));
    await store.applyPaperclipEvent(runStarted("e2", 1000, "run-b", AGENT_B, "issue-1", "project-x"));

    const res = store.getMetricsSeries(undefined, "24h");
    expect(res.agents).toHaveLength(2);
    expect(res.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agentId: AGENT_A }),
        expect.objectContaining({ agentId: AGENT_B }),
      ]),
    );
    const companyBucket = res.company[0];
    expect(companyBucket.runStarts).toBe(2);
    const aSeries = res.agents.find((s) => s.agentId === AGENT_A)!;
    const bSeries = res.agents.find((s) => s.agentId === AGENT_B)!;
    expect(aSeries.buckets[0].runStarts).toBe(1);
    expect(bSeries.buckets[0].runStarts).toBe(1);
  });

  it("keeps a stable window-shaped result with empty series represented as empty buckets", async () => {
    const store = await seedAgentA();
    const res = store.getMetricsSeries(undefined, "2h");
    expect(res.window).toBe("2h");
    expect(res.bucketIntervalMs).toBe(BUCKET_INTERVAL_MS);
    // both snapshot agents are present; AGENT_B has no events -> empty buckets
    expect(res.agents).toHaveLength(2);
    for (const s of res.agents) {
      expect(Array.isArray(s.buckets)).toBe(true);
    }
    const b = res.agents.find((s) => s.agentId === AGENT_B)!;
    expect(b.buckets).toEqual([]);
  });
});
