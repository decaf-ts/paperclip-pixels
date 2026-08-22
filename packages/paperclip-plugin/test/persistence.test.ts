import { describe, expect, it } from "vitest";
import type { CompactAgentBuckets } from "@paperclip-pixel/core";
import { STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import {
  loadCompactBuckets,
  loadLastReconciledAt,
  loadLeadershipAgentId,
  loadSchemaVersion,
  persistCompactBuckets,
  persistLastReconciledAt,
  persistLeadershipAgentId,
  persistSchemaVersion,
} from "../src/persistence.js";
import { COMPANY_ID, makeHarness } from "./fixtures.js";

async function roundTripBuckets(): Promise<void> {
  const harness = makeHarness();
  const buckets: Record<string, CompactAgentBuckets> = {
    "agent-a": {
      schemaVersion: 1,
      agentId: "agent-a",
      companyId: COMPANY_ID,
      windows: { "5m": [] },
    } as unknown as CompactAgentBuckets,
  };
  await persistCompactBuckets(harness.ctx, COMPANY_ID, buckets);
  const loaded = await loadCompactBuckets(harness.ctx, COMPANY_ID);
  expect(loaded).toEqual(buckets);
}

describe("persistence (ctx.state CRUD)", () => {
  it("skips persisting empty bucket sets", async () => {
    const harness = makeHarness();
    await persistCompactBuckets(harness.ctx, COMPANY_ID, {});
    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY_ID,
        namespace: STATE_NAMESPACES.bridge,
        stateKey: STATE_KEYS.compactBuckets,
      }),
    ).toBeUndefined();
  });

  it("round-trips compact buckets", roundTripBuckets);

  it("loads null when compact buckets state is not an object", async () => {
    const harness = makeHarness();
    const scope = {
      scopeKind: "company" as const,
      scopeId: COMPANY_ID,
      namespace: STATE_NAMESPACES.bridge,
      stateKey: STATE_KEYS.compactBuckets,
    };
    await harness.ctx.state.set(scope, "not-an-object");
    expect(await loadCompactBuckets(harness.ctx, COMPANY_ID)).toBeNull();
    await harness.ctx.state.set(scope, []);
    expect(await loadCompactBuckets(harness.ctx, COMPANY_ID)).toBeNull();
    await harness.ctx.state.set(scope, null);
    expect(await loadCompactBuckets(harness.ctx, COMPANY_ID)).toBeNull();
  });

  it("round-trips lastReconciledAt", async () => {
    const harness = makeHarness();
    expect(await loadLastReconciledAt(harness.ctx, COMPANY_ID)).toBeNull();
    await persistLastReconciledAt(harness.ctx, COMPANY_ID, "2026-08-22T00:00:00.000Z");
    expect(await loadLastReconciledAt(harness.ctx, COMPANY_ID)).toBe("2026-08-22T00:00:00.000Z");
  });

  it("loads null when lastReconciledAt is not a string", async () => {
    const harness = makeHarness();
    const scope = {
      scopeKind: "company" as const,
      scopeId: COMPANY_ID,
      namespace: STATE_NAMESPACES.bridge,
      stateKey: STATE_KEYS.lastReconciledAt,
    };
    await harness.ctx.state.set(scope, 42);
    expect(await loadLastReconciledAt(harness.ctx, COMPANY_ID)).toBeNull();
  });

  it("round-trips the leadership agent id", async () => {
    const harness = makeHarness();
    expect(await loadLeadershipAgentId(harness.ctx, COMPANY_ID)).toBeNull();
    await persistLeadershipAgentId(harness.ctx, COMPANY_ID, "agent-ceo");
    expect(await loadLeadershipAgentId(harness.ctx, COMPANY_ID)).toBe("agent-ceo");
  });

  it("persists and loads the instance schema version", async () => {
    const harness = makeHarness();
    expect(await loadSchemaVersion(harness.ctx)).toBeNull();
    await persistSchemaVersion(harness.ctx);
    expect(await loadSchemaVersion(harness.ctx)).toBe(1);
  });
});
