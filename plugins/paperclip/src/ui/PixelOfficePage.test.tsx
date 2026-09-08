/**
 * Pixel Office page tests for the R3-WS4b chrome: the red/green connection
 * indicator wiring and the fullscreen office-view control.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PixelOfficePage } from "./PixelOfficePage";
import {
  makeDataResult,
  makeStreamResult,
  usePluginDataImpl,
  usePluginStreamImpl,
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

function makeVisual(overrides: Partial<VisualSettingsData> = {}): VisualSettingsData {
  return {
    schemaVersion: 1,
    configured: true,
    pixelAgentsUiUrl: "http://localhost:8090",
    characters: [makeCharacter()],
    assignments: {},
    ...overrides,
  };
}

function servePage({ connected = false }: { connected?: boolean } = {}) {
  usePluginDataImpl.mockImplementation((...args: unknown[]) => {
    const key = String(args[0]);
    if (key === "bridge-snapshot") {
      return makeDataResult({
        data: makeSnapshot({
          agents: [makeAgentView({ projection: makeProjection({ agentId: "agent-a", name: "Alice" }) })],
          observedAt: new Date().toISOString(),
        }),
        loading: false,
        error: null,
      });
    }
    if (key === "visual-settings") {
      return makeDataResult({ data: makeVisual(), loading: false, error: null });
    }
    return makeDataResult({ data: null });
  });
  usePluginStreamImpl.mockReturnValue(makeStreamResult({ connected }));
}

async function ready() {
  await waitFor(() => expect(screen.getByTestId("pixel-office-page")).toBeTruthy());
}

describe("PixelOfficePage — connection indicator", () => {
  it("shows a green Connected indicator when the stream is connected", async () => {
    servePage({ connected: true });
    render(<PixelOfficePage context={{ companyId: "co" } as never} />);
    await ready();
    expect(screen.getByTestId("pixel-connection-indicator")).toHaveAttribute(
      "data-status",
      "connected",
    );
    expect(screen.getByTestId("pixel-connection-label")).toHaveTextContent("Connected");
  });

  it("shows a red Disconnected indicator when the stream is down", async () => {
    servePage({ connected: false });
    render(<PixelOfficePage context={{ companyId: "co" } as never} />);
    await ready();
    expect(screen.getByTestId("pixel-connection-indicator")).toHaveAttribute(
      "data-status",
      "disconnected",
    );
    expect(screen.getByTestId("pixel-connection-label")).toHaveTextContent("Disconnected");
  });
});

describe("PixelOfficePage — fullscreen office viewing", () => {
  it("renders the office iframe in normal mode and toggles to a fullscreen overlay", async () => {
    servePage();
    render(<PixelOfficePage context={{ companyId: "co" } as never} />);
    await ready();

    const normalFrame = screen.getByTestId("pixel-office-frame").querySelector("iframe");
    expect(normalFrame).toBeTruthy();
    expect(screen.queryByTestId("pixel-office-fullscreen-overlay")).toBeNull();

    fireEvent.click(screen.getByTestId("pixel-office-fullscreen"));
    await waitFor(() =>
      expect(screen.getByTestId("pixel-office-fullscreen-overlay")).toBeTruthy(),
    );
    expect(screen.getByTestId("pixel-office-exit-fullscreen")).toBeTruthy();

    fireEvent.click(screen.getByTestId("pixel-office-exit-fullscreen"));
    await waitFor(() =>
      expect(screen.queryByTestId("pixel-office-fullscreen-overlay")).toBeNull(),
    );
    expect(screen.getByTestId("pixel-office-fullscreen")).toBeTruthy();
  });
});
