/**
 * Workload, sustained-load, burstiness, idle availability, context switching,
 * and project-spread proxies (spec §11.3–11.5, §11.8).
 */

import type { BehavioralSignal } from "../domain/behavior.js";
import type { TimeWindow } from "../domain/metrics.js";
import type { AgentWindowMetrics } from "../temporal/windows.js";
import { clamp01, mean, ratioClamp, stddev, weightedMean } from "../temporal/rates.js";
import { confidenceForMetrics } from "./confidence.js";

/** Context assembled by the store for behavior derivation. */
export interface BehaviorContext {
  agentId: string;
  companyId: string;
  now: number;
  metrics: Record<TimeWindow, AgentWindowMetrics>;
  /** Currently blocked assigned issues. */
  blockedIssueCount: number;
  /** Currently assigned (open) issues. */
  assignedIssueCount: number;
  /** Approvals currently waiting. */
  waitingApprovalCount: number;
  /** Active run count (raw projection). */
  activeRunCount: number;
  /** Distinct projects across active runs. */
  activeDistinctProjects: number;
  /** Whether the agent has been observed at all since load. */
  everObserved: boolean;
}

const DEFAULT_LOAD_CONCURRENCY_NORM = 4;
const DEFAULT_ISSUE_ACTIVITY_NORM = 12;
const DEFAULT_CONTEXT_SWITCH_NORM = 8;
const DEFAULT_PROJECT_SPREAD_NORM = 5;

/** Load (spec §11.3). Four concurrent runs is NOT a universal threshold. */
export function computeLoad(ctx: BehaviorContext, norm = DEFAULT_LOAD_CONCURRENCY_NORM): BehavioralSignal {
  const m = ctx.metrics["5m"];
  const concurrency = clamp01(m.meanConcurrentRuns / norm);
  const busy = m.busyRatio ?? 0;
  const issueActivity = ratioClamp(m.issueTransitions, DEFAULT_ISSUE_ACTIVITY_NORM);
  const value = clamp01(
    weightedMean([
      [busy, 0.5],
      [concurrency, 0.35],
      [issueActivity, 0.15],
    ]),
  );
  return {
    value,
    confidence: confidenceForMetrics(m, "5m"),
    basis: ["5m:busy_ratio", "5m:mean_concurrent_runs", "5m:issue_transitions"],
  };
}

/** Sustained load (spec §11.4) prevents a 5m burst from looking like hours of work. */
export function computeSustainedLoad(ctx: BehaviorContext): BehavioralSignal {
  const load5 = computeLoad(ctx).value;
  const load30 = computeLoadForWindow(ctx, "30m");
  const load2h = computeLoadForWindow(ctx, "2h");
  const load8h = computeLoadForWindow(ctx, "8h");
  const value = clamp01(
    0.15 * load5 + 0.25 * load30 + 0.35 * load2h + 0.25 * load8h,
  );
  const conf = Math.min(
    confidenceForMetrics(ctx.metrics["2h"], "2h"),
    confidenceForMetrics(ctx.metrics["8h"], "8h"),
  );
  return {
    value,
    confidence: conf,
    basis: ["5m:load", "30m:load", "2h:load", "8h:load"],
  };
}

function computeLoadForWindow(ctx: BehaviorContext, window: TimeWindow, norm = DEFAULT_LOAD_CONCURRENCY_NORM): number {
  const m = ctx.metrics[window];
  const concurrency = clamp01(m.meanConcurrentRuns / norm);
  const busy = m.busyRatio ?? 0;
  const issueActivity = ratioClamp(m.issueTransitions, DEFAULT_ISSUE_ACTIVITY_NORM);
  return clamp01(
    weightedMean([
      [busy, 0.5],
      [concurrency, 0.35],
      [issueActivity, 0.15],
    ]),
  );
}

/** Burstiness (spec §11.5): stddev/mean of run-starts per 5m bucket. */
export function computeBurstiness(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["24h"];
  const perBucket = m.runStartsPerBucket;
  const avg = mean(perBucket);
  const sd = stddev(perBucket);
  const value = clamp01(sd / Math.max(1, avg));
  return {
    value,
    confidence: confidenceForMetrics(m, "24h"),
    basis: ["24h:run_starts_per_bucket_stddev", "24h:run_starts_per_bucket_mean"],
  };
}

/** Idle availability: how available the agent is to take new work. */
export function computeIdleAvailability(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["30m"];
  const idle = m.idleRatio ?? 1;
  // Fewer active runs and low recent load increase availability.
  const activeFactor = clamp01(1 - ctx.activeRunCount / DEFAULT_LOAD_CONCURRENCY_NORM);
  const value = clamp01(weightedMean([
    [idle, 0.6],
    [activeFactor, 0.4],
  ]));
  return {
    value,
    confidence: confidenceForMetrics(m, "30m"),
    basis: ["30m:idle_ratio", "raw:active_run_count"],
  };
}

/** Context switching (spec §11.8). */
export function computeContextSwitching(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["2h"];
  const issueSwitches = m.issueTransitions;
  const projectSwitches = m.projectSwitches;
  const overlappingDistinctProjects = m.overlappingRunRatio * m.distinctProjects;
  const value = clamp01(
    (issueSwitches * 1.0 + projectSwitches * 1.5 + overlappingDistinctProjects * 1.5) /
      DEFAULT_CONTEXT_SWITCH_NORM,
  );
  return {
    value,
    confidence: confidenceForMetrics(m, "2h"),
    basis: ["2h:issue_transitions", "2h:project_switches", "2h:overlapping_distinct_projects"],
  };
}

/** Project spread: breadth of concurrent project involvement. */
export function computeProjectSpread(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["8h"];
  const distinct = m.distinctProjects;
  const value = ratioClamp(distinct, DEFAULT_PROJECT_SPREAD_NORM);
  return {
    value,
    confidence: confidenceForMetrics(m, "8h"),
    basis: ["8h:distinct_projects", "raw:active_distinct_projects"],
  };
}

/** Interruption pressure: question/comment-driven interruptions relative to work. */
export function computeInterruptionPressure(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["30m"];
  const interruptions = m.questionEvents + m.commentEvents;
  const work = Math.max(1, m.runStarts + m.runFinishes);
  const value = ratioClamp(interruptions / work, 1);
  return {
    value,
    confidence: confidenceForMetrics(m, "30m"),
    basis: ["30m:question_events", "30m:comment_events", "30m:run_events"],
  };
}

/** Waiting: approval/blocked/question events requiring a response. */
export function computeWaiting(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["2h"];
  const waitingEvents = m.approvalWaitEvents + m.blockedEvents + m.questionEvents;
  const rawWaiting = clamp01((ctx.waitingApprovalCount + ctx.blockedIssueCount) / Math.max(1, ctx.assignedIssueCount));
  return {
    value: clamp01(weightedMean([
      [ratioClamp(waitingEvents, 6), 0.6],
      [rawWaiting, 0.4],
    ])),
    confidence: confidenceForMetrics(m, "2h"),
    basis: ["2h:approval_wait_events", "2h:blocked_events", "2h:question_events", "raw:blocked_issues", "raw:waiting_approvals"],
  };
}

/** Collaboration (spec §11.9): interaction intensity, not quality. */
export function computeCollaboration(ctx: BehaviorContext): BehavioralSignal {
  const m = ctx.metrics["8h"];
  const interactions = m.commentEvents + m.questionEvents;
  const value = ratioClamp(interactions, 10);
  return {
    value,
    confidence: confidenceForMetrics(m, "8h"),
    basis: ["8h:comment_events", "8h:question_events"],
  };
}
