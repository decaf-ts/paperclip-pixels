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
import { PIXEL_OFFICE_PAGE_ROUTE } from "./bridge-contract";

/**
 * Sidebar component for the Pixel Office UI.
 * Provides navigation link to the page slot and renders live status.
 */
export function PixelOfficeSidebar({ context }: PluginSidebarProps) {
  if (!context.companyId) {
    return null;
  }
  return <PixelOfficeSidebarInner />;
}

function PixelOfficeSidebarInner() {
  const navigation = useHostNavigation();

  return (
    <div
      data-testid="pixel-office-sidebar"
      style={{ display: "grid", gap: 6, fontSize: "0.9em" }}
    >
      <strong>Pixel Office</strong>

      <a
        data-testid="pixel-office-sidebar-link"
        {...navigation.linkProps(`/${PIXEL_OFFICE_PAGE_ROUTE}`)}
      >
        Open office and characters
      </a>
    </div>
  );
}
