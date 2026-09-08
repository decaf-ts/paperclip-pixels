/**
 * Individual-agent reply policy — the security-critical new-work gate
 * (spec §5.2, §18).
 *
 * Individual-agent replies are feedback channels that may continue existing
 * work context. They MUST NOT silently create new Paperclip work. The reply
 * handler does not hold or invoke `issues.create`; replies that look like new
 * work, or that lack an existing work context, return a `route-to-company`
 * outcome (fail closed).
 *
 * The hard guarantee is the action path, not a language-model classifier: a
 * classifier may SUGGEST new work, but only this pure policy decides whether a
 * reply may proceed.
 */

import type { AgentFeedback } from "../domain/feedback.js";
import { looksLikeNewWork } from "./intake.js";

export interface AgentReplyInput {
  companyId: string;
  feedbackId: string;
  text: string;
  /** The feedback object the reply is addressed to. */
  feedback: AgentFeedback;
  /** Host-authenticated actor (spec §15, §28.4). Supplied by the worker. */
  actor?: { id?: string; type?: string };
}

export type ReplyResult =
  | { kind: "sent"; feedbackId: string; text: string; issueId?: string; runId?: string }
  | {
      kind: "route-to-company";
      suggestedText: string;
      reason: "new-work" | "missing-context";
    };

/**
 * Assert that a feedback object is bound to existing Paperclip work
 * (spec §18.1). Throws if the feedback lacks an existing work context or an
 * issue/run binding — the caller should route such replies to company intake.
 */
export function assertExistingWorkContext(feedback: AgentFeedback): void {
  if (!feedback.existingWorkContext) {
    throw new Error(
      "Individual-agent replies require an existing Paperclip work context.",
    );
  }
  if (!feedback.issueId && !feedback.runId) {
    throw new Error(
      "Feedback lacks an issue/run binding; route through company intake.",
    );
  }
}

/**
 * Evaluate an individual-agent reply against the new-work gate.
 *
 * Returns `route-to-company` when:
 *  - the reply lacks an existing work context (missing-context), or
 *  - the reply text looks like materially new work (new-work).
 *
 * Returns `sent` only when the feedback is bound to existing work AND the text
 * does not introduce new work. This function NEVER creates an issue; it is pure
 * and holds no `issues.create` capability (spec §18.3).
 */
export function evaluateAgentReply(input: AgentReplyInput): ReplyResult {
  // Fail closed: no existing work context.
  if (!input.feedback.existingWorkContext) {
    return {
      kind: "route-to-company",
      suggestedText: input.text,
      reason: "missing-context",
    };
  }
  if (!input.feedback.issueId && !input.feedback.runId) {
    return {
      kind: "route-to-company",
      suggestedText: input.text,
      reason: "missing-context",
    };
  }

  // A classifier may suggest new work; if it does, route to company intake.
  if (looksLikeNewWork(input.text)) {
    return {
      kind: "route-to-company",
      suggestedText: input.text,
      reason: "new-work",
    };
  }

  return {
    kind: "sent",
    feedbackId: input.feedbackId,
    text: input.text,
    issueId: input.feedback.issueId,
    runId: input.feedback.runId,
  };
}
