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
 *
 * The wire-contract DTOs, operation ids, schema-version constants, and event/
 * analytics/feed/appearance shapes are owned by `@decaf-ts/paperclip-pixels-common` (the
 * board's neutral `./common` contract package). This module re-exports those
 * shared contract symbols from the package and keeps the purely local runtime
 * machinery (temporal, reducer, behavior, policy) here.
 */
import { BRIDGE_SCHEMA_VERSION } from "@decaf-ts/paperclip-pixels-common";
import { SCHEMA_VERSION as COMMON_SCHEMA_VERSION } from "@decaf-ts/paperclip-pixels-common";

// Canonical bridge contract (spec §9) — owned by the neutral contract package.
export type {
  RawAgentProjection,
  RawRunProjection,
  RawIssueRef,
  RawApprovalRef,
  RawObservedEvent,
  AgentExecutionState,
} from "@decaf-ts/paperclip-pixels-common";

export type { TimeWindow, WindowedMetrics } from "@decaf-ts/paperclip-pixels-common";
export {
  TIME_WINDOWS,
} from "@decaf-ts/paperclip-pixels-common";
// Local runtime constants (not part of the neutral wire contract). The
// analytics/time-window *shapes* are common; these bag-and-bucket timings
// drive the plugin's own temporal machinery and stay package-local.
export { WINDOW_DURATION_MS, BUCKET_INTERVAL_MS, BUCKETS_PER_24H } from "./domain/metrics.js";

export type { BehavioralSignal, AgentBehaviorVector, Hysteresis } from "@decaf-ts/paperclip-pixels-common";
export type { VersionedAgentBehaviorVector } from "@decaf-ts/paperclip-pixels-common";

export type { AgentFeedbackKind, AgentFeedback } from "@decaf-ts/paperclip-pixels-common";

// Per-agent character catalog + assignment selection (spec
// PAPERCLIP_PIXELS-2, FR-13 / WS3). The catalog/assignment SHAPES are the
// wire contract (common); the selection/runtime helpers stay local.
export type {
  CharacterCatalogEntry,
  CharacterCatalog,
  AgentCharacterAssignment,
  AgentCharacterAssignmentMap,
} from "@decaf-ts/paperclip-pixels-common";
export { HUE_SHIFT_MAX_DEG } from "@decaf-ts/paperclip-pixels-common";
export {
  parseCharacterCatalog,
  findCatalogEntry,
  isAgentCharacterAssignment,
  mulberry32,
  hashAgentSeed,
  countCharacterUsage,
  selectDefaultAssignment,
  ensureAgentAssignments,
  validateAssignmentInput,
} from "./domain/characters.js";

// Conversation-extract shaping for the dialog pane (spec
// PAPERCLIP_PIXELS-2, WS4-C; NFR-7 / CEO decision 2 guardrails).
export {
  DIALOG_EXTRACT_MAX_CHARS_REDACTED,
  DIALOG_EXTRACT_MAX_CHARS_OPT_IN,
  DIALOG_LINE_MAX_CHARS,
  redactSensitiveText,
  collapseWhitespace,
  dialogExtract,
  clampDialogLine,
} from "./domain/dialog.js";

// Decoupled input contracts (spec §12) — owned by the neutral contract package.
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
  AgentCreatedPayload,
  AgentErrorClearedPayload,
  IssueCheckedOutPayload,
  IssueAssignmentWakeupRequestedPayload,
  IssueDocumentPayload,
  BridgeInputEvent,
  BridgeEventKind,
} from "@decaf-ts/paperclip-pixels-common";
export {
  BRIDGE_EVENT_KINDS,
  eventAgentId,
} from "@decaf-ts/paperclip-pixels-common";
export {
  runProjectionFromEvent,
} from "./domain/events.js";

// Temporal.
export { RingBuffer } from "./temporal/ring-buffer.js";
export { AgentWindowStore } from "./temporal/windows.js";
export type {
  Bucket,
  BucketRecord,
  AgentWindowMetrics,
  CompactBucket,
  CompactAgentBuckets,
} from "./temporal/windows.js";
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
} from "./temporal/rates.js";

// Reducer / store.
export { EventDeduper } from "./reducer/idempotency.js";
export { BridgeStore, BRIDGE_SCHEMA_VERSION } from "./reducer/store.js";
export type {
  BridgeStoreOptions,
  RawSnapshot,
  CompanySummary,
  BehaviorChangedEvent,
  MetricsBucket,
  AgentMetricsSeries,
  MetricsSeriesResult,
} from "./reducer/store.js";
export { createState, applyEvent, recomputeAgentRaw } from "./reducer/reducer.js";
export type { AgentState, BridgeState } from "./reducer/reducer.js";
export { reconcile } from "./reducer/reconciliation.js";

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
} from "./behavior/workload.js";
export type { BehaviorContext } from "./behavior/workload.js";
export { computeFailurePressure, computeFriction } from "./behavior/friction.js";
export {
  computeMomentum,
  computeStressProxy,
  computeEngagementProxy,
} from "./behavior/momentum.js";
export {
  confidenceForWindow,
  confidenceForMetrics,
  blendConfidence,
  averageConfidence,
  dampenConfidence,
} from "./behavior/confidence.js";

// Policy (spec §5.2, §15, §17, §18).
export {
  validateIntake,
  looksLikeNewWork,
} from "./policy/intake.js";
export type {
  CompanyIntakeConfig,
  CompanyIntakeMessage,
  IntakeResult,
} from "./policy/intake.js";
export {
  assertExistingWorkContext,
  evaluateAgentReply,
} from "./policy/agent-reply.js";
export type { AgentReplyInput, ReplyResult } from "./policy/agent-reply.js";

/**
 * Recommended stream event envelope for worker -> UI bridge updates
 * (spec §16). Every serialized bridge payload carries `schemaVersion: 1`
 * (§33.1, NFR-6). Owned by the neutral contract package.
 */
export type { BridgeUiEvent } from "@decaf-ts/paperclip-pixels-common";

/** Current bridge schema version (spec §33.1, NFR-6). */
export const SCHEMA_VERSION = COMMON_SCHEMA_VERSION;
