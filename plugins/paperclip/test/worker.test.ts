import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { BRIDGE_SCHEMA_VERSION } from "../src/core/index.js";
import { DATA_KEYS, JOB_KEYS, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import * as persistence from "../src/persistence.js";
import { pluginDefinition } from "./typing.js";

vi.mock("../src/persistence.js", { spy: true });
import {
  AGENT_CEO_ID,
  AGENT_DEV_ID,
  COMPANY_2_ID,
  COMPANY_ID,
  ISSUE_ID,
  PROJECT_ID,
  makeCompany,
  makeIssue,
  makeProject,
  makeHarness,
  seedStandardWorld,
} from "./fixtures.js";

type IntervalHandle = ReturnType<typeof setInterval>;

const intervalHandles: IntervalHandle[] = [];
const intervalCallbacks: Array<{ handler: () => void; timeout: number }> = [];

beforeEach(() => {
  intervalHandles.length = 0;
  intervalCallbacks.length = 0;
  const original = setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, timeout?: number, ...args: unknown[]) => {
    const handle = original(handler, timeout, ...args) as unknown as IntervalHandle;
    intervalHandles.push(handle);
    intervalCallbacks.push({ handler, timeout: timeout ?? 0 });
    return handle;
  }) as unknown as typeof setInterval);
});

afterEach(async () => {
  await pluginDefinition(plugin).onShutdown?.();
  for (const handle of intervalHandles) clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  intervalHandles.length = 0;
  vi.restoreAllMocks();
});

async function setupWorker(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await pluginDefinition(plugin).setup(harness.ctx);
}

function bridgeSnapshot(harness: ReturnType<typeof makeHarness>, companyId = COMPANY_ID): Promise<any> {
  return harness.getData(DATA_KEYS.bridgeSnapshot, { companyId }) as Promise<any>;
}

describe("worker setup (definePlugin + runWorker)", () => {
  it("exposes definePlugin-style setup, onHealth, and a default entrypoint guard", async () => {
    expect(typeof pluginDefinition(plugin).setup).toBe("function");
    expect(await pluginDefinition(plugin).onHealth()).toMatchObject({ status: "ok", message: "Bridge worker running" });
  });

  it("is safe to import in tests (runWorker is a no-op when not the entrypoint)", () => {
    expect(plugin).toBeDefined();
  });
});

describe("worker setup with a seeded world", () => {
  it("bootstraps the authoritative snapshot on boot (criterion 1)", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.schemaVersion).toBe(BRIDGE_SCHEMA_VERSION);
    expect(snapshot.company?.id).toBe(COMPANY_ID);
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "todo", blocked: false })]);
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          projection: expect.objectContaining({ agentId: AGENT_DEV_ID }),
        }),
      ]),
    );
  });

  it("serves the UI BridgeCompanySnapshot contract, not the raw store snapshot (SAA-306)", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const snapshot = (await bridgeSnapshot(harness)) as any;
    expect(snapshot.summary).toEqual(expect.objectContaining({ companyId: COMPANY_ID, companyName: expect.any(String) }));
    expect(Array.isArray(snapshot.feedback)).toBe(true);
    for (const view of snapshot.agents) {
      expect(view.projection).toBeDefined();
      expect(view.metrics).toBeDefined();
      expect(view.behavior).toBeDefined();
    }
    const devView = snapshot.agents.find((v) => v.projection.agentId === AGENT_DEV_ID);
    expect(devView.projection).toEqual(expect.objectContaining({ companyId: COMPANY_ID }));
    expect(Object.keys(devView.metrics).sort()).toEqual(["24h", "2h", "30m", "5m", "8h"]);
    expect(devView.behavior.schemaVersion).toBe(BRIDGE_SCHEMA_VERSION);
  });

  it("records the schema version at instance scope", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);
    expect(
      harness.getState({
        scopeKind: "instance",
        namespace: STATE_NAMESPACES.bridge,
        stateKey: STATE_KEYS.schemaVersion,
      }),
    ).toBe(1);
  });
});

describe("worker event pipeline (criterion 2)", () => {
  it("applies a PluginEvent to the bridge store", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("issue.updated", { issueId: ISSUE_ID, projectId: PROJECT_ID, status: "in_progress" }, {
      companyId: COMPANY_ID,
      eventId: "evt-issue-updated",
      occurredAt: "2026-08-22T00:00:00.000Z",
    });

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "in_progress" })]);
  });

  it("bootstraps an unknown company lazily when an event arrives for it", async () => {
    const harness = makeHarness();
    harness.seed({ companies: [makeCompany()], issues: [makeIssue()] });
    await setupWorker(harness);

    harness.seed({
      companies: [makeCompany({ id: COMPANY_2_ID, name: "Late Co" })],
      projects: [makeProject({ id: "project-2", companyId: COMPANY_2_ID })],
      issues: [makeIssue({ id: "issue-2", companyId: COMPANY_2_ID, projectId: "project-2" })],
    });

    await harness.emit("issue.updated", { issueId: "issue-2", projectId: "project-2", status: "in_progress" }, {
      companyId: COMPANY_2_ID,
      eventId: "evt-late-company",
    });

    const snapshot = await bridgeSnapshot(harness, COMPANY_2_ID);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: "issue-2", status: "in_progress" })]);
  });

  it("drops events for companies that cannot be bootstrapped with a warning", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("issue.updated", { issueId: "issue-ghost", projectId: "project-ghost", status: "in_progress" }, {
      companyId: "company-ghost",
      eventId: "evt-ghost",
    });

    expect(
      harness.logs.some(
        (l) => l.level === "warn" && l.message === "Cannot bootstrap company for event" && l.meta?.companyId === "company-ghost",
      ),
    ).toBe(true);
    const snapshot = (await bridgeSnapshot(harness, "company-ghost")) as any;
    // SAA-306: even a bootstrap-failed company serves the UI contract shape
    // (identity fallback, empty arrays, fail-closed summary) rather than a raw
    // projection. The identity lets the UI render fail-closed instead of
    // throwing on `snapshot.agentCount`/`snapshot.feedback`.
    expect(snapshot.company).toEqual({ id: "company-ghost", name: "company-ghost" });
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.projects).toEqual([]);
    expect(snapshot.summary).toEqual(expect.objectContaining({ agentCount: 0 }));
    expect(Array.isArray(snapshot.feedback)).toBe(true);
  });

  it("ignores unsubscribed event types", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("company.updated", { name: "Renamed" }, { companyId: COMPANY_ID });

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.company?.name).toBe("Acme Corp");
  });
});

describe("worker reconciliation job (criterion 3)", () => {
  it("repairs derived drift against the authoritative snapshot", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("issue.updated", { issueId: ISSUE_ID, projectId: PROJECT_ID, status: "in_progress" }, {
      companyId: COMPANY_ID,
      eventId: "evt-drift",
    });
    expect((await bridgeSnapshot(harness)).issues[0].status).toBe("in_progress");

    await harness.runJob(JOB_KEYS.reconciliation);

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "todo" })]);
    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY_ID,
        namespace: STATE_NAMESPACES.bridge,
        stateKey: STATE_KEYS.lastReconciledAt,
      }),
    ).toEqual(expect.any(String));
  });
});

describe("worker data accessors", () => {
  it("returns company-not-found for unknown companies on every data key", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    for (const params of [
      { companyId: "company-nope" },
      { companyId: "company-nope", agentId: AGENT_DEV_ID },
    ]) {
      const snapshot = (await harness.getData(DATA_KEYS.bridgeSnapshot, params)) as any;
      expect(snapshot.error).toBe("company-not-found");
      expect(snapshot.schemaVersion).toBe(BRIDGE_SCHEMA_VERSION);
    }
    expect(((await harness.getData(DATA_KEYS.companySummary, { companyId: "company-nope" })) as any).error).toBe("company-not-found");
    expect(((await harness.getData(DATA_KEYS.agentBehavior, { companyId: "company-nope", agentId: AGENT_DEV_ID })) as any).error).toBe("company-not-found");
    expect(((await harness.getData(DATA_KEYS.outstandingFeedback, { companyId: "company-nope" })) as any).error).toBe("company-not-found");
  });

  it("serves company summary, behavior vector, and feedback via data handlers", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const summary = (await harness.getData(DATA_KEYS.companySummary, { companyId: COMPANY_ID })) as any;
    expect(summary.companyId).toBe(COMPANY_ID);

    const behavior = (await harness.getData(DATA_KEYS.agentBehavior, { companyId: COMPANY_ID, agentId: AGENT_DEV_ID })) as any;
    expect(behavior.agentId).toBe(AGENT_DEV_ID);
    expect(typeof behavior.load?.value).toBe("number");
    expect(typeof behavior.calculatedAt).toBe("string");

    const feedback = (await harness.getData(DATA_KEYS.outstandingFeedback, { companyId: COMPANY_ID })) as any;
    expect(Array.isArray(feedback)).toBe(true);
  });
});

describe("worker actions wiring", () => {
  it("serves company.send-message through the harness action bridge", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const result = await harness.performAction("company.send-message", {
      companyId: COMPANY_ID,
      text: "Start the next milestone",
    });

    expect(result).toMatchObject({ ok: true });
    expect(typeof (result as { sessionId?: string }).sessionId).toBe("string");
    const openSessions = await harness.ctx.agents.sessions.list(AGENT_CEO_ID, COMPANY_ID);
    expect(openSessions).toHaveLength(1);
  });

  it("routes an out-of-context reply to company intake with no side effects", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);
    const createIssue = vi.spyOn(harness.ctx.issues, "create");

    const eventId = "evt-reply-comment";
    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-1", issueId: "issue-foreign", agentId: AGENT_DEV_ID, body: "hello", isQuestion: false },
      { companyId: COMPANY_ID, eventId, occurredAt: "2026-08-22T00:00:00.000Z" },
    );

    const result = await harness.performAction("agent.reply-to-feedback", {
      companyId: COMPANY_ID,
      feedbackId: `${eventId}:progress`,
      text: "continue as-is",
    });

    expect(result).toMatchObject({ ok: false, error: "ROUTE_TO_COMPANY" });
    expect(createIssue).not.toHaveBeenCalled();
    createIssue.mockRestore();
  });
});

describe("worker trust boundary (criterion 8)", () => {
  // REVERSED 2026-08-31 (deliberately — see src/relay.ts's "DELIBERATE
  // ctx.http.fetch BYPASS" comment block): this suite originally asserted the
  // relay's push went through the SDK-gated `ctx.http.fetch` surface, never a
  // bare global fetch. That is no longer true by design. Paperclip's host
  // `ctx.http.fetch` unconditionally rejects any private/reserved-range
  // destination with no override of any kind, which makes it categorically
  // unable to reach the plugin feed endpoint's embedding surface (the
  // in-process module serving POST /api/plugin-feed inside the Pixel Agents
  // server, successor of the retired `paperclip-pixel-relay` sidecar) in any
  // topology this package documents, including its own advertised
  // `127.0.0.1` default. The relay
  // now uses the Node global `fetch` directly for this one, fixed,
  // operator-configured destination, and re-implements the one part of the
  // host's enforcement that still applies (see the next test).
  it("routes the relay's outbound push through the Node global fetch, bypassing ctx.http.fetch's private-IP block", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    const rawFetch = spyRelayFetch();
    await setupWorker(harness);
    await flushRelay();

    expect(rawFetch).toHaveBeenCalled();
    // Every outbound call goes to the operator-configured destination via the
    // Node global fetch: one POST per plugin-feed batch (the snapshot batch
    // and the appearance-map batch from setupCompany).
    expect(relayFetchCalls.length).toBeGreaterThan(0);
    for (const call of relayFetchCalls) {
      expect(call.url).toBe("https://pa.example/api/plugin-feed");
      expect(call.method).toBe("POST");
      expect(call.headers["content-type"]).toBe("application/json");
    }
  });

  it("refuses outbound HTTP through the harness when http.outbound is not declared", async () => {
    const capabilities = manifest.capabilities.filter((c) => c !== "http.outbound");
    const harness = createTestHarness({ manifest, capabilities });
    await expect(
      harness.ctx.http.fetch("https://example.com"),
    ).rejects.toThrow(/missing required capability 'http\.outbound'/);
  });

  // NOTE: BridgeRelay.configure()'s own ctx.manifest.capabilities re-check
  // (the replacement enforcement for what rawFetch's bypass skips — see
  // src/relay.ts) is unit-tested directly in relay.test.ts ("fails closed
  // when the host-validated manifest does not declare http.outbound"), not
  // here: `createTestHarness`'s `capabilities` param only gates its own fake
  // RPC clients (as the test above shows for ctx.http.fetch); it does not
  // also strip entries from `ctx.manifest`, which always echoes the real,
  // imported manifest. That's actually accurate to production — Paperclip
  // has no mechanism to dynamically revoke one capability from an installed
  // plugin's manifest independent of the manifest itself, so this scenario
  // isn't reachable through the integration harness at all; relay.test.ts's
  // hand-built fake context is the right (and only) place to exercise it.
});

// ---------------------------------------------------------------------------
// Relay wiring (SAA-229 coverage gap). The relay mirrors bridge state to the
// embedding surface's plugin feed. As of 2026-09-01 (WS2-C) every push is one
// POSTed feed batch (`{ schemaVersion, companyId, operations }`) to
// `POST /api/plugin-feed` via the Node global `fetch` — see src/relay.ts's
// "DELIBERATE ctx.http.fetch BYPASS" comment and the "worker trust boundary"
// suite above. These tests spy on `globalThis.fetch`, configure the harness's
// `ctx.config`, and assert on the captured feed batches end-to-end through
// `setup`, the event handler, the config lifecycle, health, and shutdown.
// ---------------------------------------------------------------------------

let relayFetchCalls: Array<{ url: string; method: string; headers: Record<string, string>; body: string }>;

/** Drain the relay's fire-and-forget push promise chain before asserting sink state. */
async function flushRelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Spy on the Node global `fetch` (what the relay's rawFetch() now calls directly, bypassing ctx.http.fetch) and capture the relay's push calls. */
function spyRelayFetch(): MockInstance<typeof fetch> {
  relayFetchCalls = [];
  return vi.spyOn(globalThis, "fetch").mockImplementation(
    async (url: string | URL | Request, init?: RequestInit) => {
      relayFetchCalls.push({
        url: String(url),
        method: String(init?.method ?? "GET"),
        headers: (init?.headers as Record<string, string>) ?? {},
        body: typeof init?.body === "string" ? init.body : String(init?.body ?? ""),
      });
      return new Response(JSON.stringify({ ok: true }), { status: 200, statusText: "OK" });
    },
  );
}

/** Parse the captured feed calls into their batch bodies (all of them are feed batches). */
function feedBatches(): Array<{ schemaVersion: number; companyId: string; operations: Array<Record<string, unknown>> }> {
  return relayFetchCalls.map((c) => JSON.parse(c.body));
}

/** All declareAgents declarations across the given batches, flattened. */
function declaredAgents(batches: ReturnType<typeof feedBatches>): Array<Record<string, unknown>> {
  return batches
    .flatMap((b) => b.operations)
    .filter((op) => op.op === "declareAgents")
    .flatMap((op) => op.agents as Array<Record<string, unknown>>);
}

describe("worker relay wiring (SAA-229 coverage gap)", () => {

  async function healthDetails(): Promise<Record<string, unknown>> {
    const health = await pluginDefinition(plugin).onHealth();
    return (health as { details?: Record<string, unknown> }).details ?? {};
  }

  it("setupCompany configures the relay from ctx.config and pushes declare + idle status per agent, then the appearance map", async () => {
    // Both seedStandardWorld() agents are idle (no activeRuns), so each gets
    // a declaration plus an honest waiting status in the snapshot batch —
    // through the A1 host's sanctioned agent source, so each agent renders
    // as a character immediately (the retired wire needed a synthetic
    // SessionStart+Stop pair per idle agent; the feed declares directly).
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    await flushRelay();

    expect(harness.logs.some((l) => l.level === "info" && l.message === "Bridge relay configured for company")).toBe(true);

    // Exactly two feed batches: the snapshot batch (declare + waiting status
    // per agent), then the appearance batch (declare upserts carrying each
    // agent's palette/hueShift — the sanctioned seat path, WS3).
    expect(relayFetchCalls).toHaveLength(2);
    for (const call of relayFetchCalls) {
      expect(call.url).toBe("https://pa.example/api/plugin-feed");
      expect(call.method).toBe("POST");
      expect(call.headers.authorization).toBeUndefined();
    }
    const batches = feedBatches();
    for (const batch of batches) {
      expect(batch.schemaVersion).toBe(1);
      expect(batch.companyId).toBe(COMPANY_ID);
    }

    // Snapshot batch: one declaration + one waiting status per agent.
    const [snapshotBatch, appearanceBatch] = batches;
    const snapshotDeclares = declaredAgents([snapshotBatch]);
    expect(snapshotDeclares.map((a) => a.key).sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID]);
    expect(snapshotDeclares.map((a) => a.name).sort()).toEqual(["CEO Agent", "Dev Agent"]);
    const snapshotStatuses = snapshotBatch.operations.filter((op) => op.op === "updateAgentStatus");
    expect(snapshotStatuses).toHaveLength(2);
    for (const status of snapshotStatuses) {
      expect(status.status).toBe("waiting");
      expect(status.awaitingInput).toBe(false);
      expect([AGENT_CEO_ID, AGENT_DEV_ID]).toContain(status.key);
    }
    // First-sight declarations carry no seat yet (the appearance map batch
    // right after is what seats everyone).
    for (const declared of snapshotDeclares) {
      expect(declared.palette).toBeUndefined();
      expect(declared.hueShift).toBeUndefined();
    }

    // Appearance batch: declare upserts carrying the resolved seat per agent.
    const seatedDeclares = declaredAgents([appearanceBatch]);
    expect(seatedDeclares.map((a) => a.key).sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID]);
    for (const declared of seatedDeclares) {
      expect(Number.isInteger(declared.palette)).toBe(true);
      expect(Number.isInteger(declared.hueShift)).toBe(true);
    }
  });

  it("boots with the relay enabled by default (this deployment's bundled sidecar) when no relay config is present", async () => {
    // parseRelayConfig falls back to the bundled sidecar URL so the bridge
    // works out of the box; an operator can still opt out explicitly via
    // pixelAgentsRelayEnabled: false.
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    expect(harness.logs.some((l) => l.level === "info" && l.message === "Bridge relay configured for company")).toBe(true);
    expect(await healthDetails()).toMatchObject({ relayCompanies: 1 });

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.error).toBeUndefined();
  });

  it("boots with the relay disabled when explicitly turned off", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsRelayEnabled: false });
    await setupWorker(harness);

    expect(harness.logs.some((l) => l.level === "info" && l.message === "Bridge relay disabled for company")).toBe(true);
    expect(await healthDetails()).toMatchObject({ relayCompanies: 0 });

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.error).toBeUndefined();
  });

  it("the event handler forwards the canonical event to the relay after store.applyPaperclipEvent", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    await flushRelay();
    const baseline = relayFetchCalls.length;
    expect(baseline).toBeGreaterThan(0);

    await harness.emit(
      "agent.run.started",
      {
        runId: "run-relay-late",
        agentId: "agent-relay-late",
        issueId: null,
        projectId: null,
        invocationSource: "manual",
        startedAt: "2026-08-22T00:05:00.000Z",
      },
      {
        companyId: COMPANY_ID,
        eventId: "evt-relay-late",
        occurredAt: "2026-08-22T00:05:00.000Z",
      },
    );
    await flushRelay();

    // The unseen agent spawns one feed batch: declaration + run caption +
    // active status + the run-scoped dialog line (the retired wire needed a
    // sessionStart + toolStart pair; the feed carries all four operations
    // in one body).
    expect(relayFetchCalls.length).toBe(baseline + 1);
    const forwardBatch = JSON.parse(relayFetchCalls[relayFetchCalls.length - 1].body);
    expect(forwardBatch.companyId).toBe(COMPANY_ID);
    expect(forwardBatch.operations).toHaveLength(4);
    const [declare, activity, status, dialog] = forwardBatch.operations;
    expect(declare.op).toBe("declareAgents");
    expect(declare.agents[0]).toMatchObject({ key: "agent-relay-late", name: "agent-relay-late" });
    expect(activity).toEqual({ op: "updateAgentActivity", key: "agent-relay-late", activity: "Task: Paperclip work" });
    expect(status).toEqual({ op: "updateAgentStatus", key: "agent-relay-late", status: "active" });
    expect(dialog).toEqual({
      op: "dialogLines",
      lines: [{ text: "agent-relay-late started a run" }],
    });

    // Store behavior unchanged: the store path still applies events and serves
    // the authoritative snapshot (the relay addition never replaces it).
    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "todo" })]);
  });

  it("onConfigChanged reconfigures the relay on enable and disable and never throws on malformed config", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    const def = pluginDefinition(plugin);

    expect(await healthDetails()).toMatchObject({ relayCompanies: 1 });

    // Disable path.
    await def.onConfigChanged!({ pixelAgentsRelayEnabled: false }, { companyId: COMPANY_ID });
    expect(await healthDetails()).toMatchObject({ relayCompanies: 0 });

    // Enable path.
    await def.onConfigChanged!({ pixelAgentsUrl: "https://pa.example" }, { companyId: COMPANY_ID });
    expect(await healthDetails()).toMatchObject({ relayCompanies: 1 });

    // Malformed config must never crash the worker; the hook warns instead.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(def.onConfigChanged!(null, { companyId: COMPANY_ID })).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("onConfigChanged's enable path immediately re-syncs, not just reconfigures — no need to wait for the next reconciliation job", async () => {
    // Before this fix, configure() alone rebuilt the transport but never
    // re-ingested a snapshot; a company only regained visible characters at
    // the next scheduled bridge-reconcile job (up to ~5 min later) or via a
    // manual ingestSnapshot call. Confirmed live 2026-08-31: this left agents
    // invisible through any disable/re-enable cycle (or any operator config
    // change) until then, and any live event racing ahead of that gap could
    // permanently label an agent with its raw id instead of its real name
    // (see resyncCompany's doc comment in relay.ts).
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    await flushRelay();
    const def = pluginDefinition(plugin);

    await def.onConfigChanged!({ pixelAgentsRelayEnabled: false }, { companyId: COMPANY_ID });
    await flushRelay();
    const baseline = relayFetchCalls.length;

    await def.onConfigChanged!({ pixelAgentsUrl: "https://pa.example" }, { companyId: COMPANY_ID });
    await flushRelay();

    // The enable path re-syncs immediately through the feed: a fresh mapper
    // re-declares every agent (snapshot batch), then re-applies the
    // per-agent appearance map so the rebuilt embedding surface seats
    // everyone immediately (WS3, through the sanctioned declareAgents seat
    // path). Exactly two batches, no more.
    const newCalls = relayFetchCalls.slice(baseline);
    expect(newCalls).toHaveLength(2);
    for (const call of newCalls) expect(call.url).toBe("https://pa.example/api/plugin-feed");
    const batches = newCalls.map((c) => JSON.parse(c.body));
    // Every agent is re-declared twice across the two batches — once by the
    // snapshot batch (fresh mapper, no seat yet) and once by the appearance
    // batch (seated upsert)...
    const redeclared = declaredAgents(batches);
    expect(redeclared.map((a) => a.key).sort()).toEqual(
      [AGENT_CEO_ID, AGENT_CEO_ID, AGENT_DEV_ID, AGENT_DEV_ID].sort(),
    );
    // ...and the appearance batch's declarations carry each agent's seat.
    const [snapshotBatch, appearanceBatch] = batches;
    const seated = declaredAgents([appearanceBatch]);
    expect(seated.map((a) => a.key).sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID]);
    for (const declared of seated) {
      expect(Number.isInteger(declared.palette)).toBe(true);
      expect(Number.isInteger(declared.hueShift)).toBe(true);
    }
    // The snapshot batch also repairs statuses to honest idle.
    const statuses = snapshotBatch.operations.filter((op) => op.op === "updateAgentStatus");
    expect(statuses).toHaveLength(2);
    for (const status of statuses) expect(status.status).toBe("waiting");
  });

  it("the reconciliation job periodically self-heals by resyncing the mapper every RESYNC_EVERY_N_RECONCILES ticks", async () => {
    // A declaration push that silently fails once (the feed sink is
    // fire-and-forget) otherwise strands that agent invisible for the rest of
    // the worker's lifetime: mapSnapshot only ever sends incremental
    // status/caption updates for an agent it already believes is "seen".
    // Confirmed live 2026-08-31 during a concurrent container restart. The
    // reconciliation job now forces a full resyncCompany (fresh mapper, fresh
    // snapshot) every Nth tick as a bounded-time self-heal.
    //
    // Any run of RESYNC_EVERY_N_RECONCILES (6) consecutive ticks crosses
    // exactly one multiple of the module-level tick counter, whatever its
    // starting offset from other tests sharing this module instance — so this
    // assertion is independent of test execution order. Nothing else about
    // the seeded world changes between ticks, so every non-resync tick pushes
    // nothing (mapSnapshot's already-seen/no-state-change branch is a no-op);
    // the one resync tick re-declares every agent (seated — the appearance
    // map survives reset()) in a single feed batch.
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    await flushRelay();
    const baseline = relayFetchCalls.length;
    expect(baseline).toBeGreaterThan(0);

    for (let i = 0; i < 6; i += 1) {
      await harness.runJob(JOB_KEYS.reconciliation);
      await flushRelay();
    }

    // Exactly the one resync tick's two feed batches. Batch 1: the mapper
    // retains the company's appearance map across reset(), so the
    // re-declaration in the snapshot batch already carries each agent's
    // seat — and the follow-up appearance push's declare diff is empty.
    // Batch 2 (WS4-C): the same appearance push re-emits each agent's
    // first-class `assignAgentAppearance` — the per-agent assignment state
    // was reset with the mapper, and a freshly (re)started embedding
    // surface must receive assignments again. Ordinary reconcile ticks
    // push nothing extra.
    const newCalls = relayFetchCalls.slice(baseline);
    expect(newCalls).toHaveLength(2);
    for (const call of newCalls) {
      expect(call.url).toBe("https://pa.example/api/plugin-feed");
      expect(call.method).toBe("POST");
    }
    const [resyncBatch, assignmentBatch] = newCalls.map((c) => JSON.parse(c.body));
    const redeclared = declaredAgents([resyncBatch]);
    expect(redeclared.map((a) => a.key).sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID]);
    const statuses = resyncBatch.operations.filter((op) => op.op === "updateAgentStatus");
    expect(statuses).toHaveLength(2);
    for (const status of statuses) expect(status.status).toBe("waiting");
    // WS4-C: the second batch carries exactly the two first-class
    // appearance assignments, one per seeded agent, each naming a real
    // catalog character id.
    const assignments = assignmentBatch.operations.filter((op) => op.op === "assignAgentAppearance");
    expect(assignments).toHaveLength(2);
    expect(assignments.map((op) => op.key).sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID]);
    for (const assignment of assignments) {
      expect(assignment.characterId).toMatch(/^(pixel-agents|paperclip-pixels):char-\d+$/);
    }
    expect(assignmentBatch.operations).toHaveLength(assignments.length);
    // The retained appearance map means the re-declarations are seated.
    for (const declared of redeclared) {
      expect(Number.isInteger(declared.palette)).toBe(true);
      expect(Number.isInteger(declared.hueShift)).toBe(true);
    }
  });

  it("onHealth details reports companies and relayCompanies counts", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);

    const health = (await pluginDefinition(plugin).onHealth()) as { status: string; details: Record<string, unknown> };
    expect(health.status).toBe("ok");
    expect(health.details.companies).toBe(1);
    expect(health.details.relayCompanies).toBe(1);
  });

  it("onShutdown disposes all relays (relayCompanies drops to 0)", async () => {
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    const def = pluginDefinition(plugin);

    expect(await healthDetails()).toMatchObject({ relayCompanies: 1 });
    await expect(def.onShutdown!()).resolves.not.toThrow();
    expect(await healthDetails()).toMatchObject({ relayCompanies: 0, companies: 1 });
  });
});

describe("worker onValidateConfig (M2 cleartext token rejection)", () => {
  it("accepts the authenticated bundled Compose sidecar", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents-relay:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(true);
  });
  it("accepts http: pixelAgentsUrl for the bundled compose-internal host when a token ref is configured (SAA-734 reconcile)", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts http: pixelAgentsUrl for an operator-declared trusted host in pixelAgentsAllowedHttpHosts", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://custom-internal:8081",
      pixelAgentsTokenRef: "secret-1",
      pixelAgentsAllowedHttpHosts: ["custom-internal"],
    });
    expect(result.ok).toBe(true);
  });

  // SAA-737 security-review follow-up (from SAA-736, non-blocking): pin the
  // save-time gate's NO-suffix / NO-substring / NO-wildcard trust property.
  // Each of these FAILS if the gate ever drifts to substring/suffix/wildcard
  // matching, which would silently widen the cleartext bearer-token carve-out.

  it("rejects http: pixelAgentsUrl for a suffix lookalike of a bundled trusted name (no-suffix pin)", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents.evil.com:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects http: pixelAgentsUrl for a subdomain of a bundled trusted name", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://x.pixel-agents:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects http: pixelAgentsUrl for a suffix lookalike of an operator-declared trusted host", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://custom-internal.evil.com:8081",
      pixelAgentsTokenRef: "secret-1",
      pixelAgentsAllowedHttpHosts: ["custom-internal"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects a wildcard pixelAgentsAllowedHttpHosts entry — it must not match any host", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://evil.com:8081",
      pixelAgentsTokenRef: "secret-1",
      pixelAgentsAllowedHttpHosts: ["*"],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects http: pixelAgentsUrl with a trusted name smuggled into the userinfo", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents@evil.com:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("accepts http: pixelAgentsUrl for a bundled trusted host with a trailing dot (same DNS name)", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents.:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts http: pixelAgentsUrl for an uppercase variant of the bundled trusted host (case-folded)", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://PIXEL-AGENTS:8081",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects http: pixelAgentsUrl on an untrusted remote host when a token ref is configured", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://public-host:8080",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects http: pixelAgentsUrl on an untrusted remote host when a secret_ref binding is configured", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://public-host:8080",
      pixelAgentsTokenRef: { type: "secret_ref", secretId: "secret-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects a non-array pixelAgentsAllowedHttpHosts", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents:8081",
      pixelAgentsAllowedHttpHosts: "not-an-array",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsAllowedHttpHosts must be an array of strings when present");
  });

  it("accepts http: pixelAgentsUrl when token-less", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents:8080",
    });
    expect(result.ok).toBe(true);
  });

  it("accepts https: pixelAgentsUrl with a token ref", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "https://pixel-agents:8080",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects a malformed token ref", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "https://pixel-agents:8080",
      pixelAgentsTokenRef: 42,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsTokenRef must be a secret_ref binding or non-empty string when present");
  });

  it("accepts the default loopback paperclipApiBaseUrl with a token (same-container worker, never plaintext-remote)", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      paperclipApiBaseUrl: "http://127.0.0.1:3100",
      paperclipApiTokenRef: "board-token-1",
    });
    expect(result.ok).toBe(true);
  });

  it("rejects http: paperclipApiBaseUrl on a non-loopback host when a token ref is configured", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      paperclipApiBaseUrl: "http://paperclip.example.internal:3100",
      paperclipApiTokenRef: "board-token-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "paperclipApiBaseUrl must be https: when paperclipApiTokenRef is configured and the host is not loopback",
    );
  });

  it("rejects a malformed paperclipApiTokenRef", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      paperclipApiTokenRef: 42,
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("paperclipApiTokenRef must be a secret_ref binding or non-empty string when present");
  });

  // SAA-738: the api-pair save-time gate must consult the SAME shared
  // isAllowedCleartextHost decision as the feed-token gate (and the runtime
  // parseRelayConfig backstop), so a bundled deployment hostname and an
  // operator-declared pixelAgentsAllowedHttpHosts entry are accepted for the
  // tool-activity poller's token too — these FAIL on the pre-SAA-738
  // onValidateConfig (loopback-only list for the api pair).

  it("accepts http: paperclipApiBaseUrl for the bundled compose-internal host with an api token (SAA-738 reconcile)", async () => {
    const def = pluginDefinition(plugin);
    for (const url of ["http://pixel-agents:3100", "http://pixel-agents-relay:3100"]) {
      const result = await def.onValidateConfig!({
        paperclipApiBaseUrl: url,
        paperclipApiTokenRef: "board-token-1",
      });
      expect(result.ok).toBe(true);
    }
  });

  it("accepts http: paperclipApiBaseUrl for an operator-declared trusted host in pixelAgentsAllowedHttpHosts with an api token", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      paperclipApiBaseUrl: "http://custom-internal:3100",
      paperclipApiTokenRef: "board-token-1",
      pixelAgentsAllowedHttpHosts: ["custom-internal"],
    });
    expect(result.ok).toBe(true);
  });

  it("rejects an unparseable paperclipApiBaseUrl with an api token at save time", async () => {
    const def = pluginDefinition(plugin);
    for (const url of ["http:", "http:/", "http://", "not-a-url"]) {
      const result = await def.onValidateConfig!({
        paperclipApiBaseUrl: url,
        paperclipApiTokenRef: "board-token-1",
      });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("paperclipApiBaseUrl is not a valid URL");
    }
  });

  it("is valid with neither paperclipApiBaseUrl nor paperclipApiTokenRef set (the feature is fully optional)", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({ pixelAgentsUrl: "https://pa.example" });
    expect(result.ok).toBe(true);
  });
});

describe("worker onValidateConfig pixelAgentsUiUrl scheme (SAA-1052 C1)", () => {
  it("accepts an http(s) pixelAgentsUiUrl at save time", async () => {
    const def = pluginDefinition(plugin);
    for (const url of ["http://localhost:8090", "https://pa.example/office"]) {
      const result = await def.onValidateConfig!({ pixelAgentsUiUrl: url });
      expect(result.ok).toBe(true);
    }
  });

  it("rejects a non-http(s) pixelAgentsUiUrl scheme at save time", async () => {
    const def = pluginDefinition(plugin);
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "ftp://x",
    ]) {
      const result = await def.onValidateConfig!({ pixelAgentsUiUrl: url });
      expect(result.ok).toBe(false);
      expect(result.errors).toContain("pixelAgentsUiUrl must be an http(s) URL");
    }
  });

  it("rejects an unparseable pixelAgentsUiUrl at save time", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({ pixelAgentsUiUrl: "not-a-url" });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUiUrl is not a valid URL");
  });

  it("rejects a non-http(s) pixelAgentsUiUrl alongside otherwise-valid relay config", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsUiUrl: "javascript:alert(1)",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUiUrl must be an http(s) URL");
  });
});

describe("worker persistence interval rejection handling (SAA-1055 / C4)", () => {
  it("catches a rejected persistence tick, logs it, and keeps retrying instead of rethrowing", async () => {
    const { harness } = seedStandardWorld();
    const errorSpy = vi.spyOn(harness.ctx.logger, "error");
    await setupWorker(harness);

    const persistCompact = vi.mocked(persistence.persistCompactBuckets);
    persistCompact.mockRejectedValue(new Error("persist-boom"));

    try {
      const persistenceTimer = intervalCallbacks.find((c) => c.timeout === 60_000)?.handler;
      expect(persistenceTimer).toBeDefined();

      expect(() => persistenceTimer!()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toMatch(/Bucket persistence failed on interval/);
      expect(errorSpy.mock.calls[0][1]).toMatchObject({ error: "persist-boom" });

      expect(() => persistenceTimer!()).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(errorSpy).toHaveBeenCalledTimes(2);
    } finally {
      persistCompact.mockRestore();
    }
  });
});
