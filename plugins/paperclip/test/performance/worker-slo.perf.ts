/**
 * Production measurement / SLO suite for the Paperclip bridge plugin worker
 * (`./plugins/paperclip`).
 *
 * Drives the outbound feed path (PluginFeedMapper -> PluginFeedHttpSink), the
 * idempotent event deduper, and the bounded temporal store through
 * `@decaf-ts/utils` `PerformanceRunner` (the sanctioned measurement harness —
 * no hand-rolled timing framework) and asserts committed SLO thresholds from
 * `./slo.config.ts`. A crossed threshold makes this suite fail.
 *
 * Scope covered (as delegated by SAA-879 / SAA-936):
 *   1. End-to-end feed latency distribution (operation emit -> embed
 *      application) under sustained load.
 *   2. Queue pressure / back-pressure of the feed mapper + retry/observability
 *      feed sink.
 *   3. At-least-once delivery with dedupe under induced failure injection
 *      (zero delivery loss after dedupe).
 *   4. Bounded relay history / temporal store (no unbounded growth).
 *   5. Sustained resource stability (bounded RSS growth, stable CPU).
 */

import { describe, expect, it } from "vitest";
import { PerformanceRunner } from "@decaf-ts/utils";
import type {
  IterationMetric,
  Phase,
  PhaseConfig,
  PhaseResult,
} from "@decaf-ts/utils";
import { PluginFeedMapper } from "../../src/feed-mapper.js";
import { PluginFeedHttpSink, type FeedFetchLike } from "../../src/feed-sink.js";
import {
  AgentWindowStore,
  BUCKETS_PER_24H,
  BridgeStore,
  EventDeduper,
  RingBuffer,
  percentile,
} from "../../src/core/index.js";
import type { BridgeInputEvent } from "../../src/core/index.js";
import { RelayCommsStore, DEFAULT_RELAY_COMMS_LIMIT } from "../../src/comms-store.js";
import { buildBridgeEvent, buildSnapshot } from "@decaf-ts/paperclip-pixels-common";
import type { PluginFeedBatch } from "@decaf-ts/paperclip-pixels-common";
import {
  BACKPRESSURE_RUN,
  FEED_LATENCY_RUN,
  loadSloThresholds,
  type PerfRunConfig,
} from "./slo.config.js";

const COMPANY_ID = "company-airline";
const AGENT_COUNT = 8;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function collectDurations(results: PhaseResult[]): number[] {
  const out: number[] = [];
  for (const result of results) {
    for (const metric of result.iterationMetrics) out.push(metric.durationMs);
  }
  return out;
}

function collectByPhase(results: PhaseResult[]): Map<string, IterationMetric[]> {
  const map = new Map<string, IterationMetric[]>();
  for (const result of results) {
    map.set(result.phase.name, result.iterationMetrics);
  }
  return map;
}

function makeEvent(companyId: string, agentCount: number, iteration: number): BridgeInputEvent {
  const agentId = `agent-${iteration % agentCount}`;
  const runId = `run-${agentId}-${iteration}`;
  const issueId = `issue-${iteration % 5}`;
  switch (iteration % 6) {
    case 0:
      return buildBridgeEvent("agent.created", {
        payload: { agentId, name: `Agent ${agentId}` },
      });
    case 1:
      return buildBridgeEvent("agent.run.started", {
        payload: { runId, agentId, issueId: null, projectId: null, startedAt: new Date().toISOString() },
      });
    case 2:
      return buildBridgeEvent("agent.run.finished", {
        payload: { runId, agentId, status: "finished", finishedAt: new Date().toISOString() },
      });
    case 3:
      return buildBridgeEvent("issue.comment.created", {
        payload: { commentId: `c-${iteration}`, issueId, agentId, body: `comment ${iteration}: update` },
      });
    case 4:
      return buildBridgeEvent("approval.created", {
        payload: { approvalId: `a-${iteration}`, issueId, agentId, status: "pending" },
      });
    default:
      return buildBridgeEvent("agent.status_changed", {
        payload: { agentId, status: "active", previousStatus: "idle" },
      });
  }
}

/** A mock embedded feed endpoint that applies operations and records batches. */
interface EmbedFetchState {
  applied: PluginFeedBatch[];
  failures: number;
}

interface EmbedFetchOptions {
  /** Simulated embedding-surface application latency (ms) to create back-pressure. */
  applicationDelayMs?: number;
  /** Fraction of pushes to fail (delivery-loss accounting / failure injection). */
  failRate?: number;
  /** RNG for the fail-rate decision (injectable for determinism). */
  rng?: () => number;
}

function makeEmbedFetch(options: EmbedFetchOptions = {}): FeedFetchLike & EmbedFetchState {
  const state: EmbedFetchState = { applied: [], failures: 0 };
  const fetch: FeedFetchLike = async (url, init) => {
    const fail =
      options.failRate !== undefined
        && (options.rng ? options.rng() : Math.random()) < options.failRate;
    if (options.applicationDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.applicationDelayMs));
    }
    if (fail) {
      state.failures += 1;
      return { ok: false, status: 404, statusText: "Not Found" };
    }
    const batch = JSON.parse(init.body) as PluginFeedBatch;
    state.applied.push(batch);
    return { ok: true, status: 200, statusText: "OK" };
  };
  // Expose live views of the mutable counters (a plain Object.assign would
  // copy the primitive `failures` by value and the test would read a stale 0).
  Object.defineProperty(fetch, "applied", { get: () => state.applied });
  Object.defineProperty(fetch, "failures", { get: () => state.failures });
  return fetch as FeedFetchLike & EmbedFetchState;
}

function buildPhases(run: PerfRunConfig): Phase[] {
  return run.phases.map((phase) => ({
    name: phase.name,
    config: {
      iterations: phase.iterations,
      mode: phase.mode,
      concurrency: phase.concurrency,
      delayBetweenIterationsMs: phase.delayBetweenIterationsMs,
      burst: phase.burstSize
        ? { size: phase.burstSize, intervalMs: phase.burstIntervalMs ?? 0 }
        : undefined,
      loadStart: phase.loadStart,
      loadStep: phase.loadStep,
    } satisfies PhaseConfig,
  }));
}

interface FeedContext {
  companyId: string;
  agentCount: number;
}

function buildFeedPipeline(context: FeedContext, fetch: FeedFetchLike): { mapper: PluginFeedMapper; sink: PluginFeedHttpSink } {
  return {
    mapper: new PluginFeedMapper(),
    sink: new PluginFeedHttpSink({ baseUrl: "http://127.0.0.1:8081", fetch }),
  };
}

// ---------------------------------------------------------------------------
// Scope 1 + 2: end-to-end feed latency and back-pressure under sustained load
// ---------------------------------------------------------------------------

describe("worker production SLO — feed latency + back-pressure", () => {
  const slo = loadSloThresholds();

  it("end-to-end feed latency (op emit -> embed application) stays under the committed p95/max SLO", async () => {
    const embed = makeEmbedFetch();
    const { mapper, sink } = buildFeedPipeline({ companyId: COMPANY_ID, agentCount: AGENT_COUNT }, embed);
    const runner = new PerformanceRunner<FeedContext>({
      name: FEED_LATENCY_RUN.name,
      baseContext: { companyId: COMPANY_ID, agentCount: AGENT_COUNT },
      phases: buildPhases(FEED_LATENCY_RUN),
      failOnError: true,
      handler: async ({ iteration, context }) => {
        const event = makeEvent(context.companyId, context.agentCount, iteration);
        const ops = mapper.mapEvent(event);
        await sink.push(context.companyId, ops);
        return { success: true, meta: { opCount: ops.length } };
      },
    });
    const results = await runner.run();
    const durations = collectDurations(results);
    expect(durations.length).toBeGreaterThan(0);
    const p95 = percentile(durations, 0.95);
    const max = Math.max(...durations);
    // The suite must have actually exercised the outbound feed.
    expect(embed.applied.length).toBeGreaterThan(0);
    process.stdout.write(`[baseline] feed latency p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms applied=${embed.applied.length}\n`);
    expect(p95).toBeLessThanOrEqual(slo.feedP95LatencyMs);
    expect(max).toBeLessThanOrEqual(slo.feedMaxLatencyMs);
  });

  it("outbound feed sink queue pressure stays bounded, ordered, and fail-closed under a slow embed", async () => {
    const embed = makeEmbedFetch({ applicationDelayMs: 4 });
    const { mapper, sink } = buildFeedPipeline({ companyId: COMPANY_ID, agentCount: AGENT_COUNT }, embed);
    const runner = new PerformanceRunner<FeedContext>({
      name: BACKPRESSURE_RUN.name,
      baseContext: { companyId: COMPANY_ID, agentCount: AGENT_COUNT },
      phases: buildPhases(BACKPRESSURE_RUN),
      failOnError: true,
      handler: async ({ iteration, context }) => {
        const event = makeEvent(context.companyId, context.agentCount, iteration);
        const ops = mapper.mapEvent(event);
        await sink.push(context.companyId, ops);
        return { success: true, meta: { opCount: ops.length } };
      },
    });
    const results = await runner.run();
    const durations = collectDurations(results);
    const p95 = percentile(durations, 0.95);
    const max = Math.max(...durations);
    expect(p95).toBeLessThanOrEqual(slo.backpressureP95LatencyMs);
    expect(max).toBeLessThanOrEqual(slo.backpressureMaxLatencyMs);
    const byPhase = collectByPhase(results);
    const phase = byPhase.get(BACKPRESSURE_RUN.phases[0].name) ?? [];
    expect(phase.length).toBeGreaterThan(0);
    process.stdout.write(`[baseline] backpressure p95=${p95.toFixed(3)}ms max=${max.toFixed(3)}ms\n`);
    // A healthy sink has no recorded push error.
    expect(sink.lastPushError).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Scope 3: retry + delivery-loss accounting (at-least-once delivery + dedupe)
// ---------------------------------------------------------------------------

describe("worker production SLO — retry & delivery-loss accounting", () => {
  const slo = loadSloThresholds();

  it("at-least-once delivery with dedupe records zero delivery loss after induced failure injection", async () => {
    const rng = (() => {
      let seed = 12345;
      return () => {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        return seed / 0x7fffffff;
      };
    })();
    const embed = makeEmbedFetch({ failRate: 0.3, rng });
    const { mapper, sink } = buildFeedPipeline({ companyId: COMPANY_ID, agentCount: AGENT_COUNT }, embed);

    const deduper = new EventDeduper();
    const store = new BridgeStore();
    const deliver = async (event: BridgeInputEvent): Promise<"applied" | "duplicate"> => {
      if (deduper.seen(event.eventId)) return "duplicate";
      await store.applyPaperclipEvent(event);
      const ops = mapper.mapEvent(event);
      await sink.push(COMPANY_ID, ops);
      return "applied";
    };

    // Ground truth of what the embedding surface actually received: the
    // distinct agent keys the sink successfully delivered as `declareAgents`.
    // This is measured from the surface's applied batches — not from the
    // worker's `deliver()` return value, which only tracks dedupe, so a
    // push that failed (sink records `lastPushError` but never throws) still
    // shows up here as an agent the surface never saw.
    const declaredAgentsAtSurface = (): Set<string> => {
      const declared = new Set<string>();
      for (const batch of embed.applied) {
        for (const op of batch.operations) {
          if (op.op === "declareAgents") {
            for (const agent of op.agents) declared.add(agent.key);
          }
        }
      }
      return declared;
    };

    const runner = new PerformanceRunner<{ count: number }>({
      name: "delivery-loss",
      baseContext: { count: 240 },
      phases: [{ name: "sustained", config: { iterations: 260, mode: "concurrent", concurrency: 8 } }],
      failOnError: true,
      handler: async ({ iteration }) => {
        const event = makeEvent(COMPANY_ID, AGENT_COUNT, iteration);
        const first = await deliver(event);
        const second = await deliver({ ...event });
        return { success: true, meta: { deduped: first === "applied" && second === "duplicate" } };
      },
    });
    const results = await runner.run();
    const byPhase = collectByPhase(results);
    const metrics = byPhase.get("sustained") ?? [];

    // Dedupe exactness: a repeated eventId is a no-op.
    const dedupedCount = metrics.filter((m) => m.meta?.deduped === true).length;
    expect(dedupedCount).toBeGreaterThan(0);
    expect(metrics.length).toBeGreaterThan(0);

    // Reconciling replay: re-ingest an authoritative snapshot, re-declaring
    // every agent through the feed, which self-heals any op dropped by the
    // induced failures. Zero permanent delivery loss.
    const snapshot = buildSnapshot({
      company: { id: COMPANY_ID, name: "Airline", status: "active" },
      agents: Array.from({ length: AGENT_COUNT }, (_, i) => ({
        id: `agent-${i}`,
        companyId: COMPANY_ID,
        name: `Agent ${i}`,
        status: "idle",
      })),
      issues: [],
      projects: [],
      approvals: [],
      observedAt: new Date().toISOString(),
    });
    mapper.reset();
    const reconcileOps = mapper.mapSnapshot(snapshot);
    const declaresAfterReplay = reconcileOps.filter(
      (op) => op.op === "declareAgents",
    ).length;
    // Reconciling replay self-heals the feed: every agent is re-declared, so
    // no operation is permanently lost even after the induced failures.
    expect(declaresAfterReplay).toBeGreaterThanOrEqual(AGENT_COUNT);

    // The induced failures were real...
    expect(embed.failures).toBeGreaterThan(0);

    // ...but the self-heal runs through the ACTUAL delivery path: push the
    // reconciling declaration batch through the sink so the embedding surface
    // re-receives every agent. This is what genuinely enforces the
    // `maxDeliveryLossAfterDedupe` SLO — a regression that permanently drops
    // feed deliveries shows up here as agents missing from the surface rather
    // than being masked by a `deliver()` return value that only tracks dedupe.
    await sink.push(COMPANY_ID, reconcileOps);

    const deliveredAgentCount = declaredAgentsAtSurface().size;
    const deliveryLossAfterDedupe = AGENT_COUNT - deliveredAgentCount;
    process.stdout.write(
      `[baseline] delivery-loss failures=${embed.failures} declaresAfterReplay=${declaresAfterReplay}`
      + ` deduperSize=${deduper.size} deliveredAgents=${deliveredAgentCount}`
      + ` deliveryLossAfterDedupe=${deliveryLossAfterDedupe} (slo=${slo.maxDeliveryLossAfterDedupe})\n`,
    );

    // Scope 3 SLO: zero delivery loss after dedupe — every agent must be
    // declared at the embedding surface once the reconciling push lands.
    expect(deliveryLossAfterDedupe).toBeLessThanOrEqual(slo.maxDeliveryLossAfterDedupe);

    // The deduper never outgrows the unique events seen.
    expect(deduper.size).toBeLessThanOrEqual(slo.maxEventDeduperEntries);
  });
});

// ---------------------------------------------------------------------------
// Scope 4: bounded relay history / temporal store (no unbounded growth)
// ---------------------------------------------------------------------------

describe("worker production SLO — bounded relay history / temporal store", () => {
  const slo = loadSloThresholds();

  it("the bounded rolling temporal store and deduper stay bounded under sustained load", async () => {
    const windows = new AgentWindowStore();
    const deduper = new EventDeduper();
    const ring = new RingBuffer<number>(BUCKETS_PER_24H);
    const comms = new RelayCommsStore();

    const runner = new PerformanceRunner<{ agentCount: number }>({
      name: "bounded-history",
      baseContext: { agentCount: 8 },
      phases: [{
        name: "sustained",
        config: { iterations: 1200, mode: "concurrent", concurrency: 16, loadStart: 1, loadStep: 0.01 },
      }],
      failOnError: true,
      handler: async ({ iteration, context }) => {
        const agentId = `agent-${iteration % context.agentCount}`;
        const runId = `run-${iteration}`;
        const now = 1_700_000_000_000 + (iteration % (BUCKETS_PER_24H + 10)) * 5 * 60 * 1000;
        windows.recordRunStart(agentId, runId, now, iteration % 4 === 0 ? `issue-${iteration % 4}` : undefined);
        windows.recordRunEnd(agentId, runId, now + 1000, iteration % 3 === 0 ? "failed" : "finished", 1000);
        windows.record(agentId, { runStarts: 1, commentEvents: iteration % 2 }, now);
        ring.push(iteration);
        deduper.seen(`evt-${iteration}`);
        // The bounded rolling relay-communications log (spec R3-WS4a): append
        // one outbound feed-push per iteration and let the store evict the
        // oldest so the retained count never grows past its hard limit.
        comms.append({
          companyId: COMPANY_ID,
          occurredAt: new Date(now).toISOString(),
          direction: "outbound",
          kind: "feed-push",
          status: "sent",
          operations: [{ op: "updateAgentStatus", agentId, key: agentId }],
        });
        return { success: true };
      },
    });
    await runner.run();

    for (let i = 0; i < 8; i += 1) {
      const buckets = windows.exportCompact(`agent-${i}`);
      expect(buckets.buckets.length).toBeLessThanOrEqual(slo.maxBucketsPerAgent);
      expect(buckets.buckets.length).toBeLessThanOrEqual(BUCKETS_PER_24H);
    }
    expect(ring.size).toBeLessThanOrEqual(BUCKETS_PER_24H);
    expect(ring.isFull).toBe(true);
    expect(deduper.size).toBeLessThanOrEqual(slo.maxEventDeduperEntries);
    deduper.forceGc(Date.now() + 2 * 60 * 60 * 1000);
    expect(deduper.size).toBe(0);
    // The bounded rolling relay-communications log must never outgrow its
    // hard limit after a full sustained-load run (oldest evicted on overflow).
    expect(comms.count(COMPANY_ID)).toBeLessThanOrEqual(DEFAULT_RELAY_COMMS_LIMIT);
    expect(comms.count(COMPANY_ID)).toBeLessThanOrEqual(comms.getLimit(COMPANY_ID));
    const page = comms.list(COMPANY_ID, { limit: DEFAULT_RELAY_COMMS_LIMIT });
    expect(page.entries.length).toBeLessThanOrEqual(DEFAULT_RELAY_COMMS_LIMIT);
    // Eviction is real: we appended 1200, so the retained count must be the
    // hard cap, not the append count.
    expect(comms.count(COMPANY_ID)).toBe(DEFAULT_RELAY_COMMS_LIMIT);
    process.stdout.write(`[baseline] bounded-history commsCount=${comms.count(COMPANY_ID)} limit=${DEFAULT_RELAY_COMMS_LIMIT}\n`);
  });
});

// ---------------------------------------------------------------------------
// Scope 5: sustained resource stability (bounded RSS growth, stable CPU)
// ---------------------------------------------------------------------------

describe("worker production SLO — sustained resource stability", () => {
  const slo = loadSloThresholds();

  it("RSS growth stays bounded and CPU stays stable over a worker soak run", async () => {
    // Soak the worker's steady-state machinery — the feed mapper + outbound
    // sink + bounded temporal store — which all use bounded state. A memory
    // leak would show RSS climbing over the soak; the plateau/end-to-end
    // growth assertions below make that fail.
    const windows = new AgentWindowStore();
    const deduper = new EventDeduper();
    const embed = makeEmbedFetch({ applicationDelayMs: 1 });
    const { mapper, sink } = buildFeedPipeline(
      { companyId: COMPANY_ID, agentCount: AGENT_COUNT },
      embed,
    );
    const samples: Array<{ rss: number; cpu: number }> = [];
    const startCpu = process.cpuUsage();

    const runner = new PerformanceRunner<{ agentCount: number }>({
      name: "resource-soak",
      baseContext: { agentCount: AGENT_COUNT },
      phases: [{
        name: "soak",
        config: { iterations: 600, mode: "sequential", delayBetweenIterationsMs: 1, loadStart: 1, loadStep: 0.005 },
      }],
      failOnError: true,
      handler: async ({ iteration, context }) => {
        const event = makeEvent(COMPANY_ID, context.agentCount, iteration);
        const ops = mapper.mapEvent(event);
        await sink.push(COMPANY_ID, ops);
        const agentId = `agent-${iteration % context.agentCount}`;
        windows.record(agentId, { runStarts: iteration % 2, commentEvents: 1 }, Date.now());
        windows.recordRunEnd(agentId, `run-${iteration}`, Date.now(), "finished", 500);
        deduper.seen(`evt-${iteration}`);
        const mem = process.memoryUsage();
        const cpu = process.cpuUsage();
        samples.push({ rss: mem.rss, cpu: cpu.user + cpu.system });
        return { success: true, meta: { rss: mem.rss } };
      },
    });
    await runner.run();

    const firstRss = samples[0]?.rss ?? 0;
    const maxRss = Math.max(...samples.map((s) => s.rss));
    const rssGrowth = maxRss - firstRss;
    // Peak growth over the soak must be bounded (no unbounded memory climb).
    expect(rssGrowth).toBeLessThanOrEqual(slo.maxRssGrowthBytes);

    // Plateau check: the RSS at the end must not be materially higher than the
    // RSS at the start of the soak — a linear leak (state accumulation) would
    // keep pushing the tail up. Allow only a small steady-state drift.
    const lastRss = samples[samples.length - 1]?.rss ?? firstRss;
    const plateauDrift = Math.abs(lastRss - firstRss);
    expect(plateauDrift).toBeLessThanOrEqual(slo.maxRssGrowthBytes * 0.5);
    process.stdout.write(
      `[baseline] resource-soak rssGrowth=${(rssGrowth / 1024 / 1024).toFixed(2)}MB`
      + ` plateauDrift=${(plateauDrift / 1024 / 1024).toFixed(2)}MB maxRss=${(maxRss / 1024 / 1024).toFixed(2)}MB\n`,
    );

    // CPU stability: the per-sample CPU delta should not explode across the
    // soak (a runaway loop would show a large late-window growth ratio).
    const cpuDeltas: number[] = [];
    let prevCpu = startCpu.user + startCpu.system;
    for (const s of samples) {
      const cur = s.cpu;
      cpuDeltas.push(Math.max(0, cur - prevCpu));
      prevCpu = cur;
    }
    const meanCpu = cpuDeltas.length ? cpuDeltas.reduce((a, b) => a + b, 0) / cpuDeltas.length : 0;
    const tailStart = Math.floor(cpuDeltas.length * 0.9);
    const tailSlice = cpuDeltas.slice(tailStart);
    const tailCpu = tailSlice.length ? tailSlice.reduce((a, b) => a + b, 0) / tailSlice.length : 0;
    expect(tailCpu).toBeLessThanOrEqual(Math.max(1, meanCpu) * slo.maxSustainedCpuGrowthRatio);
  });
});
