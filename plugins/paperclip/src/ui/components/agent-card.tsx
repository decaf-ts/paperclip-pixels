/**
 * Factual agent card (spec PAPERCLIP_PIXELS-1, §26.2, FR-1, FR-2).
 *
 * Shows raw facts with canonical Paperclip IDs and run-level concurrency
 * (each active run listed — never collapsed), plus a short operational
 * signal summary and outstanding feedback. Derived signals are labeled as
 * operational proxies, never as emotion (FR-15).
 */

import type { BridgeAgentView } from "../bridge-contract";
import { shortId } from "../format";
import { BehaviorSignal } from "./behavior-signal";

export interface AgentCardProps {
  view: BridgeAgentView;
  onOpen: (agentId: string) => void;
}

export function AgentCard({ view, onOpen }: AgentCardProps) {
  const { projection, behavior } = view;

  return (
    <section
      data-testid="agent-card"
      data-agent-id={projection.agentId}
      style={{
        border: "1px solid #d0d0d0",
        borderRadius: 8,
        padding: 12,
        display: "grid",
        gap: 8,
      }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <strong style={{ fontSize: "1.05em" }}>{projection.name}</strong>
          {projection.role ? (
            <div style={{ opacity: 0.75 }}>Role: {projection.role}</div>
          ) : null}
          <div style={{ opacity: 0.6, fontSize: "0.85em" }}>
            agent {shortId(projection.agentId)} · status {projection.status}
          </div>
        </div>
        <button
          type="button"
          data-testid="agent-open-detail"
          onClick={() => onOpen(projection.agentId)}
        >
          Details
        </button>
      </header>

      <div>
        <div style={{ fontWeight: 600 }}>Current</div>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <li>
            {projection.activeRunCount} active run
            {projection.activeRunCount === 1 ? "" : "s"}
          </li>
          <li>
            {projection.projectIds.length} project
            {projection.projectIds.length === 1 ? "" : "s"}
          </li>
          <li>
            {projection.blockedIssues.length} blocked issue
            {projection.blockedIssues.length === 1 ? "" : "s"}
          </li>
        </ul>
        {projection.activeRuns.length > 0 ? (
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: "0.9em" }}>
            {projection.activeRuns.map((run) => (
              <li key={run.runId} data-testid="active-run" data-run-id={run.runId}>
                run {shortId(run.runId)} · {run.status}
                {run.issueId ? ` · issue ${shortId(run.issueId)}` : ""}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <div>
        <div style={{ fontWeight: 600 }}>Operational signals (derived proxies)</div>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <BehaviorSignal label="sustained load" signal={behavior.sustainedLoad} />
          <BehaviorSignal label="friction" signal={behavior.friction} />
          <BehaviorSignal label="collaboration" signal={behavior.collaboration} />
        </ul>
      </div>

      {projection.approvalsWaiting.length > 0 ? (
        <div style={{ opacity: 0.85 }}>
          Waiting on {projection.approvalsWaiting.length} approval
          {projection.approvalsWaiting.length === 1 ? "" : "s"}
        </div>
      ) : null}
    </section>
  );
}
