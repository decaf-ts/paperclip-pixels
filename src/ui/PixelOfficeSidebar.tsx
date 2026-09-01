/**
 * Pixel Office sidebar (spec PAPERCLIP_PIXELS-1, §26.1 — high-level
 * project/agent status).
 *
 * Single-line entry rendered inside the host's "Work" section, visually
 * identical to the host's own `SidebarNavItem` rows (spec PAPERCLIP_PIXELS-2,
 * WS0 task 1): same pill geometry, typography, hover/active highlight, and
 * 16px icon slot. No state-changing actions live here — intake and feedback
 * replies are on the page.
 */

import { useHostLocation, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { PIXEL_OFFICE_PAGE_ROUTE } from "./bridge-contract";

// Mirrors of the host `SidebarNavItem` NavLink classes (paperclip/ui
// SidebarNavItem.tsx). The plugin SDK does not export the component itself,
// so the class strings are replicated verbatim to keep the row pixel-identical.
const ROW_BASE =
  "flex items-center gap-2.5 mx-2 rounded-lg px-2 py-1.5 pointer-coarse:py-1 text-(length:--text-compact) font-medium transition-colors";
const ROW_ACTIVE = "bg-accent text-foreground";
const ROW_INACTIVE = "text-foreground/80 hover:bg-accent/50 hover:text-foreground";

// Plugin-owned 16px pixel-grid glyph (licensing-safe, no third-party sprites).
function PixelOfficeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <rect x="2" y="2" width="4" height="4" />
      <rect x="10" y="2" width="4" height="4" />
      <rect x="2" y="10" width="4" height="4" />
      <rect x="10" y="10" width="4" height="4" opacity="0.45" />
    </svg>
  );
}

/**
 * Sidebar component for the Pixel Office UI.
 * Provides navigation link to the page slot and renders live status.
 */
export function PixelOfficeSidebar({ context }: PluginSidebarProps) {
  const navigation = useHostNavigation();
  const location = useHostLocation();

  if (!context.companyId) {
    return null;
  }

  const to = `/${PIXEL_OFFICE_PAGE_ROUTE}`;
  const href = navigation.resolveHref(to);
  // Same prefix-match semantics the host NavLink applies to native rows.
  const isActive = location.pathname === href || location.pathname.startsWith(`${href}/`);

  return (
    <div data-testid="pixel-office-sidebar">
      <a
        data-testid="pixel-office-sidebar-link"
        aria-current={isActive ? "page" : undefined}
        className={`${ROW_BASE} ${isActive ? ROW_ACTIVE : ROW_INACTIVE}`}
        {...navigation.linkProps(to)}
      >
        <span className="relative shrink-0">
          <PixelOfficeIcon />
        </span>
        <span className="min-w-0 flex-1 truncate">Pixel Office</span>
      </a>
    </div>
  );
}
