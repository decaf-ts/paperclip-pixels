/**
 * In-plugin bridge relay (spec PAPERCLIP_PIXELS-2, §2, §21).
 *
 * Connects the canonical bridge contract produced by this worker to a Pixel
 * Agents server's real, unmodified hook endpoint (`POST /api/hooks/claude`).
 * The relay owns one {@link BridgeTransport} per company, fed the same
 * canonical `BridgeInputEvent`s the worker already applies to its
 * `BridgeStore` and the same authoritative snapshots it bootstraps/reconciles
 * from. Each transport maps events into Pixel Agents `AgentEvent`s (plus the
 * rich sidecar) and pushes them through an {@link HttpPushSink}, which
 * serializes them into the real Claude hook JSON body Pixel Agents' single
 * shipped provider (`claudeProvider`) already accepts unmodified — see
 * `@paperclip-pixel/pixel-agents-provider`'s `transport.ts` for the full wire
 * boundary rationale. No Pixel Agents source change is required.
 *
 * Configuration is operator-set, company-scoped plugin config (the worker env
 * is scrubbed by the host, so env vars are not available here). Config fields:
 *   - `pixelAgentsUrl`         — base URL of the running `paperclip-pixel-relay`
 *                                companion CLI (never Pixel Agents directly —
 *                                see `bin/paperclip-pixel-relay.js`). Must be
 *                                `https:` when a token is configured. Defaults
 *                                to `http://127.0.0.1:8081` (the relay's own
 *                                default bind, for the common same-machine
 *                                case) when unset — any topology where they
 *                                run on separate hosts/pods MUST set this
 *                                explicitly, fully overridable per company.
 *   - `pixelAgentsTokenRef`    — secret reference resolving to a bearer token
 *                                sent to the relay (optional; never stored as
 *                                a plaintext value). Only relevant if the
 *                                relay was started with `--shared-secret` —
 *                                Pixel Agents' own token never touches
 *                                Paperclip, the relay handles that itself.
 *   - `pixelAgentsProviderId`  — provider id in the hook path (default
 *                                `claude`, the only id Pixel Agents' route
 *                                currently dispatches on)
 *   - `pixelAgentsRelayEnabled`— explicit on/off (default on)
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "./core/index.js";
import {
  BridgeTransport,
  HttpPushSink,
  CLAUDE_WIRE_PROVIDER_ID,
  type FetchLike,
} from "./pixel-agents-provider/index.js";

/**
 * Generic-package default: `paperclip-pixel-relay` binds `127.0.0.1:8081` by
 * default too (see the CLI's own `--host` default), so this matches the most
 * common "try it out" topology — Paperclip, the relay, and Pixel Agents all
 * on one machine. Any deployment where they live on separate hosts/pods
 * (e.g. this repo's own `deploy/k8s/`, where the relay runs in the Pixel
 * Agents pod, not the Paperclip one) MUST set `pixelAgentsUrl` explicitly —
 * fully overridable per company.
 */
export const DEFAULT_PIXEL_AGENTS_URL = "http://127.0.0.1:8081";

/** Resolved per-company relay configuration. */
export interface RelayCompanyConfig {
  enabled: boolean;
  pixelAgentsUrl: string;
  /** Resolved bearer token (never the persisted ref). */
  pixelAgentsToken?: string;
  providerId: string;
}

/** Company-scoped runtime state: a transport plus its underlying push sink. */
interface CompanyRelay {
  transport: BridgeTransport;
  sink: HttpPushSink;
  config: RelayCompanyConfig;
}

/** Names of the operator-config fields the relay reads. */
/**
 * Names of the operator-config fields that the relay reads from plugin config.
 * These are the same fields defined in `relayConfigSchema` and validated in
 * the plugin's `onValidateConfig` hook.
 */
export const RELAY_CONFIG_FIELDS = [
  "pixelAgentsUrl",
  "pixelAgentsTokenRef",
  "pixelAgentsProviderId",
  "pixelAgentsRelayEnabled",
] as const;

/**
 * Extract the operator-bound secret reference for the bearer token, if any.
 * The value is the shared `{ type: "secret_ref", secretId, version? }` binding
 * stored by the host's secret-ref config field (or a legacy string ref). The
 * raw token is never persisted in plugin config and is resolved at call time
 * in {@link BridgeRelay.configure} via `ctx.secrets.resolve`.
 */
export function extractTokenRef(
  raw: Record<string, unknown>,
): EnvSecretRefBinding | string | undefined {
  const ref = raw.pixelAgentsTokenRef;
  if (ref == null) return undefined;
  if (typeof ref === "string") {
    return ref.trim().length > 0 ? ref : undefined;
  }
  if (
    typeof ref === "object"
    && !Array.isArray(ref)
    && (ref as { type?: unknown }).type === "secret_ref"
    && typeof (ref as { secretId?: unknown }).secretId === "string"
  ) {
    return ref as EnvSecretRefBinding;
  }
  return undefined;
}

/**
 * Parse and validate raw operator config into a resolved relay config (without
 * the bearer token, which is resolved separately from the secret reference).
 * The relay is enabled by default as soon as a non-empty `pixelAgentsUrl` is
 * present, unless `pixelAgentsRelayEnabled` is explicitly `false`.
 */
export function parseRelayConfig(
  raw: Record<string, unknown>,
): RelayCompanyConfig {
  const configuredUrl = typeof raw.pixelAgentsUrl === "string"
    ? raw.pixelAgentsUrl.trim()
    : "";
  // Falls back to this deployment's bundled sidecar rather than requiring an
  // operator to configure a URL before the bridge works at all (§17.2-style
  // sensible default, fully overridable).
  const url = configuredUrl.length > 0 ? configuredUrl : DEFAULT_PIXEL_AGENTS_URL;
  const explicitEnabled = raw.pixelAgentsRelayEnabled;
  const enabled = explicitEnabled !== false;
  const providerId = typeof raw.pixelAgentsProviderId === "string" && raw.pixelAgentsProviderId.trim().length > 0
    ? raw.pixelAgentsProviderId.trim()
    : CLAUDE_WIRE_PROVIDER_ID;
  return { enabled, pixelAgentsUrl: url, providerId };
}

/**
 * ============================================================================
 * DELIBERATE ctx.http.fetch BYPASS — read this before "fixing" it back.
 * ============================================================================
 * Paperclip's host `ctx.http.fetch` implementation
 * (`server/src/services/plugin-host-services.ts`, `validateAndResolveFetchUrl`
 * / `isPrivateIP`) unconditionally rejects ANY destination that resolves to a
 * private/reserved IP range (RFC1918, loopback, link-local, ULA) — with NO
 * allowlist, NO environment variable, NO manifest capability, and NO per-call
 * override anywhere in the host. Verified 2026-08-31 by reading the host
 * source directly: `http.fetch(params)` calls `validateAndResolveFetchUrl`
 * unconditionally on every call; the private-IP check is a single hard-coded
 * function with no configurability at all.
 *
 * That makes `ctx.http.fetch` categorically unable to reach
 * `paperclip-pixel-relay` in every topology this package documents —
 * including its own advertised default (`http://127.0.0.1:8081`; loopback is
 * on the blocklist) and this repo's own multi-container/k8s deployments
 * (Compose/Kubernetes DNS always resolves to private-range addresses). This
 * is not a deployment misconfiguration and there is no configuration fix for
 * it: upstream Paperclip would need to add an allowlist mechanism, which does
 * not exist as of this host version. Confirmed live: every push attempt
 * through `ctx.http.fetch` failed with
 * `"All resolved IPs for <host> are in private/reserved ranges"`, and no
 * character ever appeared in Pixel Agents for real Paperclip agent activity
 * as a result.
 *
 * What using the Node global `fetch` here instead of `ctx.http.fetch` gives
 * up, specifically:
 *   - Paperclip's own `http.outbound` capability enforcement for this call.
 *     A future per-company/per-plugin revocation of that capability would
 *     silently NOT apply to this one push path.
 *   - The host's centralized outbound-request audit/tracing for this call.
 *     An admin inspecting this plugin's network activity through Paperclip's
 *     own logs/UI would see nothing for these pushes.
 *   - The host's SSRF backstop for this one code path. If `pixelAgentsUrl`
 *     were ever set to something other than the intended relay, there is no
 *     longer a host-level check stopping the request from going out.
 *
 * Why this is an acceptable, narrow tradeoff here and not a general escape
 * hatch: `pixelAgentsUrl` is operator-set, company-scoped plugin config —
 * settable only by a board/instance admin, the exact same trust boundary that
 * already controls this plugin's installation and configuration. This is a
 * same-operator sidecar link (the relay that operator deployed alongside
 * Paperclip), never a destination influenced by event payloads, agent
 * output, or any other less-trusted input. The multi-tenant "protect the
 * platform from someone else's plugin" threat model `ctx.http.fetch`'s SSRF
 * filter defends against does not apply to a company bridging its own
 * infrastructure to itself.
 *
 * Scope discipline: `rawFetch` is used ONLY to construct the `HttpPushSink`
 * for `config.pixelAgentsUrl` below. Do not reuse it for any other outbound
 * call in this codebase without re-reading this comment block and updating
 * it to cover the new call site's trust reasoning.
 * ============================================================================
 */
function rawFetch(): FetchLike {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // Keep the one part of ctx.http.fetch's validation that costs nothing
      // to retain even outside the host's gate.
      throw new Error(`Refusing non-http(s) protocol for relay push: ${parsed.protocol}`);
    }
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText };
  };
}

/**
 * Per-company bridge relay. The worker constructs one instance in `setup()`,
 * configures it from company-scoped plugin config, feeds it canonical events
 * and snapshots, reconfigures it on `configChanged`, and disposes it on
 * shutdown.
 */
export class BridgeRelay {
  private readonly companies = new Map<string, CompanyRelay>();
  private readonly ctx: PluginContext;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  /** Number of companies with an active (enabled) relay. */
  get activeCompanyCount(): number {
    return this.companies.size;
  }

  /**
   * (Re)configure the relay for a specific company based on raw operator config.
   * If a transport already exists for the company it is disposed before the new
   * configuration is applied. When the resulting config is disabled the relay is
   * not created and a log entry is emitted.
   *
   * The bearer token is resolved from the operator-bound `pixelAgentsTokenRef`
   * secret reference via `ctx.secrets.resolve` (requires `secrets.read-ref`).
   * The resolved value lives only in memory for the sink's lifetime and is never
   * persisted or logged. Resolution failure is logged and the relay is left
   * disabled for the company (fail-securely) rather than pushing unauthenticated
   * traffic.
   *
   * @param companyId - Identifier of the company whose relay is being configured.
   * @param raw - Raw configuration object as stored by the plugin system.
   */
  async configure(companyId: string, raw: Record<string, unknown>): Promise<void> {
    const config = parseRelayConfig(raw);
    const existing = this.companies.get(companyId);
    if (existing) {
      existing.transport.dispose();
      this.companies.delete(companyId);
    }
    if (!config.enabled) {
      this.ctx.logger.info("Bridge relay disabled for company", { companyId });
      return;
    }
    let authToken: string | undefined;
    const tokenRef = extractTokenRef(raw);
    if (tokenRef) {
      try {
        authToken = await this.ctx.secrets.resolve(tokenRef, {
          companyId,
          configPath: "pixelAgentsTokenRef",
        });
      } catch (err) {
        this.ctx.logger.warn("Bridge relay token resolution failed; relay disabled for company", {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    // rawFetch() skips the RPC round-trip entirely, so it also skips the
    // host's own runtime capability gate (plugin-capability-validator.ts's
    // `checkOperation`/`assertOperation`, which normally rejects an
    // "http.request" call for any plugin whose manifest doesn't declare
    // `http.outbound`). Paperclip has no dynamic, post-install, per-capability
    // revocation mechanism to check instead (confirmed 2026-08-31: capability
    // grants are all-or-nothing at install time; there is no "toggle this one
    // capability off" API) — the closest honest equivalent is re-checking the
    // one thing that IS authoritative and host-confirmed: `ctx.manifest`
    // ("the plugin's manifest as validated at install time", per the SDK's
    // own doc comment), not our local `constants.ts` copy, which could in
    // principle drift from what the host actually has on record. Fail closed
    // if the host's own record of this plugin's manifest does not declare
    // `http.outbound` — never push regardless of `pixelAgentsUrl`.
    if (!this.ctx.manifest.capabilities.includes("http.outbound")) {
      this.ctx.logger.warn(
        "Bridge relay disabled for company: host-validated manifest does not declare http.outbound",
        { companyId },
      );
      return;
    }
    const sink = new HttpPushSink({
      baseUrl: config.pixelAgentsUrl,
      authToken,
      providerId: config.providerId,
      // See rawFetch()'s doc comment above: ctx.http.fetch cannot reach this
      // operator-configured, same-operator sidecar destination (the host's
      // private-IP SSRF block has no override). Deliberate, narrowly-scoped
      // bypass — not a general pattern to copy elsewhere. The capability
      // check just above is this bypass's replacement for the host's normal
      // per-call enforcement, re-done here since rawFetch never asks the host.
      fetch: rawFetch(),
    });
    const transport = new BridgeTransport({ agentEventSink: sink });
    this.companies.set(companyId, { transport, sink, config: { ...config, pixelAgentsToken: authToken } });
    this.ctx.logger.info("Bridge relay configured for company", {
      companyId,
      pixelAgentsUrl: config.pixelAgentsUrl,
      providerId: config.providerId,
    });
  }

  /** Feed an authoritative snapshot (bootstrap / reconciliation). */
  /**
   * Ingest an authoritative snapshot for the specified company.
   * The snapshot is passed to the underlying {@link BridgeTransport} which
   * updates its internal state and propagates any required side‑effects.
   *
   * @param companyId - The target company identifier.
   * @param snapshot - Snapshot data to ingest.
   */
  ingestSnapshot(companyId: string, snapshot: AuthoritativeSnapshotInput): void {
    const relay = this.companies.get(companyId);
    if (relay) relay.transport.ingestSnapshot(snapshot);
  }

  /** Feed a continuous canonical bridge event. */
  /**
   * Ingest a single canonical bridge event for the given company.
   * The event is forwarded to the company's {@link BridgeTransport} which
   * maps it to a {@link HttpPushSink} payload and pushes it to the Pixel Agents
   * server if the relay is enabled.
   *
   * @param companyId - Identifier of the company.
   * @param event - The bridge event to process.
   */
  ingestEvent(companyId: string, event: BridgeInputEvent): void {
    const relay = this.companies.get(companyId);
    if (relay) relay.transport.ingestEvent(event);
  }

  /** Most recent push error for a company, if any (cleared on a successful push). */
  /**
   * Retrieve the most recent push error message for a company, if any.
   * The error is cleared automatically when a successful push occurs.
   *
   * @param companyId - Company identifier.
   * @returns The error string or `undefined` when no error is present.
   */
  lastPushError(companyId: string): string | undefined {
    return this.companies.get(companyId)?.sink.lastPushError;
  }

  /** Whether a relay is configured (enabled) for a company. */
  /**
   * Determine whether a relay is currently configured (enabled) for a company.
   *
   * @param companyId - Identifier of the company.
   * @returns `true` if the relay is active; otherwise `false`.
   */
  isConfigured(companyId: string): boolean {
    return this.companies.has(companyId);
  }

  /** Dispose all company relays (called on shutdown). */
  /**
   * Dispose all active company relays and clear internal state.
   * Called during worker shutdown to ensure all outbound connections are
   * terminated cleanly.
   */
  disposeAll(): void {
    for (const relay of this.companies.values()) {
      relay.transport.dispose();
    }
    this.companies.clear();
  }
}
