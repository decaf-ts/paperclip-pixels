/**
 * Agent-scoped Character detail tab tests (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The host renders this `detailTab` on each native Paperclip agent detail page.
 * It shows the agent's character customization beside its operational metrics
 * and behavioral proxies from the bridge snapshot.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { render, screen, waitFor } from "@testing-library/react";
import { AgentCharacterDetailTab } from "./AgentCharacterDetailTab";
import {
  makeDataResult,
  usePluginActionImpl,
  usePluginDataImpl,
} from "./test-utils/sdk-ui";
import { makeAgentView, makeProjection, makeSnapshot } from "./test-utils/fixtures";
import type { PixelCharacterChoice, VisualSettingsData } from "./bridge-contract";

function makeCharacter(): PixelCharacterChoice {
  return {
    id: "char-a",
    name: "Sheet Alpha",
    palette: 2,
    previewDataUrl: "data:image/png;base64,AAAA",
    source: "builtin",
    license: "CC0",
  };
}

function makeVisual(): VisualSettingsData {
  return {
    schemaVersion: 1,
    configured: true,
    characters: [makeCharacter()],
    assignments: {},
  };
}

function serveAgent(overrides: { agentId?: string } = {}) {
  const agentId = overrides.agentId ?? "agent-a";
  usePluginDataImpl.mockImplementation((...args: unknown[]) => {
    const key = args[0] as string;
    if (key === "bridge-snapshot") {
      return makeDataResult({
        data: makeSnapshot({
          agents: [
            makeAgentView({
              projection: makeProjection({ companyId: "co", agentId, name: "Alice" }),
            }),
          ],
        }),
      });
    }
    if (key === "visual-settings") return makeDataResult({ data: makeVisual() });
    return makeDataResult({ data: null });
  });
  usePluginActionImpl.mockReturnValue(jest.fn().mockResolvedValue({ ok: true, applied: true }));
}

const agentContext = { companyId: "co", entityId: "agent-a", entityType: "agent" } as never;

describe("AgentCharacterDetailTab", () => {
  it("requires a company and agent context", async () => {
    render(<AgentCharacterDetailTab context={{ companyId: null, entityId: null } as never} />);
    await waitFor(() => expect(screen.getByTestId("agent-detail-tab-empty")).toBeTruthy());
  });

  it("shows a loading row while the snapshot is loading", async () => {
    usePluginDataImpl.mockImplementation((...args: unknown[]) =>
      (args[0] as string) === "bridge-snapshot"
        ? makeDataResult({ data: null, loading: true })
        : makeDataResult({ data: null }),
    );
    render(<AgentCharacterDetailTab context={agentContext} />);
    await waitFor(() => expect(screen.getByTestId("agent-detail-tab-loading")).toBeTruthy());
  });

  it("renders the character tab with the agent id and its metrics panel", async () => {
    serveAgent();
    render(<AgentCharacterDetailTab context={agentContext} />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-detail-character-tab")).toHaveAttribute(
        "data-agent-id",
        "agent-a",
      ),
    );
    expect(screen.getByTestId("character-picker")).toBeTruthy();
    expect(screen.getByTestId("agent-detail-tab-metrics")).toBeTruthy();
    expect(screen.getByTestId("agent-detail-tab-metrics")).toHaveAttribute(
      "data-agent-id",
      "agent-a",
    );
  });

  it("renders one metrics window row per TIME_WINDOWS", async () => {
    serveAgent();
    render(<AgentCharacterDetailTab context={agentContext} />);
    await waitFor(() =>
      expect(screen.getAllByTestId("detail-tab-metrics-window").length).toBeGreaterThan(0),
    );
    const rows = screen.getAllByTestId("detail-tab-metrics-window");
    expect(rows.length).toBe(5);
    expect(rows[0]).toHaveAttribute("data-window", "5m");
  });

  it("renders the operational signals for the agent", async () => {
    serveAgent();
    render(<AgentCharacterDetailTab context={agentContext} />);
    await waitFor(() => expect(screen.getByTestId("agent-detail-tab-metrics")).toBeTruthy());
    expect(screen.getByText("Operational signals")).toBeTruthy();
    for (const label of ["load", "failure pressure", "waiting", "collaboration", "momentum"]) {
      expect(screen.getByText(label)).toBeTruthy();
    }
  });

  it("shows an empty metrics panel when the agent is not in the snapshot", async () => {
    serveAgent({ agentId: "agent-zzz" });
    render(<AgentCharacterDetailTab context={agentContext} />);
    await waitFor(() =>
      expect(screen.getByTestId("agent-detail-tab-metrics-empty")).toBeTruthy(),
    );
  });
});
