import { BridgeStore } from "../src";
import { snapshot, AGENT_A, BASE_MS } from "./fixtures";

const NOW = BASE_MS + 60_000;

describe("missing optional data (§9.1, §31.1)", () => {
  it("leaves optional numeric fields undefined when source data is missing", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    const raw = store.getAgentProjection(AGENT_A);
    expect(raw?.observedCostCents).toBeUndefined();
    expect(raw?.observedInputTokens).toBeUndefined();
    expect(raw?.observedOutputTokens).toBeUndefined();
  });

  it("never invents 0 as unknown — WindowedMetrics optionals stay undefined", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    const m = store.getWindowedMetrics(AGENT_A, "5m", NOW);
    // No cost/token events observed => optionals undefined, not 0.
    expect(m.costCents).toBeUndefined();
    expect(m.inputTokens).toBeUndefined();
    expect(m.outputTokens).toBeUndefined();
    expect(m.meanRunDurationMs).toBeUndefined();
    expect(m.p95RunDurationMs).toBeUndefined();
    // Counters that are always meaningful default to 0.
    expect(m.runStarts).toBe(0);
    expect(m.samples).toBe(0);
  });

  it("preserves observed cost/tokens when provided in the snapshot", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(
      snapshot({
        agents: [
          {
            id: AGENT_A,
            companyId: snapshot().company.id,
            name: "Alice",
            status: "idle",
            observedCostCents: 1234,
            observedInputTokens: 1000,
            observedOutputTokens: 500,
          },
        ],
      }),
    );

    const raw = store.getAgentProjection(AGENT_A);
    expect(raw?.observedCostCents).toBe(1234);
    expect(raw?.observedInputTokens).toBe(1000);
    expect(raw?.observedOutputTokens).toBe(500);
  });
});
