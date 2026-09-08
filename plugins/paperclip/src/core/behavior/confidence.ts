/**
 * Confidence model (spec §25).
 *
 * Confidence considers window coverage, number of observations, source
 * directness, missing event types, and time since last reconciliation. After a
 * restart, long-window confidence naturally rises as history rebuilds unless
 * compact bucket history was persisted (§39.3).
 */

import type { TimeWindow } from "../domain/metrics.js";
import { WINDOW_DURATION_MS } from "../domain/metrics.js";
import type { AgentWindowMetrics } from "../temporal/windows.js";
import { clamp01 } from "../temporal/rates.js";

/**
 * Window-level confidence from sample count and coverage (spec §25 example).
 * `0.4 * sampleScore + 0.6 * coverageScore`.
 */
export function confidenceForWindow(
  samples: number,
  coverageMs: number,
  expectedCoverageMs: number,
): number {
  const sampleScore = clamp01(samples / 20);
  const coverageScore = clamp01(coverageMs / Math.max(1, expectedCoverageMs));
  return clamp01(0.4 * sampleScore + 0.6 * coverageScore);
}

/** Confidence for a specific window's metrics. */
export function confidenceForMetrics(
  metrics: AgentWindowMetrics,
  window: TimeWindow,
): number {
  return confidenceForWindow(
    metrics.samples,
    metrics.coverageMs,
    WINDOW_DURATION_MS[window],
  );
}

/**
 * Blend a primary window confidence with a secondary one. Used when a signal
 * draws from multiple windows; the lower-confidence contributor drags the
 * result down so we never over-claim.
 */
export function blendConfidence(a: number, b: number, weightA = 0.5): number {
  return clamp01(weightA * a + (1 - weightA) * b);
}

/** Average confidence across several signals (for compound proxies). */
export function averageConfidence(confidences: readonly number[]): number {
  if (confidences.length === 0) return 0;
  let total = 0;
  for (const c of confidences) total += c;
  return clamp01(total / confidences.length);
}

/**
 * Damp confidence for weak/subjective proxies (spec §11.12): because
 * engagement-like signals are weak proxies for a subjective concept, their
 * confidence should normally be lower than workload/conflict metrics.
 */
export function dampenConfidence(confidence: number, factor: number): number {
  return clamp01(confidence * clamp01(factor));
}
