/**
 * Pixel Office sidebar (spec PAPERCLIP_PIXELS-1, §26.1 — high-level
 * project/agent status).
 *
 * Native "Office" menu (R3-WS4b): a group header plus two main-route rows —
 * `Design/View` (the Pixel Office page) and `Configuration` (the dedicated
 * Configuration page). Both rows render with the host's own `SidebarNavItem`
 * classes (same pill geometry, typography, hover/active highlight, 16px icon
 * slot) so the menu reads as native to the host rather than a plugin-painted
 * widget. No state-changing actions live here — intake, feedback replies, and
 * configuration edits are on the pages.
 */

import type { ReactNode } from "react";
import { useHostLocation, useHostNavigation } from "@paperclipai/plugin-sdk/ui";
import type { PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { PIXEL_OFFICE_PAGE_ROUTE } from "./bridge-contract";
import { PIXEL_OFFICE_CONFIG_PAGE_ROUTE } from "../constants.js";

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

/** Plugin-owned gear glyph (Configuration), licensing-safe. */
function ConfigurationIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor" aria-hidden="true">
      <path d="M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z" />
      <path
        fillRule="evenodd"
        d="M6.6 1.5h2.8l.4 1.5a1.2 1.2 0 0 0 .7.7l1.5.4 1.3-1 2 2-1 1.3.4 1.5c.1.2.2.5.4.7l1.5.4v2.8l-1.5.4a1.2 1.2 0 0 0-.7.7l-.4 1.5 1 1.3-2 2-1.3-1-1.5.4c-.2.1-.5.2-.7.4l-.4 1.5H6.6l-.4-1.5a1.2 1.2 0 0 0-.7-.7l-1.5-.4-1.3 1-2-2 1-1.3-.4-1.5a1.2 1.2 0 0 0-.4-.7l-1.5-.4V6.6l1.5-.4c.3-.1.5-.2.7-.4l.4-1.5-1-1.3 2-2 1.3 1 1.5-.4c.2-.1.5-.2.7-.4l.4-1.5Z"
      />
    </svg>
  );
}

/** A single host-styled nav row for the Office menu. */
function OfficeNavRow({
  to,
  isActive,
  icon,
  label,
  testId,
}: {
  to: string;
  isActive: boolean;
  icon: ReactNode;
  label: string;
  testId: string;
}) {
  const navigation = useHostNavigation();
  return (
    <a
      data-testid={testId}
      aria-current={isActive ? "page" : undefined}
      className={`${ROW_BASE} ${isActive ? ROW_ACTIVE : ROW_INACTIVE}`}
      {...navigation.linkProps(to)}
    >
      <span className="relative shrink-0">{icon}</span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </a>
  );
}

/**
 * Sidebar component for the Pixel Office UI: the native Office menu.
 * Renders the Design/View and Configuration main-route entries and marks the
 * active child the same way the host marks native rows.
 */
export function PixelOfficeSidebar({ context }: PluginSidebarProps) {
  const location = useHostLocation();
  const navigation = useHostNavigation();

  if (!context.companyId) {
    return null;
  }

  const pageTo = `/${PIXEL_OFFICE_PAGE_ROUTE}`;
  const configTo = `/${PIXEL_OFFICE_CONFIG_PAGE_ROUTE}`;
  const pageHref = navigation.resolveHref(pageTo);
  const configHref = navigation.resolveHref(configTo);
  // Same prefix-match semantics the host NavLink applies to native rows.
  const pageActive =
    location.pathname === pageHref || location.pathname.startsWith(`${pageHref}/`);
  const configActive =
    location.pathname === configHref || location.pathname.startsWith(`${configHref}/`);

  return (
    <div data-testid="pixel-office-sidebar">
      <div
        data-testid="pixel-office-menu-label"
        className="mx-2 mb-1 mt-3 px-2 text-(length:--text-compact) font-semibold uppercase tracking-wide text-foreground/60"
      >
        Office
      </div>
      <OfficeNavRow
        to={pageTo}
        isActive={pageActive}
        icon={<PixelOfficeIcon />}
        label="Design/View"
        testId="pixel-office-sidebar-link"
      />
      <OfficeNavRow
        to={configTo}
        isActive={configActive}
        icon={<ConfigurationIcon />}
        label="Configuration"
        testId="pixel-office-sidebar-config-link"
      />
    </div>
  );
}
