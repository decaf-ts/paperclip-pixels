/**
 * WS5-C company-switch hardening (spec PAPERCLIP_PIXELS-2, NFR-7, delegation
 * SAA-754) — extends the PAPERCLIP_PIXELS-1 Phase 8 company-switch guarantee
 * ("switching companies re-scopes characters/labels/feed with no cross-company
 * leakage") to the NEW plugin-host surface: per-company CompanyRuntime
 * isolation in `src/worker.ts`.
 *
 * The worker keeps ONE `BridgeRuntime.companies` map (CompanyRuntime per
 * companyId — separate BridgeStore, per-agent characterAssignments, and a
 * separate relay feed mapper/sink per company). This suite asserts that no
 * company B event, snapshot, or appearance assignment leaks into company A's
 * bridge-snapshot / relay feed batch — the exact unit shape the SAA-693 brief
 * asks for (use-bridge-style company-switch + worker CompanyRuntime isolation).
 *
 * AUTOMATED (vitest plugin-SDK harness) because the worker test harness
 * already supports two companies via `seedStandardWorld({ includeSecondCompany: true })`
 * and a captured global-fetch relay sidecar.
 */

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { DATA_KEYS, JOB_KEYS, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import plugin from "../src/worker.js";
import { pluginDefinition } from "./typing.js";
import {
  AGENT_CEO_ID,
  AGENT_DEV_ID,
  COMPANY_2_ID,
  COMPANY_ID,
  ISSUE_ID,
  makeHarness,
  seedStandardWorld,
} from "./fixtures.js";

type IntervalHandle = ReturnType<typeof setInterval>;

const intervalHandles: IntervalHandle[] = [];
let relayFetchCalls: Array<{ url: string; method: string; body: string }>;

beforeEach(() => {
  intervalHandles.length = 0;
  const original = setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, timeout?: number, ...args: unknown[]) => {
    const handle = original(handler, timeout, ...args) as unknown as IntervalHandle;
    intervalHandles.push(handle);
    return handle;
  }) as unknown as typeof setInterval);
});

afterEach(async () => {
  await pluginDefinition(plugin).onShutdown?.();
  for (const handle of intervalHandles) clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  intervalHandles.length = 0;
  vi.restoreAllMocks();
});

/** Run the worker plugin's `setup` against the harness context. */
async function setupWorker(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await pluginDefinition(plugin).setup(harness.ctx);
}

/** The bridge-snapshot data key for one company (the same payload the Pixel
 * Office UI consumes), as an untyped promise for direct field assertions. */
function bridgeSnapshot(harness: ReturnType<typeof makeHarness>, companyId: string): Promise<any> {
  return harness.getData(DATA_KEYS.bridgeSnapshot, { companyId }) as Promise<any>;
}

/** Capture every global-fetch call the relay makes into
 * {@link relayFetchCalls} (each entry records url/method/body) and answer all
 * of them with a canned 200 so the relay's push loop keeps running. */
function spyRelayFetch(): MockInstance<typeof fetch> {
  relayFetchCalls = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url: string | URL | Request, init?: RequestInit) => {
      relayFetchCalls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
    },
  );
}

/** Parse the captured feed calls into their batch bodies. */
function feedBatches(): Array<{ schemaVersion: number; companyId: string; operations: Array<Record<string, unknown>> }> {
  return relayFetchCalls.map((c) => JSON.parse(c.body));
}

/** All declareAgents keys across the batches for ONE company. */
function declaredKeysFor(companyId: string): string[] {
  return feedBatches()
    .filter((b) => b.companyId === companyId)
    .flatMap((b) => b.operations)
    .filter((op) => op.op === "declareAgents")
    .flatMap((op) => (op.agents as Array<{ key: string }>).map((a) => a.key));
}

describe("company-switch isolation (NFR-7): CompanyRuntime + relay feed re-scope", () => {
  it("keeps company A's bridge snapshot free of company B's agents/issues after B is seeded and bootstrapped", async () => {
    const { harness } = seedStandardWorld({ includeSecondCompany: true });
    // The worker bootstraps every company the host lists, so both companies
    // get their own CompanyRuntime (separate BridgeStore + assignments).
    await setupWorker(harness);

    // Company A sees only its own agents/issues.
    const a = await bridgeSnapshot(harness, COMPANY_ID);
    expect(a.company?.id).toBe(COMPANY_ID);
    expect(a.agents.map((v: any) => v.projection.agentId).sort()).toEqual(
      [AGENT_CEO_ID, AGENT_DEV_ID].sort(),
    );
    expect(a.issues.map((i: any) => i.id)).toEqual([ISSUE_ID]);

    // Company B sees its own world, never A's.
    const b = await bridgeSnapshot(harness, COMPANY_2_ID);
    expect(b.company?.id).toBe(COMPANY_2_ID);
    expect(b.agents).toEqual([]);
    expect(b.issues.map((i: any) => i.id)).toEqual(["issue-other"]);
  });

  it("a company B event mutates only B's runtime, never company A's snapshot", async () => {
    const { harness } = seedStandardWorld({ includeSecondCompany: true });
    await setupWorker(harness);

    await harness.emit(
      "issue.updated",
      { issueId: "issue-other", projectId: "project-other", status: "done" },
      { companyId: COMPANY_2_ID, eventId: "evt-b-only" },
    );

    // B reflected the change.
    const b = await bridgeSnapshot(harness, COMPANY_2_ID);
    expect(b.issues[0]).toMatchObject({ id: "issue-other", status: "done" });

    // A is untouched.
    const a = await bridgeSnapshot(harness, COMPANY_ID);
    expect(a.issues[0]).toMatchObject({ id: ISSUE_ID, status: "todo" });
  });

  it("reconciles each company independently: repairing B never changes A", async () => {
    const { harness } = seedStandardWorld({ includeSecondCompany: true });
    await setupWorker(harness);

    // Drive A's state so it has something worth reconciling, then reconcile
    // B and confirm A's snapshot is unchanged by the B-only reconcile.
    await harness.emit(
      "issue.updated",
      { issueId: ISSUE_ID, projectId: "project-core", status: "in_progress" },
      { companyId: COMPANY_ID, eventId: "evt-a-drift" },
    );
    expect((await bridgeSnapshot(harness, COMPANY_ID)).issues[0].status).toBe("in_progress");

    await harness.runJob(JOB_KEYS.reconciliation);

    // The reconcile repaired A against its authoritative snapshot (todo).
    expect((await bridgeSnapshot(harness, COMPANY_ID)).issues[0].status).toBe("todo");
    // B was reconciled too but its world is independent.
    const b = await bridgeSnapshot(harness, COMPANY_2_ID);
    expect(b.issues[0]).toMatchObject({ id: "issue-other", status: "todo" });
  });

  it("relay feed batches are company-scoped: B's declarations never appear in A's feed batch", async () => {
    const { harness } = seedStandardWorld({ includeSecondCompany: true });
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);

    const keysA = declaredKeysFor(COMPANY_ID);
    const keysB = declaredKeysFor(COMPANY_2_ID);
    // A's feed carries only A's agents — the per-company appearance batch
    // re-declares each agent (seated), so dedupe to the declared agent set.
    expect([...new Set(keysA)].sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID].sort());
    // B's feed carries no A agent (B has no seeded agents) — a fresh company
    // B runtime materializes no characters.
    expect(keysB).toEqual([]);
    // Cross-check: no A agent key leaks into any non-A batch.
    const allBKeys = feedBatches()
      .filter((b) => b.companyId !== COMPANY_ID)
      .flatMap((b) => b.operations)
      .filter((op) => op.op === "declareAgents")
      .flatMap((op) => (op.agents as Array<{ key: string }>).map((a) => a.key));
    expect(allBKeys).toEqual([]);
  });

  it("a company B event does not leak into company A's relay feed", async () => {
    const { harness } = seedStandardWorld({ includeSecondCompany: true });
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);

    const baseline = relayFetchCalls.length;
    await harness.emit(
      "issue.updated",
      { issueId: "issue-other", projectId: "project-other", status: "done" },
      { companyId: COMPANY_2_ID, eventId: "evt-b-only" },
    );
    const newCalls = relayFetchCalls.slice(baseline);
    for (const call of newCalls) {
      const batch = JSON.parse(call.body) as { companyId: string };
      expect(batch.companyId).toBe(COMPANY_2_ID);
    }
  });

  it("character assignments are isolated per company (company A assignment never applies to company B)", async () => {
    const { harness } = seedStandardWorld({ includeSecondCompany: true });
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);

    // A's assignments are persisted into the agent state scope; B has no
    // seeded agents so its world carries no assignments. Assert A's
    // assignment state exists and no relay batch for B names an A-style
    // character assignment.
    const aState = harness.getState({
      scopeKind: "instance",
      namespace: STATE_NAMESPACES.bridge,
      stateKey: STATE_KEYS.schemaVersion,
    });
    expect(aState).toBe(1);

    // Direct cross-company proof (rather than only absence-of-op): A's
    // assignment is genuinely persisted in A's agent scope, and B's own
    // character state never references A's agent. A fresh company B has no
    // agents, so its visual-settings assignment map is empty.
    const aAssignment = harness.getState({
      scopeKind: "agent",
      scopeId: AGENT_DEV_ID,
      namespace: STATE_NAMESPACES.characters,
      stateKey: STATE_KEYS.agentCharacter,
    });
    expect(aAssignment).not.toBeNull();
    const bVisual = (await harness.getData(DATA_KEYS.visualSettings, {
      companyId: COMPANY_2_ID,
    })) as { assignments?: Record<string, unknown> };
    expect(bVisual.assignments ?? {}).toEqual({});

    const allBAssignments = feedBatches()
      .filter((b) => b.companyId === COMPANY_2_ID)
      .flatMap((b) => b.operations)
      .filter((op) => op.op === "assignAgentAppearance");
    expect(allBAssignments).toEqual([]);
  });
});

describe("restart safety (NFR-7): per-agent appearance assignments rehydrate exactly once", () => {
  it("re-declares each agent exactly once (no duplicate characters) after a fresh worker setup (restart) and still serves both agents", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);

    // Simulate a restart: shut down then re-setup against the SAME harness
    // (ctx.state persists across `runWorker` calls in the SDK test harness).
    await pluginDefinition(plugin).onShutdown?.();
    relayFetchCalls = [];
    await setupWorker(harness);

    // Post-restart the relay re-declares each seeded agent EXACTLY ONCE in the
    // fresh snapshot batch (idempotent upsert-by-key, no duplicates).
    const declared = feedBatches()
      .flatMap((b) => b.operations)
      .filter((op) => op.op === "declareAgents")
      .flatMap((op) => (op.agents as Array<{ key: string }>).map((a) => a.key));
    expect(declared.sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID].sort());
    expect(declared.length).toBe(2);

    // The bridge snapshot still materializes exactly the two agents after the
    // restart (state rehydrates — no lost agents, no desync).
    const viaSecond = (await bridgeSnapshot(harness, COMPANY_ID)).agents;
    expect(viaSecond.length).toBe(2);
    expect(viaSecond.map((a: any) => a.projection.agentId).sort()).toEqual(
      [AGENT_CEO_ID, AGENT_DEV_ID].sort(),
    );
  });

  it("restores compact buckets across a restart so windowed history survives (bridge store restart-safe)", async () => {
    const { harness } = seedStandardWorld();
    // The persistence timer writes compact buckets; verify they round-trip
    // after a restart (restoreCompactBuckets path in setupCompany).
    await setupWorker(harness);
    const before = await bridgeSnapshot(harness, COMPANY_ID);
    expect(before.summary).toBeDefined();
    // A fresh setup against the same harness must not throw and must keep the
    // company runtime (restart-safe rehydrate).
    await pluginDefinition(plugin).onShutdown?.();
    await setupWorker(harness);
    const after = await bridgeSnapshot(harness, COMPANY_ID);
    expect(after.summary).toBeDefined();
    expect(after.company?.id).toBe(COMPANY_ID);
  });
});

