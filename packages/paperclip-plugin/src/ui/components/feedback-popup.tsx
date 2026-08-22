/**
 * Individual-agent feedback popup (spec PAPERCLIP_PIXELS-1, §5.3, §18,
 * §26.2/26.3, FR-7/FR-8, FR-15).
 *
 * Bound to existing work context only. The reply path is fail-closed:
 * - feedback without an existing work context offers no reply — only
 *   "Send to company";
 * - reply text that looks like new work is not submitted — "Send to company"
 *   is offered instead (no mutation occurs, §5.2);
 * - the worker re-evaluates the same policy and can still return
 *   `route-to-company`, which the UI honors by routing to intake.
 *
 * The reply action path holds no `issues.create` capability — the structural
 * guarantee (spec §5.2, §18.3).
 */

import { useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import type { HostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { AgentFeedback } from "@paperclip-pixel/core";
import { BRIDGE_ACTION_KEYS } from "../bridge-contract";
import { gateAgentReply, validateReplyText } from "../new-work-gate";

export interface FeedbackPopupProps {
  feedback: AgentFeedback;
  companyId: string;
  /** True while the bridge is stale/disconnected — blocks replying (§30.1). */
  disabled: boolean;
  navigation: HostNavigation;
  /** Route text to the company intake surface (fail-closed reroute). */
  onSendToCompany: (text: string) => void;
  /** Locally dismiss the feedback from the UI list (no Paperclip mutation). */
  onDismiss: (feedbackId: string) => void;
}

interface WorkerReplyResult {
  kind: "sent" | "route-to-company";
  suggestedText?: string;
  reason?: "new-work" | "missing-context";
}

export function FeedbackPopup({
  feedback,
  companyId,
  disabled,
  navigation,
  onSendToCompany,
  onDismiss,
}: FeedbackPopupProps) {
  const replyToAgent = usePluginAction(BRIDGE_ACTION_KEYS.agentReplyToFeedback);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState(false);

  const gate = gateAgentReply(feedback, text);
  const hasWorkContext = Boolean(feedback.existingWorkContext && (feedback.issueId || feedback.runId));
  const issueHref = feedback.issueId
    ? navigation.resolveHref(`/issues/${feedback.issueId}`)
    : null;

  async function handleReply() {
    if (disabled || sending || gate.kind !== "reply") return;
    const validationError = validateReplyText(text);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSending(true);
    setError(null);
    try {
      const result = (await replyToAgent({
        companyId,
        feedbackId: feedback.id,
        text: text.trim(),
      })) as WorkerReplyResult | undefined;

      // The worker re-evaluates the new-work gate (defense in depth). Honor a
      // route-to-company outcome: no mutation happened; offer intake routing.
      if (result && result.kind === "route-to-company") {
        setError(
          result.reason === "new-work"
            ? "This reply looks like new work, so it was not sent to the agent. Route it through company intake instead."
            : "This feedback has no existing work context, so the reply was not sent. Route it through company intake instead.",
        );
        if (result.suggestedText) {
          onSendToCompany(result.suggestedText);
        }
        return;
      }

      setSent(true);
      setText("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send reply.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      data-testid="feedback-popup"
      data-feedback-id={feedback.id}
      style={{
        border: "1px solid #d0d0d0",
        borderRadius: 8,
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <div>
        <strong>
          {feedback.kind}
          {feedback.requiresResponse ? " · needs response" : ""}
        </strong>
        <div style={{ opacity: 0.6, fontSize: "0.85em" }}>
          agent {feedback.agentId}
          {feedback.issueId ? ` · issue ${feedback.issueId}` : ""}
          {feedback.runId ? ` · run ${feedback.runId}` : ""}
          {feedback.projectId ? ` · project ${feedback.projectId}` : ""}
        </div>
        <div>{feedback.summary}</div>
        {feedback.detail ? (
          <div style={{ opacity: 0.8, fontSize: "0.9em" }}>{feedback.detail}</div>
        ) : null}
      </div>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {hasWorkContext ? (
          <button
            type="button"
            data-testid="feedback-reply"
            onClick={() => {
              void handleReply();
            }}
            disabled={disabled || sending || gate.kind !== "reply"}
          >
            Reply
          </button>
        ) : null}
        {issueHref ? (
          <a
            data-testid="feedback-open-context"
            {...navigation.linkProps(issueHref)}
          >
            Open work context
          </a>
        ) : null}
        <button
          type="button"
          data-testid="feedback-send-to-company"
          onClick={() => onSendToCompany(text.trim() || feedback.summary)}
          disabled={disabled}
        >
          Send to company
        </button>
        <button
          type="button"
          data-testid="feedback-dismiss"
          onClick={() => onDismiss(feedback.id)}
        >
          Dismiss
        </button>
      </div>

      {hasWorkContext ? (
        <textarea
          data-testid="feedback-reply-input"
          value={text}
          placeholder="Reply in the context of this work…"
          rows={2}
          disabled={disabled || sending || sent}
          onChange={(event) => setText(event.target.value)}
          style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
        />
      ) : (
        <div style={{ opacity: 0.8, fontSize: "0.9em" }}>
          This feedback is not bound to existing work, so replies are not
          available. Use “Send to company” to route it to company intake.
        </div>
      )}

      {hasWorkContext && gate.kind === "route-to-company" && text.trim() !== "" ? (
        <div
          role="alert"
          data-testid="feedback-reroute-notice"
          style={{ color: "#8a6d00", fontSize: "0.9em" }}
        >
          {gate.reason === "new-work"
            ? "This looks like new work. It will not be sent to the agent — use “Send to company” to route it through company intake."
            : "This feedback has no existing work context — use “Send to company” instead."}
        </div>
      ) : null}

      {error ? (
        <div role="alert" data-testid="feedback-error" style={{ color: "#b00020" }}>
          {error}
        </div>
      ) : null}
      {sent ? (
        <div data-testid="feedback-sent" style={{ opacity: 0.75, fontSize: "0.9em" }}>
          Reply sent in the context of the existing work.
        </div>
      ) : null}
    </div>
  );
}
