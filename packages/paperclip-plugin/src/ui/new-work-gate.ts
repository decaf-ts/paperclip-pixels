/**
 * Fail-closed new-work gate for the UI (spec PAPERCLIP_PIXELS-1, §5.2,
 * §18.1/§18.3, FR-7/FR-8).
 *
 * If text entered in an individual-agent interaction appears to introduce new
 * work — or the feedback is not bound to existing work — the UI must fail
 * closed: no mutation occurs and a deliberate "Send to company" path is
 * offered.
 *
 * The hard guarantee is the worker action path: `agent.reply-to-feedback`
 * holds no `issues.create` capability and re-evaluates the same policy
 * server-side (defense in depth, §28.4). This module only keeps the UI from
 * submitting replies the worker would refuse or reroute, and from rendering a
 * reply affordance where none is valid.
 */

import { looksLikeNewWork } from "@paperclip-pixel/core";
import type { AgentFeedback } from "@paperclip-pixel/core";

export type ReplyGateDecision =
  | { kind: "reply"; issueId?: string; runId?: string }
  | { kind: "route-to-company"; reason: "new-work" | "missing-context" };

/**
 * Decide whether a reply to `feedback` may be submitted on the
 * individual-agent path.
 *
 * - `missing-context`: the feedback is not bound to an existing Paperclip
 *   work context (no `existingWorkContext`, or no issue/run binding) —
 *   replies are only valid in the context of existing work (§5.4, §18.1).
 * - `new-work`: the text looks like materially new work (§5.2, §18.3). The
 *   classifier is advisory; the action path is the hard boundary.
 */
export function gateAgentReply(
  feedback: AgentFeedback,
  text: string,
): ReplyGateDecision {
  if (!feedback.existingWorkContext) {
    return { kind: "route-to-company", reason: "missing-context" };
  }
  if (!feedback.issueId && !feedback.runId) {
    return { kind: "route-to-company", reason: "missing-context" };
  }
  if (looksLikeNewWork(text)) {
    return { kind: "route-to-company", reason: "new-work" };
  }
  return {
    kind: "reply",
    issueId: feedback.issueId,
    runId: feedback.runId,
  };
}

/** Maximum length for locally composed messages (defense in depth; the worker Zod-validates too). */
export const BRIDGE_MESSAGE_MAX_LENGTH = 4000;

/** Validate company-intake text. Returns an error message, or null when valid. */
export function validateIntakeText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Enter a message for the company.";
  }
  if (trimmed.length > BRIDGE_MESSAGE_MAX_LENGTH) {
    return `Message must be ${BRIDGE_MESSAGE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}

/** Validate an individual-agent reply. Returns an error message, or null when valid. */
export function validateReplyText(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) {
    return "Enter a reply for the agent.";
  }
  if (trimmed.length > BRIDGE_MESSAGE_MAX_LENGTH) {
    return `Reply must be ${BRIDGE_MESSAGE_MAX_LENGTH} characters or fewer.`;
  }
  return null;
}
