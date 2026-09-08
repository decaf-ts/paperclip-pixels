/**
 * Company / CEO intake surface (spec PAPERCLIP_PIXELS-1, §17, §26.1, FR-6).
 *
 * This is the ONLY UI path that may originate new-work intent. Messages are
 * sent through the worker's `company.send-message` action (spec §15) — never
 * through a direct Paperclip call (FR-9). Input is validated locally before
 * submission (defense in depth; the worker Zod-validates too, §28.4).
 *
 * State-changing actions are blocked while the bridge is stale/disconnected
 * (§30.1, NFR-4).
 */

import { useEffect, useRef, useState } from "react";
import { usePluginAction } from "@paperclipai/plugin-sdk/ui";
import { BRIDGE_ACTION_KEYS } from "../bridge-contract";
import { validateIntakeText } from "../new-work-gate";

export interface CompanyIntakeProps {
  companyId: string;
  /** True while the bridge is stale/disconnected — blocks sending (§30.1). */
  disabled: boolean;
  /** Text prefilled from a fail-closed "Send to company" reroute (§5.2). */
  prefill: string | null;
  onPrefillConsumed: () => void;
}

export function CompanyIntake({
  companyId,
  disabled,
  prefill,
  onPrefillConsumed,
}: CompanyIntakeProps) {
  const sendCompanyMessage = usePluginAction(BRIDGE_ACTION_KEYS.companySendMessage);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [sentCount, setSentCount] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (prefill !== null) {
      setText(prefill);
      onPrefillConsumed();
      textareaRef.current?.focus();
    }
  }, [prefill, onPrefillConsumed]);

  async function handleSend() {
    if (disabled || sending) return;
    const validationError = validateIntakeText(text);
    if (validationError) {
      setError(validationError);
      return;
    }
    setSending(true);
    setError(null);
    try {
      await sendCompanyMessage({ companyId, text: text.trim() });
      setText("");
      setSentCount((count) => count + 1);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to send company message.");
    } finally {
      setSending(false);
    }
  }

  return (
    <section
      data-testid="company-intake"
      style={{
        border: "1px solid #d0d0d0",
        borderRadius: 8,
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <div>
        <strong>Company intake</strong>
        <div style={{ opacity: 0.75, fontSize: "0.9em" }}>
          New work starts here — routed to company/leadership intake.
        </div>
      </div>

      <textarea
        ref={textareaRef}
        data-testid="company-intake-input"
        value={text}
        placeholder="Describe the work for the company…"
        rows={3}
        disabled={disabled || sending}
        onChange={(event) => setText(event.target.value)}
        style={{ width: "100%", boxSizing: "border-box", fontFamily: "inherit" }}
      />

      {error ? (
        <div role="alert" data-testid="company-intake-error" style={{ color: "#b00020" }}>
          {error}
        </div>
      ) : null}

      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <button
          type="button"
          data-testid="company-intake-send"
          onClick={() => {
            void handleSend();
          }}
          disabled={disabled || sending}
        >
          {sending ? "Sending…" : "Send to company"}
        </button>
        {disabled ? (
          <span style={{ opacity: 0.75, fontSize: "0.9em" }}>
            Disconnected — sending is paused until the bridge reconnects.
          </span>
        ) : null}
        {sentCount > 0 ? (
          <span style={{ opacity: 0.75, fontSize: "0.9em" }}>
            {sentCount} message{sentCount === 1 ? "" : "s"} sent.
          </span>
        ) : null}
      </div>
    </section>
  );
}
