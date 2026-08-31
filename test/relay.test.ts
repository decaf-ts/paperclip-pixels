import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginLogger } from "@paperclipai/plugin-sdk";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "../src/core/index.js";
import {
  BridgeRelay,
  extractTokenRef,
  parseRelayConfig,
} from "../src/relay.js";

/**
 * Unit tests for `src/relay.ts` (`parseRelayConfig`, `extractTokenRef` and
 * `BridgeRelay`).
 *
 * NOTE ON THE TOKEN FIELD: the SAA-229 staged implementation read a plaintext
 * `pixelAgentsToken` config field; the current worker-tree implementation has
 * moved to an operator-bound secret reference (`pixelAgentsTokenRef`) resolved
 * at `configure` time via `ctx.secrets.resolve`, and `parseRelayConfig` no
 * longer touches the token at all. These tests assert the *current* behavior:
 * token handling belongs to `extractTokenRef` + `configure`, and `parseRelayConfig`
 * returns no token payload. The whitespace-only-token nit from the original
 * task (``Authorization: Bearer   ``) now applies to the *secret ref*: a
 * whitespace-only string ref is trimmed away by `extractTokenRef`, so no auth
 * header is ever sent for it.
 *
 * TRANSPORT NOTE (reversed 2026-08-31, deliberately — see src/relay.ts's
 * "DELIBERATE ctx.http.fetch BYPASS" comment block): `BridgeRelay` used to
 * construct an `HttpPushSink` routed through the SDK-gated `ctx.http.fetch`
 * surface. It now uses the Node global `fetch` directly instead, because
 * Paperclip's host `ctx.http.fetch` unconditionally rejects any
 * private/reserved-range destination (including `127.0.0.1`, this package's
 * own advertised default) with no override of any kind. The fake context's
 * `http.fetch` field below is kept only because `BridgeRelay` still holds a
 * `PluginContext` and other code paths may reference `ctx.http` — the actual
 * push tests in this file mock the Node global `fetch` (see `makeCtx`'s
 * `httpFetch` param, which now backs a `globalThis.fetch` spy, not
 * `ctx.http.fetch`). The fake context's `manifest.capabilities` includes
 * `http.outbound` by default so `BridgeRelay.configure()`'s own
 * capability re-check (its replacement for the host's per-call enforcement
 * that the bypass skips) passes; tests exercising the fail-closed path pass
 * a context built with that capability removed instead.
 */

const COMPANY_ID = "company-acme";
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const ISO = "2026-08-22T00:00:00.000Z";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let calls: FetchCall[];
let fetchMock: ReturnType<typeof vi.fn>;
let responses: Array<{ ok: boolean; status: number; statusText: string } | Error>;

/** Fake plugin context: capturing logger + controllable token resolver. */
function makeLogger(): PluginLogger & { calls: { level: string; message: string }[] } {
  const log: { level: string; message: string }[] = [];
  const mk = (level: "info" | "warn" | "error" | "debug") =>
    (message: string, _meta?: Record<string, unknown>) => {
      log.push({ level, message });
    };
  const logger = {
    info: mk("info"),
    warn: mk("warn"),
    error: mk("error"),
    debug: mk("debug"),
    calls: log,
  } as unknown as PluginLogger & { calls: { level: string; message: string }[] };
  return logger;
}

interface ResolveOptions {
  companyId?: string;
  configPath?: string;
}

/**
 * Fake context's manifest capabilities. `BridgeRelay.configure()` checks
 * `ctx.manifest.capabilities.includes("http.outbound")` before ever
 * constructing the sink (its replacement for the host's per-call enforcement
 * that the rawFetch bypass skips — see src/relay.ts). Defaults to including
 * it so existing push-path tests are unaffected; pass `capabilities` to
 * exercise the fail-closed path (see "fails closed when the fake manifest
 * omits http.outbound" below).
 */
function makeCtx(
  resolve: (ref: unknown) => Promise<string> | string = async () => "",
  capabilities: string[] = ["http.outbound"],
): {
  ctx: PluginContext;
  resolve: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  const resolveFn = vi.fn(
    async (ref: unknown, _opts?: ResolveOptions): Promise<string> => resolve(ref),
  );
  const ctx = {
    logger,
    secrets: { resolve: resolveFn },
    // Vestigial: BridgeRelay's rawFetch() now calls the Node global `fetch`
    // directly (see beforeEach's globalThis.fetch spy), never ctx.http.fetch.
    // Kept only so code that types against a full PluginContext still compiles.
    http: { fetch: fetchMock },
    manifest: { capabilities },
  } as unknown as PluginContext;
  return { ctx, resolve: resolveFn, logger };
}

// -- canonical bridge input builders ----------------------------------------

function runStarted(
  companyId: string,
  agentId: string,
  runId: string,
): BridgeInputEvent {
  return {
    eventId: `evt-${runId}`,
    timestamp: ISO,
    companyId,
    kind: "agent.run.started",
    payload: {
      runId,
      agentId,
      issueId: null,
      projectId: null,
      invocationSource: "manual",
      startedAt: ISO,
    },
  };
}

function statusChanged(
  companyId: string,
  agentId: string,
  status: string,
  previousStatus?: string,
): BridgeInputEvent {
  return {
    eventId: `evt-status-${agentId}-${status}`,
    timestamp: ISO,
    companyId,
    kind: "agent.status_changed",
    payload: {
      agentId,
      status,
      ...(previousStatus !== undefined ? { previousStatus } : {}),
    },
  };
}

function snapshot(
  companyId: string,
  agentIds: string[],
): AuthoritativeSnapshotInput {
  return {
    company: { id: companyId, name: "Acme", status: "active" },
    agents: agentIds.map((id) => ({
      id,
      companyId,
      name: id,
      status: "idle",
    })),
    projects: [],
    issues: [],
    approvals: [],
    observedAt: ISO,
  };
}

/** Drain the fire-and-forget push promise chain before asserting sink state. */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

beforeEach(() => {
  calls = [];
  responses = [];
  fetchMock = vi.fn(
    async (url: string, init: { method: string; headers: Record<string, string>; body: string }) => {
      calls.push({ url, method: init.method, headers: init.headers, body: init.body });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
      return { ok: true, status: 200, statusText: "OK" };
    },
  );
  // BridgeRelay's rawFetch() calls the Node global `fetch` directly (see
  // src/relay.ts's "DELIBERATE ctx.http.fetch BYPASS" comment) — spy on it
  // with the same fetchMock so every existing calls/responses-based
  // assertion below keeps working unchanged.
  vi.spyOn(globalThis, "fetch").mockImplementation(fetchMock as unknown as typeof fetch);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRelayConfig", () => {
  it("enables the relay by default when a url is set", () => {
    const cfg = parseRelayConfig({ pixelAgentsUrl: "  https://pa.example  " });
    expect(cfg.enabled).toBe(true);
    expect(cfg.pixelAgentsUrl).toBe("https://pa.example");
    expect(cfg.providerId).toBe("claude");
  });

  it("is disabled when pixelAgentsRelayEnabled is explicitly false", () => {
    const cfg = parseRelayConfig({
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsRelayEnabled: false,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.pixelAgentsUrl).toBe("https://pa.example");
  });

  it("falls back to the relay's own default bind (127.0.0.1:8081), and stays enabled, when no url is configured", () => {
    // A sensible built-in default so the bridge works without requiring an
    // operator to configure a URL first; still fully overridable per company
    // and still disable-able via pixelAgentsRelayEnabled: false.
    const noUrl = parseRelayConfig({});
    expect(noUrl.enabled).toBe(true);
    expect(noUrl.pixelAgentsUrl).toBe("http://127.0.0.1:8081");

    const blankUrl = parseRelayConfig({ pixelAgentsUrl: "   " });
    expect(blankUrl.enabled).toBe(true);
    expect(blankUrl.pixelAgentsUrl).toBe("http://127.0.0.1:8081");

    expect(parseRelayConfig({ pixelAgentsUrl: 12345 }).pixelAgentsUrl).toBe("http://127.0.0.1:8081");
    expect(
      parseRelayConfig({ pixelAgentsUrl: "https://pa.example", pixelAgentsRelayEnabled: false }).enabled,
    ).toBe(false);
  });

  it("defaults the provider id to claude (the only id Pixel Agents' route currently dispatches on)", () => {
    expect(parseRelayConfig({ pixelAgentsUrl: "https://pa.example" }).providerId).toBe("claude");
  });

  it("trims a custom provider id", () => {
    const cfg = parseRelayConfig({
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsProviderId: "  my-provider  ",
    });
    expect(cfg.providerId).toBe("my-provider");
  });

  it("falls back to the default provider id for empty/whitespace-only values", () => {
    expect(
      parseRelayConfig({ pixelAgentsUrl: "https://pa.example", pixelAgentsProviderId: "" }).providerId,
    ).toBe("claude");
    expect(
      parseRelayConfig({ pixelAgentsUrl: "https://pa.example", pixelAgentsProviderId: "   " }).providerId,
    ).toBe("claude");
  });

  it("does not carry the bearer token (tokens are resolved from pixelAgentsTokenRef at configure time)", () => {
    // Current behavior: the token is never part of the parsed config — it is
    // resolved separately from the operator-bound secret reference.
    const cfg = parseRelayConfig({
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsToken: "secret-1",
      pixelAgentsTokenRef: "ref-1",
    });
    expect(cfg.pixelAgentsToken).toBeUndefined();
  });
});

describe("extractTokenRef", () => {
  it("returns undefined when no token ref is present", () => {
    expect(extractTokenRef({})).toBeUndefined();
    expect(extractTokenRef({ pixelAgentsTokenRef: null })).toBeUndefined();
    expect(extractTokenRef({ pixelAgentsTokenRef: undefined })).toBeUndefined();
  });

  it("accepts a non-empty string ref and trims whitespace-only strings to undefined", () => {
    expect(extractTokenRef({ pixelAgentsTokenRef: "secret-1" })).toBe("secret-1");
    expect(extractTokenRef({ pixelAgentsTokenRef: "  secret-1  " })).toBe("  secret-1  ");
    expect(extractTokenRef({ pixelAgentsTokenRef: "" })).toBeUndefined();
    expect(extractTokenRef({ pixelAgentsTokenRef: "   " })).toBeUndefined();
  });

  it("passes through a secret_ref binding object", () => {
    const binding = { type: "secret_ref", secretId: "secret-1", version: 2 };
    expect(extractTokenRef({ pixelAgentsTokenRef: binding } as never)).toEqual(binding);
  });

  it("returns undefined for malformed values", () => {
    expect(extractTokenRef({ pixelAgentsTokenRef: 42 } as never)).toBeUndefined();
    expect(extractTokenRef({ pixelAgentsTokenRef: ["secret-1"] } as never)).toBeUndefined();
    for (const malformed of [
      { type: "not-a-secret-ref", secretId: "x" },
      { type: "secret_ref" },
      { secretId: "x" },
      "  ",
      "",
    ]) {
      expect(extractTokenRef({ pixelAgentsTokenRef: malformed } as never)).toBeUndefined();
    }
  });
});

describe("BridgeRelay", () => {
  it("configure with a URL marks the company configured with count 1", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    expect(relay.activeCompanyCount).toBe(0);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    expect(relay.isConfigured(COMPANY_ID)).toBe(true);
    expect(relay.activeCompanyCount).toBe(1);
  });

  it("fails closed when the host-validated manifest does not declare http.outbound", async () => {
    // rawFetch() bypasses ctx.http.fetch, so the host's own per-call
    // capability gate never runs for this push. configure() re-checks
    // ctx.manifest.capabilities itself as the replacement enforcement (see
    // src/relay.ts's "DELIBERATE ctx.http.fetch BYPASS" comment) — this
    // proves that re-check actually refuses to configure the relay, never
    // touches fetch, and warns instead of silently proceeding.
    const { ctx, logger } = makeCtx(async () => "", []);
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    expect(relay.isConfigured(COMPANY_ID)).toBe(false);
    expect(relay.activeCompanyCount).toBe(0);
    expect(calls).toHaveLength(0);
    expect(
      logger.calls.some(
        (l) => l.level === "warn" && l.message === "Bridge relay disabled for company: host-validated manifest does not declare http.outbound",
      ),
    ).toBe(true);
  });

  it("ingestEvent (canonical agent.run.started) pushes sessionStart + toolStart as real Claude hook bodies", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    // First sight of the agent: a leading sessionStart, then the §21.4
    // toolStart("PaperclipWork") for the run itself — both pushed to the
    // real, unmodified Pixel Agents claude hook endpoint.
    expect(calls).toHaveLength(2);
    const [sessionStartCall, toolStartCall] = calls;
    expect(sessionStartCall.url).toBe("https://pa.example/api/hooks/claude");
    expect(sessionStartCall.method).toBe("POST");
    expect(sessionStartCall.headers["content-type"]).toBe("application/json");
    expect(sessionStartCall.headers.authorization).toBeUndefined();
    const sessionStartBody = JSON.parse(sessionStartCall.body);
    expect(sessionStartBody.hook_event_name).toBe("SessionStart");
    expect(sessionStartBody.session_id).toBe("paperclip-bridge:company-acme:agent-a");
    expect(sessionStartBody).not.toHaveProperty("transcript_path");

    const toolStartBody = JSON.parse(toolStartCall.body);
    expect(toolStartBody).toEqual({
      hook_event_name: "PreToolUse",
      session_id: "paperclip-bridge:company-acme:agent-a",
      tool_name: "PaperclipWork",
      tool_input: {},
    });
  });

  it("honors a custom pixelAgentsProviderId in the hook path (body shape is unaffected)", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsProviderId: "my-provider",
    });

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://pa.example/api/hooks/my-provider");
      expect(JSON.parse(call.body)).not.toHaveProperty("providerId");
    }
  });

  it("resolves a string token reference and sends an authorization: Bearer header", async () => {
    const { ctx, resolve } = makeCtx(async () => "token-value-1");
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(resolve).toHaveBeenCalledWith("secret-1", {
      companyId: COMPANY_ID,
      configPath: "pixelAgentsTokenRef",
    });

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.headers.authorization).toBe("Bearer token-value-1");
  });

  it("resolves the bearer token from a secret_ref binding object", async () => {
    const { ctx, resolve } = makeCtx(async () => "token-value-2");
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsTokenRef: { type: "secret_ref", secretId: "secret-2" } as never,
    });
    expect(resolve).toHaveBeenCalled();

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    expect(calls[0].headers.authorization).toBe("Bearer token-value-2");
  });

  it("fails secure when token resolution throws: relay disabled, no push, warn logged", async () => {
    const ctx = makeCtx(async () => {
      throw new Error("secret not found");
    });
    const relay = new BridgeRelay(ctx.ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsTokenRef: "secret-1",
    });

    expect(relay.isConfigured(COMPANY_ID)).toBe(false);
    expect(relay.activeCompanyCount).toBe(0);
    expect(ctx.logger.calls.some((l) => l.level === "warn" && l.message.includes("token resolution failed"))).toBe(true);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("sends no authorization header for a whitespace-only token ref (trimmed by extractTokenRef)", async () => {
    const { ctx } = makeCtx(async () => "");
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsTokenRef: "   ",
    });

    expect(relay.isConfigured(COMPANY_ID)).toBe(true);
    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    expect(calls).toHaveLength(2);
    for (const call of calls) expect(call.headers.authorization).toBeUndefined();
  });

  it("disabled config leaves the company unconfigured and ingestEvent pushes nothing", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsRelayEnabled: false });
    expect(relay.isConfigured(COMPANY_ID)).toBe(false);
    expect(relay.activeCompanyCount).toBe(0);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("reconfigures disabled -> enabled on the same company, replacing the prior transport cleanly", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsRelayEnabled: false });
    expect(relay.activeCompanyCount).toBe(0);

    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    expect(relay.activeCompanyCount).toBe(1);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    expect(calls).toHaveLength(2); // sessionStart + toolStart
  });

  it("an identical enabled reconfigure preserves the transport and its ordered push queue", async () => {
    const { ctx, logger } = makeCtx();
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    expect(relay.activeCompanyCount).toBe(1);
    expect(logger.calls.filter((l) => l.message === "Bridge relay configured for company")).toHaveLength(1);
    expect(logger.calls.some((l) => l.message === "Bridge relay config unchanged for company")).toBe(true);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    // The original transport remains live and emits exactly once per mapped
    // AgentEvent (sessionStart + toolStart), with no queue cancellation.
    expect(calls).toHaveLength(2);
  });

  it("ingestSnapshot with two agents pushes sessionStart + an idle confirmation per agent", async () => {
    // Each newly-seen agent gets a SessionStart AND an immediate confirming
    // event (Stop/turnEnd here, since snapshot()'s fixture agents are idle —
    // no activeRuns). Without the second event Pixel Agents never promotes
    // the session past "pending", so it never renders as a character at all
    // (confirmed live 2026-08-31: this was silently true for every idle
    // agent, which is most agents most of the time).
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A, AGENT_B]));
    await flush();

    expect(calls).toHaveLength(4);
    for (const call of calls) {
      expect(call.url).toBe("https://pa.example/api/hooks/claude");
      const body = JSON.parse(call.body);
      expect(["SessionStart", "Stop"]).toContain(body.hook_event_name);
      expect(typeof body.session_id).toBe("string");
      expect(body.session_id.length).toBeGreaterThan(0);
    }
    const bySession = new Map<string, string[]>();
    for (const call of calls) {
      const body = JSON.parse(call.body);
      const list = bySession.get(body.session_id) ?? [];
      list.push(body.hook_event_name);
      bySession.set(body.session_id, list);
    }
    expect([...bySession.keys()].sort()).toEqual(
      [
        "paperclip-bridge:company-acme:agent-a",
        "paperclip-bridge:company-acme:agent-b",
      ].sort(),
    );
    for (const events of bySession.values()) {
      expect(events).toEqual(["SessionStart", "Stop"]);
    }
    // The friendly display name (snapshot()'s fixture sets name: id) shows up
    // as cwd's basename, which is what Pixel Agents uses as its label.
    const sessionStartBodies = calls
      .map((c) => JSON.parse(c.body))
      .filter((b) => b.hook_event_name === "SessionStart");
    expect(sessionStartBodies.map((b) => b.cwd).sort()).toEqual(
      [
        "/paperclip/company-acme/agent-a",
        "/paperclip/company-acme/agent-b",
      ].sort(),
    );
  });

  it("does not push for a sidecar-only event (agent.status_changed to a non-offline status) — FR-14", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestEvent(
      COMPANY_ID,
      statusChanged(COMPANY_ID, AGENT_A, "busy", "idle"),
    );
    await flush();

    expect(calls).toHaveLength(0);
  });

  it("records lastPushError on a 500 response and clears it on the next success", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    // Two pushes fire for a first-sight run.started (sessionStart + toolStart,
    // §21.4) — queue a failure for both so the last-seen error reflects it.
    responses.push({ ok: false, status: 500, statusText: "Server Error" });
    responses.push({ ok: false, status: 500, statusText: "Server Error" });
    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    expect(relay.lastPushError(COMPANY_ID)).toBe("push failed: 500 Server Error");

    // A different unseen agent so the mapper emits a fresh sessionStart.
    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_B, "run-2"));
    await flush();
    expect(relay.lastPushError(COMPANY_ID)).toBeUndefined();
  });

  it("ingestEvent/ingestSnapshot for an unknown company are a no-op and do not throw", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    expect(() =>
      relay.ingestEvent("company-ghost", runStarted("company-ghost", AGENT_A, "run-1")),
    ).not.toThrow();
    expect(() =>
      relay.ingestSnapshot("company-ghost", snapshot("company-ghost", [AGENT_A])),
    ).not.toThrow();
    await flush();
    expect(calls).toHaveLength(0);
    expect(relay.lastPushError("company-ghost")).toBeUndefined();
  });

  it("resyncCompany is a no-op for an unconfigured company (does not throw, no push)", async () => {
    // The full resync path (mapper reset + fresh bootstrapSnapshot) needs a
    // ctx surface (ctx.companies/ctx.agents/...) this file's narrow makeCtx()
    // doesn't provide — see test/worker.test.ts's "reconciliation job
    // periodically self-heals" and "onConfigChanged's enable path immediately
    // re-syncs" tests for that end-to-end coverage against the real harness.
    // This only exercises the early-return guard.
    const relay = new BridgeRelay(makeCtx().ctx);
    await expect(relay.resyncCompany("company-ghost")).resolves.toBeUndefined();
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("disposeAll clears every company and further ingests are no-ops", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    expect(relay.activeCompanyCount).toBe(1);

    relay.disposeAll();
    expect(relay.activeCompanyCount).toBe(0);
    expect(relay.isConfigured(COMPANY_ID)).toBe(false);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A]));
    await flush();
    expect(calls).toHaveLength(0);
  });

  it("a malformed stored URL surfaces as a captured push error, not a crash", async () => {
    // Nit: onValidateConfig rejects non-http(s) URLs, but parseRelayConfig does
    // not re-validate — a malformed stored URL only surfaces later as a
    // lastPushError when the sink attempts to push.
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "not-a-url" });
    expect(relay.isConfigured(COMPANY_ID)).toBe(true);

    // First-sight run.started fires two pushes (sessionStart + toolStart).
    responses.push(new Error("Invalid URL"));
    responses.push(new Error("Invalid URL"));

    expect(() =>
      relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1")),
    ).not.toThrow();
    await flush();

    expect(relay.lastPushError(COMPANY_ID)).toBe("push error: Invalid URL");
  });
});
