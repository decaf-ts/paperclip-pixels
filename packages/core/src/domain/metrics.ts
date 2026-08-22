/**
 * Temporal metrics contract (spec §9.2).
 *
 * Rolling-window metrics derived from observed events over fixed windows.
 * Optional numeric fields stay `undefined` when source data is missing.
 */

export type TimeWindow = "5m" | "30m" | "2h" | "8h" | "24h";

export interface WindowedMetrics {
  window: TimeWindow;

  busyRatio?: number;
  idleRatio?: number;

  runStarts: number;
  runFinishes: number;
  runFailures: number;
  runCancellations: number;

  issueTransitions: number;
  projectSwitches: number;
  distinctProjects: number;
  distinctIssues: number;

  commentEvents: number;
  questionEvents: number;
  blockedEvents: number;
  approvalWaitEvents: number;

  meanRunDurationMs?: number;
  p95RunDurationMs?: number;

  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;

  samples: number;
  coverageMs: number;
}

/** Window duration in milliseconds. */
export const WINDOW_DURATION_MS: Record<TimeWindow, number> = {
  "5m": 5 * 60 * 1000,
  "30m": 30 * 60 * 1000,
  "2h": 2 * 60 * 60 * 1000,
  "8h": 8 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

/** Fixed 5-minute bucket interval (spec §9.2, NFR-1). 288 buckets span 24h. */
export const BUCKET_INTERVAL_MS = 5 * 60 * 1000;
export const BUCKETS_PER_24H = Math.floor(
  WINDOW_DURATION_MS["24h"] / BUCKET_INTERVAL_MS,
); // 288

export const TIME_WINDOWS: readonly TimeWindow[] = [
  "5m",
  "30m",
  "2h",
  "8h",
  "24h",
];
