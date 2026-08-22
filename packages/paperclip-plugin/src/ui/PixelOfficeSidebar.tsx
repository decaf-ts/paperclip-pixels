/**
 * Pixel Office sidebar (spec PAPERCLIP_PIXELS-1, §26.1 — high-level
 * project/agent status).
 *
 * Compact, read-only status surface: live/stale indicator, last sync, key
 * counts, and a link to the full Pixel Office page. No state-changing
 * actions live here — intake and feedback replies are on the page.
 */

import { useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { PIXEL_OFFICE_PLUGIN_ID } from "./bridge-contract";
import { formatTimestamp } from "./format";
import { useBridge } from "./use-bridge";

export function PixelOfficeSidebar({ context }: PluginSidebarProps) {
  if (!context.companyId) {
    return null;
  }
  return <PixelOfficeSidebarInner companyId={context.companyId} />;
}

function PixelOfficeSidebarInner({ companyId }: { companyId: string }) {
  const { state, connected, stale } = useBridge(companyId);
  const navigation = useHostNavigation();
  const snapshot = state.snapshot;

  return (
    <div
      data-testid="pixel-office-sidebar"
      style={{ display: "grid", gap: 6, fontSize: "0.9em" }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <strong>Pixel Office</strong>
        <span data-testid="pixel-office-sidebar-status">
          {state.loading && !snapshot
            ? "loading"
            : connected
              ? "live"
              : stale
                ? "stale"
                : "offline"}
        </span>
      </div>

      {snapshot ? (
        <>
          <div>{snapshot.summary.agentCount} agents · {snapshot.summary.activeRunCount} active runs</div>
          <div>
            {snapshot.summary.openIssueCount} open · {snapshot.summary.blockedIssueCount}{" "}
            blocked · {snapshot.summary.waitingApprovalCount} approvals waiting
          </div>
          <div style={{ opacity: 0.7 }}>
            last sync {formatTimestamp(state.lastSyncedAt)}
          </div>
        </>
      ) : state.error ? (
        <div style={{ opacity: 0.7 }}>bridge unavailable</div>
      ) : null}

      <a
        data-testid="pixel-office-sidebar-link"
        {...navigation.linkProps(`/plugins/${PIXEL_OFFICE_PLUGIN_ID}`)}
      >
        Open Pixel Office
      </a>
    </div>
  );
}
