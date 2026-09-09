/**
 * Office-layout editor tests (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The editor consumes the worker's `office-layout` data handler, edits the
 * host-neutral floor/seat vocabulary (normalized 0..1 coordinates), persists a
 * validated layout through the `office.set-layout` action, and pauses writes
 * while the bridge is stale.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { OfficeLayoutEditor } from "./office-layout-editor";
import {
  usePluginActionImpl,
  usePluginDataImpl,
} from "../test-utils/sdk-ui";
import type { OfficeLayout } from "@decaf-ts/paperclip-pixels-common";

function makeLayout(overrides: Partial<OfficeLayout> = {}): OfficeLayout {
  return {
    schemaVersion: 1,
    name: "Main office",
    floors: [
      {
        id: "floor-1",
        name: "Ground",
        walls: [],
        furniture: [],
        seats: [
          { id: "seat-1", agentId: null, position: { x: 0.25, y: 0.3 }, label: "Desk 1" },
          { id: "seat-2", agentId: null, position: { x: 0.75, y: 0.3 }, label: "Desk 2" },
        ],
      },
    ],
    ...overrides,
  };
}

function serveConfig(layout: OfficeLayout | null, configured = true) {
  usePluginDataImpl.mockReturnValue({
    data: { schemaVersion: 1, companyId: "co", configured, layout },
    loading: false,
    error: null,
    refresh: jest.fn(),
  });
}

function actionResult(overrides: Record<string, unknown> = {}) {
  return jest.fn().mockResolvedValue({ ok: true, ...overrides });
}

describe("OfficeLayoutEditor", () => {
  it("shows a loading row while the config is loading", async () => {
    usePluginDataImpl.mockReturnValue({ data: null, loading: true, error: null, refresh: jest.fn() });
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("office-layout-loading")).toBeTruthy());
  });

  it("surfaces a data error as an alert", async () => {
    usePluginDataImpl.mockReturnValue({
      data: null,
      loading: false,
      error: { message: "boom", code: "E" },
      refresh: jest.fn(),
    });
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("office-layout-error")).toBeTruthy());
    expect(screen.getByTestId("office-layout-error")).toHaveTextContent("boom");
  });

  it("renders the served layout name, floors, and seats", async () => {
    serveConfig(makeLayout());
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("office-layout-name")).toHaveValue("Main office"));
    expect(screen.getByTestId("office-layout-floor-name")).toHaveValue("Ground");
    expect(screen.getAllByTestId("office-layout-seat")).toHaveLength(2);
    expect(screen.getAllByTestId("office-layout-seat-x")[0]).toHaveValue(0.25);
  });

  it("shows an empty state when no layout is configured", async () => {
    serveConfig(null, false);
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("office-layout-empty")).toBeTruthy());
    expect(screen.queryByTestId("office-layout-name")).toBeNull();
  });

  it("saves an edited layout through the set-office-layout action", async () => {
    const action = actionResult();
    serveConfig(makeLayout());
    usePluginActionImpl.mockReturnValue(action);
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("office-layout-name")).toHaveValue("Main office"));

    fireEvent.change(screen.getByTestId("office-layout-name"), { target: { value: "Renamed" } });
    fireEvent.click(screen.getByTestId("office-layout-save"));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const arg = action.mock.calls[0][0] as { companyId: string; layout: OfficeLayout };
    expect(arg.companyId).toBe("co");
    expect(arg.layout.name).toBe("Renamed");
    await waitFor(() =>
      expect(screen.getByTestId("office-layout-message")).toHaveTextContent("Office layout saved."),
    );
  });

  it("clamps seat coordinates to the 0..1 unit range", async () => {
    const action = actionResult();
    serveConfig(makeLayout());
    usePluginActionImpl.mockReturnValue(action);
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() =>
      expect(screen.getAllByTestId("office-layout-seat-x")[0]).toHaveValue(0.25),
    );

    fireEvent.change(screen.getAllByTestId("office-layout-seat-x")[0], {
      target: { value: "2" },
    });
    fireEvent.click(screen.getByTestId("office-layout-save"));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const arg = action.mock.calls[0][0] as { layout: OfficeLayout };
    expect(arg.layout.floors[0].seats[0].position.x).toBe(1);
  });

  it("creates and persists a default layout", async () => {
    const action = actionResult();
    serveConfig(null, false);
    usePluginActionImpl.mockReturnValue(action);
    render(<OfficeLayoutEditor companyId="co" />);
    await waitFor(() =>
      expect(screen.getByTestId("office-layout-create-default")).toBeTruthy(),
    );

    fireEvent.click(screen.getByTestId("office-layout-create-default"));

    await waitFor(() => expect(action).toHaveBeenCalled());
    const arg = action.mock.calls[0][0] as { layout: OfficeLayout };
    expect(arg.layout.name).toBe("Default office");
    await waitFor(() =>
      expect(screen.getByTestId("office-layout-message")).toHaveTextContent(
        "Default office layout created.",
      ),
    );
  });

  it("surfaces a contract error when the action resolves ok:false", async () => {
    usePluginActionImpl.mockReturnValue(
      jest.fn().mockResolvedValue({ ok: false, error: "INVALID_LAYOUT" }),
    );
    serveConfig(makeLayout());
    render(<OfficeLayoutEditor companyId="co" />);
    // Wait until the served layout seeds the draft (the save button is
    // enabled) before clicking, so the click actually triggers a save.
    await waitFor(() =>
      expect(screen.getByTestId("office-layout-save")).not.toBeDisabled(),
    );

    fireEvent.click(screen.getByTestId("office-layout-save"));

    await waitFor(() =>
      expect(screen.getByTestId("office-layout-save-error")).toHaveTextContent("INVALID_LAYOUT"),
    );
  });

  it("pauses the editor behind the stale-bridge gate", async () => {
    const action = actionResult();
    serveConfig(makeLayout());
    usePluginActionImpl.mockReturnValue(action);
    render(<OfficeLayoutEditor companyId="co" disabled />);
    await waitFor(() => expect(screen.getByTestId("office-layout-paused")).toBeTruthy());
    expect(screen.getByTestId("office-layout-save")).toBeDisabled();

    fireEvent.click(screen.getByTestId("office-layout-save"));
    expect(action).not.toHaveBeenCalled();
  });
});
