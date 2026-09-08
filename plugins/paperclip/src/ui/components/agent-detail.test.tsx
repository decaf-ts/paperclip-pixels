/**
 * Agent detail tests (spec PAPERCLIP_PIXELS-1, §26.2, §9.2, §9.3, FR-3,
 * FR-4, FR-15). Full raw projection on one agent: canonical IDs, run-level
 * concurrency, windowed metrics, and stem-qualified behavioral signals.
 *
 * NOTE: the pinned react commits asynchronously; renders are awaited.
 */

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { TIME_WINDOWS } from "../../core/index.js";
import { AgentDetail } from "./agent-detail";
import type { BridgeAgentView } from "../bridge-contract";
import {
  ENGAGEMENT_PROXY_NOTE,
  shortId,
  STRESS_PROXY_NOTE,
} from "../format";
import {
  makeAgentView,
  makeMetrics,
  makeProjection,
} from "../test-utils/fixtures";

function makeProxiedView(): BridgeAgentView {
  const base = makeAgentView();
  return {
    ...base,
    projection: makeProjection({
      companyId: "co",
      agentId: "agent-aaaa",
      name: "Alice",
      status: "running",
      role: "engineer",
      activeRuns: [
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
          startedAt: "2026-08-22T09:05:00.000Z",
        },
        {
          runId: "run-3",
          agentId: "agent-aaaa",
          issueId: "iss-3",
          status: "running",
          startedAt: "2026-08-22T09:10:00.000Z",
        },
      ],
      activeRunCount: 3,
      assignedIssues: [{ issueId: "iss-1", status: "in_progress", title: "Scope" }],
      blockedIssues: [{ issueId: "iss-2", status: "blocked" }],
      projectIds: ["prj-p1", "prj-p2"],
      approvalsWaiting: [
        { approvalId: "apr-1", status: "pending", issueId: "iss-1" },
      ],
      observedAt: "2026-08-22T10:00:00.000Z",
    }),
    behavior: {
      ...base.behavior,
      stressProxy: { value: 0.6, confidence: 0.7, basis: ["observed:values"] },
      engagementProxy: {
        value: 0.4,
        confidence: 0.7,
        basis: ["observed:values"],
      },
    },
  };
}

const detailReady = () => waitFor(() => screen.getByTestId("agent-detail"));

describe("AgentDetail — raw projection & concurrency", () => {
  it("renders canonical agent id, name, role, and status", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    const section = await detailReady();
    expect(section).toHaveAttribute("data-agent-id", "agent-aaaa");
    expect(section).toHaveTextContent("Alice");
    expect(section).toHaveTextContent("Role: engineer");
    expect(section).toHaveTextContent("status running");
  });

  it("renders each active run as its own row (concurrency preserved)", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getByText("Active runs (3)")).toBeInTheDocument(),
    );
    const rows = screen.getAllByTestId("detail-run");
    expect(rows).toHaveLength(3);
    const rendered = rows.map((r) => r.textContent ?? "").join(" | ");
    for (const runId of ["run-1", "run-2", "run-3"]) {
      expect(rendered).toContain(runId);
    }
    expect(document.querySelectorAll('tr[data-run-id="run-1"]')).toHaveLength(1);
  });

  it("renders assigned and blocked issues with canonical ids", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    const section = await detailReady();
    expect(section).toHaveTextContent("Scope · iss-1 (in_progress)");
    expect(section).toHaveTextContent("iss-2 (blocked)");
  });

  it("renders projects by short id and the waiting approval", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    const section = await detailReady();
    expect(section).toHaveTextContent(shortId("prj-p1"));
    expect(section).toHaveTextContent(shortId("prj-p2"));
    expect(section).toHaveTextContent("apr-1 (pending) · issue iss-1");
  });

  it("renders a windowed metrics row for every time window", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    await waitFor(() =>
      expect(screen.getAllByTestId("metrics-window").length).toBe(
        TIME_WINDOWS.length,
      ),
    );
    for (const window of TIME_WINDOWS) {
      expect(document.querySelector(`tr[data-window="${window}"]`)).not.toBeNull();
    }
  });

  it("Back button calls onBack", async () => {
    const onBack = jest.fn();
    render(<AgentDetail view={makeProxiedView()} onBack={onBack} />);
    await detailReady();
    fireEvent.click(screen.getByTestId("agent-detail-back"));
    await waitFor(() => expect(onBack).toHaveBeenCalledTimes(1));
  });
});

describe("AgentDetail — operational proxies (FR-15)", () => {
  it("labels the panel and every signal as an operational estimate", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    const section = await detailReady();
    expect(
      section,
    ).toHaveTextContent("Operational signals (derived proxies — not emotion)");
    for (const label of [
      "load",
      "sustained load",
      "burstiness",
      "friction",
      "failure pressure",
      "interruption pressure",
      "idle availability",
    ]) {
      expect(section).toHaveTextContent(label);
    }
    expect(section).toHaveTextContent("stress proxy (operational estimate)");
    expect(section).toHaveTextContent(STRESS_PROXY_NOTE);
    expect(section).toHaveTextContent("engagement proxy (operational estimate)");
    expect(section).toHaveTextContent(ENGAGEMENT_PROXY_NOTE);
  });

  it("never emits emotion labels for the derived proxies", async () => {
    render(<AgentDetail view={makeProxiedView()} onBack={jest.fn()} />);
    const section = await detailReady();
    const text = section.textContent ?? "";
    for (const emotion of ["unhappy", "stressed", "satisfied"]) {
      expect(text).not.toMatch(emotion);
    }
  });

  it("omits optional proxies when absent (empty-state honesty)", async () => {
    const base = makeAgentView();
    const plainView: BridgeAgentView = {
      ...base,
      projection: makeProjection(),
      metrics: makeMetrics(),
    };
    render(<AgentDetail view={plainView} onBack={jest.fn()} />);
    const section = await detailReady();
    expect(section).toHaveTextContent("none");
    expect(section).not.toHaveTextContent("stress proxy");
  });
});
