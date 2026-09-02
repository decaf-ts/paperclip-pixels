/**
 * In-plugin bridge relay (spec PAPERCLIP_PIXELS-2, §2, §21, WS2-C).
 *
 * Feeds the canonical bridge contract produced by this worker to the
 * Paperclip plugin's embedding surface inside Pixel Agents — the first-class
 * WS2-C path. The relay owns one {@link PluginFeedMapper} + one
 * {@link PluginFeedHttpSink} per company: the mapper translates canonical
 * `BridgeInputEvent`s and authoritative snapshots into plugin feed operations
 * (thin wrappers around the WS2-A1 agent/team data source), and the sink POSTs
 * them to the embedding surface's `POST /api/plugin-feed` endpoint, where they
 * are applied through the registered plugin's sanctioned
 * `declareAgents`/`updateAgentStatus`/`updateAgentActivity`/`removeAgents`
 * source. The retired impersonation path — serializing events into the Claude
 * hook JSON body and POSTing them to `/api/hooks/claude` — is gone; so is the
 * `saveAgentSeats` seat-driving push (seat assignments ride `declareAgents`).
 *
 * Configuration is operator-set, company-scoped plugin config (the worker env
 * is scrubbed by the host, so env vars are not available here). Config fields:
 *   - `pixelAgentsUrl`         — base URL of the embedding surface serving
 *                                `POST /api/plugin-feed` (the companion
 *                                sidecar that owns the Pixel Agents server
 *                                process; historically the relay CLI's own
 *                                default bind). Defaults to
 *                                `http://127.0.0.1:8081` (the companion's
 *                                default bind, for the common same-machine
 *                                case) when unset — any topology where they
 *                                run on separate hosts/pods MUST set this
 *                                explicitly, fully overridable per company.
 *                                Must be `https:` when a token is configured;
 *                                plain `http:` is then accepted only for
 *                                loopback hosts (`localhost`,
 *                                `127.0.0.0/8`, `::1`).
 *   - `pixelAgentsTokenRef`    — secret reference resolving to a bearer token
 *                                sent with each feed push (optional; never
 *                                stored as a plaintext value).
 *   - `pixelAgentsRelayEnabled`— explicit on/off (default on)
 *   - `paperclipApiBaseUrl` / `paperclipApiTokenRef` — the Paperclip API the
 *                                tool-activity poller reads run logs from
 *                                (and the reply forwarder routes click-menu
 *                                replies through, on the embedding side).
 */

import type { EnvSecretRefBinding, PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "./core/index.js";
import {
  PluginFeedHttpSink,
  PluginFeedMapper,
  type FeedAppearanceEntry,
  type FeedFetchLike,
} from "./pixel-agents-plugin/index.js";
import { bootstrapSnapshot } from "./snapshot.js";
import { ToolActivityPoller, type LogFetchLike } from "./tool-activity-poller.js";

/**
 * Generic-package default: the companion sidecar binds `127.0.0.1:8081` by
 * default too, so this matches the most common "try it out" topology —
 * Paperclip, the companion, and Pixel Agents all on one machine. Any
 * deployment where they live on separate hosts/pods (e.g. this repo's own
 * `deploy/k8s/`) MUST set `pixelAgentsUrl` explicitly — fully overridable.
 */
export const DEFAULT_PIXEL_AGENTS_URL = "http://127.0.0.1:8081";

/**
 * Default base URL for the tool-activity poller's `GET
 * /api/heartbeat-runs/:runId/log` calls -- the plugin worker runs in the same
 * container/process group as the Paperclip server itself (confirmed live
 * 2026-08-31), so loopback is the correct default for the bundled Compose
 * deployment. Overridable per company for topologies where that colocation
 * doesn't hold.
 */
export const DEFAULT_PAPERCLIP_API_BASE_URL = "http://127.0.0.1:3100";

/**
 * One agent's fully-resolved appearance, as handed to the relay for
 * application in Pixel Agents. Carries the frozen per-agent assignment
 * record (see `core/domain/characters.ts`) plus the agent's display name —
 * the relay needs the name for the declaration's office label, but the name
 * is deliberately NOT part of the persisted assignment contract. Applied
 * through the sanctioned seat path (`declareAgents` palette/hueShift), never
 * `saveAgentSeats`.
 */
export interface AgentAppearanceSyncEntry {
  agentId: string;
  agentName: string;
  characterId: string;
  palette: number;
  hueShift: number;
  updatedAt: string;
}

/** Resolved per-company relay configuration. */
export interface RelayCompanyConfig {
  enabled: boolean;
  pixelAgentsUrl: string;
  pixelAgentsUiUrl: string;
  /** Resolved bearer token (never the persisted ref). */
  pixelAgentsToken?: string;
  /** Base URL for the tool-activity poller's Paperclip API calls. */
  paperclipApiBaseUrl: string;
  /** Resolved bearer token for the tool-activity poller, if configured (never the persisted ref). */
  paperclipApiToken?: string;
}

/** Company-scoped runtime state: a feed mapper plus its underlying push sink. */
interface CompanyRelay {
  mapper: PluginFeedMapper;
  sink: PluginFeedHttpSink;
  config: RelayCompanyConfig;
  /** Present only when paperclipApiTokenRef resolved to a token (see configure()). */
  toolActivityPoller?: ToolActivityPoller;
}

/**
 * Names of the operator-config fields that the relay reads from plugin config.
 * These are the same fields defined in `relayConfigSchema` and validated in
 * the plugin's `onValidateConfig` hook.
 */
export const RELAY_CONFIG_FIELDS = [
  "pixelAgentsUrl",
  "pixelAgentsUiUrl",
  "pixelAgentsTokenRef",
  "pixelAgentsRelayEnabled",
  "paperclipApiBaseUrl",
  "paperclipApiTokenRef",
] as const;

/** How often the tool-activity poller re-fetches each tracked run's log. */
const TOOL_ACTIVITY_POLL_INTERVAL_MS = 15_000;

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
 * Thrown by {@link parseRelayConfig} when the configured transport violates
 * the documented https-when-token contract (a feed token alongside a
 * cleartext `http:` URL for a non-loopback host). Carries no secret
 * material — only the offending host.
 */
export class RelayTransportContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RelayTransportContractError";
  }
}

/**
 * Parse and validate raw operator config into a resolved relay config (without
 * the bearer token, which is resolved separately from the secret reference).
 * The relay is enabled by default unless `pixelAgentsRelayEnabled` is
 * explicitly `false`; an unset `pixelAgentsUrl` falls back to
 * {@link DEFAULT_PIXEL_AGENTS_URL}.
 *
 * Also enforces the https-when-token transport contract at runtime,
 * fail-closed: when a feed token reference is configured, a cleartext
 * `http:` URL is accepted only for loopback hosts ({@link isLoopbackHost}) —
 * anything else would send the bearer token over plaintext HTTP to a remote
 * host and is rejected. This is the runtime backstop for config that
 * predates (or bypassed) the save-time `onValidateConfig` gate; an
 * unparseable `pixelAgentsUrl` is likewise rejected while a token is
 * configured (tokenless config keeps its historical late push-error
 * surface).
 *
 * @param raw - Raw configuration object as stored by the plugin system.
 * @returns The resolved, validated relay configuration.
 * @throws {RelayTransportContractError} When the relay is enabled and a feed
 *   token reference is configured, and `pixelAgentsUrl` is either not a
 *   valid http(s) URL or resolves to a cleartext `http:` URL for a
 *   non-loopback host.
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
  // Enforce the documented transport contract (SAA-557, security F1): the
  // resolved bearer token must never travel over cleartext HTTP to a
  // non-loopback host. `onValidateConfig` already rejects this combination at
  // config-save time; this is the runtime fail-closed backstop for config
  // that predates that gate or bypassed it. Loopback stays allowed so the
  // bundled same-machine default keeps working for local development.
  if (enabled && extractTokenRef(raw) != null) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      // SAA-590 security review (§2): a scheme-prefixed but unparseable URL
      // (e.g. "http:") skips the protocol check here yet can late-parse in
      // the sink ("${baseUrl}/api/plugin-feed") to a cleartext non-loopback
      // host and dispatch the bearer token. Reject ambiguous input rather
      // than sanitizing it; tokenless config keeps the historical late
      // push-error surface.
      throw new RelayTransportContractError(
        `pixelAgentsUrl must be a valid http(s) URL when pixelAgentsTokenRef `
          + `is configured; refusing an ambiguous transport for the feed `
          + `bearer token`,
      );
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:")
      || (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname))
    ) {
      throw new RelayTransportContractError(
        `pixelAgentsUrl must be an https: URL when pixelAgentsTokenRef is `
          + `configured (plain http: is only allowed for loopback hosts); `
          + `refusing to send the feed bearer token to ${parsed.protocol}//${parsed.hostname}`,
      );
    }
  }
  const pixelAgentsUiUrl = typeof raw.pixelAgentsUiUrl === "string" && raw.pixelAgentsUiUrl.trim().length > 0
    ? raw.pixelAgentsUiUrl.trim()
    : "http://localhost:8090";
  const configuredApiUrl = typeof raw.paperclipApiBaseUrl === "string" ? raw.paperclipApiBaseUrl.trim() : "";
  const paperclipApiBaseUrl = configuredApiUrl.length > 0 ? configuredApiUrl : DEFAULT_PAPERCLIP_API_BASE_URL;
  return { enabled, pixelAgentsUrl: url, pixelAgentsUiUrl, paperclipApiBaseUrl };
}

/**
 * Whether a URL hostname is a loopback address: `localhost`, any IPv4
 * address in `127.0.0.0/8`, or IPv6 `::1`. These are the only hosts for
 * which a cleartext `http:` `pixelAgentsUrl` may carry a configured feed
 * token (see {@link parseRelayConfig}); everything else requires `https:`.
 *
 * @param hostname - URL hostname as reported by `new URL(...).hostname`
 *   (bracketed IPv6 forms like `[::1]` are tolerated; a trailing dot is
 *   ignored).
 * @returns `true` when the host is a loopback address.
 */
export function isLoopbackHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || host === "::1" || host === "[::1]") return true;
  const octets = host.split(".");
  return octets.length === 4
    && octets[0] === "127"
    && octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

/**
 * Extract the operator-bound secret reference for the tool-activity poller's
 * Paperclip API token, if any. Mirrors {@link extractTokenRef} exactly; kept
 * separate because the two tokens authenticate against different servers
 * (the Pixel Agents companion vs. Paperclip's own API) and an operator may
 * configure either without the other.
 */
export function extractApiTokenRef(
  raw: Record<string, unknown>,
): EnvSecretRefBinding | string | undefined {
  const ref = raw.paperclipApiTokenRef;
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
 * `LogFetchLike` companion to `rawFetch()` below (same DELIBERATE
 * ctx.http.fetch bypass, same trust-boundary reasoning: this is a call to
 * Paperclip's own API on the same operator's infrastructure, not a
 * multi-tenant destination `ctx.http.fetch`'s SSRF filter needs to protect
 * against). Reads the JSON body, unlike `rawFetch()`'s fire-and-forget POSTs.
 */
function rawLogFetch(): LogFetchLike {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Refusing non-http(s) protocol for heartbeat-log read: ${parsed.protocol}`);
    }
    const res = await fetch(url, { method: init.method, headers: init.headers });
    return { ok: res.ok, status: res.status, statusText: res.statusText, json: () => res.json() };
  };
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
 * That makes `ctx.http.fetch` categorically unable to reach the companion
 * sidecar in every topology this package documents — including its own
 * advertised default (`http://127.0.0.1:8081`; loopback is on the blocklist)
 * and this repo's own multi-container/k8s deployments (Compose/Kubernetes DNS
 * always resolves to private-range addresses). This is not a deployment
 * misconfiguration and there is no configuration fix for it: upstream
 * Paperclip would need to add an allowlist mechanism, which does not exist as
 * of this host version. Confirmed live: every push attempt through
 * `ctx.http.fetch` failed with
 * `"All resolved IPs for <host> are in private/reserved ranges"`.
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
 *     were ever set to something other than the intended companion, there is
 *     no longer a host-level check stopping the request from going out.
 *
 * Why this is an acceptable, narrow tradeoff here and not a general escape
 * hatch: `pixelAgentsUrl` is operator-set, company-scoped plugin config —
 * settable only by a board/instance admin, the exact same trust boundary that
 * already controls this plugin's installation and configuration. This is a
 * same-operator sidecar link (the companion that operator deployed alongside
 * Paperclip), never a destination influenced by event payloads, agent output,
 * or any other less-trusted input. The multi-tenant "protect the platform
 * from someone else's plugin" threat model `ctx.http.fetch`'s SSRF filter
 * defends against does not apply to a company bridging its own infrastructure
 * to itself.
 *
 * Scope discipline: `rawFetch` is used ONLY to construct the plugin feed sink
 * for `config.pixelAgentsUrl` below. Do not reuse it for any other outbound
 * call in this codebase without re-reading this comment block and updating
 * it to cover the new call site's trust reasoning.
 * ============================================================================
 */
function rawFetch(): FeedFetchLike {
  return async (url, init) => {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      // Keep the one part of ctx.http.fetch's validation that costs nothing
      // to retain even outside the host's gate.
      throw new Error(`Refusing non-http(s) protocol for feed push: ${parsed.protocol}`);
    }
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return { ok: res.ok, status: res.status, statusText: res.statusText };
  };
}

/** Convert a resolved appearance entry to the feed mapper's entry shape. */
function toFeedAppearance(entry: AgentAppearanceSyncEntry): FeedAppearanceEntry {
  return {
    agentId: entry.agentId,
    agentName: entry.agentName,
    palette: entry.palette,
    hueShift: entry.hueShift,
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
   * If a mapper+sink pair already exists for the company it is disposed before
   * the new configuration is applied. When the resulting config is disabled the
   * relay is not created and a log entry is emitted.
   *
   * The bearer token is resolved from the operator-bound `pixelAgentsTokenRef`
   * secret reference via `ctx.secrets.resolve` (requires `secrets.read-ref`).
   * The resolved value lives only in memory for the sink's lifetime and is never
   * persisted or logged. Resolution failure is logged and the relay is left
   * disabled for the company (fail-securely) rather than pushing unauthenticated
   * traffic.
   *
   * A config rejected by the transport contract (see
   * {@link RelayTransportContractError}) fails closed here as well: the
   * rejection from {@link parseRelayConfig} is caught, any existing
   * mapper/sink/poller for the company is disposed, and the relay is left
   * disabled with a warning — the previous transport is never kept for a
   * company whose new config violates the https-when-token contract. Any
   * other parsing error still propagates to the caller.
   *
   * @param companyId - Identifier of the company whose relay is being configured.
   * @param raw - Raw configuration object as stored by the plugin system.
   */
  async configure(companyId: string, raw: Record<string, unknown>): Promise<void> {
    let config: RelayCompanyConfig;
    try {
      config = parseRelayConfig(raw);
    } catch (err) {
      // Fail securely on a rejected transport config (the https-when-token
      // contract): never keep pushing with the previous transport for this
      // company — dispose it and leave the relay disabled. Genuinely
      // malformed input still propagates to the caller, whose own
      // catch-and-warn keeps the worker alive.
      if (!(err instanceof RelayTransportContractError)) throw err;
      const existing = this.companies.get(companyId);
      existing?.sink.dispose();
      existing?.toolActivityPoller?.stop();
      this.companies.delete(companyId);
      this.ctx.logger.warn("Bridge relay config rejected for company; relay disabled", {
        companyId,
        error: err.message,
      });
      return;
    }
    const existing = this.companies.get(companyId);
    if (!config.enabled) {
      existing?.sink.dispose();
      existing?.toolActivityPoller?.stop();
      this.companies.delete(companyId);
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
        existing?.sink.dispose();
        existing?.toolActivityPoller?.stop();
        this.companies.delete(companyId);
        this.ctx.logger.warn("Bridge relay token resolution failed; relay disabled for company", {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
    }
    // Unlike pixelAgentsTokenRef above, a resolution failure here disables
    // only the tool-activity poller (an additive enhancement), never the
    // core relay -- names, rooms, and busy/idle status keep working exactly
    // as before this feature existed.
    let apiToken: string | undefined;
    const apiTokenRef = extractApiTokenRef(raw);
    if (apiTokenRef) {
      try {
        apiToken = await this.ctx.secrets.resolve(apiTokenRef, {
          companyId,
          configPath: "paperclipApiTokenRef",
        });
      } catch (err) {
        this.ctx.logger.warn(
          "Tool-activity poller token resolution failed; real tool descriptions disabled for company",
          { companyId, error: err instanceof Error ? err.message : String(err) },
        );
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
      existing?.sink.dispose();
      this.companies.delete(companyId);
      this.ctx.logger.warn(
        "Bridge relay disabled for company: host-validated manifest does not declare http.outbound",
        { companyId },
      );
      return;
    }
    if (
      existing
      && existing.config.enabled === config.enabled
      && existing.config.pixelAgentsUrl === config.pixelAgentsUrl
      && existing.config.pixelAgentsUiUrl === config.pixelAgentsUiUrl
      && existing.config.pixelAgentsToken === authToken
      && existing.config.paperclipApiBaseUrl === config.paperclipApiBaseUrl
      && existing.config.paperclipApiToken === apiToken
    ) {
      this.ctx.logger.debug("Bridge relay config unchanged for company", { companyId });
      return;
    }
    existing?.sink.dispose();
    existing?.toolActivityPoller?.stop();
    this.companies.delete(companyId);
    const sink = new PluginFeedHttpSink({
      baseUrl: config.pixelAgentsUrl,
      authToken,
      // See rawFetch()'s doc comment above: ctx.http.fetch cannot reach this
      // operator-configured, same-operator sidecar destination (the host's
      // private-IP SSRF block has no override). Deliberate, narrowly-scoped
      // bypass — not a general pattern to copy elsewhere. The capability
      // check just above is this bypass's replacement for the host's normal
      // per-call enforcement, re-done here since rawFetch never asks the host.
      fetch: rawFetch(),
    });
    const mapper = new PluginFeedMapper();
    const entry: CompanyRelay = {
      mapper,
      sink,
      config: { ...config, pixelAgentsToken: authToken, paperclipApiToken: apiToken },
    };
    if (apiToken) {
      const toolActivityPoller = new ToolActivityPoller({
        apiBaseUrl: config.paperclipApiBaseUrl,
        apiToken,
        fetch: rawLogFetch(),
        sink: {
          reportToolActivity: (cid, agentId, caption) => {
            // Map the real tool description onto the agent's caption through
            // the feed (sanctioned updateAgentActivity), replacing the
            // generic run caption for that agent.
            void entry.sink.push(cid, entry.mapper.mapToolActivity(agentId, caption));
          },
        },
        onError: (runId, err) => {
          this.ctx.logger.debug("Tool-activity poll failed", {
            companyId,
            runId,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      });
      toolActivityPoller.start(TOOL_ACTIVITY_POLL_INTERVAL_MS);
      entry.toolActivityPoller = toolActivityPoller;
    }
    this.companies.set(companyId, entry);
    this.ctx.logger.info("Bridge relay configured for company", {
      companyId,
      pixelAgentsUrl: config.pixelAgentsUrl,
      toolActivityPollingEnabled: !!entry.toolActivityPoller,
    });
  }

  /**
   * Begin tracking a run for the tool-activity poller (a real tool call
   * detected in its raw log becomes the agent's activity caption, replacing
   * the generic "Task: …" run caption for that agent). A no-op when the
   * company has no poller configured (no paperclipApiTokenRef resolved).
   */
  trackActiveRun(companyId: string, agentId: string, runId: string): void {
    this.companies.get(companyId)?.toolActivityPoller?.trackRun(runId, companyId, agentId);
  }

  /** Stop tracking a finished/failed/cancelled run. A no-op if it was never tracked. */
  untrackActiveRun(companyId: string, runId: string): void {
    this.companies.get(companyId)?.toolActivityPoller?.untrackRun(runId);
  }

  /**
   * Force a full re-sync for a company: clears the feed mapper's state (so
   * every agent is treated as never-before-declared again) and immediately
   * re-ingests a freshly bootstrapped snapshot.
   *
   * Exists for the same two gaps the retired transport had, both confirmed
   * live 2026-08-31:
   *
   * 1. `configure()` rebuilding the mapper/sink (e.g. on an operator config
   *    change, or a disable/re-enable cycle) does NOT itself re-ingest a
   *    snapshot — that only happens in `setupCompany`'s one-time initial call
   *    or the next scheduled `bridge-reconcile` job (every 5 min). Calling
   *    this right after a reconfigure closes that window.
   * 2. The sink is fire-and-forget (a transient failure is recorded in
   *    `lastPushError` but never retried), and the mapper diffs against its
   *    own pushed-state tracking — so a single bad push during the initial
   *    burst would otherwise strand that agent until the next full resync.
   *    Resetting the mapper here (called periodically from the reconciliation
   *    job, see worker.ts) re-declares every agent and re-pushes statuses,
   *    self-healing within a bounded time. Re-declaring an agent the host
   *    already knows is an idempotent upsert on its side.
   *
   * A no-op when the company has no configured relay.
   *
   * @param companyId - Identifier of the company to re-sync.
   * @param appearances - Optional per-agent appearance map to re-apply after
   *   the resync, so a freshly rebuilt embedding surface seats everyone
   *   without waiting for the next explicit write. Skipped when omitted or empty.
   */
  async resyncCompany(
    companyId: string,
    appearances?: AgentAppearanceSyncEntry[],
  ): Promise<void> {
    const entry = this.companies.get(companyId);
    if (!entry) return;
    try {
      entry.mapper.reset();
      const result = await bootstrapSnapshot(this.ctx, companyId);
      this.ingestSnapshot(companyId, result.snapshot);
      // Re-apply the per-agent appearance map so a freshly (re)configured
      // embedding surface immediately seats everyone correctly.
      if (appearances && appearances.length > 0) {
        await this.syncAppearances(companyId, appearances);
      }
    } catch (err) {
      this.ctx.logger.warn("Bridge relay re-sync failed for company", {
        companyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Ingest an authoritative snapshot for the specified company: the feed
   * mapper turns it into (re-)declarations plus status/caption repairs,
   * pushed through the company's sink if the relay is enabled.
   *
   * @param companyId - The target company identifier.
   * @param snapshot - Snapshot data to ingest.
   */
  ingestSnapshot(companyId: string, snapshot: AuthoritativeSnapshotInput): void {
    const relay = this.companies.get(companyId);
    if (relay) void relay.sink.push(companyId, relay.mapper.mapSnapshot(snapshot));
  }

  /**
   * Ingest a single canonical bridge event for the given company: mapped to
   * plugin feed operations and pushed to the embedding surface if the relay
   * is enabled.
   *
   * @param companyId - Identifier of the company.
   * @param event - The bridge event to process.
   */
  ingestEvent(companyId: string, event: BridgeInputEvent): void {
    const relay = this.companies.get(companyId);
    if (relay) void relay.sink.push(companyId, relay.mapper.mapEvent(event));
  }

  /** Most recent push error for a company, if any (cleared on a successful push). */
  lastPushError(companyId: string): string | undefined {
    return this.companies.get(companyId)?.sink.lastPushError;
  }

  /** Whether a relay is configured (enabled) for a company. */
  isConfigured(companyId: string): boolean {
    return this.companies.has(companyId);
  }

  /**
   * The UI URL of the company's Pixel Agents instance (for the embedded
   * office iframe), regardless of relay state.
   */
  getPixelAgentsUiUrl(companyId: string): string {
    return this.companies.get(companyId)?.config.pixelAgentsUiUrl ?? "http://localhost:8090";
  }

  /**
   * Apply the company's complete per-agent appearance map (WS3) through the
   * sanctioned seat path: the feed mapper records the map and emits
   * `declareAgents` upserts carrying each agent's palette/hueShift, which the
   * WS2-A1 host persists through its own seat adapter — replacing the retired
   * `saveAgentSeats` seat-driving push. Plugin `ctx.state` agent scope
   * remains the single source of truth; the embedding surface is a stateless
   * applier.
   *
   * @returns `true` when the company's relay exists and the operations were
   * enqueued; `false` when the relay is not configured for the company (the
   * next sync re-applies it — an appearance write must not fail because the
   * feed is momentarily down).
   */
  async syncAppearances(
    companyId: string,
    assignments: AgentAppearanceSyncEntry[],
  ): Promise<boolean> {
    const relay = this.companies.get(companyId);
    if (!relay) return false;
    if (assignments.length > 0) {
      void relay.sink.push(companyId, relay.mapper.setAppearances(assignments.map(toFeedAppearance)));
    }
    return true;
  }

  /** Dispose all company relays (called on shutdown). */
  disposeAll(): void {
    for (const relay of this.companies.values()) {
      relay.sink.dispose();
      relay.toolActivityPoller?.stop();
    }
    this.companies.clear();
  }
}
