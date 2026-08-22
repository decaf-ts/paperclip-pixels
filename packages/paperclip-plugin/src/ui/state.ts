/**
 * Pure bridge UI state machine (spec PAPERCLIP_PIXELS-1, §16, §29.3, §30).
 *
 * Snapshot + delta model: a full snapshot is applied on mount, company
 * switch, reconnect, sequence gap, and explicit refresh; stream deltas are
 * applied otherwise. Any delta that cannot be applied safely (unknown type,
 * unknown entity, or a delta before the first snapshot) marks the state as
 * gapped so the UI re-fetches a full snapshot (NFR-3, FR-13).
 *
 * This module is React-free so it can be tested directly.
 */

import type { AgentFeedback } from "@paperclip-pixel/core";
import type {
  BridgeCompanySnapshot,
  BridgeStreamEvent,
  FeedbackChangedDelta,
} from "./bridge-contract";
import { isBridgeStreamEvent } from "./bridge-contract";

export interface BridgeUiState {
  snapshot: BridgeCompanySnapshot | null;
  /** True while a full snapshot fetch is in flight. */
  loading: boolean;
  /** Last snapshot fetch error message, if any. */
  error: string | null;
  /** `observedAt` of the last applied full snapshot. */
  lastSyncedAt: string | null;
  /**
   * True when a stream delta could not be applied (unknown type, unknown
   * entity, or delta before first snapshot). The consumer must re-fetch a
   * full snapshot (spec §29.3).
   */
  gapDetected: boolean;
}

export const initialBridgeUiState: BridgeUiState = {
  snapshot: null,
  loading: false,
  error: null,
  lastSyncedAt: null,
  gapDetected: false,
};

export type BridgeUiAction =
  | { type: "reset" }
  | { type: "fetch-started" }
  | { type: "fetch-failed"; message: string }
  | { type: "snapshot-received"; snapshot: BridgeCompanySnapshot }
  | { type: "delta-received"; event: unknown }
  | { type: "gap-cleared" };

export function bridgeUiReducer(
  state: BridgeUiState,
  action: BridgeUiAction,
): BridgeUiState {
  switch (action.type) {
    case "reset":
      return { ...initialBridgeUiState, loading: state.loading };
    case "fetch-started":
      return { ...state, loading: true, error: null };
    case "fetch-failed":
      return { ...state, loading: false, error: action.message };
    case "snapshot-received":
      return applySnapshot(state, action.snapshot);
    case "delta-received":
      return applyDelta(state, action.event);
    case "gap-cleared":
      return { ...state, gapDetected: false };
    default:
      return state;
  }
}

function applySnapshot(
  state: BridgeUiState,
  snapshot: BridgeCompanySnapshot,
): BridgeUiState {
  return {
    ...state,
    loading: false,
    error: null,
    gapDetected: false,
    snapshot,
    lastSyncedAt: snapshot.observedAt ?? state.lastSyncedAt,
  };
}

function applyDelta(state: BridgeUiState, rawEvent: unknown): BridgeUiState {
  if (!isBridgeStreamEvent(rawEvent)) {
    // Unknown/foreign event type: sequence anomaly — re-fetch a full snapshot.
    return { ...state, gapDetected: true };
  }

  const event = rawEvent as BridgeStreamEvent;

  if (event.type === "bridge.snapshot") {
    return applySnapshot(state, event.payload);
  }

  if (!state.snapshot) {
    // A delta before the first full snapshot is a sequence anomaly (§29.3):
    // re-fetch the full snapshot.
    return { ...state, gapDetected: true };
  }

  switch (event.type) {
    case "company.summary.changed":
      return {
        ...state,
        snapshot: { ...state.snapshot, summary: event.payload },
      };
    case "agent.projection.changed":
      return replaceAgent(state, event.payload.agentId, (agent) => ({
        ...agent,
        projection: event.payload,
      }));
    case "agent.metrics.changed":
      return replaceAgent(state, event.payload.agentId, (agent) => ({
        ...agent,
        metrics: event.payload.metrics,
      }));
    case "agent.behavior.changed":
      return replaceAgent(state, event.payload.agentId, (agent) => ({
        ...agent,
        behavior: event.payload,
      }));
    case "feedback.changed":
      return {
        ...state,
        snapshot: {
          ...state.snapshot,
          feedback: upsertFeedback(state.snapshot.feedback, event.payload),
        },
      };
    default:
      return { ...state, gapDetected: true };
  }
}

/**
 * Replace one agent's view by canonical agentId. If the agent is not present
 * in the snapshot the delta is a sequence anomaly (gap) — never invent state.
 */
function replaceAgent(
  state: BridgeUiState,
  agentId: string,
  update: (agent: BridgeCompanySnapshot["agents"][number]) => BridgeCompanySnapshot["agents"][number],
): BridgeUiState {
  const snapshot = state.snapshot;
  if (!snapshot) return state;
  const exists = snapshot.agents.some((agent) => agent.projection.agentId === agentId);
  if (!exists) {
    return { ...state, gapDetected: true };
  }
  return {
    ...state,
    snapshot: {
      ...snapshot,
      agents: snapshot.agents.map((agent) =>
        agent.projection.agentId === agentId ? update(agent) : agent,
      ),
    },
  };
}

function upsertFeedback(
  list: AgentFeedback[],
  delta: FeedbackChangedDelta,
): AgentFeedback[] {
  if (delta.removed) {
    return list.filter((feedback) => feedback.id !== delta.feedback.id);
  }
  const index = list.findIndex((feedback) => feedback.id === delta.feedback.id);
  if (index === -1) {
    return [...list, delta.feedback];
  }
  const next = list.slice();
  next[index] = delta.feedback;
  return next;
}
