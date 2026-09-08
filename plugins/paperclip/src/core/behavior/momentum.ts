/**
 * Momentum and the optional higher-level proxies (spec §11.10–11.12).
 *
 * The optional `stressProxy` and `engagementProxy` are OPERATIONAL estimates
 * only. They are never assertions of factual emotion (FR-15, §11.11–11.12).
 */

import type { BehavioralSignal } from "../domain/behavior.js";
import type { BehaviorContext } from "./workload.js";
import { clamp01, ratioClamp, weightedMean } from "../temporal/rates.js";
import { averageConfidence, confidenceForMetrics, dampenConfidence } from "./confidence.js";

/**
 * Momentum (spec §11.10): rewards observable forward movement (successful
 * finishes, completed issues, resolved blockers, approvals obtained) and decays
 * during prolonged no-progress periods.
 */
export function computeMomentum(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["2h"];
  const successes = m.runFinishes;
  const failures = m.runFailures;
  const totalRuns = successes + failures + m.runCancellations;
  const completionRate = totalRuns > 0 ? successes / totalRuns : 0;
  const progress = m.issueTransitions + m.runFinishes;
  const value = clamp01(
    weightedMean([
      [ratioClamp(progress, 8), 0.5],
      [clamp01(completionRate), 0.3],
      [ratioClamp(m.approvalWaitEvents === 0 ? 0 : -1, 1) < 0 ? 0 : 0, 0],
      [clamp01(1 - ratioClamp(m.blockedEvents, 6)), 0.2],
    ]),
  );
  return {
    value,
    confidence: confidenceForMetrics(m, "2h"),
    basis: ["2h:run_finishes", "2h:issue_transitions", "2h:completion_rate", "2h:blocked_events"],
  };
}

/** Optional stress proxy (spec §11.11). Only computed when enabled. */
export function computeStressProxy(
  ctx: BehaviorContext,
  sustainedLoad: BehavioralSignal,
  friction: BehavioralSignal,
  interruptionPressure: BehavioralSignal,
  failurePressure: BehavioralSignal,
): BehavioralSignal {
  const value = clamp01(
    weightedMean([
      [sustainedLoad.value, 0.35],
      [friction.value, 0.3],
      [interruptionPressure.value, 0.2],
      [failurePressure.value, 0.15],
    ]),
  );
  const confidence = dampenConfidence(
    averageConfidence([
      sustainedLoad.confidence,
      friction.confidence,
      interruptionPressure.confidence,
      failurePressure.confidence,
    ]),
    0.8,
  );
  return {
    value,
    confidence,
    basis: [
      "sustainedLoad",
      "friction",
      "interruptionPressure",
      "failurePressure",
      "proxy:operational_pressure_not_emotion",
    ],
  };
}

/**
 * Optional engagement proxy (spec §11.12). Prefer this over any
 * "jobSatisfaction" claim. Confidence is deliberately lower than
 * workload/conflict metrics because these are weak proxies for a subjective
 * concept.
 */
export function computeEngagementProxy(
  ctx: BehaviorContext,
  sustainedLoad: BehavioralSignal,
  momentum: BehavioralSignal,
  collaboration: BehavioralSignal,
  failurePressure: BehavioralSignal,
): BehavioralSignal {
  const m = ctx.metrics["8h"];
  const idleRecovery = clamp01(1 - (m.busyRatio ?? 0));
  const value = clamp01(
    weightedMean([
      [momentum.value, 0.3],
      [sustainedLoad.value, 0.2],
      [collaboration.value, 0.2],
      [idleRecovery, 0.15],
      [clamp01(1 - failurePressure.value), 0.15],
    ]),
  );
  const confidence = dampenConfidence(
    averageConfidence([
      momentum.confidence,
      sustainedLoad.confidence,
      collaboration.confidence,
    ]),
    0.6,
  );
  return {
    value,
    confidence,
    basis: [
      "momentum",
      "sustainedLoad",
      "collaboration",
      "8h:idle_recovery",
      "proxy:operational_not_subjective_emotion",
    ],
  };
}
