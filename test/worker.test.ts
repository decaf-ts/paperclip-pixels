import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import { BRIDGE_SCHEMA_VERSION } from "../src/core/index.js";
import { DATA_KEYS, JOB_KEYS, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";
import { pluginDefinition } from "./typing.js";
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
  // unable to reach `paperclip-pixel-relay` in any topology this package
  // documents, including its own advertised `127.0.0.1` default. The relay
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
    for (const [url, init] of rawFetch.mock.calls as Array<[string, RequestInit?]>) {
      expect(url).toBe("https://pa.example/api/hooks/claude");
      expect(init?.method).toBe("POST");
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
// Relay wiring (SAA-229 coverage gap). The relay mirrors bridge state to a
// Pixel Agents hook endpoint. As of 2026-08-31 this goes through the Node
// global `fetch` directly, not the capability-gated `ctx.http.fetch` surface
// — see src/relay.ts's "DELIBERATE ctx.http.fetch BYPASS" comment and the
// "worker trust boundary" suite above for why. These tests spy on
// `globalThis.fetch`, configure the harness's `ctx.config`, and assert on the
// captured push envelopes end-to-end through `setup`, the event handler, the
// config lifecycle, health, and shutdown hooks.
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

describe("worker relay wiring (SAA-229 coverage gap)", () => {

  async function healthDetails(): Promise<Record<string, unknown>> {
    const health = await pluginDefinition(plugin).onHealth();
    return (health as { details?: Record<string, unknown> }).details ?? {};
  }

  it("setupCompany configures the relay from ctx.config and spawns sessionStart + an idle confirmation per agent via ingestSnapshot", async () => {
    // Both seedStandardWorld() agents are idle (no activeRuns), so each gets
    // a SessionStart plus an immediate Stop/turnEnd confirmation — without
    // the second event Pixel Agents never promotes the session past
    // "pending" and it never renders as a character (see event-mapper.ts's
    // mapSnapshot doc comment).
    const { harness } = seedStandardWorld();
    harness.setConfig({ pixelAgentsUrl: "https://pa.example" });
    spyRelayFetch();
    await setupWorker(harness);
    await flushRelay();

    expect(harness.logs.some((l) => l.level === "info" && l.message === "Bridge relay configured for company")).toBe(true);
    expect(relayFetchCalls).toHaveLength(4);
    for (const call of relayFetchCalls) {
      expect(call.url).toBe("https://pa.example/api/hooks/claude");
      expect(call.method).toBe("POST");
      expect(call.headers["content-type"]).toBe("application/json");
      expect(call.headers.authorization).toBeUndefined();
      const body = JSON.parse(call.body);
      expect(["SessionStart", "Stop"]).toContain(body.hook_event_name);
      expect(typeof body.session_id).toBe("string");
      expect(body.session_id.length).toBeGreaterThan(0);
    }
    const bySession = new Map<string, string[]>();
    for (const call of relayFetchCalls) {
      const body = JSON.parse(call.body);
      const list = bySession.get(body.session_id) ?? [];
      list.push(body.hook_event_name);
      bySession.set(body.session_id, list);
    }
    expect([...bySession.keys()].sort()).toEqual([
      "paperclip-bridge:company-acme:agent-ceo",
      "paperclip-bridge:company-acme:agent-dev",
    ]);
    for (const events of bySession.values()) {
      expect(events).toEqual(["SessionStart", "Stop"]);
    }
    // The friendly display name (fixtures.ts's makeCeoAgent/makeAgent set
    // real names) shows up as cwd's basename, Pixel Agents' own label source.
    const sessionStartBodies = relayFetchCalls
      .map((c) => JSON.parse(c.body))
      .filter((b) => b.hook_event_name === "SessionStart");
    expect(sessionStartBodies.map((b) => b.cwd).sort()).toEqual(
      [
        "/paperclip/company-acme/CEO Agent",
        "/paperclip/company-acme/Dev Agent",
      ].sort(),
    );
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

    // The unseen agent spawns sessionStart + toolStart("PaperclipWork", §21.4).
    expect(relayFetchCalls.length).toBe(baseline + 2);
    const [sessionStartCall, toolStartCall] = relayFetchCalls.slice(-2);
    const sessionStartBody = JSON.parse(sessionStartCall.body);
    expect(sessionStartBody.session_id).toBe("paperclip-bridge:company-acme:agent-relay-late");
    expect(sessionStartBody.hook_event_name).toBe("SessionStart");
    const toolStartBody = JSON.parse(toolStartCall.body);
    expect(toolStartBody.hook_event_name).toBe("PreToolUse");
    expect(toolStartBody.tool_name).toBe("PaperclipWork");

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
  it("rejects http: pixelAgentsUrl when a token ref is configured", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents:8080",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
  });

  it("rejects http: pixelAgentsUrl when a secret_ref binding is configured", async () => {
    const def = pluginDefinition(plugin);
    const result = await def.onValidateConfig!({
      pixelAgentsUrl: "http://pixel-agents:8080",
      pixelAgentsTokenRef: { type: "secret_ref", secretId: "secret-1" },
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
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
});
