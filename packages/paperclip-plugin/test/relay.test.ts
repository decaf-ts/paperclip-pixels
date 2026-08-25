import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginLogger } from "@paperclipai/plugin-sdk";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "@paperclip-pixel/core";
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
 * `BridgeRelay` constructs an `HttpPushSink` whose outbound push is routed
 * through the SDK-gated `ctx.http.fetch` surface (never the Node global
 * `fetch`). The fake context therefore wires a controllable `http.fetch`
 * mock; each test spies/inspects it and asserts against the captured calls
 * (URL, method, headers, JSON body).
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

function makeCtx(
  resolve: (ref: unknown) => Promise<string> | string = async () => "",
  httpFetch?: typeof fetchMock,
): {
  ctx: PluginContext;
  resolve: ReturnType<typeof vi.fn>;
  logger: ReturnType<typeof makeLogger>;
} {
  const logger = makeLogger();
  const resolveFn = vi.fn(
    async (ref: unknown, _opts?: ResolveOptions): Promise<string> => resolve(ref),
  );
  const gatedFetch: typeof fetchMock = httpFetch ?? fetchMock;
  const ctx = {
    logger,
    secrets: { resolve: resolveFn },
    http: { fetch: gatedFetch },
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
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseRelayConfig", () => {
  it("enables the relay by default when a url is set", () => {
    const cfg = parseRelayConfig({ pixelAgentsUrl: "  https://pa.example  " });
    expect(cfg.enabled).toBe(true);
    expect(cfg.pixelAgentsUrl).toBe("https://pa.example");
    expect(cfg.providerId).toBe("paperclip-bridge");
  });

  it("is disabled when pixelAgentsRelayEnabled is explicitly false", () => {
    const cfg = parseRelayConfig({
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsRelayEnabled: false,
    });
    expect(cfg.enabled).toBe(false);
    expect(cfg.pixelAgentsUrl).toBe("https://pa.example");
  });

  it("is disabled when no usable url is present", () => {
    expect(parseRelayConfig({}).enabled).toBe(false);
    expect(parseRelayConfig({ pixelAgentsUrl: "   " }).enabled).toBe(false);
    expect(parseRelayConfig({ pixelAgentsUrl: 12345 }).enabled).toBe(false);
    expect(parseRelayConfig({ pixelAgentsUrl: "https://pa.example", pixelAgentsRelayEnabled: false }).enabled).toBe(false);
  });

  it("defaults the provider id to paperclip-bridge", () => {
    expect(parseRelayConfig({ pixelAgentsUrl: "https://pa.example" }).providerId).toBe("paperclip-bridge");
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
    ).toBe("paperclip-bridge");
    expect(
      parseRelayConfig({ pixelAgentsUrl: "https://pa.example", pixelAgentsProviderId: "   " }).providerId,
    ).toBe("paperclip-bridge");
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

  it("ingestEvent (canonical agent.run.started) pushes exactly one envelope to the bridge hook", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.url).toBe("https://pa.example/api/hooks/paperclip-bridge");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBeUndefined();
    const body = JSON.parse(call.body);
    expect(body).toEqual({
      providerId: "paperclip-bridge",
      sessionId: "paperclip-bridge:company-acme:agent-a",
      event: { kind: "sessionStart", source: "paperclip-bridge" },
    });
    expect(body.providerId).toBe("paperclip-bridge");
    expect(typeof body.sessionId).toBe("string");
    expect(body.sessionId.length).toBeGreaterThan(0);
  });

  it("honors a custom pixelAgentsProviderId in the hook path and envelope", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsProviderId: "my-provider",
    });

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://pa.example/api/hooks/my-provider");
    expect(JSON.parse(calls[0].body).providerId).toBe("my-provider");
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

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBe("Bearer token-value-1");
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

    expect(calls).toHaveLength(1);
    expect(calls[0].headers.authorization).toBeUndefined();
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
    expect(calls).toHaveLength(1);
  });

  it("reconfigure enabled -> enabled disposes the prior transport (no duplicate pushes from old sink)", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });
    expect(relay.activeCompanyCount).toBe(1);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    // The old transport was disposed; the new transport emits exactly once.
    expect(calls).toHaveLength(1);
  });

  it("ingestSnapshot with two agents pushes one sessionStart per agent", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A, AGENT_B]));
    await flush();

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.url).toBe("https://pa.example/api/hooks/paperclip-bridge");
      const body = JSON.parse(call.body);
      expect(body.event).toEqual({ kind: "sessionStart", source: "paperclip-bridge" });
      expect(typeof body.sessionId).toBe("string");
      expect(body.sessionId.length).toBeGreaterThan(0);
    }
    expect(calls.map((c) => JSON.parse(c.body).sessionId).sort()).toEqual(
      [
        "paperclip-bridge:company-acme:agent-a",
        "paperclip-bridge:company-acme:agent-b",
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

    responses.push(new Error("Invalid URL"));

    expect(() =>
      relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1")),
    ).not.toThrow();
    await flush();

    expect(relay.lastPushError(COMPANY_ID)).toBe("push error: Invalid URL");
  });
});
