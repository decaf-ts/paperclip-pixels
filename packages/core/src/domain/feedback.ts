/**
 * Feedback contract (spec §9.4).
 *
 * Semantic feedback surfaced by individual agents, bound to existing Paperclip
 * work where applicable. `existingWorkContext` is true only when the feedback
 * is bound to a pre-existing Paperclip work/conversation context.
 */

export type AgentFeedbackKind =
  | "progress"
  | "question"
  | "blocked"
  | "warning"
  | "review"
  | "approval"
  | "result"
  | "completion"
  | "failure"
  | "informational";

export interface AgentFeedback {
  id: string;

  companyId: string;
  agentId: string;

  runId?: string;
  issueId?: string;
  projectId?: string;

  kind: AgentFeedbackKind;
  summary: string;
  detail?: string;

  requiresResponse: boolean;

  /**
   * True only when the feedback is bound to a pre-existing Paperclip
   * work/conversation context.
   */
  existingWorkContext: boolean;

  createdAt: string;

  provenance: {
    eventIds?: string[];
    commentId?: string;
    sessionId?: string;
  };
}
