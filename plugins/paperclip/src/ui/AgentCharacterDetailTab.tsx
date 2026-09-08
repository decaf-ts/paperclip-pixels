/**
 * Agent-scoped `detailTab` (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The installed Paperclip SDK supports agent-scoped `detailTab` slots
 * (`entityTypes: ["agent"]`). The host renders this as an additional
 * "Character" tab on each native Paperclip agent detail page, with the agent's
 * operational metrics shown beside its character customization.
 *
 * `context.entityId` is the Paperclip agent id; `context.companyId` scopes the
 * character catalog/assignment data and the bridge snapshot that carries the
 * agent's metrics. Trust boundary (FR-9, §28.2): every read/write goes through
 * the plugin worker via `ctx.data` / `ctx.actions`.
 */

import { useMemo } from "react";
import { usePluginData } from "@paperclipai/plugin-sdk/ui";
import type { PluginDetailTabProps } from "@paperclipai/plugin-sdk/ui";
import type { TimeWindow } from "../core/index.js";
import { TIME_WINDOWS } from "../core/index.js";
import {
  BRIDGE_DATA_KEYS,
  type BridgeCompanySnapshot,
  type VisualSettingsData,
} from "./bridge-contract";
import { formatPercent, STRESS_PROXY_NOTE, ENGAGEMENT_PROXY_NOTE } from "./format";
import { AgentCharacterPicker } from "./components/character-picker";
import { BehaviorSignal } from "./components/behavior-signal";

export function AgentCharacterDetailTab({ context }: PluginDetailTabProps) {
  const companyId = context.companyId;
  const agentId = context.entityId;

  if (!companyId || !agentId) {
    return (
      <div data-testid="agent-detail-tab-empty">
        Select a company and agent to view character settings.
      </div>
    );
  }

  const snapshot = usePluginData<BridgeCompanySnapshot>(BRIDGE_DATA_KEYS.snapshot, {
    companyId,
  });
  const visual = usePluginData<VisualSettingsData>(BRIDGE_DATA_KEYS.visualSettings, {
    companyId,
  });

  const view = useMemo(
    () => snapshot.data?.agents.find((agent) => agent.projection.agentId === agentId),
    [snapshot.data, agentId],
  );

  if (snapshot.loading && !snapshot.data) {
    return (
      <div data-testid="agent-detail-tab-loading">Loading agent…</div>
    );
  }

  return (
    <div
      data-testid="agent-detail-character-tab"
      data-agent-id={agentId}
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}
    >
      <AgentCharacterPicker
        companyId={companyId}
        agents={view ? [view] : []}
        visual={visual.data ?? null}
        visualLoading={visual.loading}
        visualError={visual.error?.message ?? visual.data?.error ?? null}
      />
      <AgentMetricsPanel view={view} />
    </div>
  );
}

/** The metrics half of the agent detail tab (windowed metrics + signals). */
function AgentMetricsPanel({
  view,
}: {
  view: BridgeCompanySnapshot["agents"][number] | undefined;
}) {
  if (!view) {
    return (
      <section
        data-testid="agent-detail-tab-metrics"
        style={{ display: "grid", gap: 8 }}
      >
        <div style={{ fontWeight: 600 }}>Metrics</div>
        <div data-testid="agent-detail-tab-metrics-empty" style={{ opacity: 0.7 }}>
          No bridge metrics available for this agent yet.
        </div>
      </section>
    );
  }

  const { projection, metrics, behavior } = view;

  return (
    <section
      data-testid="agent-detail-tab-metrics"
      data-agent-id={projection.agentId}
      style={{ display: "grid", gap: 12 }}
    >
      <div style={{ fontWeight: 600 }}>Metrics — {projection.name}</div>

      <table style={{ borderCollapse: "collapse", fontSize: "0.9em" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", padding: "2px 8px 2px 0" }}>window</th>
            <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>busy</th>
            <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>runs</th>
            <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>failures</th>
            <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>blocked</th>
            <th style={{ textAlign: "right", padding: "2px 8px 2px 0" }}>samples</th>
          </tr>
        </thead>
        <tbody>
          {TIME_WINDOWS.map((window: TimeWindow) => {
            const m = metrics[window];
            return (
              <tr key={window} data-testid="detail-tab-metrics-window" data-window={window}>
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
                  {m.samples}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      <div>
        <div style={{ fontWeight: 600 }}>Operational signals</div>
        <ul style={{ margin: "4px 0 0", paddingLeft: 18 }}>
          <BehaviorSignal label="load" signal={behavior.load} />
          <BehaviorSignal label="failure pressure" signal={behavior.failurePressure} />
          <BehaviorSignal label="waiting" signal={behavior.waiting} />
          <BehaviorSignal label="collaboration" signal={behavior.collaboration} />
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
