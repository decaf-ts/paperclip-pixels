/**
 * Pixel Office page (spec PAPERCLIP_PIXELS-1, §26, §27, §30).
 *
 * The embedded Paperclip plugin UI: renders bridge state (companies, agents,
 * active runs with concurrency preserved, assigned/blocked issues, approvals
 * waiting, project context, per-agent windowed metrics and behavior vectors),
 * hosts the company/CEO intake surface (the only new-work path), and the
 * fail-closed individual-agent feedback surface.
 *
 * Trust boundary (FR-9, §28.2): every domain read/write goes through the
 * plugin worker via `ctx.data` / `ctx.actions` / `ctx.streams` — this
 * component tree never calls Paperclip HTTP routes directly.
 */

import { useCallback, useState } from "react";
import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { PluginPageProps } from "@paperclipai/plugin-sdk/ui";
import { formatTimestamp } from "./format";
import { useBridge } from "./use-bridge";
import { AgentCard } from "./components/agent-card";
import { AgentDetail } from "./components/agent-detail";
import { CompanyIntake } from "./components/company-intake";
import { FeedbackPopup } from "./components/feedback-popup";

export function PixelOfficePage({ context }: PluginPageProps) {
  if (!context.companyId) {
    return (
      <div data-testid="pixel-office-no-company">
        Select a company to view the Pixel Office.
      </div>
    );
  }
  return <PixelOfficePageInner companyId={context.companyId} />;
}

function PixelOfficePageInner({ companyId }: { companyId: string }) {
  const { state, connected, stale, refresh } = useBridge(companyId);
  const navigation = useHostNavigation();
  const [openAgentId, setOpenAgentId] = useState<string | null>(null);
  const [intakePrefill, setIntakePrefill] = useState<string | null>(null);
  const [dismissedFeedbackIds, setDismissedFeedbackIds] = useState<ReadonlySet<string>>(
    new Set<string>(),
  );

  const handleSendToCompany = useCallback((text: string) => {
    setIntakePrefill(text);
  }, []);

  const handleDismissFeedback = useCallback((feedbackId: string) => {
    setDismissedFeedbackIds((prev) => {
      const next = new Set(prev);
      next.add(feedbackId);
      return next;
    });
  }, []);

  const snapshot = state.snapshot;

  if (state.loading && !snapshot) {
    return <div data-testid="pixel-office-loading">Loading Pixel Office…</div>;
  }

  if (state.error && !snapshot) {
    return (
      <div role="alert" data-testid="pixel-office-error">
        Unable to load the Pixel Office: {state.error}
      </div>
    );
  }

  if (!snapshot) {
    return <div data-testid="pixel-office-empty">No bridge data available.</div>;
  }

  const openAgent = openAgentId
    ? snapshot.agents.find((agent) => agent.projection.agentId === openAgentId)
    : undefined;

  const visibleFeedback = snapshot.feedback.filter(
    (feedback) => !dismissedFeedbackIds.has(feedback.id),
  );

  return (
    <div data-testid="pixel-office-page" style={{ display: "grid", gap: 16 }}>
      <header style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
        <div>
          <h1 style={{ margin: 0 }}>{snapshot.company.name}</h1>
          <div style={{ opacity: 0.75, fontSize: "0.9em" }}>
            {connected ? "Live" : "Disconnected — state may be stale"} · last
            synchronized {formatTimestamp(state.lastSyncedAt)}
          </div>
        </div>
        <button type="button" data-testid="pixel-office-refresh" onClick={refresh}>
          Refresh
        </button>
      </header>

      {stale ? (
        <div
          role="status"
          data-testid="pixel-office-stale-banner"
          style={{
            border: "1px solid #8a6d00",
            borderRadius: 8,
            padding: 8,
            background: "#fff8e1",
          }}
        >
          Paperclip connection unavailable. Last synchronized:{" "}
          {formatTimestamp(state.lastSyncedAt)}. State-changing actions are
          paused until the bridge reconnects.
        </div>
      ) : null}

      <section
        data-testid="company-overview"
        style={{ display: "flex", gap: 16, flexWrap: "wrap", opacity: 0.9 }}
      >
        <span>{snapshot.summary.agentCount} agents</span>
        <span>{snapshot.summary.activeRunCount} active runs</span>
        <span>{snapshot.summary.openIssueCount} open issues</span>
        <span>{snapshot.summary.blockedIssueCount} blocked issues</span>
        <span>{snapshot.summary.waitingApprovalCount} approvals waiting</span>
      </section>

      <CompanyIntake
        companyId={companyId}
        disabled={stale}
        prefill={intakePrefill}
        onPrefillConsumed={() => setIntakePrefill(null)}
      />

      <section style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Agents</h2>
        {openAgent ? (
          <AgentDetail view={openAgent} onBack={() => setOpenAgentId(null)} />
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {snapshot.agents.map((view) => (
              <AgentCard
                key={view.projection.agentId}
                view={view}
                onOpen={setOpenAgentId}
              />
            ))}
            {snapshot.agents.length === 0 ? (
              <div style={{ opacity: 0.7 }}>No agents observed.</div>
            ) : null}
          </div>
        )}
      </section>

      <section style={{ display: "grid", gap: 12 }}>
        <h2 style={{ margin: 0 }}>Outstanding feedback</h2>
        {visibleFeedback.length === 0 ? (
          <div style={{ opacity: 0.7 }}>No outstanding feedback.</div>
        ) : (
          visibleFeedback.map((feedback) => (
            <FeedbackPopup
              key={feedback.id}
              feedback={feedback}
              companyId={companyId}
              disabled={stale}
              navigation={navigation}
              onSendToCompany={handleSendToCompany}
              onDismiss={handleDismissFeedback}
            />
          ))
        )}
      </section>
    </div>
  );
}
