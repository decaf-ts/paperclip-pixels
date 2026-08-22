/**
 * @paperclip-pixel/core
 *
 * Shared translation core for the Paperclip <-> Pixel Agents bridge (spec
 * PAPERCLIP_PIXELS-1). Owns the canonical bridge contract, raw projection,
 * temporal metrics, behavioral proxies, feedback classification, idempotent
 * reducer, reconciliation, and the action policy / new-work gate.
 *
 * Pure TypeScript. No UI framework, no visual renderer, no host UI, and no
 * runtime dependency on the host plugin SDK (spec §7.1, NFR-8).
 */

import { BRIDGE_SCHEMA_VERSION } from "./reducer/store";

// Canonical bridge contract (spec §9) — exported verbatim.
export type {
  RawAgentProjection,
  RawRunProjection,
  RawIssueRef,
  RawApprovalRef,
  RawObservedEvent,
  AgentExecutionState,
} from "./domain/raw";

export type { TimeWindow, WindowedMetrics } from "./domain/metrics";
export {
  WINDOW_DURATION_MS,
  BUCKET_INTERVAL_MS,
  BUCKETS_PER_24H,
  TIME_WINDOWS,
} from "./domain/metrics";

export type { BehavioralSignal, AgentBehaviorVector, Hysteresis } from "./domain/behavior";
export type { VersionedAgentBehaviorVector } from "./domain/behavior";

export type { AgentFeedbackKind, AgentFeedback } from "./domain/feedback";

// Decoupled input contracts (spec §12).
export type {
  CompanyInput,
  AgentInput,
  ProjectInput,
  RunSummaryInput,
  IssueInput,
  ApprovalInput,
  AuthoritativeSnapshotInput,
  BridgeEventActor,
  BridgeEventEntity,
  BridgeEventBase,
  AgentStatusChangedPayload,
  AgentRunStartedPayload,
  AgentRunFinishedPayload,
  AgentRunFailedPayload,
  AgentRunCancelledPayload,
  IssueUpdatedPayload,
  IssueCommentCreatedPayload,
  ApprovalCreatedPayload,
  ApprovalDecidedPayload,
  BudgetIncidentOpenedPayload,
  BudgetIncidentResolvedPayload,
  CostEventCreatedPayload,
  BridgeInputEvent,
  BridgeEventKind,
} from "./domain/events";
export {
  BRIDGE_EVENT_KINDS,
  eventAgentId,
  runProjectionFromEvent,
} from "./domain/events";

// Temporal.
export { RingBuffer } from "./temporal/ring-buffer";
export { AgentWindowStore } from "./temporal/windows";
export type {
  Bucket,
  BucketRecord,
  AgentWindowMetrics,
  CompactBucket,
  CompactAgentBuckets,
} from "./temporal/windows";
export {
  clamp01,
  clamp,
  mean,
  stddev,
  weightedMean,
  ratioClamp,
  percentile,
  weightedRecentCount,
  roundTo,
} from "./temporal/rates";

// Reducer / store.
export { EventDeduper } from "./reducer/idempotency";
export { BridgeStore, BRIDGE_SCHEMA_VERSION } from "./reducer/store";
export type {
  BridgeStoreOptions,
  RawSnapshot,
  CompanySummary,
  BehaviorChangedEvent,
} from "./reducer/store";
export { createState, applyEvent, recomputeAgentRaw } from "./reducer/reducer";
export type { AgentState, BridgeState } from "./reducer/reducer";
export { reconcile } from "./reducer/reconciliation";

// Behavior.
export {
  computeLoad,
  computeSustainedLoad,
  computeBurstiness,
  computeIdleAvailability,
  computeContextSwitching,
  computeProjectSpread,
  computeInterruptionPressure,
  computeWaiting,
  computeCollaboration,
} from "./behavior/workload";
export type { BehaviorContext } from "./behavior/workload";
export { computeFailurePressure, computeFriction } from "./behavior/friction";
export {
  computeMomentum,
  computeStressProxy,
  computeEngagementProxy,
} from "./behavior/momentum";
export {
  confidenceForWindow,
  confidenceForMetrics,
  blendConfidence,
  averageConfidence,
  dampenConfidence,
} from "./behavior/confidence";

// Policy (spec §5.2, §15, §17, §18).
export {
  validateIntake,
  looksLikeNewWork,
} from "./policy/intake";
export type {
  CompanyIntakeConfig,
  CompanyIntakeMessage,
  IntakeResult,
} from "./policy/intake";
export {
  assertExistingWorkContext,
  evaluateAgentReply,
} from "./policy/agent-reply";
export type { AgentReplyInput, ReplyResult } from "./policy/agent-reply";

/**
 * Recommended stream event envelope for worker -> UI bridge updates
 * (spec §16). Every serialized bridge payload carries `schemaVersion: 1`
 * (§33.1, NFR-6).
 */
export interface BridgeUiEvent<T = unknown> {
  schemaVersion: 1;
  eventId: string;
  type: string;
  companyId: string;
  occurredAt: string;
  payload: T;
}

/** Current bridge schema version (spec §33.1, NFR-6). */
export const SCHEMA_VERSION = BRIDGE_SCHEMA_VERSION;
