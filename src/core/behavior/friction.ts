/**
 * Friction and failure-pressure proxies (spec §11.6–11.7).
 */

import type { BehavioralSignal } from "../domain/behavior.js";
import type { BehaviorContext } from "./workload.js";
import { clamp01, ratioClamp, weightedMean } from "../temporal/rates.js";
import { confidenceForMetrics } from "./confidence.js";

/** Failure pressure (spec §11.6): weighted recent failures / weighted recent runs. */
export function computeFailurePressure(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["8h"];
  const failures = m.recentFailureWeighted;
  const runs = Math.max(1, m.recentRunWeighted);
  const value = clamp01(failures / runs);
  return {
    value,
    confidence: confidenceForMetrics(m, "8h"),
    basis: ["8h:weighted_recent_failures", "8h:weighted_recent_runs"],
  };
}

/**
 * Friction (spec §11.7). Combines blocked issues, approval waits, failure
 * pressure, stalled work, and invocation blocks (the latter two approximated
 * from available evidence in V1).
 */
export function computeFriction(ctx: BehaviorContext): BehavioralSignal {
  const m8 = ctx.metrics["8h"];
  const m2 = ctx.metrics["2h"];

  const assigned = Math.max(1, ctx.assignedIssueCount);
  const blockedIssueRatio = ratioClamp(ctx.blockedIssueCount, assigned);
  const approvalWaitRatio = ratioClamp(ctx.waitingApprovalCount, assigned);
  const failurePressure = computeFailurePressure(ctx).value;
  const stalledWorkRatio = ratioClamp(m2.blockedEvents, Math.max(1, m2.issueTransitions + m2.blockedEvents));
  const invocationBlockRatio = ratioClamp(m8.approvalWaitEvents, Math.max(1, m8.runStarts + m8.approvalWaitEvents));

  const value = clamp01(
    weightedMean([
      [blockedIssueRatio, 0.3],
      [approvalWaitRatio, 0.2],
      [failurePressure, 0.25],
      [stalledWorkRatio, 0.15],
      [invocationBlockRatio, 0.1],
    ]),
  );

  const confidence = Math.min(
    confidenceForMetrics(m8, "8h"),
    confidenceForMetrics(m2, "2h"),
  );

  return {
    value,
    confidence,
    basis: [
      "raw:blocked_issue_ratio",
      "raw:approval_wait_ratio",
      "8h:failure_pressure",
      "2h:stalled_work_ratio",
      "8h:invocation_block_ratio",
    ],
  };
}
