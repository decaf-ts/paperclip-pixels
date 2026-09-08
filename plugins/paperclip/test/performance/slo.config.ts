/**
 * Production measurement / SLO suite configuration for the Paperclip bridge
 * plugin worker (`./plugins/paperclip`).
 *
 * The committed SLO thresholds live here so the release CI gate
 * (`npm run test:perf`) fails when a measured production signal crosses a
 * bound. The suite is driven by `@decaf-ts/utils` `PerformanceRunner`
 * (no hand-rolled timing framework).
 *
 * Failure-injection demonstration: any numeric threshold may be overridden at
 * run time via an environment variable of the form
 * `SLO_OVERRIDE_<thresholdKey>=<number>` (e.g.
 * `SLO_OVERRIDE_feedP95LatencyMs=0.0001`). This is how the suite is proven to
 * fail on a crossed threshold without committing a crossed config.
 */

/** The 24h bucket count the temporal store is designed around (spec §9.2). */
export const BUCKETS_PER_24H = 288;

export interface SloThresholds {
  /** Scope 1 — end-to-end feed latency (operation emit → embed application). */
  feedP95LatencyMs: number;
  feedMaxLatencyMs: number;

  /** Scope 2 — outbound feed sink queue pressure / back-pressure. */
  backpressureP95LatencyMs: number;
  backpressureMaxLatencyMs: number;

  /** Scope 3 — retry / delivery-loss accounting (0 == zero loss after dedupe). */
  maxDeliveryLossAfterDedupe: number;

  /** Scope 4 — bounded relay history / temporal store (no unbounded growth). */
  maxBucketsPerAgent: number;
  maxRingBufferSize: number;
  maxEventDeduperEntries: number;

  /** Scope 5 — sustained resource stability over a worker soak run. */
  maxRssGrowthBytes: number;
  maxSustainedCpuGrowthRatio: number;
}

export const SLO_DEFAULTS: SloThresholds = {
  feedP95LatencyMs: 250,
  feedMaxLatencyMs: 1500,
  backpressureP95LatencyMs: 500,
  backpressureMaxLatencyMs: 3000,
  maxDeliveryLossAfterDedupe: 0,
  maxBucketsPerAgent: BUCKETS_PER_24H,
  maxRingBufferSize: BUCKETS_PER_24H,
  maxEventDeduperEntries: 5000,
  maxRssGrowthBytes: 256 * 1024 * 1024,
  maxSustainedCpuGrowthRatio: 50,
};

/** Keys that are numeric and may be overridden via `SLO_OVERRIDE_*`. */
const NUMERIC_THRESHOLD_KEYS = Object.keys(SLO_DEFAULTS) as Array<
  keyof SloThresholds
>;

/** Load committed thresholds, applying optional `SLO_OVERRIDE_*` env overrides. */
export function loadSloThresholds(): SloThresholds {
  const out = { ...SLO_DEFAULTS };
  for (const key of NUMERIC_THRESHOLD_KEYS) {
    const raw = process.env[`SLO_OVERRIDE_${key}`];
    if (raw !== undefined) {
      const value = Number(raw);
      if (!Number.isNaN(value)) {
        out[key] = value;
      }
    }
  }
  return out;
}

/** One phase of a PerformanceRunner scenario. */
export interface PerfPhaseConfig {
  name: string;
  iterations: number;
  mode: "sequential" | "concurrent" | "burst";
  concurrency?: number;
  burstSize?: number;
  burstIntervalMs?: number;
  delayBetweenIterationsMs?: number;
  loadStart?: number;
  loadStep?: number;
}

export interface PerfRunConfig {
  name: string;
  companyId: string;
  agentCount: number;
  phases: PerfPhaseConfig[];
}

/**
 * Sustained-load shape for the end-to-end feed latency and back-pressure
 * scenarios: a warm-up sequential phase, then a concurrent phase under load,
 * then a burst phase to exercise queue back-pressure.
 */
export const FEED_LATENCY_RUN: PerfRunConfig = {
  name: "feed-latency",
  companyId: "company-airline",
  agentCount: 8,
  phases: [
    { name: "warmup-sequential", iterations: 50, mode: "sequential", delayBetweenIterationsMs: 0 },
    { name: "sustained-concurrent", iterations: 300, mode: "concurrent", concurrency: 8, loadStart: 1, loadStep: 0.02 },
    { name: "burst-backpressure", iterations: 200, mode: "burst", burstSize: 32, burstIntervalMs: 0, loadStart: 2, loadStep: 0.04 },
  ],
};

export const BACKPRESSURE_RUN: PerfRunConfig = {
  name: "feed-backpressure",
  companyId: "company-airline",
  agentCount: 8,
  phases: [
    { name: "high-concurrency", iterations: 300, mode: "concurrent", concurrency: 32, loadStart: 4, loadStep: 0.05 },
  ],
};
