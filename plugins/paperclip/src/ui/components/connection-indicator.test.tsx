/**
 * Connection indicator tests (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The acceptance criterion requires the indicator to be red on
 * stale/disconnected and green when the bridge/feed is connected. The status
 * is computed from `connected` + `stale` and rendered as a coloured dot plus
 * a host-styled label.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { render, screen, waitFor } from "@testing-library/react";
import {
  ConnectionIndicator,
  connectionStatusLabel,
  resolveConnectionStatus,
} from "./connection-indicator";

describe("resolveConnectionStatus", () => {
  it("is connected only when the stream is connected", () => {
    expect(resolveConnectionStatus(true, false)).toBe("connected");
    expect(resolveConnectionStatus(true, true)).toBe("connected");
    expect(resolveConnectionStatus(false, false)).toBe("disconnected");
    expect(resolveConnectionStatus(false, true)).toBe("disconnected");
  });
});

describe("connectionStatusLabel", () => {
  it("names the connected state", () => {
    expect(connectionStatusLabel(true, false)).toBe("Connected");
  });
  it("names the stale/disconnected state", () => {
    expect(connectionStatusLabel(false, true)).toBe("Disconnected — state may be stale");
  });
  it("names a plain disconnect", () => {
    expect(connectionStatusLabel(false, false)).toBe("Disconnected");
  });
});

describe("ConnectionIndicator", () => {
  it("renders a green dot with a Connected label when connected", async () => {
    render(<ConnectionIndicator connected stale={false} lastSyncedAt={null} />);
    await waitFor(() => expect(screen.getByTestId("pixel-connection-indicator")).toBeTruthy());
    const indicator = screen.getByTestId("pixel-connection-indicator");
    expect(indicator).toHaveAttribute("data-status", "connected");
    expect(screen.getByTestId("pixel-connection-label")).toHaveTextContent("Connected");
    const dot = screen.getByTestId("pixel-connection-dot");
    expect(dot).toHaveStyle({ backgroundColor: "rgb(31, 157, 85)" });
    expect(dot).toHaveAttribute("aria-hidden", "true");
  });

  it("renders a red dot with a Disconnected label when stale/disconnected", async () => {
    render(<ConnectionIndicator connected={false} stale lastSyncedAt={null} />);
    await waitFor(() => expect(screen.getByTestId("pixel-connection-indicator")).toBeTruthy());
    const indicator = screen.getByTestId("pixel-connection-indicator");
    expect(indicator).toHaveAttribute("data-status", "disconnected");
    expect(screen.getByTestId("pixel-connection-label")).toHaveTextContent(
      "Disconnected — state may be stale",
    );
    const dot = screen.getByTestId("pixel-connection-dot");
    expect(dot).toHaveStyle({ backgroundColor: "rgb(192, 57, 43)" });
  });

  it("renders a red dot with a plain Disconnected label when not connected and not stale", async () => {
    render(<ConnectionIndicator connected={false} stale={false} lastSyncedAt={null} />);
    await waitFor(() => expect(screen.getByTestId("pixel-connection-indicator")).toBeTruthy());
    expect(screen.getByTestId("pixel-connection-label")).toHaveTextContent("Disconnected");
  });

  it("appends the last sync time to a disconnected label when available", async () => {
    render(
      <ConnectionIndicator
        connected={false}
        stale
        lastSyncedAt="2026-09-08T10:00:00.000Z"
      />,
    );
    await waitFor(() => expect(screen.getByTestId("pixel-connection-indicator")).toBeTruthy());
    const label = screen.getByTestId("pixel-connection-label");
    expect(label).toHaveTextContent("last sync");
    expect(label).toHaveTextContent("2026-09-08");
  });

  it("omits the last-sync suffix when there is no sync time", async () => {
    render(<ConnectionIndicator connected={false} stale lastSyncedAt={null} />);
    await waitFor(() => expect(screen.getByTestId("pixel-connection-indicator")).toBeTruthy());
    expect(screen.getByTestId("pixel-connection-label")).not.toHaveTextContent("last sync");
  });
});
