/**
 * Test fixtures for the Paperclip plugin UI tests. Shape sticks to the
 * canonical bridge contract in `@paperclip-pixel/core` + `bridge-contract.ts`
 * so assertions read against real production types.
 */

import type { AgentFeedback, CompanySummary, RawAgentProjection, TimeWindow, VersionedAgentBehaviorVector, WindowedMetrics } from "@paperclip-pixel/core";
import { TIME_WINDOWS } from "@paperclip-pixel/core";
import type {
  BridgeAgentView,
  BridgeCompanySnapshot,
  BridgeStreamEvent,
} from "../bridge-contract";

export function makeSignal(
  value = 0.5,
  confidence = 0.8,
  basis: string[] = ["observed:values"],
): { value: number; confidence: number; basis: string[] } {
  return { value, confidence, basis };
}

function fillBehavior(): VersionedAgentBehaviorVector {
  const proxy = {
    value: 0.5,
    confidence: 0.8,
    basis: ["observed:values"],
  };
  return {
    schemaVersion: 1,
    agentId: "agent-a",
    companyId: "co",
    calculatedAt: "2026-08-22T10:00:00.000Z",
    load: proxy,
    sustainedLoad: proxy,
    burstiness: proxy,
    friction: proxy,
    failurePressure: proxy,
    interruptionPressure: proxy,
    collaboration: proxy,
    waiting: proxy,
    idleAvailability: proxy,
    contextSwitching: proxy,
    projectSpread: proxy,
    momentum: proxy,
    // Optional higher-level proxies are intentionally left out by default;
    // tests opt in via overrides.
  };
}

export function makeMetrics(): Record<TimeWindow, WindowedMetrics> {
  const emptyWindow = Object.fromEntries(
    TIME_WINDOWS.map((window) => [
      window,
      {
        window,
        runStarts: 0,
        runFinishes: 0,
        runFailures: 0,
        runCancellations: 0,
        issueTransitions: 0,
        projectSwitches: 0,
        distinctProjects: 0,
        distinctIssues: 0,
        commentEvents: 0,
        questionEvents: 0,
        blockedEvents: 0,
        approvalWaitEvents: 0,
        samples: 0,
        coverageMs: 5 * 60 * 1000,
      } satisfies WindowedMetrics,
    ]),
  );
  return emptyWindow as unknown as Record<TimeWindow, WindowedMetrics>;
}

export function makeProjection(
  overrides: Partial<RawAgentProjection> = {},
): RawAgentProjection {
  return {
    companyId: "co",
    agentId: "agent-a",
    name: "Alice",
    status: "running",
    role: "engineer",
    activeRuns: [],
    activeRunCount: 0,
    assignedIssues: [],
    blockedIssues: [],
    projectIds: [],
    approvalsWaiting: [],
    recentEvents: [],
    observedAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

export function makeAgentView(
  overrides: Partial<BridgeAgentView> = {},
): BridgeAgentView {
  return {
    projection: makeProjection(),
    metrics: makeMetrics(),
    behavior: fillBehavior(),
    ...overrides,
  };
}

export function makeSnapshot(
  overrides: Partial<BridgeCompanySnapshot> = {},
): BridgeCompanySnapshot {
  return {
    schemaVersion: 1,
    company: { id: "co", name: "Pixel Company" },
    summary: {
      schemaVersion: 1,
      companyId: "co",
      companyName: "Pixel Company",
      agentCount: 1,
      activeRunCount: 0,
      openIssueCount: 0,
      blockedIssueCount: 0,
      waitingApprovalCount: 0,
    },
    agents: [],
    issues: [],
    projects: [],
    approvals: [],
    feedback: [],
    observedAt: "2026-08-22T10:00:00.000Z",
    lastReconciledAt: "2026-08-22T10:00:00.000Z",
    ...overrides,
  };
}

export function makeFeedback(
  overrides: Partial<AgentFeedback> = {},
): AgentFeedback {
  return {
    id: "fb-1",
    companyId: "co",
    agentId: "agent-a",
    runId: "run-1",
    issueId: "iss-1",
    projectId: "prj-1",
    kind: "question",
    summary: "Need a decision on scope.",
    requiresResponse: true,
    existingWorkContext: true,
    createdAt: "2026-08-22T10:00:00.000Z",
    provenance: {},
    ...overrides,
  };
}

type StreamEventOf<T extends BridgeStreamEvent["type"]> = Extract<
  BridgeStreamEvent,
  { type: T }
>;

export function makeStreamEvent<T extends BridgeStreamEvent["type"]>(
  type: T,
  payload: StreamEventOf<T>["payload"],
  overrides: Partial<StreamEventOf<T>> = {},
): StreamEventOf<T> {
  return {
    schemaVersion: 1,
    eventId: `evt-${Math.random().toString(36).slice(2)}`,
    type,
    companyId: "co",
    occurredAt: "2026-08-22T10:00:01.000Z",
    ...overrides,
    payload,
  } as StreamEventOf<T>;
}

export function makeSummary(overrides: Partial<CompanySummary> = {}): CompanySummary {
  return {
    schemaVersion: 1,
    companyId: "co",
    companyName: "Pixel Company",
    agentCount: 1,
    activeRunCount: 0,
    openIssueCount: 0,
    blockedIssueCount: 0,
    waitingApprovalCount: 0,
    ...overrides,
  } satisfies CompanySummary;
}
