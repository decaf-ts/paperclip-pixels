/**
 * Agent card tests (spec PAPERCLIP_PIXELS-1, §26.2, FR-1, FR-2, FR-15).
 * Factual summary with canonical ids, run-level concurrency never collapsed,
 * and only three stem-qualified operational signals.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { AgentCard } from "./agent-card";
import type { BridgeAgentView } from "../bridge-contract";
import { shortId } from "../format";
import { makeAgentView, makeProjection } from "../test-utils/fixtures";

function makeCardView({
  runs,
  count,
  approvals,
}: {
  runs: BridgeAgentView["projection"]["activeRuns"];
  count: number;
  approvals: NonNullable<BridgeAgentView["projection"]["approvalsWaiting"]>;
}): BridgeAgentView {
  return makeAgentView({
    projection: makeProjection({
      companyId: "co",
      agentId: "agent-aaaa",
      name: "Alice",
      status: "running",
      role: "engineer",
      activeRuns: runs,
      activeRunCount: count,
      projectIds: ["prj-p1", "prj-p2"],
      blockedIssues: [{ issueId: "iss-2", status: "blocked" }],
      approvalsWaiting: approvals,
    }),
  });
}

const twoRuns: BridgeAgentView["projection"]["activeRuns"] = [
  {
    runId: "run-1",
    agentId: "agent-aaaa",
    issueId: "iss-1",
    status: "running",
    startedAt: "2026-08-22T09:00:00.000Z",
  },
  {
    runId: "run-2",
    agentId: "agent-aaaa",
    status: "waiting",
    startedAt: "2026-08-22T09:10:00.000Z",
  },
];

const cardReady = () => waitFor(() => screen.getByTestId("agent-card"));

describe("AgentCard — factual summary", () => {
  it("renders the canonical agent id as the data-agent-id, with short display id", async () => {
    render(
      <AgentCard
        view={makeCardView({ runs: twoRuns, count: 2, approvals: [] })}
        onOpen={jest.fn()}
      />,
    );
    const card = await cardReady();
    expect(card).toHaveAttribute("data-agent-id", "agent-aaaa");
    expect(card).toHaveTextContent(`agent ${shortId("agent-aaaa")}`);
  });

  it("lists each active run individually (concurrency preserved)", async () => {
    render(
      <AgentCard
        view={makeCardView({ runs: twoRuns, count: 2, approvals: [] })}
        onOpen={jest.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getAllByTestId("active-run").length).toBe(2),
    );
    const items = screen.getAllByTestId("active-run");
    const rendered = items.map((i) => i.textContent ?? "").join(" | ");
    expect(rendered).toContain(shortId("run-1"));
    expect(rendered).toContain(shortId("run-2"));
    expect(rendered).toContain(`issue ${shortId("iss-1")}`);
  });

  it("renders factual counts (never collapsed)", async () => {
    render(
      <AgentCard
        view={makeCardView({ runs: twoRuns, count: 2, approvals: [] })}
        onOpen={jest.fn()}
      />,
    );
    const card = await cardReady();
    expect(card).toHaveTextContent("2 active runs");
    expect(card).toHaveTextContent("2 projects");
    expect(card).toHaveTextContent("1 blocked issue");
  });

  it("shows a waiting-approvals summary when present", async () => {
    render(
      <AgentCard
        view={makeCardView({
          runs: twoRuns,
          count: 2,
          approvals: [{ approvalId: "apr-1", status: "pending" }],
        })}
        onOpen={jest.fn()}
      />,
    );
    const card = await cardReady();
    expect(card).toHaveTextContent("Waiting on 1 approval");
  });

  it("Details button opens the detail view with the canonical agent id", async () => {
    const onOpen = jest.fn();
    render(
      <AgentCard
        view={makeCardView({ runs: twoRuns, count: 2, approvals: [] })}
        onOpen={onOpen}
      />,
    );
    await cardReady();
    fireEvent.click(screen.getByTestId("agent-open-detail"));
    await waitFor(() => expect(onOpen).toHaveBeenCalledWith("agent-aaaa"));
  });
});

describe("AgentCard — stem-qualified signals (FR-15/FR-13)", () => {
  it("renders only sustained load, friction, and collaboration", async () => {
    render(
      <AgentCard
        view={makeCardView({ runs: twoRuns, count: 2, approvals: [] })}
        onOpen={jest.fn()}
      />,
    );
    const card = await cardReady();
    expect(card).toHaveTextContent("Operational signals (derived proxies)");
    for (const label of ["sustained load", "friction", "collaboration"]) {
      expect(card).toHaveTextContent(label);
    }
    expect(card).not.toHaveTextContent("stress proxy");
    expect(card).not.toHaveTextContent("engagement proxy");
  });
});
