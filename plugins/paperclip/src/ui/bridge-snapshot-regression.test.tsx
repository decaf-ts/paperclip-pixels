/**
 * Regression test for SAA-306: the worker's `bridge-snapshot` data handler
 * previously served a core `RawSnapshot`, which threw `PixelOfficePage` (on
 * `snapshot.feedback.filter`) and `PixelOfficeSidebar` (on
 * `snapshot.summary.agentCount`). The worker now composes a full
 * `BridgeCompanySnapshot` contract payload.
 *
 * These tests lock the contract on the consumer side:
 *  1. A proper `BridgeCompanySnapshot` renders the acceptance testids
 *     (`pixel-office-page`, `pixel-office-sidebar-link`).
 *  2. A raw `RawSnapshot` (w/o summary/feedback/view-shaped agents) still
 *     fails closed via the render boundary rather than silently misrendering.
 */

import { Component, type ReactNode } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { PixelOfficePage } from "./PixelOfficePage";
import { PixelOfficeSidebar } from "./PixelOfficeSidebar";
import {
  makeDataResult,
  makeLocation,
  makeStreamResult,
  useHostLocationImpl,
  usePluginDataImpl,
  usePluginStreamImpl,
} from "./test-utils/sdk-ui";
import { makeAgentView, makeProjection, makeSnapshot } from "./test-utils/fixtures";

class Boundary extends Component<{ children: ReactNode }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return <div data-testid="boundary-error">{String(this.state.error.message)}</div>;
    }
    return this.props.children;
  }
}

const rawSnapshotPayload = () => ({
  schemaVersion: 1,
  company: { id: "co", name: "Pixel Company" },
  agents: [
    {
      companyId: "co",
      agentId: "agent-a",
      name: "Alice",
      status: "running",
      role: "engineer",
      activeRuns: [],
      activeRunCount: 0,
      assignedIssues: [],
      blockedIssues: [],
      projectIds: [],
      approvalsWaiting: [],
      recentEvents: [],
      observedAt: "2026-08-22T10:00:00.000Z",
    },
  ],
  issues: [],
  projects: [],
  approvals: [],
  observedAt: "2026-08-22T10:00:00.000Z",
});

const contractSnapshot = () =>
  makeSnapshot({
    agents: [makeAgentView({ projection: makeProjection({ agentId: "agent-a", companyId: "co" }) })],
  });

async function serveSnapshot(payload: unknown): Promise<void> {
  usePluginDataImpl.mockReturnValue(makeDataResult({ data: payload, loading: false, error: null }));
  usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected: false }));
}

describe("Pixel Office against the BridgeCompanySnapshot contract (SAA-306)", () => {
  it("renders the page testid when served the worker's contract snapshot", async () => {
    await serveSnapshot(contractSnapshot());
    render(<PixelOfficePage context={{ companyId: "co" } as never} />);
    await waitFor(() => expect(screen.getByTestId("pixel-office-page")).toBeTruthy());
    expect(screen.getByTestId("company-overview")).toBeTruthy();
  });

  it("renders the sidebar link when served the worker's contract snapshot", async () => {
    await serveSnapshot(contractSnapshot());
    render(<PixelOfficeSidebar context={{ companyId: "co" } as never} />);
    await waitFor(() => expect(screen.getByTestId("pixel-office-sidebar-link")).toBeTruthy());
    // Wrapper div + menu rows stay mounted inside the sidebar.
    expect(screen.getByTestId("pixel-office-sidebar").contains(screen.getByTestId("pixel-office-sidebar-link"))).toBe(true);
    // No sidecar status row (pre-SAA-306 shape).
    expect(screen.queryByTestId("pixel-office-sidebar-status")).toBeNull();
    // R3-WS4b Office menu: the Design/View and Configuration children.
    const menuLabel = screen.getByTestId("pixel-office-menu-label");
    expect(menuLabel.textContent).toBe("Office");
    const link = screen.getByTestId("pixel-office-sidebar-link");
    expect(link.textContent).toBe("Design/View");
    expect(link.querySelector("strong")).toBeNull();
    const configLink = screen.getByTestId("pixel-office-sidebar-config-link");
    expect(configLink.textContent).toBe("Configuration");
    expect(configLink.getAttribute("href")).toBe("/pixel-office-configuration");
    // Host SidebarNavItem row classes are replicated verbatim (pixel-identical row).
    const className = link.getAttribute("class") ?? "";
    expect(className).toContain("flex items-center");
    expect(className).toContain("gap-2.5");
    expect(className).toContain("mx-2");
    expect(className).toContain("rounded-lg");
    expect(className).toContain("px-2");
    expect(className).toContain("py-1.5");
    expect(className).toContain("font-medium");
    expect(className).toContain("transition-colors");
  });

  it("marks the sidebar link active when the host pathname matches the resolved href", async () => {
    await serveSnapshot(contractSnapshot());
    useHostLocationImpl.mockReturnValue(makeLocation({ pathname: "/pixel-office" }));
    render(<PixelOfficeSidebar context={{ companyId: "co" } as never} />);
    await waitFor(() => expect(screen.getByTestId("pixel-office-sidebar-link")).toBeTruthy());
    const link = screen.getByTestId("pixel-office-sidebar-link");
    expect(link.getAttribute("aria-current")).toBe("page");
    expect(link.getAttribute("class")).toContain("bg-accent text-foreground");
    expect(link.getAttribute("class")).not.toContain("text-foreground/80");
  });

  it("does not mark the sidebar link active for an unrelated pathname", async () => {
    await serveSnapshot(contractSnapshot());
    useHostLocationImpl.mockReturnValue(makeLocation({ pathname: "/dashboard" }));
    render(<PixelOfficeSidebar context={{ companyId: "co" } as never} />);
    await waitFor(() => expect(screen.getByTestId("pixel-office-sidebar-link")).toBeTruthy());
    const link = screen.getByTestId("pixel-office-sidebar-link");
    expect(link.getAttribute("aria-current")).toBeNull();
    expect(link.getAttribute("class")).toContain("text-foreground/80");
    expect(link.getAttribute("class")).not.toContain("bg-accent text-foreground");
  });

  it("fails closed (error boundary) when served a raw RawSnapshot instead of the contract", async () => {
    // The boundary is expected to log the intentional render error; silence
    // the stack trace so it doesn't pollute the UI test output.
    const errorSpy = jest.spyOn(console, "error").mockImplementation(() => {});
    try {
      await serveSnapshot(rawSnapshotPayload());
      render(
        <Boundary>
          <PixelOfficePage context={{ companyId: "co" } as never} />
        </Boundary>,
      );
      await waitFor(() => expect(screen.queryByTestId("boundary-error")).toBeTruthy());
      expect(screen.queryByTestId("pixel-office-page")).toBeNull();
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
