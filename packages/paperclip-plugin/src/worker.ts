import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import type { PluginContext, PluginEvent } from "@paperclipai/plugin-sdk";
import {
  BridgeStore,
  type BehaviorChangedEvent,
  type BridgeUiEvent,
  BRIDGE_SCHEMA_VERSION,
} from "@paperclip-pixel/core";
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

interface CompanyRuntime {
  store: BridgeStore;
  companyId: string;
  leadershipAgentId?: string;
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

async function setupCompany(ctx: PluginContext, runtime: BridgeRuntime, companyId: string): Promise<CompanyRuntime> {
  const restoredBuckets = await loadCompactBuckets(ctx, companyId);
  const rt = runtime.getOrCreateCompany(companyId);
  if (restoredBuckets) {
    rt.store.restoreCompactBuckets(restoredBuckets);
  }

  const result = await bootstrapSnapshot(ctx, companyId);
  rt.store.replaceAuthoritativeSnapshot(result.snapshot);

  ctx.streams.open(behaviorChannel(companyId), companyId);

  rt.store.on("agentBehaviorChanged", (change) => {
    runtime.emitBehaviorChange(change);
  });

  runtime.emitBridgeEvent(companyId, "bridge.snapshot.loaded", rt.store.getRawSnapshot());

  return rt;
}

async function reconcileCompany(ctx: PluginContext, runtime: BridgeRuntime, companyId: string): Promise<void> {
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
    }
    ctx.logger.debug("Reconciliation complete", { companyId, changed: recon.changedEntities.length });
  } catch (err) {
    ctx.logger.warn("Reconciliation failed", {
      companyId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.logger.info("Paperclip Pixel Bridge worker starting", {
      pluginId: manifest.id,
      version: manifest.version,
    });

    await persistSchemaVersion(ctx);

    const runtime = new BridgeRuntime(ctx);

    const bootResults = await bootstrapAllCompanies(ctx);
    for (const br of bootResults) {
      await setupCompany(ctx, runtime, br.companyId);
    }

    for (const eventType of SUBSCRIBED_EVENT_TYPES) {
      ctx.events.on(eventType, async (event: PluginEvent) => {
        const companyId = event.companyId;
        const rt = runtime.getCompany(companyId);
        if (!rt) {
          ctx.logger.debug("Event for unknown company, bootstrapping", { companyId });
          try {
            await setupCompany(ctx, runtime, companyId);
          } catch {
            ctx.logger.warn("Cannot bootstrap company for event", { companyId });
            return;
          }
        }
        const rt2 = runtime.getCompany(companyId);
        if (!rt2) return;

        const bridgeEvent = mapPluginEvent(event);
        if (!bridgeEvent) return;

        await rt2.store.applyPaperclipEvent(bridgeEvent);
        runtime.emitBridgeEvent(companyId, "bridge.event.received", {
          eventId: event.eventId,
          eventType: event.eventType,
        });
      });
    }

    ctx.jobs.register(JOB_KEYS.reconciliation, async () => {
      for (const companyId of runtime.companies.keys()) {
        await reconcileCompany(ctx, runtime, companyId);
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
    ctx.data.register(DATA_KEYS.bridgeSnapshot, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = runtime.getCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getRawSnapshot();
    });

    ctx.data.register(DATA_KEYS.companySummary, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = runtime.getCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getCompanySummary();
    });

    ctx.data.register(DATA_KEYS.agentBehavior, async (params) => {
      const companyId = String(params.companyId ?? "");
      const agentId = String(params.agentId ?? "");
      const rt = runtime.getCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getBehaviorVector(agentId);
    });

    ctx.data.register(DATA_KEYS.outstandingFeedback, async (params) => {
      const companyId = String(params.companyId ?? "");
      const rt = runtime.getCompany(companyId);
      if (!rt) return { schemaVersion: BRIDGE_SCHEMA_VERSION, error: "company-not-found" };
      return rt.store.getOutstandingFeedback(companyId);
    });

    registerActions({
      ctx,
      // C1: feedback is resolved server-side from the company's BridgeStore
      // (state.feedback, keyed by feedback id), company-scoped by
      // getFeedbackById. The worker never held a parallel feedback map.
      getFeedback: (cid, fid) => runtime.getCompany(cid)?.store.getFeedbackById(cid, fid),
      getLeadershipAgentId: (cid) => runtime.getCompany(cid)?.leadershipAgentId,
    });

    runtime.startTimers();
  },

  async onHealth() {
    return {
      status: "ok" as const,
      message: "Bridge worker running",
      details: {},
    };
  },

  async onShutdown() {
    // Timers are owned by the runtime instance; in a real process the host
    // tears down the worker process. This hook documents intent.
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
