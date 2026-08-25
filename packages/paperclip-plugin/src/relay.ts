/**
 * In-plugin bridge relay (spec PAPERCLIP_PIXELS-2, §2).
 *
 * Connects the canonical bridge contract produced by this worker to a Pixel
 * Agents server's hook endpoint (`POST /api/hooks/<providerId>`). The relay
 * owns one {@link BridgeTransport} per company, fed the same canonical
 * `BridgeInputEvent`s the worker already applies to its `BridgeStore` and the
 * same authoritative snapshots it bootstraps/reconciles from. Each transport
 * maps events into Pixel Agents `AgentEvent`s (plus the rich sidecar) and
 * pushes them through an {@link HttpPushSink}.
 *
 * Configuration is operator-set, company-scoped plugin config (the worker env
 * is scrubbed by the host, so env vars are not available here). Config fields:
 *   - `pixelAgentsUrl`         — base URL of the Pixel Agents server (required;
 *                                must be `https:` when a token is configured)
 *   - `pixelAgentsTokenRef`    — secret reference resolving to the bearer token
 *                                for the hook endpoint (optional; never stored
 *                                as a plaintext value)
 *   - `pixelAgentsProviderId`  — provider id in the hook path (default
 *                                `paperclip-bridge`)
 *   - `pixelAgentsRelayEnabled`— explicit on/off (default on when a URL is set)
 *
 * Reaching the *current* Pixel Agents runtime (events appearing in the office
 * UI) additionally requires the upstream per-`providerId` dispatch change so
 * the `paperclip-bridge` provider normalizes these envelopes instead of the
 * single injected `claudeProvider` (spike SAA-175 §5/§6; tracked separately).
 * The relay itself is provider-agnostic: it pushes correctly shaped envelopes
 * and the Pixel Agents HTTP route accepts and acknowledges them today.
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "@paperclip-pixel/core";
import {
  BridgeTransport,
  HttpPushSink,
  PAPERCLIP_BRIDGE_PROVIDER_ID,
  type FetchLike,
} from "@paperclip-pixel/pixel-agents-provider";

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
  const url = typeof raw.pixelAgentsUrl === "string"
    ? raw.pixelAgentsUrl.trim()
    : "";
  const explicitEnabled = raw.pixelAgentsRelayEnabled;
  const enabled = url.length > 0 && explicitEnabled !== false;
  const providerId = typeof raw.pixelAgentsProviderId === "string" && raw.pixelAgentsProviderId.trim().length > 0
    ? raw.pixelAgentsProviderId.trim()
    : PAPERCLIP_BRIDGE_PROVIDER_ID;
  return { enabled, pixelAgentsUrl: url, providerId };
}

/**
 * Adapt this relay's SDK-gated `ctx.http.fetch` (RequestInit/Response) to the
 * provider's injectable `FetchLike` (which keeps the provider free of node
 * globals). Routing the push through `ctx.http.fetch` — never the Node global
 * `fetch` — keeps the relay behind the manifest's declared `http.outbound`
 * capability gate and the host's outbound tracing/audit.
 */
function gateFetch(httpClient: PluginContext["http"]): FetchLike {
  return async (url, init) => {
    const res = await httpClient.fetch(url, {
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
    const sink = new HttpPushSink({
      baseUrl: config.pixelAgentsUrl,
      authToken,
      providerId: config.providerId,
      fetch: gateFetch(this.ctx.http),
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
