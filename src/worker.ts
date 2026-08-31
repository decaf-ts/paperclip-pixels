import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  BridgeStore,
  type BehaviorChangedEvent,
  type BridgeUiEvent,
  type CompanySummary,
  BRIDGE_SCHEMA_VERSION,
  TIME_WINDOWS,
  type TimeWindow,
  type WindowedMetrics,
} from "./core/index.js";
import type { BridgeAgentView, BridgeCompanySnapshot } from "./ui/bridge-contract.js";
import manifest from "./manifest.js";
import {
  DATA_KEYS,
  JOB_KEYS,
  STREAM_CHANNELS,
  SUBSCRIBED_EVENT_TYPES,
  behaviorChannel,
} from "./constants.js";
import { bootstrapAllCompanies, bootstrapSnapshot } from "./snapshot.js";
import { mapPluginEvent } from "./subscriptions.js";
import {
  loadCompactBuckets,
  persistCompactBuckets,
  persistLastReconciledAt,
  persistSchemaVersion,
} from "./persistence.js";
import { registerActions } from "./actions.js";
import { BridgeRelay } from "./relay.js";

/**
 * A valid `pixelAgentsTokenRef` is either the shared
 * `{ type: "secret_ref", secretId, version? }` binding produced by the host's
 * secret-ref config field, or a legacy non-empty string ref. Anything else is
 * rejected by `onValidateConfig` so a malformed stored ref surfaces at validate
 * time rather than as a runtime resolution error.
 */
/**
 * Validates that a token reference is either a non‑empty string or a secret‑ref binding.
 * Used by configuration validation to ensure the bearer token is supplied correctly.
 */
function isValidTokenRef(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0;
  return (
    typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && (value as { type?: unknown }).type === "secret_ref"
    && typeof (value as { secretId?: unknown }).secretId === "string"
  );
}

interface CompanyRuntime {
  store: BridgeStore;
  companyId: string;
  leadershipAgentId?: string;
}

/**
 * Composes the UI-view `BridgeCompanySnapshot` served by the `bridge-snapshot`
 * data handler (spec §15) from the authoritative `BridgeStore`. The store's
 * `RawSnapshot` is a persistence-centric projection; the UI contract carries
 * `summary`, per-agent `BridgeAgentView` entries (projection + full
 * TIME_WINDOWS metrics + behavior vector FR-3/FR-4), and outstanding
 * `feedback`. Composing here keeps core free of UI-view types while honoring
 * the canonical UI contract for every host that consumes `bridge-snapshot`.
 */
function buildCompanySnapshot(rt: CompanyRuntime): BridgeCompanySnapshot {
  const raw = rt.store.getRawSnapshot();
  const agents: BridgeAgentView[] = raw.agents.map((projection) => ({
    projection,
    metrics: Object.fromEntries(
      TIME_WINDOWS.map((window) => [window, rt.store.getWindowedMetrics(projection.agentId, window)] as const),
    ) as Record<TimeWindow, WindowedMetrics>,
    behavior: rt.store.getBehaviorVector(projection.agentId),
  }));
  return {
    schemaVersion: BRIDGE_SCHEMA_VERSION,
    company: raw.company ?? { id: rt.companyId, name: rt.companyId },
    summary: rt.store.getCompanySummary(),
    agents,
    issues: raw.issues,
    projects: raw.projects,
    approvals: raw.approvals,
    feedback: rt.store.getOutstandingFeedback(rt.companyId),
    observedAt: raw.observedAt,
    lastReconciledAt: raw.lastReconciledAt,
  };
}

class BridgeRuntime {
  readonly companies = new Map<string, CompanyRuntime>();
  readonly ctx: PluginContext;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private persistenceTimer: ReturnType<typeof setInterval> | null = null;

  constructor(ctx: PluginContext) {
    this.ctx = ctx;
  }

  getOrCreateCompany(companyId: string): CompanyRuntime {
    let rt = this.companies.get(companyId);
    if (!rt) {
      rt = { store: new BridgeStore(), companyId };
      this.companies.set(companyId, rt);
    }
    return rt;
  }

  getCompany(companyId: string): CompanyRuntime | undefined {
    return this.companies.get(companyId);
  }

  startTimers(): void {
    this.flushTimer = setInterval(() => {
      for (const rt of this.companies.values()) {
        rt.store.flushBehavior();
      }
    }, 30_000);

    this.persistenceTimer = setInterval(() => {
      void this.persistAllBuckets();
    }, 60_000);
  }

  async persistAllBuckets(): Promise<void> {
    for (const rt of this.companies.values()) {
      const buckets = rt.store.exportCompactBuckets();
      await persistCompactBuckets(this.ctx, rt.companyId, buckets);
    }
  }

  async stopTimers(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.persistenceTimer) clearInterval(this.persistenceTimer);
    this.flushTimer = null;
    this.persistenceTimer = null;
    await this.persistAllBuckets();
  }

  emitBridgeEvent(companyId: string, type: string, payload: unknown): void {
    const event: BridgeUiEvent = {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      eventId: `bridge-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      companyId,
      occurredAt: new Date().toISOString(),
      payload,
    };
    this.ctx.streams.emit(STREAM_CHANNELS.bridge, event);
  }

  // The UI subscribes to the company-scoped behavior channel (use-bridge.ts:
  // usePluginStream(behaviorChannel(companyId))) and live-applies deltas whose
  // type is in BRIDGE_STREAM_EVENT_TYPES (bridge-contract.ts). Reconstruction /
  // event-driven store mutations must be pushed as `company.summary.changed`
  // (or `bridge.snapshot` / `feedback.changed`) on that channel — the shared
  // `bridge` channel events (emitBridgeEvent) are NOT consumed by the Pixel
  // Office UI, so without this the summary only updates on manual refresh.
  /**
   * Emit a **company.summary.changed** `BridgeUiEvent` on the company-specific
   * behavior channel. This is used by UI live gauges to react to a new
   * summary for the given company.
   *
   * @param companyId - The unique identifier of the company whose summary changed.
   * @param summary - The new `CompanySummary` payload to broadcast.
   */
  emitCompanySummaryChanged(companyId: string, summary: CompanySummary): void {
    const uiEvent: BridgeUiEvent = {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      eventId: `bridge-summary-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: "company.summary.changed",
      companyId,
      occurredAt: new Date().toISOString(),
      payload: summary,
    };
    this.ctx.streams.emit(behaviorChannel(companyId), uiEvent);
  }

  emitBehaviorChange(change: BehaviorChangedEvent): void {
    const uiEvent: BridgeUiEvent = {
      schemaVersion: BRIDGE_SCHEMA_VERSION,
      eventId: `bridge-behavior-${change.agentId}-${change.occurredAt}`,
      type: change.type,
      companyId: change.companyId,
      occurredAt: change.occurredAt,
      payload: change.payload,
    };
    this.ctx.streams.emit(behaviorChannel(change.companyId), uiEvent);
  }
}

/**
 * Initialise runtime support for a company.
 * Opens both the per-company **behaviorChannel(companyId)** and the shared
 * **STREAM_CHANNELS.bridge** so that subsequent `BridgeUiEvent`s contain a
 * non-empty `companyId` (fulfilling AC#2 from SAA-316).
 *
 * @param ctx - The plugin execution context.
 * @param runtime - The `BridgeRuntime` instance managing UI events.
 * @param companyId - Identifier of the company being set-up.
 * @param relay - The bridge relay used for event emission.
 */
async function setupCompany(ctx: PluginContext, runtime: BridgeRuntime, companyId: string, relay: BridgeRelay): Promise<CompanyRuntime> {
  const restoredBuckets = await loadCompactBuckets(ctx, companyId);
  const rt = runtime.getOrCreateCompany(companyId);
  if (restoredBuckets) {
    rt.store.restoreCompactBuckets(restoredBuckets);
  }

  const result = await bootstrapSnapshot(ctx, companyId);
  rt.store.replaceAuthoritativeSnapshot(result.snapshot);

  // Open every channel the worker emits on so the SDK's per-process
  // channelCompanyMap is populated for subsequent emit() calls (spec §16).
  // The shared `bridge` channel also carries company-scoped events
  // (emitBridgeEvent), so opening it per company keeps its notifications'
  // companyId populated for the host invocation-scope guard (SAA-316 AC#2).
  ctx.streams.open(behaviorChannel(companyId), companyId);
  ctx.streams.open(STREAM_CHANNELS.bridge, companyId);

  rt.store.on("agentBehaviorChanged", (change) => {
    runtime.emitBehaviorChange(change);
  });

  runtime.emitBridgeEvent(companyId, "bridge.snapshot.loaded", buildCompanySnapshot(rt));

  // Configure this company's bridge relay from its operator plugin config and
  // seed it with the authoritative snapshot (spawns a character per agent).
  try {
    const companyConfig = await ctx.config.get(companyId);
    await relay.configure(companyId, companyConfig);
    relay.ingestSnapshot(companyId, result.snapshot);
  } catch (err) {
    ctx.logger.warn("Bridge relay setup failed for company", {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return rt;
}

/**
 * Reconcile the stored state of a company and push any required updates.
 * If the computed summary differs from the persisted one, this routine
 * invokes `emitCompanySummaryChanged` to inform UI listeners.
 *
 * @param ctx - The plugin execution context.
 * @param runtime - The `BridgeRuntime` handling UI events.
 * @param companyId - Identifier of the company being reconciled.
 * @param relay - The bridge relay used for event emission.
 */
async function reconcileCompany(ctx: PluginContext, runtime: BridgeRuntime, companyId: string, relay: BridgeRelay): Promise<void> {
  const rt = runtime.getCompany(companyId);
  if (!rt) return;
  try {
    const result = await bootstrapSnapshot(ctx, companyId);
    const recon = rt.store.reconcile(result.snapshot);
    await persistLastReconciledAt(ctx, companyId, result.snapshot.observedAt);
    if (recon.changedEntities.length > 0) {
      runtime.emitBridgeEvent(companyId, "bridge.reconciliation.changed", {
        changedEntities: recon.changedEntities,
      });
      // Push the fresh summary on the UI's behavior channel so live gauges
      // (open-issue count, active-run count, ...) update without a manual
      // refresh (SAA-320 AC#2 / spec §16 contract in bridge-contract.ts).
      runtime.emitCompanySummaryChanged(companyId, rt.store.getCompanySummary());
    }
    // Re-feed the authoritative snapshot so the relay sidecar resyncs and
    // re-spawns any agents that appeared since the last reconciliation.
    relay.ingestSnapshot(companyId, result.snapshot);
    ctx.logger.debug("Reconciliation complete", { companyId, changed: recon.changedEntities.length });
  } catch (err) {
    ctx.logger.warn("Reconciliation failed", {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Module-level runtime singletons. The host forks one worker process per
// plugin instance, so a single BridgeRuntime + BridgeRelay pair is correct.
// They are assigned in `setup()` and read by the lifecycle hooks below.
let runtime: BridgeRuntime | null = null;
let relay: BridgeRelay | null = null;

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Paperclip Pixel Bridge worker starting", {
      pluginId: manifest.id,
      version: manifest.version,
    });

    await persistSchemaVersion(ctx);

    runtime = new BridgeRuntime(ctx);
    relay = new BridgeRelay(ctx);
    const localRuntime = runtime;
    const localRelay = relay;

    const bootResults = await bootstrapAllCompanies(ctx);
    for (const br of bootResults) {
      await setupCompany(ctx, localRuntime, br.companyId, localRelay);
    }

    for (const eventType of SUBSCRIBED_EVENT_TYPES) {
      /**
       * Event-driven handler for incoming Paperclip events within the bridge
       * plugin. Performs a before/after summary comparison and, when a summary
       * actually changes, calls `emitCompanySummaryChanged` to broadcast the
       * update.
       *
       * @param event - The raw Paperclip event payload received by the plugin.
       * @returns A promise that resolves when the event has been fully processed.
       */
      ctx.events.on(eventType, async (event: PluginEvent) => {
        const companyId = event.companyId;
        const rt = localRuntime.getCompany(companyId);
        if (!rt) {
          ctx.logger.debug("Event for unknown company, bootstrapping", { companyId });
          try {
            await setupCompany(ctx, localRuntime, companyId, localRelay);
          } catch {
            ctx.logger.warn("Cannot bootstrap company for event", { companyId });
            return;
          }
        }
        const rt2 = localRuntime.getCompany(companyId);
        if (!rt2) return;

        const bridgeEvent = mapPluginEvent(event);
        if (!bridgeEvent) return;

        const before = rt2.store.getCompanySummary();
        await rt2.store.applyPaperclipEvent(bridgeEvent);
        // A summary-affecting event (issue created/updated, run started /
        // finished / failed, ...) must live-update the UI's gauges on the
        // behavior channel without a manual refresh (SAA-320 AC#2). Emit only
        // when the summary actually changed to avoid delta spam.
        const after = rt2.store.getCompanySummary();
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          localRuntime.emitCompanySummaryChanged(companyId, after);
        }
        // Forward the canonical event to the Pixel Agents relay (no-op when
        // the company has no relay configured).
        localRelay.ingestEvent(companyId, bridgeEvent);
        localRuntime.emitBridgeEvent(companyId, "bridge.event.received", {
          eventId: event.eventId,
          eventType: event.eventType,
        });
      });
    }

    ctx.jobs.register(JOB_KEYS.reconciliation, async () => {
      for (const companyId of localRuntime.companies.keys()) {
        await reconcileCompany(ctx, localRuntime, companyId, localRelay);
      }
    });

    // M1 (spec §5.2, §15): the SDK does not pass an authenticated actor
    // context to `getData` handlers. The host scopes `getData` server-side by
    // merging the host-authorized `companyId` into the handler params (see
    // `handleGetData` in @paperclipai/plugin-sdk), overriding any
    // caller-supplied `companyId`. Each handler below reads `params.companyId`
    // (host-derived) and `runtime.getCompany(companyId)` fails closed
    // ("company-not-found") for any company the worker did not bootstrap, so a
    // caller cannot read another company's bridge state. This server-side
    // scoping assumption is the accepted V1 resolution for data handlers.
    //
    // Lazy bootstrap: if setup() could not bootstrap the company (because
    // proactiveCompanyScopes was not yet populated at worker start time),
    // attempt the bootstrap now. The getData call carries a host-issued
    // invocation scope for this company, so company-scoped host calls inside
    // setupCompany (companies.get, agents.list, etc.) will succeed.
    /**
 * Lazily bootstraps a company on demand for a getData request.
 * If bootstrap succeeds, returns the runtime; on failure it logs a warning,
 * removes any partially created runtime entry to enforce the fail‑closed
 * contract (spec §15), and returns `null`.
 *
 * @param companyId - The host‑derived identifier of the company.
 * @returns The `CompanyRuntime` for the company, or `null` if bootstrapping failed.
 */
const getOrBootstrapCompany = async (companyId: string): Promise<CompanyRuntime | null> => {
      const rt = localRuntime.getCompany(companyId);
      if (rt) return rt;
      try {
        ctx.logger.info("Lazy-bootstrapping company on demand", { companyId });
        await setupCompany(ctx, localRuntime, companyId, localRelay);
      } catch (err) {
        ctx.logger.warn("Lazy bootstrap failed for getData", {
          companyId,
          error: err instanceof Error ? err.message : String(err),
        });
        // setupCompany creates the company runtime before it fetches the host
        // snapshot, so a failed lazy bootstrap leaves a partial empty entry
        // behind. Keeping it would make the next getData treat the unknown
        // company as bootstrapped and serve a real (empty) snapshot instead of
        // failing closed. Roll it back so unknown companies consistently
        // resolve to "company-not-found" on every data key.
        localRuntime.companies.delete(companyId);
        return null;
      }
      return localRuntime.getCompany(companyId) ?? null;
    };

    ctx.data.register(DATA_KEYS.bridgeSnapshot, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = await getOrBootstrapCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return buildCompanySnapshot(rt);
    });

    ctx.data.register(DATA_KEYS.companySummary, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = await getOrBootstrapCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getCompanySummary();
    });

    ctx.data.register(DATA_KEYS.agentBehavior, async (params) => {
      const companyId = String(params.companyId ?? "");
      const agentId = String(params.agentId ?? "");
      const rt = await getOrBootstrapCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getBehaviorVector(agentId);
    });

    ctx.data.register(DATA_KEYS.outstandingFeedback, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = await getOrBootstrapCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getOutstandingFeedback(companyId);
    });

    ctx.data.register(DATA_KEYS.visualSettings, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = await getOrBootstrapCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      try {
        return await localRelay.getVisualSettings(companyId);
      } catch (err) {
        return {
          schemaVersion: BRIDGE_SCHEMA_VERSION,
          configured: localRelay.isConfigured(companyId),
          characters: [],
          assignments: {},
          error: err instanceof Error ? err.message : String(err),
        };
      }
    });

    registerActions({
      ctx,
      // C1: feedback is resolved server-side from the company's BridgeStore
      // (state.feedback, keyed by feedback id), company-scoped by
      // getFeedbackById. The worker never held a parallel feedback map.
      getFeedback: (cid, fid) => localRuntime.getCompany(cid)?.store.getFeedbackById(cid, fid),
      getLeadershipAgentId: (cid) => localRuntime.getCompany(cid)?.leadershipAgentId,
      setAgentAppearance: (cid, input) => localRelay.setAgentAppearance(cid, input),
    });

    localRuntime.startTimers();
  },

  // The bridge bootstraps and relays state for every company the worker is
  // configured for, keyed by companyId. Declaring multi-company support opts
  // in to per-company configChanged delivery instead of single-tenant
  // collapse/restart.
  multiCompanyConfig: true,

  /**
   * Called when the operator config for a company changes.
   * Reconfigures the {@link BridgeRelay} for the affected company based on the new
   * configuration. Errors are caught and logged; they must not crash the worker.
   *
   * @param newConfig - Raw operator config object for the company.
   * @param context - Context containing the `companyId` whose config changed.
   */
  async onConfigChanged(newConfig, context) {
    // Reconfigure the relay for the company whose config changed. The relay
    // disposes its prior transport and rebuilds from the new config; without
    // a `pixelAgentsUrl` it disables itself for that company. Uses the
    // delivered `newConfig` directly (no `ctx` is available in this hook).
    const companyId = context?.companyId;
    if (!companyId) return;
    try {
      await relay?.configure(companyId, newConfig);
    } catch (err) {
      // Best-effort: a config change must never crash the worker.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[paperclip-pixel-bridge] relay reconfigure failed for ${companyId}: ${msg}`);
    }
  },

  /**
   * Validates the operator configuration for a company.
   * Returns an object indicating overall validity and an optional array of error
   * messages describing each validation failure.
   *
   * @param config - The raw config supplied by the operator.
   * @returns An object `{ ok: boolean, errors?: string[] }` where `ok` is true when
   *          the config passes all checks.
   */
  async onValidateConfig(config) {
    const errors: string[] = [];
    const url = config.pixelAgentsUrl;
    let urlProtocol: string | null = null;
    if (url != null) {
      if (typeof url !== "string" || url.trim().length === 0) {
        errors.push("pixelAgentsUrl must be a non-empty string when present");
      } else {
        try {
          const parsed = new URL(url);
          if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
            errors.push("pixelAgentsUrl must be an http(s) URL");
          } else {
            urlProtocol = parsed.protocol;
          }
        } catch {
          errors.push("pixelAgentsUrl is not a valid URL");
        }
      }
    }
    // M2 (fail-securely): a token must never travel over public cleartext
    // HTTP. The package's exact loopback/Compose sidecar names are the only
    // exception; all operator-supplied remote names still require TLS.
    const hasToken = config.pixelAgentsTokenRef != null;
    let bundledSidecar = false;
    if (typeof url === "string") {
      try {
        bundledSidecar = ["localhost", "127.0.0.1", "::1", "pixel-agents-relay"]
          .includes(new URL(url).hostname);
      } catch { /* URL validation above reports the error. */ }
    }
    if (hasToken && urlProtocol === "http:" && !bundledSidecar) {
      errors.push("pixelAgentsUrl must be https: when pixelAgentsTokenRef is configured");
    }
    if (
      config.pixelAgentsTokenRef != null
      && !isValidTokenRef(config.pixelAgentsTokenRef)
    ) {
      errors.push("pixelAgentsTokenRef must be a secret_ref binding or non-empty string when present");
    }
    if (
      config.pixelAgentsProviderId != null
      && (typeof config.pixelAgentsProviderId !== "string"
        || !/^[a-z0-9-]+$/.test(config.pixelAgentsProviderId))
    ) {
      errors.push("pixelAgentsProviderId must match ^[a-z0-9-]+$ when present");
    }
    if (
      config.pixelAgentsRelayEnabled != null
      && typeof config.pixelAgentsRelayEnabled !== "boolean"
    ) {
      errors.push("pixelAgentsRelayEnabled must be a boolean when present");
    }
    return { ok: errors.length === 0, errors: errors.length ? errors : undefined };
  },

  /**
   * Provides health information for the worker process.
   * Includes counts of companies bootstrapped and active relay connections.
   *
   * @returns An object describing the health status.
   */
  async onHealth() {
    const activeRelays = relay?.activeCompanyCount ?? 0;
    return {
      status: "ok" as const,
      message: "Bridge worker running",
      details: {
        companies: runtime?.companies.size ?? 0,
        relayCompanies: activeRelays,
      },
    };
  },

  /**
   * Called during worker shutdown.
   * Disposes all relay connections and allows timers to be cleared by the host.
   */
  async onShutdown() {
    // Dispose the relay's outbound connections. Timers are owned by the
    // runtime instance; the host tears down the worker process after this
    // hook resolves.
    relay?.disposeAll();
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
