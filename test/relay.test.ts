import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginContext, PluginLogger } from "@paperclipai/plugin-sdk";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "../src/core/index.js";
import {
  BridgeRelay,
  extractApiTokenRef,
  extractTokenRef,
  isAllowedCleartextHost,
  isLoopbackHost,
  parseRelayConfig,
  RelayTransportContractError,
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
 * TRANSPORT NOTE (updated 2026-09-01 for WS2-C — see src/relay.ts's
 * "DELIBERATE ctx.http.fetch BYPASS" comment block): `BridgeRelay` pushes
 * plugin feed batches (`{ schemaVersion, companyId, operations }`) to the
 * embedding surface's `POST /api/plugin-feed` endpoint via the Node global
 * `fetch`, because Paperclip's host `ctx.http.fetch` unconditionally rejects
 * any private/reserved-range destination (including `127.0.0.1`, this
 * package's own advertised default) with no override of any kind. The fake
 * context's `http.fetch` field below is kept only because `BridgeRelay` still
 * holds a `PluginContext` and other code paths may reference `ctx.http` — the
 * actual push tests in this file mock the Node global `fetch` (see `makeCtx`'s
 * `httpFetch` param, which now backs a `globalThis.fetch` spy, not
 * `ctx.http.fetch`). The fake context's `manifest.capabilities` includes
 * `http.outbound` by default so `BridgeRelay.configure()`'s own capability
 * re-check (its replacement for the host's per-call enforcement that the
 * bypass skips) passes; tests exercising the fail-closed path pass a context
 * built with that capability removed instead.
 *
 * WIRE NOTE (WS2-C): the retired Claude-hook push (one JSON body per
 * synthesized hook event, 2 calls per first-sight run) is gone. Each
 * ingest/sync call now produces exactly ONE POST to `/api/plugin-feed`
 * carrying the mapped feed operations in order (declare before status before
 * activity). Re-pinned tests below assert that batch shape; deeper mapper
 * semantics are delegated to the Tester child issue for SAA-536.
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

describe("parseRelayConfig transport contract (SAA-557, security F1 regression)", () => {
  // https-when-token enforcement: a configured feed token must never travel
  // over cleartext http: to a non-loopback host. `onValidateConfig` rejects
  // this combination at config-save time; parseRelayConfig is the runtime
  // fail-closed backstop for config that predates the gate or bypassed it.
  // These tests FAIL on the pre-SAA-557 parseRelayConfig (no enforcement).

  it("throws RelayTransportContractError for http: + token ref + non-loopback host", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://pa.example:8081",
        pixelAgentsTokenRef: "secret-1",
      }),
    ).toThrow(RelayTransportContractError);
    try {
      parseRelayConfig({
        pixelAgentsUrl: "http://pa.example:8081",
        pixelAgentsTokenRef: "secret-1",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RelayTransportContractError);
      expect((err as Error).message).toContain("pa.example");
    }
  });

  it("counts a secret_ref binding object as token-present and rejects http: non-loopback for it too", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://pa.example:8081",
        pixelAgentsTokenRef: { type: "secret_ref", secretId: "secret-1" } as never,
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("still allows http: for loopback hosts when a token is configured (local dev)", () => {
    for (const url of [
      "http://localhost:8081",
      "http://127.0.0.1:8081",
      "http://127.9.8.7:8081", // 127.0.0.0/8, not just 127.0.0.1
      "http://[::1]:8081",
    ]) {
      expect(() =>
        parseRelayConfig({ pixelAgentsUrl: url, pixelAgentsTokenRef: "secret-1" }),
      ).not.toThrow();
    }
  });

  it("allows http: + token for the bundled compose-internal host (pixel-agents, SAA-734 reconcile)", () => {
    // The separate-container compose topology reaches the feed at the
    // `pixel-agents` service name. The transport contract now trusts this
    // package's own bundled deployment hostname so the feed token may ride the
    // cleartext internal link (pixel-agents-relay is the retired sidecar name
    // kept for backward compatibility).
    for (const url of [
      "http://pixel-agents:8081",
      "http://pixel-agents-relay:8081",
    ]) {
      expect(() =>
        parseRelayConfig({ pixelAgentsUrl: url, pixelAgentsTokenRef: "secret-1" }),
      ).not.toThrow();
    }
  });

  it("allows http: + token for an operator-declared trusted host in pixelAgentsAllowedHttpHosts", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://custom-internal:8081",
        pixelAgentsTokenRef: "secret-1",
        pixelAgentsAllowedHttpHosts: ["custom-internal"],
      }),
    ).not.toThrow();
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://custom-internal:8081",
        pixelAgentsTokenRef: "secret-1",
        pixelAgentsAllowedHttpHosts: ["  CUSTOM-INTERNAL.  "],
      }),
    ).not.toThrow();
  });

  it("still rejects http: + token for a host not in the trusted set", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://other-internal:8081",
        pixelAgentsTokenRef: "secret-1",
        pixelAgentsAllowedHttpHosts: ["custom-internal"],
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("allows https: with a token for any host", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "https://pa.example",
        pixelAgentsTokenRef: "secret-1",
      }),
    ).not.toThrow();
  });

  it("keeps http: non-loopback allowed when NO token is configured", () => {
    expect(() =>
      parseRelayConfig({ pixelAgentsUrl: "http://pa.example:8081" }),
    ).not.toThrow();
  });

  it("does not throw for http + token when the relay is explicitly disabled", () => {
    // pixelAgentsRelayEnabled: false means no pushes happen at all, so the
    // transport contract has nothing to protect — parse must not reject.
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://pa.example:8081",
        pixelAgentsTokenRef: "secret-1",
        pixelAgentsRelayEnabled: false,
      }),
    ).not.toThrow();
  });
});

describe("parseRelayConfig transport contract (SAA-590 §2 regression)", () => {
  // The §2 bypass: a scheme-prefixed but unparseable pixelAgentsUrl (e.g.
  // "http:") skipped the §1 protocol check in parseRelayConfig yet could
  // late-parse in the sink ("${baseUrl}/api/plugin-feed") to a cleartext
  // non-loopback host and dispatch the bearer token. The fix rejects ANY
  // unparseable URL — and any non-http(s) protocol — while a token ref is
  // configured. These tests FAIL on the pre-§2-fix parseRelayConfig (gate
  // silently skipped on new URL failure, only http: was protocol-checked).

  it("throws RelayTransportContractError for a scheme-only pixelAgentsUrl with a token ref", () => {
    // The exact SAA-590 §2 bypass input: "http:" + token used to slip past
    // the gate and late-parse in the sink to a cleartext non-loopback host.
    expect(() =>
      parseRelayConfig({ pixelAgentsUrl: "http:", pixelAgentsTokenRef: "s" }),
    ).toThrow(RelayTransportContractError);
    try {
      parseRelayConfig({ pixelAgentsUrl: "http:", pixelAgentsTokenRef: "s" });
    } catch (err) {
      expect(err).toBeInstanceOf(RelayTransportContractError);
      expect((err as Error).message).toContain("must be a valid http(s) URL");
    }
  });

  it("throws for near-miss scheme-only variants of the bypass input", () => {
    for (const url of ["http:/", "http://"]) {
      expect(() =>
        parseRelayConfig({ pixelAgentsUrl: url, pixelAgentsTokenRef: "s" }),
      ).toThrow(RelayTransportContractError);
    }
  });

  it("throws for a wholly unparseable pixelAgentsUrl with a token ref", () => {
    expect(() =>
      parseRelayConfig({ pixelAgentsUrl: "not-a-url", pixelAgentsTokenRef: "s" }),
    ).toThrow(RelayTransportContractError);
  });

  it("throws for a non-http(s) protocol with a token ref, naming the refused transport", () => {
    expect(() =>
      parseRelayConfig({ pixelAgentsUrl: "ftp://x", pixelAgentsTokenRef: "s" }),
    ).toThrow(RelayTransportContractError);
    try {
      parseRelayConfig({ pixelAgentsUrl: "ftp://x", pixelAgentsTokenRef: "s" });
    } catch (err) {
      expect(err).toBeInstanceOf(RelayTransportContractError);
      expect((err as Error).message).toContain("ftp://x");
    }
  });

  it("still parses a tokenless malformed URL without throwing (historical late push-error surface preserved)", () => {
    // Tokenless config keeps the pre-§2 behavior: parse succeeds and the
    // malformed URL only surfaces later as a sink push error (see the
    // "malformed stored URL surfaces as a captured push error" test below).
    expect(() => parseRelayConfig({ pixelAgentsUrl: "not-a-url" })).not.toThrow();
    expect(parseRelayConfig({ pixelAgentsUrl: "not-a-url" }).pixelAgentsUrl).toBe("not-a-url");
    expect(() => parseRelayConfig({ pixelAgentsUrl: "http:" })).not.toThrow();
  });
});

describe("parseRelayConfig transport contract (SAA-737 no-suffix / no-wildcard regression)", () => {
  // SAA-737 security-review follow-up (non-blocking, from SAA-736): pin the
  // trust decision at the parse level too — a configured feed bearer token
  // must NEVER ride a cleartext http: pixelAgentsUrl for a host that merely
  // LOOKS LIKE a trusted one (suffix/subdomain/wildcard/userinfo). Each of
  // these FAILS if parseRelayConfig ever accepts substring/suffix/wildcard
  // matching, which would silently widen the bearer-token carve-out.

  it("rejects http: + token for a suffix lookalike of a bundled trusted name", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://pixel-agents.evil.com:8081",
        pixelAgentsTokenRef: "s",
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("rejects http: + token for a subdomain of a bundled trusted name", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://x.pixel-agents:8081",
        pixelAgentsTokenRef: "s",
      }),
    ).toThrow(RelayTransportContractError);
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://x.pixel-agents-relay:8081",
        pixelAgentsTokenRef: "s",
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("rejects http: + token for a suffix lookalike of an operator-declared trusted host", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://custom-internal.evil.com:8081",
        pixelAgentsTokenRef: "s",
        pixelAgentsAllowedHttpHosts: ["custom-internal"],
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("rejects a wildcard pixelAgentsAllowedHttpHosts entry — it must not match any host", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://evil.com:8081",
        pixelAgentsTokenRef: "s",
        pixelAgentsAllowedHttpHosts: ["*"],
      }),
    ).toThrow(RelayTransportContractError);
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://custom-internal.evil.com:8081",
        pixelAgentsTokenRef: "s",
        pixelAgentsAllowedHttpHosts: ["*", "custom-internal"],
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("rejects http: + token when a trusted name is smuggled into the userinfo (hostname is the real destination)", () => {
    // new URL(...).hostname for "http://pixel-agents@evil.com:8081" is
    // "evil.com" — the userinfo prefix must never be able to smuggle a trust
    // decision that the destination host itself did not earn.
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://pixel-agents@evil.com:8081",
        pixelAgentsTokenRef: "s",
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("accepts http: + token for the bundled name with a trailing dot (same DNS name after normalization)", () => {
    expect(() =>
      parseRelayConfig({ pixelAgentsUrl: "http://pixel-agents.:8081", pixelAgentsTokenRef: "s" }),
    ).not.toThrow();
  });

  it("accepts http: + token for an uppercase variant of the bundled trusted name", () => {
    expect(() =>
      parseRelayConfig({ pixelAgentsUrl: "http://PIXEL-AGENTS:8081", pixelAgentsTokenRef: "s" }),
    ).not.toThrow();
  });

  it("accepts http: + token for the exact operator-declared trusted host", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "http://custom-internal:8081",
        pixelAgentsTokenRef: "s",
        pixelAgentsAllowedHttpHosts: ["custom-internal"],
      }),
    ).not.toThrow();
  });
});

describe("parseRelayConfig transport contract (SAA-738 paperclipApiTokenRef pair)", () => {
  // Same-class residual from the SAA-736 security review: the tool-activity
  // poller's token pair (paperclipApiTokenRef + paperclipApiBaseUrl) had only
  // the save-time onValidateConfig gate; parseRelayConfig did no transport
  // check, so a stale/bypassed config would push the resolved api token as
  // `Authorization: Bearer` over cleartext http: to a non-loopback host.
  // These mirror the SAA-557/SAA-590/SAA-737 feed-token cases and FAIL on the
  // pre-SAA-738 parseRelayConfig (no api-pair enforcement at all).

  it("throws RelayTransportContractError for http: api token + non-trusted host", () => {
    expect(() =>
      parseRelayConfig({
        paperclipApiBaseUrl: "http://non-trusted:3100",
        paperclipApiTokenRef: "secret-1",
      }),
    ).toThrow(RelayTransportContractError);
    try {
      parseRelayConfig({
        paperclipApiBaseUrl: "http://non-trusted:3100",
        paperclipApiTokenRef: "secret-1",
      });
    } catch (err) {
      expect(err).toBeInstanceOf(RelayTransportContractError);
      expect((err as Error).message).toContain("non-trusted");
    }
  });

  it("counts a secret_ref binding api token as present and rejects http: non-loopback for it too", () => {
    expect(() =>
      parseRelayConfig({
        paperclipApiBaseUrl: "http://non-trusted:3100",
        paperclipApiTokenRef: { type: "secret_ref", secretId: "secret-1" } as never,
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("still allows http: api token for loopback hosts (same-container default)", () => {
    for (const url of [
      "http://localhost:3100",
      "http://127.0.0.1:3100",
      "http://127.9.8.7:3100", // 127.0.0.0/8
      "http://[::1]:3100",
    ]) {
      expect(() =>
        parseRelayConfig({ paperclipApiBaseUrl: url, paperclipApiTokenRef: "secret-1" }),
      ).not.toThrow();
    }
  });

  it("allows http: api token for the bundled compose-internal host (pixel-agents)", () => {
    for (const url of [
      "http://pixel-agents:3100",
      "http://pixel-agents-relay:3100",
    ]) {
      expect(() =>
        parseRelayConfig({ paperclipApiBaseUrl: url, paperclipApiTokenRef: "secret-1" }),
      ).not.toThrow();
    }
  });

  it("allows http: api token for an operator-declared trusted host in pixelAgentsAllowedHttpHosts", () => {
    expect(() =>
      parseRelayConfig({
        paperclipApiBaseUrl: "http://custom-internal:3100",
        paperclipApiTokenRef: "secret-1",
        pixelAgentsAllowedHttpHosts: ["custom-internal"],
      }),
    ).not.toThrow();
  });

  it("still rejects http: api token for a host not in the trusted set even when the feed url is fine", () => {
    expect(() =>
      parseRelayConfig({
        pixelAgentsUrl: "https://pa.example",
        paperclipApiBaseUrl: "http://other-internal:3100",
        paperclipApiTokenRef: "secret-1",
        pixelAgentsAllowedHttpHosts: ["custom-internal"],
      }),
    ).toThrow(RelayTransportContractError);
  });

  it("allows https: for the api token with any host", () => {
    expect(() =>
      parseRelayConfig({
        paperclipApiBaseUrl: "https://paperclip.example.internal:3100",
        paperclipApiTokenRef: "secret-1",
      }),
    ).not.toThrow();
  });

  it("keeps http: non-loopback allowed when NO api token is configured", () => {
    expect(() =>
      parseRelayConfig({ paperclipApiBaseUrl: "http://non-trusted:3100" }),
    ).not.toThrow();
  });

  it("does not throw for http api token when the relay is explicitly disabled", () => {
    expect(() =>
      parseRelayConfig({
        paperclipApiBaseUrl: "http://non-trusted:3100",
        paperclipApiTokenRef: "secret-1",
        pixelAgentsRelayEnabled: false,
      }),
    ).not.toThrow();
  });

  it("throws for an unparseable paperclipApiBaseUrl with an api token (SAA-590 road)", () => {
    for (const url of ["http:", "http:/", "http://", "not-a-url"]) {
      expect(() =>
        parseRelayConfig({ paperclipApiBaseUrl: url, paperclipApiTokenRef: "s" }),
      ).toThrow(RelayTransportContractError);
    }
    try {
      parseRelayConfig({ paperclipApiBaseUrl: "http:", paperclipApiTokenRef: "s" });
    } catch (err) {
      expect((err as Error).message).toContain("must be a valid http(s) URL");
    }
  });

  it("throws for a non-http(s) protocol paperclipApiBaseUrl with an api token", () => {
    expect(() =>
      parseRelayConfig({ paperclipApiBaseUrl: "ftp://x", paperclipApiTokenRef: "s" }),
    ).toThrow(RelayTransportContractError);
  });

  it("still parses a tokenless malformed paperclipApiBaseUrl without throwing", () => {
    expect(() => parseRelayConfig({ paperclipApiBaseUrl: "http:" })).not.toThrow();
  });
});

describe("extractApiTokenRef", () => {
  it("returns undefined when no api token ref is present", () => {
    expect(extractApiTokenRef({})).toBeUndefined();
    expect(extractApiTokenRef({ paperclipApiTokenRef: null })).toBeUndefined();
  });

  it("accepts a non-empty string ref and trims whitespace-only strings to undefined", () => {
    expect(extractApiTokenRef({ paperclipApiTokenRef: "secret-1" })).toBe("secret-1");
    expect(extractApiTokenRef({ paperclipApiTokenRef: "" })).toBeUndefined();
    expect(extractApiTokenRef({ paperclipApiTokenRef: "   " })).toBeUndefined();
  });

  it("passes through a secret_ref binding object", () => {
    const binding = { type: "secret_ref", secretId: "secret-1", version: 2 };
    expect(extractApiTokenRef({ paperclipApiTokenRef: binding } as never)).toEqual(binding);
  });

  it("returns undefined for malformed values", () => {
    expect(extractApiTokenRef({ paperclipApiTokenRef: 42 } as never)).toBeUndefined();
    expect(extractApiTokenRef({ paperclipApiTokenRef: ["secret-1"] } as never)).toBeUndefined();
  });
});

describe("isLoopbackHost", () => {
  it("is true for localhost, any 127.0.0.0/8 IPv4, and ::1", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("LOCALHOST")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.9.8.7")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
  });

  it("is false for non-loopback hosts and near-miss addresses", () => {
    expect(isLoopbackHost("pa.example")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.example.com")).toBe(false);
    expect(isLoopbackHost("128.0.0.1")).toBe(false);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("::2")).toBe(false);
    expect(isLoopbackHost("10.0.0.1")).toBe(false);
  });
});

describe("isAllowedCleartextHost", () => {
  it("is true for loopback, the bundled deployment hostnames, and operator-declared hosts", () => {
    expect(isAllowedCleartextHost("localhost")).toBe(true);
    expect(isAllowedCleartextHost("127.0.0.1")).toBe(true);
    expect(isAllowedCleartextHost("::1")).toBe(true);
    expect(isAllowedCleartextHost("pixel-agents")).toBe(true);
    expect(isAllowedCleartextHost("pixel-agents-relay")).toBe(true);
    expect(isAllowedCleartextHost("custom-internal", ["custom-internal"])).toBe(true);
    expect(isAllowedCleartextHost("  CUSTOM-INTERNAL.  ", ["custom-internal"])).toBe(true);
  });

  it("is false for a host that is neither loopback, bundled, nor operator-declared", () => {
    expect(isAllowedCleartextHost("pa.example")).toBe(false);
    expect(isAllowedCleartextHost("custom-internal")).toBe(false);
    expect(isAllowedCleartextHost("custom-internal", ["other-internal"])).toBe(false);
    expect(isAllowedCleartextHost("10.0.0.1")).toBe(false);
  });

  // SAA-737 security-review follow-up: pin the NO-suffix / NO-substring /
  // NO-wildcard property of the trust decision. These assertions FAIL if
  // isAllowedCleartextHost ever drifts to substring, suffix, or wildcard
  // matching, which would silently widen the cleartext bearer-token carve-out
  // to attacker-chosen lookalike hosts.

  it("rejects suffix and subdomain lookalikes of the bundled trusted names", () => {
    // Not the bundled name itself, so each must be refused — never matched by
    // a ".includes(...)" / suffix / prefix-wildcard rule.
    expect(isAllowedCleartextHost("pixel-agents.evil.com")).toBe(false);
    expect(isAllowedCleartextHost("evil.pixel-agents")).toBe(false);
    expect(isAllowedCleartextHost("pixel-agents-relay.evil.com")).toBe(false);
    expect(isAllowedCleartextHost("x.pixel-agents-relay")).toBe(false);
    expect(isAllowedCleartextHost("pixel-agents.dev")).toBe(false);
  });

  it("rejects a suffix lookalike of an operator-declared trusted host", () => {
    expect(isAllowedCleartextHost("custom-internal.evil.com", ["custom-internal"])).toBe(false);
    expect(isAllowedCleartextHost("evil.custom-internal", ["custom-internal"])).toBe(false);
  });

  it("never treats a wildcard entry as matching any host", () => {
    // "*" must be compared literally (exact-equality after normalization),
    // never expanded into a glob — otherwise any host becomes trusted.
    expect(isAllowedCleartextHost("evil.com", ["*"])).toBe(false);
    expect(isAllowedCleartextHost("custom-internal.evil.com", ["*"])).toBe(false);
    expect(isAllowedCleartextHost("feedback.internal", ["*"])).toBe(false);
  });

  it("still accepts the bundled names after normalization (trailing dot, case)", () => {
    // Same DNS name as the trusted entries once the trailing dot is stripped
    // and case is folded — these are the legitimately-trusted forms.
    expect(isAllowedCleartextHost("pixel-agents.")).toBe(true);
    expect(isAllowedCleartextHost("PIXEL-AGENTS")).toBe(true);
    expect(isAllowedCleartextHost("Pixel-Agents-Relay")).toBe(true);
    expect(isAllowedCleartextHost(" PIXEL-AGENTS. ")).toBe(true);
  });

  it("still accepts the exact operator-declared host (and its normalized variant)", () => {
    expect(isAllowedCleartextHost("custom-internal", ["custom-internal"])).toBe(true);
    expect(isAllowedCleartextHost("  CUSTOM-INTERNAL.  ", ["custom-internal"])).toBe(true);
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

  it("configure() fails secure on a transport-contract rejection: relay disabled, warn logged, never pushes", async () => {
    // SAA-557: a config that parseRelayConfig rejects as a cleartext-token
    // transport must disable the company's relay (disposing any prior
    // transport), warn, and never push — NOT keep pushing on the old
    // transport and NOT propagate the error to the worker hook.
    const { ctx, logger } = makeCtx(async () => "token-value-1");
    const relay = new BridgeRelay(ctx);
    // Start from a valid configured transport, then feed it the violating
    // config: the previous transport must be disposed, not retained.
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(relay.isConfigured(COMPANY_ID)).toBe(true);

    await expect(
      relay.configure(COMPANY_ID, {
        pixelAgentsUrl: "http://pa.example:8081",
        pixelAgentsTokenRef: "secret-1",
      }),
    ).resolves.toBeUndefined();

    expect(relay.isConfigured(COMPANY_ID)).toBe(false);
    expect(relay.activeCompanyCount).toBe(0);
    expect(
      logger.calls.some(
        (l) => l.level === "warn" && l.message === "Bridge relay config rejected for company; relay disabled",
      ),
    ).toBe(true);

    // Never pushes: the rejected transport carries no token anywhere.
    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A]));
    await flush();
    expect(calls.filter((c) => c.url.startsWith("http://pa.example"))).toHaveLength(0);

    // And the rejected company stays disabled for later ingests (no stale
    // transport revived by a subsequent push attempt).
    expect(relay.lastPushError(COMPANY_ID)).toBeUndefined();
  });

  it("configure() fails secure on an api-pair transport rejection (SAA-738): relay disabled, warn logged, never pushes", async () => {
    // Same fail-closed handling as the feed-token contract: a config whose
    // paperclipApiBaseUrl would carry the resolved api token over cleartext
    // http: to a non-loopback host must disable the company's relay (disposing
    // any prior transport) and warn — never keep pushing on the old transport.
    const { ctx, logger } = makeCtx(async () => "board-token-value");
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      paperclipApiTokenRef: "board-token",
      paperclipApiBaseUrl: "http://127.0.0.1:3100",
    });
    expect(relay.isConfigured(COMPANY_ID)).toBe(true);

    await expect(
      relay.configure(COMPANY_ID, {
        pixelAgentsUrl: "https://pa.example",
        paperclipApiTokenRef: "board-token",
        paperclipApiBaseUrl: "http://non-trusted:3100",
      }),
    ).resolves.toBeUndefined();

    expect(relay.isConfigured(COMPANY_ID)).toBe(false);
    expect(relay.activeCompanyCount).toBe(0);
    expect(
      logger.calls.some(
        (l) => l.level === "warn" && l.message === "Bridge relay config rejected for company; relay disabled",
      ),
    ).toBe(true);

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A]));
    await flush();
    expect(calls).toHaveLength(0);
    expect(relay.lastPushError(COMPANY_ID)).toBeUndefined();
  });

  it("configure() with the §2 bypass input dispatches ZERO fetches: company disabled, prior transport disposed, warn logged", async () => {
    // SAA-590 §2: a previously-valid transport fed
    // { pixelAgentsUrl: "http:", pixelAgentsTokenRef: "s" } used to keep the
    // old (or worse, a late-parsing cleartext) transport and could dispatch
    // the bearer token. Post-fix, the §2 contract rejection must fail
    // secure exactly like the §1 one: dispose, disable, warn, never fetch.
    const { ctx, logger } = makeCtx(async () => "token-value-1");
    const relay = new BridgeRelay(ctx);
    await relay.configure(COMPANY_ID, {
      pixelAgentsUrl: "https://pa.example",
      pixelAgentsTokenRef: "secret-1",
    });
    expect(relay.isConfigured(COMPANY_ID)).toBe(true);

    await expect(
      relay.configure(COMPANY_ID, {
        pixelAgentsUrl: "http:",
        pixelAgentsTokenRef: "s",
      }),
    ).resolves.toBeUndefined();

    expect(relay.isConfigured(COMPANY_ID)).toBe(false);
    expect(relay.activeCompanyCount).toBe(0);
    expect(
      logger.calls.some(
        (l) => l.level === "warn" && l.message === "Bridge relay config rejected for company; relay disabled",
      ),
    ).toBe(true);

    // ZERO fetch dispatches — neither on a late-parsing cleartext transport
    // nor on the disposed prior one.
    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A]));
    await flush();
    expect(calls).toHaveLength(0);
    expect(relay.lastPushError(COMPANY_ID)).toBeUndefined();
  });

  it("ingestEvent (canonical agent.run.started) pushes one feed batch: declare + activity + active status", async () => {
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();

    // First sight of the agent: ONE ordered batch to the plugin feed
    // endpoint — the declaration (spawn/upsert), the run caption, the
    // active status, and the run-scoped dialog-pane line (WS4-C). The
    // retired wire needed two hook-body POSTs for this; the feed carries
    // all four operations in one body, applied in order.
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://pa.example/api/plugin-feed");
    expect(call.method).toBe("POST");
    expect(call.headers["content-type"]).toBe("application/json");
    expect(call.headers.authorization).toBeUndefined();
    const batch = JSON.parse(call.body);
    expect(batch.schemaVersion).toBe(1);
    expect(batch.companyId).toBe(COMPANY_ID);
    expect(batch.operations).toHaveLength(4);
    const [declare, activity, status, dialog] = batch.operations;
    expect(declare.op).toBe("declareAgents");
    expect(declare.agents).toHaveLength(1);
    expect(declare.agents[0].key).toBe(AGENT_A);
    expect(declare.agents[0].name).toBe(AGENT_A);
    // Per-agent unique team name: the no-grouping semantics of the retired
    // transcript hack, through the sanctioned declaration field. It must be
    // a stable, non-empty, per-agent-unique string ( Tester child pins the
    // exact uniqueness contract across agents).
    expect(declare.agents[0].teamName).toMatch(/^paperclip-bridge-[0-9a-f]+$/);
    expect(activity).toEqual({ op: "updateAgentActivity", key: AGENT_A, activity: "Task: Paperclip work" });
    expect(status).toEqual({ op: "updateAgentStatus", key: AGENT_A, status: "active" });
    expect(dialog).toEqual({
      op: "dialogLines",
      lines: [{ text: `${AGENT_A} started a run` }],
    });
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

    expect(calls).toHaveLength(1);
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
    expect(calls).toHaveLength(1); // one feed batch (declare + activity + status)
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
    // The original transport remains live and emits exactly one feed batch
    // per mapped ingest, with no queue cancellation.
    expect(calls).toHaveLength(1);
  });

  it("ingestSnapshot with two agents pushes one batch: declare + idle status per agent", async () => {
    // Every newly-seen agent gets a declaration AND an honest idle status
    // (waiting, not awaitingInput) in one ordered batch — through the A1
    // host's sanctioned agent source, so each agent renders as a character
    // immediately (the retired wire needed a synthetic SessionStart+Stop
    // pair per idle agent for this; the feed declares them directly).
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

    relay.ingestSnapshot(COMPANY_ID, snapshot(COMPANY_ID, [AGENT_A, AGENT_B]));
    await flush();

    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.url).toBe("https://pa.example/api/plugin-feed");
    const batch = JSON.parse(call.body);
    expect(batch.companyId).toBe(COMPANY_ID);
    expect(batch.operations).toHaveLength(4); // 2 agents x (declare + idle status)

    const declares = batch.operations.filter((op: { op: string }) => op.op === "declareAgents");
    const statuses = batch.operations.filter((op: { op: string }) => op.op === "updateAgentStatus");
    expect(declares.map((d: { agents: Array<{ key: string }> }) => d.agents[0].key).sort())
      .toEqual([AGENT_A, AGENT_B]);
    // Per-agent unique team names (no synthetic grouping across agents).
    const teamNames = declares.map((d: { agents: Array<{ teamName: string }> }) => d.agents[0].teamName);
    expect(new Set(teamNames).size).toBe(2);
    for (const name of teamNames) expect(name).toMatch(/^paperclip-bridge-[0-9a-f]+$/);
    // Idle agents are declared waiting and NOT awaitingInput, in the same
    // batch, after their declarations.
    expect(statuses).toHaveLength(2);
    for (const status of statuses) {
      expect(status.status).toBe("waiting");
      expect(status.awaitingInput).toBe(false);
      expect([AGENT_A, AGENT_B]).toContain(status.key);
    }
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

    // One feed batch fires for a first-sight run.started (declare + activity
    // + status) — queue a failure for it so the last-seen error reflects it.
    responses.push({ ok: false, status: 500, statusText: "Server Error" });
    relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1"));
    await flush();
    expect(relay.lastPushError(COMPANY_ID)).toBe("feed push failed: 500 Server Error");

    // A different unseen agent so the mapper emits a fresh declaration batch.
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

  describe("syncAppearances (WS3)", () => {
    function syncEntries(): Array<{ agentId: string; agentName: string; characterId: string; palette: number; hueShift: number; updatedAt: string }> {
      return [
        { agentId: AGENT_A, agentName: "Agent A", characterId: "pixel-agents:char-0", palette: 0, hueShift: 0, updatedAt: ISO },
        { agentId: AGENT_B, agentName: "Agent B", characterId: "paperclip-pixels:char-6", palette: 6, hueShift: 45, updatedAt: ISO },
      ];
    }

    it("pushes the appearance map as declare upserts carrying palette/hueShift and reports success", async () => {
      // WS2-C: seat application rides the sanctioned path — declareAgents
      // upserts carrying each agent's palette/hueShift in one feed batch —
      // replacing the retired POST /api/appearance-sync seat-driving push.
      const relay = new BridgeRelay(makeCtx().ctx);
      await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

      await expect(relay.syncAppearances(COMPANY_ID, syncEntries())).resolves.toBe(true);
      expect(calls).toHaveLength(1);
      const call = calls[0];
      expect(call.url).toBe("https://pa.example/api/plugin-feed");
      expect(call.method).toBe("POST");
      expect(call.headers["content-type"]).toBe("application/json");
      // No bearer token configured for this relay: no authorization header.
      expect(call.headers.authorization).toBeUndefined();
      const batch = JSON.parse(call.body);
      expect(batch.companyId).toBe(COMPANY_ID);
      const declared = batch.operations
        .filter((op: { op: string }) => op.op === "declareAgents")
        .flatMap((op: { agents: Array<Record<string, unknown>> }) => op.agents);
      expect(declared.map((a: { key: string }) => a.key).sort()).toEqual([AGENT_A, AGENT_B]);
      const byKey = new Map(declared.map((a: { key: string }) => [a.key, a]));
      expect(byKey.get(AGENT_A)).toMatchObject({ palette: 0, hueShift: 0 });
      // SAA-694 seat-palette clamp: the declaration's palette is the SEAT /
      // fallback index into Pixel Agents' built-in sheet set (6 sheets) —
      // catalog indices >= 6 are cycled into the built-in range so the
      // embedding host's fail-closed declaration validator accepts the seat
      // everywhere (see PluginFeedMapper.declarationFor).
      expect(byKey.get(AGENT_B)).toMatchObject({ palette: 0, hueShift: 45 });
    });

    it("sends the configured bearer token when one was resolved from the secret ref", async () => {
      const { ctx, resolve } = makeCtx(() => "test-token");
      const relay = new BridgeRelay(ctx);
      await relay.configure(COMPANY_ID, {
        pixelAgentsUrl: "https://pa.example",
        pixelAgentsTokenRef: "ref-token",
      });
      expect(resolve).toHaveBeenCalled();

      await expect(relay.syncAppearances(COMPANY_ID, syncEntries())).resolves.toBe(true);
      expect(calls[0].headers.authorization).toBe("Bearer test-token");
      resolve.mockRestore();
    });

    it("returns false (never throws) when the relay is not configured for the company", async () => {
      const { ctx } = makeCtx(() => "");
      const relay = new BridgeRelay(ctx);
      await relay.configure(COMPANY_ID, { pixelAgentsUrl: "https://pa.example" });

      // Unconfigured company: the write reports false — the next sync
      // re-applies it; an appearance write must not fail because the feed
      // is momentarily down. (Delivery failures of an enqueued batch land
      // in lastPushError, not in this return value — the sink is ordered
      // fire-and-forget.)
      await expect(relay.syncAppearances("company-ghost", syncEntries())).resolves.toBe(false);
      expect(calls).toHaveLength(0);
    });
  });

  it("a malformed stored URL surfaces as a captured push error, not a crash", async () => {
    // Nit: onValidateConfig rejects non-http(s) URLs, but parseRelayConfig does
    // not re-validate — a malformed stored URL only surfaces later as a
    // lastPushError when the sink attempts to push.
    const relay = new BridgeRelay(makeCtx().ctx);
    await relay.configure(COMPANY_ID, { pixelAgentsUrl: "not-a-url" });
    expect(relay.isConfigured(COMPANY_ID)).toBe(true);

    // The sink's protocol guard (new URL(...)) rejects before fetch is called.
    expect(() =>
      relay.ingestEvent(COMPANY_ID, runStarted(COMPANY_ID, AGENT_A, "run-1")),
    ).not.toThrow();
    await flush();

    expect(relay.lastPushError(COMPANY_ID)).toBe("feed push error: Invalid URL");
  });
});
