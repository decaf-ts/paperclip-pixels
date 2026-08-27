/**
 * Temporal windows (spec §9.2, §11.2, §39.3, NFR-1).
 *
 * Fixed 5-minute buckets retained 24h per agent (288 buckets), stored in a
 * ring buffer. From these, `WindowedMetrics` is derived for each `TimeWindow`.
 * Restart-safe: buckets can be exported to / restored from a compact
 * serializable form for persistence in plugin state (§39.3).
 */

import type { TimeWindow, WindowedMetrics } from "../domain/metrics.js";
import {
  BUCKET_INTERVAL_MS,
  BUCKETS_PER_24H,
  WINDOW_DURATION_MS,
} from "../domain/metrics.js";
import { RingBuffer } from "./ring-buffer.js";
import { mean, percentile, stddev, weightedRecentCount } from "./rates.js";

const HALF_LIFE_2H = 2 * 60 * 60 * 1000;
const RECENT_TIMESTAMP_WINDOW = 24 * 60 * 60 * 1000;

/** One 5-minute observation bucket. */
export interface Bucket {
  bucketStart: number;
  runStarts: number;
  runFinishes: number;
  runFailures: number;
  runCancellations: number;
  issueTransitions: number;
  projectSwitches: number;
  commentEvents: number;
  questionEvents: number;
  blockedEvents: number;
  approvalWaitEvents: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  projects: Set<string>;
  issues: Set<string>;
  runDurationsMs: number[];
  concurrentRunSamples: number[];
  samples: number;
}

function emptyBucket(bucketStart: number): Bucket {
  return {
    bucketStart,
    runStarts: 0,
    runFinishes: 0,
    runFailures: 0,
    runCancellations: 0,
    issueTransitions: 0,
    projectSwitches: 0,
    commentEvents: 0,
    questionEvents: 0,
    blockedEvents: 0,
    approvalWaitEvents: 0,
    costCents: 0,
    inputTokens: 0,
    outputTokens: 0,
    projects: new Set<string>(),
    issues: new Set<string>(),
    runDurationsMs: [],
    concurrentRunSamples: [],
    samples: 0,
  };
}

/** Incremental record applied to a bucket. */
export interface BucketRecord {
  runStarts?: number;
  runFinishes?: number;
  runFailures?: number;
  runCancellations?: number;
  issueTransitions?: number;
  projectSwitches?: number;
  commentEvents?: number;
  questionEvents?: number;
  blockedEvents?: number;
  approvalWaitEvents?: number;
  costCents?: number;
  inputTokens?: number;
  outputTokens?: number;
  projects?: string[];
  issues?: string[];
  runDurationMs?: number;
  concurrentRuns?: number;
  samples?: number;
}

interface ActiveRun {
  startedAt: number | null;
  issueId?: string | null;
  projectId?: string | null;
}

interface AgentRuntime {
  buckets: RingBuffer<Bucket>;
  activeRuns: Map<string, ActiveRun>;
  runStartTimestamps: number[];
  failureTimestamps: number[];
  runFinishTimestamps: number[];
  lastProject?: string;
  lastIssue?: string;
}

/** Internal extended metrics used by the behavioral model. */
export interface AgentWindowMetrics extends WindowedMetrics {
  meanConcurrentRuns: number;
  maxConcurrentRuns: number;
  overlappingRunRatio: number;
  runStartsPerBucket: number[];
  recentFailureWeighted: number;
  recentRunWeighted: number;
}

/** Compact, JSON-serializable per-agent state for restart recovery (§39.3). */
export interface CompactBucket {
  bucketStart: number;
  runStarts: number;
  runFinishes: number;
  runFailures: number;
  runCancellations: number;
  issueTransitions: number;
  projectSwitches: number;
  commentEvents: number;
  questionEvents: number;
  blockedEvents: number;
  approvalWaitEvents: number;
  costCents: number;
  inputTokens: number;
  outputTokens: number;
  projects: string[];
  issues: string[];
  runDurationsMs: number[];
  concurrentRunSamples: number[];
  samples: number;
}

export interface CompactAgentBuckets {
  buckets: CompactBucket[];
  activeRuns: Array<{ runId: string; startedAt: number | null; issueId?: string | null; projectId?: string | null }>;
  runStartTimestamps: number[];
  failureTimestamps: number[];
  runFinishTimestamps: number[];
  lastProject?: string;
  lastIssue?: string;
}

function bucketStartFor(ts: number): number {
  return Math.floor(ts / BUCKET_INTERVAL_MS) * BUCKET_INTERVAL_MS;
}

function pruneRecent(arr: number[], now: number, windowMs = RECENT_TIMESTAMP_WINDOW): void {
  const cutoff = now - windowMs;
  while (arr.length > 0 && arr[0] < cutoff) arr.shift();
}

export class AgentWindowStore {
  private readonly agents = new Map<string, AgentRuntime>();

  private ensure(agentId: string): AgentRuntime {
    let r = this.agents.get(agentId);
    if (!r) {
      r = {
        buckets: new RingBuffer<Bucket>(BUCKETS_PER_24H),
        activeRuns: new Map(),
        runStartTimestamps: [],
        failureTimestamps: [],
        runFinishTimestamps: [],
      };
      this.agents.set(agentId, r);
    }
    return r;
  }

  has(agentId: string): boolean {
    return this.agents.has(agentId);
  }

  /** Record an incremental update into the bucket for `ts`. */
  record(agentId: string, rec: BucketRecord, ts: number): void {
    const r = this.ensure(agentId);
    const start = bucketStartFor(ts);
    let bucket = r.buckets.newest();
    if (!bucket || bucket.bucketStart !== start) {
      bucket = emptyBucket(start);
      r.buckets.push(bucket);
    }
    bucket.runStarts += rec.runStarts ?? 0;
    bucket.runFinishes += rec.runFinishes ?? 0;
    bucket.runFailures += rec.runFailures ?? 0;
    bucket.runCancellations += rec.runCancellations ?? 0;
    bucket.issueTransitions += rec.issueTransitions ?? 0;
    bucket.projectSwitches += rec.projectSwitches ?? 0;
    bucket.commentEvents += rec.commentEvents ?? 0;
    bucket.questionEvents += rec.questionEvents ?? 0;
    bucket.blockedEvents += rec.blockedEvents ?? 0;
    bucket.approvalWaitEvents += rec.approvalWaitEvents ?? 0;
    bucket.costCents += rec.costCents ?? 0;
    bucket.inputTokens += rec.inputTokens ?? 0;
    bucket.outputTokens += rec.outputTokens ?? 0;
    if (rec.projects) for (const p of rec.projects) bucket.projects.add(p);
    if (rec.issues) for (const i of rec.issues) bucket.issues.add(i);
    if (rec.runDurationMs !== undefined) bucket.runDurationsMs.push(rec.runDurationMs);
    if (rec.concurrentRuns !== undefined) bucket.concurrentRunSamples.push(rec.concurrentRuns);
    bucket.samples += rec.samples ?? 1;
  }

  recordRunStart(
    agentId: string,
    runId: string,
    ts: number,
    issueId?: string | null,
    projectId?: string | null,
  ): void {
    const r = this.ensure(agentId);
    r.activeRuns.set(runId, { startedAt: ts, issueId, projectId });
    r.runStartTimestamps.push(ts);
    pruneRecent(r.runStartTimestamps, ts);
    this.record(agentId, { runStarts: 1, concurrentRuns: r.activeRuns.size, issues: issueId ? [issueId] : [], projects: projectId ? [projectId] : [] }, ts);
  }

  /** Returns the finished run's info, or undefined if it was not tracked. */
  recordRunEnd(
    agentId: string,
    runId: string,
    ts: number,
    kind: "finished" | "failed" | "cancelled",
    durationMs?: number,
  ): ActiveRun | undefined {
    const r = this.ensure(agentId);
    const run = r.activeRuns.get(runId);
    r.activeRuns.delete(runId);
    r.runFinishTimestamps.push(ts);
    pruneRecent(r.runFinishTimestamps, ts);
    const rec: BucketRecord = { concurrentRuns: r.activeRuns.size };
    if (kind === "finished") {
      rec.runFinishes = 1;
      if (durationMs !== undefined) rec.runDurationMs = durationMs;
    } else if (kind === "failed") {
      rec.runFailures = 1;
      r.failureTimestamps.push(ts);
      pruneRecent(r.failureTimestamps, ts);
      if (durationMs !== undefined) rec.runDurationMs = durationMs;
    } else {
      rec.runCancellations = 1;
    }
    this.record(agentId, rec, ts);
    return run;
  }

  /** Note an issue/project observation; increments switch counters on change. */
  noteContext(
    agentId: string,
    ts: number,
    issueId?: string | null,
    projectId?: string | null,
  ): void {
    const r = this.ensure(agentId);
    const rec: BucketRecord = {
      issues: issueId ? [issueId] : [],
      projects: projectId ? [projectId] : [],
    };
    if (issueId && issueId !== r.lastIssue) {
      rec.issueTransitions = 1;
      r.lastIssue = issueId;
    }
    if (projectId && projectId !== r.lastProject) {
      rec.projectSwitches = 1;
      r.lastProject = projectId;
    }
    this.record(agentId, rec, ts);
  }

  getActiveRuns(agentId: string): Map<string, ActiveRun> {
    return this.ensure(agentId).activeRuns;
  }

  getActiveRunCount(agentId: string): number {
    return this.ensure(agentId).activeRuns.size;
  }

  getRecentTimestamps(agentId: string): {
    runStarts: number[];
    failures: number[];
    finishes: number[];
  } {
    const r = this.ensure(agentId);
    return {
      runStarts: r.runStartTimestamps,
      failures: r.failureTimestamps,
      finishes: r.runFinishTimestamps,
    };
  }

  /** Buckets whose span overlaps [now - windowMs, now]. */
  private recentBuckets(agentId: string, now: number, windowMs: number): Bucket[] {
    const r = this.ensure(agentId);
    const cutoff = now - windowMs;
    return r.buckets
      .toArray()
      .filter((b) => b.bucketStart + BUCKET_INTERVAL_MS > cutoff && b.bucketStart <= now);
  }

  getWindowedMetrics(agentId: string, window: TimeWindow, now: number): WindowedMetrics {
    return this.getExtendedMetrics(agentId, window, now);
  }

  getExtendedMetrics(agentId: string, window: TimeWindow, now: number): AgentWindowMetrics {
    const windowMs = WINDOW_DURATION_MS[window];
    const buckets = this.recentBuckets(agentId, now, windowMs);

    const runStarts = sum(buckets, (b) => b.runStarts);
    const runFinishes = sum(buckets, (b) => b.runFinishes);
    const runFailures = sum(buckets, (b) => b.runFailures);
    const runCancellations = sum(buckets, (b) => b.runCancellations);
    const issueTransitions = sum(buckets, (b) => b.issueTransitions);
    const projectSwitches = sum(buckets, (b) => b.projectSwitches);
    const commentEvents = sum(buckets, (b) => b.commentEvents);
    const questionEvents = sum(buckets, (b) => b.questionEvents);
    const blockedEvents = sum(buckets, (b) => b.blockedEvents);
    const approvalWaitEvents = sum(buckets, (b) => b.approvalWaitEvents);
    const costCents = sum(buckets, (b) => b.costCents);
    const inputTokens = sum(buckets, (b) => b.inputTokens);
    const outputTokens = sum(buckets, (b) => b.outputTokens);
    const samples = sum(buckets, (b) => b.samples);

    const projects = new Set<string>();
    const issues = new Set<string>();
    const durations: number[] = [];
    const concurrency: number[] = [];
    const runStartsPerBucket: number[] = [];
    for (const b of buckets) {
      for (const p of b.projects) projects.add(p);
      for (const i of b.issues) issues.add(i);
      for (const d of b.runDurationsMs) durations.push(d);
      for (const c of b.concurrentRunSamples) concurrency.push(c);
      runStartsPerBucket.push(b.runStarts);
    }

    const r = this.ensure(agentId);
    const cutoff = now - windowMs;
    const recentRunStarts = r.runStartTimestamps.filter((t) => t >= cutoff);
    const recentFailures = r.failureTimestamps.filter((t) => t >= cutoff);

    const meanConcurrentRuns = concurrency.length > 0 ? mean(concurrency) : 0;
    const maxConcurrentRuns = concurrency.length > 0 ? Math.max(...concurrency) : 0;
    const overlappingSamples = concurrency.filter((c) => c > 1).length;
    const overlappingRunRatio =
      concurrency.length > 0 ? overlappingSamples / concurrency.length : 0;

    const recentFailureWeighted = weightedRecentCount(
      r.failureTimestamps.filter((t) => t >= now - windowMs),
      now,
      HALF_LIFE_2H,
    );
    const recentRunWeighted = weightedRecentCount(
      r.runStartTimestamps.filter((t) => t >= now - windowMs),
      now,
      HALF_LIFE_2H,
    );

    let coverageMs = 0;
    if (buckets.length > 0) {
      const oldest = Math.min(...buckets.map((b) => b.bucketStart));
      coverageMs = Math.min(windowMs, Math.max(0, now - oldest));
    }

    const hasCost = buckets.some((b) => b.costCents !== 0);
    const hasTokens = buckets.some((b) => b.inputTokens !== 0 || b.outputTokens !== 0);

    const metrics: AgentWindowMetrics = {
      window,
      runStarts,
      runFinishes,
      runFailures,
      runCancellations,
      issueTransitions,
      projectSwitches,
      distinctProjects: projects.size,
      distinctIssues: issues.size,
      commentEvents,
      questionEvents,
      blockedEvents,
      approvalWaitEvents,
      samples,
      coverageMs,
      meanConcurrentRuns,
      maxConcurrentRuns,
      overlappingRunRatio,
      runStartsPerBucket,
      recentFailureWeighted,
      recentRunWeighted,
    };

    const busySamples = concurrency.filter((c) => c > 0).length;
    if (concurrency.length > 0) {
      metrics.busyRatio = busySamples / concurrency.length;
      metrics.idleRatio = 1 - metrics.busyRatio;
    }
    if (durations.length > 0) {
      metrics.meanRunDurationMs = mean(durations);
      metrics.p95RunDurationMs = percentile(durations, 0.95);
    }
    if (hasCost) metrics.costCents = costCents;
    if (hasTokens) {
      metrics.inputTokens = inputTokens;
      metrics.outputTokens = outputTokens;
    }

    void recentRunStarts;
    void recentFailures;
    return metrics;
  }

  /** Drop stale per-agent timestamp buffers and empty agents (housekeeping). */
  gc(now: number): void {
    for (const [agentId, r] of this.agents) {
      pruneRecent(r.runStartTimestamps, now);
      pruneRecent(r.failureTimestamps, now);
      pruneRecent(r.runFinishTimestamps, now);
      if (
        r.activeRuns.size === 0 &&
        r.runStartTimestamps.length === 0 &&
        r.failureTimestamps.length === 0 &&
        r.buckets.size === 0
      ) {
        this.agents.delete(agentId);
      }
    }
  }

  // --- Restart-safe compact export / restore (§39.3) -----------------------

  exportCompact(agentId: string): CompactAgentBuckets {
    const r = this.ensure(agentId);
    const buckets: CompactBucket[] = r.buckets.toArray().map((b) => ({
      bucketStart: b.bucketStart,
      runStarts: b.runStarts,
      runFinishes: b.runFinishes,
      runFailures: b.runFailures,
      runCancellations: b.runCancellations,
      issueTransitions: b.issueTransitions,
      projectSwitches: b.projectSwitches,
      commentEvents: b.commentEvents,
      questionEvents: b.questionEvents,
      blockedEvents: b.blockedEvents,
      approvalWaitEvents: b.approvalWaitEvents,
      costCents: b.costCents,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      projects: [...b.projects],
      issues: [...b.issues],
      runDurationsMs: b.runDurationsMs,
      concurrentRunSamples: b.concurrentRunSamples,
      samples: b.samples,
    }));
    const activeRuns: CompactAgentBuckets["activeRuns"] = [];
    for (const [runId, run] of r.activeRuns) {
      activeRuns.push({
        runId,
        startedAt: run.startedAt,
        issueId: run.issueId ?? null,
        projectId: run.projectId ?? null,
      });
    }
    return {
      buckets,
      activeRuns,
      runStartTimestamps: [...r.runStartTimestamps],
      failureTimestamps: [...r.failureTimestamps],
      runFinishTimestamps: [...r.runFinishTimestamps],
      lastProject: r.lastProject,
      lastIssue: r.lastIssue,
    };
  }

  restoreCompact(agentId: string, compact: CompactAgentBuckets): void {
    const r = this.ensure(agentId);
    r.buckets.clear();
    for (const cb of compact.buckets) {
      const b: Bucket = {
        bucketStart: cb.bucketStart,
        runStarts: cb.runStarts,
        runFinishes: cb.runFinishes,
        runFailures: cb.runFailures,
        runCancellations: cb.runCancellations,
        issueTransitions: cb.issueTransitions,
        projectSwitches: cb.projectSwitches,
        commentEvents: cb.commentEvents,
        questionEvents: cb.questionEvents,
        blockedEvents: cb.blockedEvents,
        approvalWaitEvents: cb.approvalWaitEvents,
        costCents: cb.costCents,
        inputTokens: cb.inputTokens,
        outputTokens: cb.outputTokens,
        projects: new Set(cb.projects),
        issues: new Set(cb.issues),
        runDurationsMs: [...cb.runDurationsMs],
        concurrentRunSamples: [...cb.concurrentRunSamples],
        samples: cb.samples,
      };
      r.buckets.push(b);
    }
    r.activeRuns.clear();
    for (const ar of compact.activeRuns) {
      r.activeRuns.set(ar.runId, {
        startedAt: ar.startedAt,
        issueId: ar.issueId,
        projectId: ar.projectId,
      });
    }
    r.runStartTimestamps = [...compact.runStartTimestamps];
    r.failureTimestamps = [...compact.failureTimestamps];
    r.runFinishTimestamps = [...compact.runFinishTimestamps];
    r.lastProject = compact.lastProject;
    r.lastIssue = compact.lastIssue;
  }

  exportAll(): Record<string, CompactAgentBuckets> {
    const out: Record<string, CompactAgentBuckets> = {};
    for (const agentId of this.agents.keys()) out[agentId] = this.exportCompact(agentId);
    return out;
  }

  restoreAll(data: Record<string, CompactAgentBuckets>): void {
    for (const [agentId, compact] of Object.entries(data)) {
      this.restoreCompact(agentId, compact);
    }
  }
}

function sum(buckets: Bucket[], pick: (b: Bucket) => number): number {
  let total = 0;
  for (const b of buckets) total += pick(b);
  return total;
}

// stddev is exported for behavior burstiness; re-export to keep the math local.
export { stddev };
