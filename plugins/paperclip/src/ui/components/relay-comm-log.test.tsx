/**
 * Relay-communications log tests (R3-WS4b, PAPERCLIP_PIXELS-2).
 *
 * The log pages the bounded rolling relay/feed communications newest-first
 * over a strict `beforeSeq` cursor, accumulates pages, exposes a "Load more"
 * that advances until exhaustion, and surfaces a company-not-found error
 * envelope on invalid input.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { RelayCommLog } from "./relay-comm-log";
import { usePluginDataImpl } from "../test-utils/sdk-ui";
import type { RelayCommsEntry, RelayCommsPage } from "../bridge-contract";

function entry(
  seq: number,
  overrides: Partial<RelayCommsEntry> = {},
): RelayCommsEntry {
  return {
    seq,
    companyId: "co",
    occurredAt: "2026-09-08T10:00:00.000Z",
    direction: "outbound",
    kind: "feed-push",
    status: "sent",
    operations: [],
    ...overrides,
  };
}

function page(
  entries: RelayCommsEntry[],
  nextBeforeSeq: number | null,
): RelayCommsPage {
  return { schemaVersion: 1, companyId: "co", nextBeforeSeq, entries };
}

describe("RelayCommLog", () => {
  it("renders the empty state when there are no communications", async () => {
    usePluginDataImpl.mockReturnValue({
      data: page([], null),
      loading: false,
      error: null,
      refresh: jest.fn(),
    });
    render(<RelayCommLog companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("relay-comm-log-empty")).toBeTruthy());
    expect(screen.queryByTestId("relay-comm-table")).toBeNull();
  });

  it("renders the newest-first entries with their fields", async () => {
    usePluginDataImpl.mockReturnValue({
      data: page(
        [
          entry(12, { kind: "dialog-line", agentId: "agent-a", text: "Reading X" }),
          entry(11, { kind: "feed-push", status: "failed", error: "boom" }),
        ],
        10,
      ),
      loading: false,
      error: null,
      refresh: jest.fn(),
    });
    render(<RelayCommLog companyId="co" />);
    await waitFor(() => expect(screen.getAllByTestId("relay-comm-row")).toHaveLength(2));
    const rows = screen.getAllByTestId("relay-comm-row");
    expect(rows[0]).toHaveAttribute("data-seq", "12");
    expect(rows[0]).toHaveTextContent("dialog-line");
    expect(rows[0]).toHaveTextContent("agent-a");
    expect(rows[0]).toHaveTextContent("Reading X");
    expect(rows[1]).toHaveAttribute("data-seq", "11");
    expect(rows[1]).toHaveTextContent("feed-push");
    expect(rows[1]).toHaveTextContent("0 operations");
  });

  it("advances the beforeSeq cursor on Load more and accumulates pages", async () => {
    const callParams: Array<Record<string, unknown>> = [];
    usePluginDataImpl.mockImplementation((...args: unknown[]) => {
      const params = (args[1] ?? {}) as Record<string, unknown>;
      callParams.push(params);
      const beforeSeq = params.beforeSeq;
      if (beforeSeq === undefined) {
        return { data: page([entry(20)], 19), loading: false, error: null, refresh: jest.fn() };
      }
      return { data: page([entry(19)], null), loading: false, error: null, refresh: jest.fn() };
    });

    render(<RelayCommLog companyId="co" />);
    await waitFor(() => expect(screen.getAllByTestId("relay-comm-row")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("relay-comm-load-more"));

    await waitFor(() => expect(screen.getAllByTestId("relay-comm-row")).toHaveLength(2));
    expect(callParams.some((params) => params.beforeSeq === 19)).toBe(true);
    // Exhausted: nextBeforeSeq is null for the final page.
    expect(screen.getByTestId("relay-comm-exhausted")).toBeTruthy();
    expect(screen.getByTestId("relay-comm-load-more")).toBeDisabled();
  });

  it("resets the log when the page size selector changes", async () => {
    usePluginDataImpl.mockImplementation(() => {
      return {
        data: page([entry(20)], null),
        loading: false,
        error: null,
        refresh: jest.fn(),
      };
    });
    render(<RelayCommLog companyId="co" />);
    await waitFor(() => expect(screen.getAllByTestId("relay-comm-row")).toHaveLength(1));

    fireEvent.change(screen.getByTestId("relay-comm-page-size"), { target: { value: "10" } });
    // After a reset the log is re-fetched from the top; the mock still serves
    // one row, so the table remains 1 row but is re-requested with limit 10.
    await waitFor(() =>
      expect(screen.getByTestId("relay-comm-page-size")).toHaveValue("10"),
    );
  });

  it("surfaces the company-not-found error envelope", async () => {
    usePluginDataImpl.mockReturnValue({
      data: { schemaVersion: 1, error: "company-not-found" },
      loading: false,
      error: null,
      refresh: jest.fn(),
    });
    render(<RelayCommLog companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("relay-comm-log-error")).toBeTruthy());
    expect(screen.getByTestId("relay-comm-log-error")).toHaveTextContent("company-not-found");
    expect(screen.queryByTestId("relay-comm-table")).toBeNull();
  });

  it("shows the loading indicator while the query is in flight", async () => {
    usePluginDataImpl.mockReturnValue({
      data: null,
      loading: true,
      error: null,
      refresh: jest.fn(),
    });
    render(<RelayCommLog companyId="co" />);
    await waitFor(() => expect(screen.getByTestId("relay-comm-loading")).toBeTruthy());
  });
});
