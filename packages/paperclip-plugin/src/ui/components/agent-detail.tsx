/**
 * Expanded agent detail (spec PAPERCLIP_PIXELS-1, §26.2, §9.2, §9.3, FR-3,
 * FR-4, FR-15).
 *
 * Renders the full raw projection (runs, issues, approvals, projects —
 * canonical IDs, concurrency preserved), windowed metrics per time window,
 * and the complete behavioral vector with value + confidence + basis.
 * Optional stress/engagement proxies carry an explicit operational-proxy
 * disclaimer and are never presented as factual emotion.
 */

import type { TimeWindow } from "@paperclip-pixel/core";
import { TIME_WINDOWS } from "@paperclip-pixel/core";
import type { BridgeAgentView } from "../bridge-contract";
import {
  ENGAGEMENT_PROXY_NOTE,
  formatPercent,
  formatTimestamp,
  shortId,
  STRESS_PROXY_NOTE,
} from "../format";
import { BehaviorSignal } from "./behavior-signal";

export interface AgentDetailProps {
  view: BridgeAgentView;
  onBack: () => void;
}

export function AgentDetail({ view, onBack }: AgentDetailProps) {
  const { projection, metrics, behavior } = view;

  return (
    <section
      data-testid="agent-detail"
      data-agent-id={projection.agentId}
      style={{ border: "1px solid #d0d0d0", borderRadius: 8, padding: 12, display: "grid", gap: 12 }}
    >
      <header style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div>
          <strong style={{ fontSize: "1.1em" }}>{projection.name}</strong>
          {projection.role ? <div style={{ opacity: 0.75 }}>Role: {projection.role}</div> : null}
          <div style={{ opacity: 0.6, fontSize: "0.85em" }}>
            agent {projection.agentId} · status {projection.status} · observed{" "}
            {formatTimestamp(projection.observedAt)}
          </div>
        </div>
        <button type="button" data-testid="agent-detail-back" onClick={onBack}>
          Back
        </button>
      </header>

      <div>
        <div style={{ fontWeight: 600 }}>Active runs ({projection.activeRunCount})</div>
        {projection.activeRuns.length === 0 ? (
          <div style={{ opacity: 0.7 }}>none</div>
        ) : (
          <table style={{ borderCollapse: "collapse", fontSize: "0.9em", marginTop: 4 }}>
            <thead>
              <tr>
                <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>run</th>
                <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>status</th>
                <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>issue</th>
                <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>started</th>
              </tr>
            </thead>
            <tbody>
              {projection.activeRuns.map((run) => (
                <tr key={run.runId} data-testid="detail-run" data-run-id={run.runId}>
                  <td style={{ padding: "2px 8px 2px 0" }}>{run.runId}</td>
                  <td style={{ padding: "2px 8px 2px 0" }}>{run.status}</td>
                  <td style={{ padding: "2px 8px 2px 0" }}>
                    {run.issueId ? run.issueId : "—"}
                  </td>
                  <td style={{ padding: "2px 8px 2px 0" }}>
                    {formatTimestamp(run.startedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
        <div>
          <div style={{ fontWeight: 600 }}>Assigned issues</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: "0.9em" }}>
            {projection.assignedIssues.length === 0 ? (
              <li style={{ opacity: 0.7 }}>none</li>
            ) : (
              projection.assignedIssues.map((issue) => (
                <li key={issue.issueId}>
                  {issue.title ? `${issue.title} · ` : ""}
                  {issue.issueId} ({issue.status})
                </li>
              ))
            )}
          </ul>
        </div>
        <div>
          <div style={{ fontWeight: 600 }}>Blocked issues</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: "0.9em" }}>
            {projection.blockedIssues.length === 0 ? (
              <li style={{ opacity: 0.7 }}>none</li>
            ) : (
              projection.blockedIssues.map((issue) => (
                <li key={issue.issueId}>
                  {issue.title ? `${issue.title} · ` : ""}
                  {issue.issueId} ({issue.status})
                </li>
              ))
            )}
          </ul>
        </div>
      </div>

      <div>
        <div style={{ fontWeight: 600 }}>Projects</div>
        <div style={{ fontSize: "0.9em", marginTop: 4 }}>
          {projection.projectIds.length === 0
            ? "none"
            : projection.projectIds.map((id) => shortId(id)).join(", ")}
        </div>
      </div>

      {projection.approvalsWaiting.length > 0 ? (
        <div>
          <div style={{ fontWeight: 600 }}>Approvals waiting</div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 18, fontSize: "0.9em" }}>
            {projection.approvalsWaiting.map((approval) => (
              <li key={approval.approvalId}>
                {approval.approvalId} ({approval.status})
                {approval.issueId ? ` · issue ${approval.issueId}` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <div>
        <div style={{ fontWeight: 600 }}>Windowed metrics</div>
        <table style={{ borderCollapse: "collapse", fontSize: "0.9em", marginTop: 4 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>window</th>
              <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>busy</th>
              <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>runs</th>
              <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>failures</th>
              <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>blocked</th>
              <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>projects</th>
              <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>samples</th>
            </tr>
          </thead>
          <tbody>
            {TIME_WINDOWS.map((window: TimeWindow) => {
              const m = metrics[window];
              return (
                <tr key={window} data-testid="metrics-window" data-window={window}>
                  <td style={{ padding: "2px 8px 2px 0" }}>{window}</td>
                  <td style={{ padding: "2px 8px 2px 0", textAlign: "right" }}>
                    {m.busyRatio !== undefined ? formatPercent(m.busyRatio) : "—"}
                  </td>
                  <td style={{ padding: "2px 8px 2px 0", textAlign: "right" }}>
                    {m.runStarts}/{m.runFinishes}
                  </td>
                  <td style={{ padding: "2px 8px 2px 0", textAlign: "right" }}>
                    {m.runFailures}
                  </td>
                  <td style={{ padding: "2px 8px 2px 0", textAlign: "right" }}>
                    {m.blockedEvents}
                  </td>
                  <td style={{ padding: "2px 8px 2px 0", textAlign: "right" }}>
                    {m.distinctProjects}
                  </td>
                  <td style={{ padding: "2px 8px 2px 0", textAlign: "right" }}>
                    {m.samples}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div>
        <div style={{ fontWeight: 600 }}>
          Operational signals (derived proxies — not emotion)
        </div>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <BehaviorSignal label="load" signal={behavior.load} />
          <BehaviorSignal label="sustained load" signal={behavior.sustainedLoad} />
          <BehaviorSignal label="burstiness" signal={behavior.burstiness} />
          <BehaviorSignal label="friction" signal={behavior.friction} />
          <BehaviorSignal label="failure pressure" signal={behavior.failurePressure} />
          <BehaviorSignal label="interruption pressure" signal={behavior.interruptionPressure} />
          <BehaviorSignal label="collaboration" signal={behavior.collaboration} />
          <BehaviorSignal label="waiting" signal={behavior.waiting} />
          <BehaviorSignal label="idle availability" signal={behavior.idleAvailability} />
          <BehaviorSignal label="context switching" signal={behavior.contextSwitching} />
          <BehaviorSignal label="project spread" signal={behavior.projectSpread} />
          <BehaviorSignal label="momentum" signal={behavior.momentum} />
          {behavior.stressProxy ? (
            <BehaviorSignal
              label="stress proxy (operational estimate)"
              signal={behavior.stressProxy}
              note={STRESS_PROXY_NOTE}
            />
          ) : null}
          {behavior.engagementProxy ? (
            <BehaviorSignal
              label="engagement proxy (operational estimate)"
              signal={behavior.engagementProxy}
              note={ENGAGEMENT_PROXY_NOTE}
            />
          ) : null}
        </ul>
      </div>
    </section>
  );
}
