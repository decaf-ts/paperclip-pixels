import { describe, expect, it } from "vitest";
import type { PluginEventType } from "@paperclipai/plugin-sdk";
import type { BridgeInputEvent } from "../src/core/index.js";
import { mapPluginEvent } from "../src/subscriptions.js";
import { makePluginEvent } from "./fixtures.js";

function payloadOf<T>(bridge: BridgeInputEvent | null): T {
  return (bridge as unknown as { payload: T }).payload;
}

describe("mapPluginEvent", () => {
  it("maps base envelope fields onto the bridge event", () => {
    const bridge = mapPluginEvent(
      makePluginEvent("agent.status_changed", { agentId: "a1", status: "running" }, {
        eventId: "evt-base",
        occurredAt: "2026-08-22T00:00:00.000Z",
        actorId: "user-1",
        actorType: "user",
        entityId: "a1",
        entityType: "agent",
        companyId: "comp-1",
      }),
    );
    expect(bridge).toEqual({
      eventId: "evt-base",
      timestamp: "2026-08-22T00:00:00.000Z",
      companyId: "comp-1",
      actor: { id: "user-1", type: "user" },
      entity: { id: "a1", type: "agent" },
      kind: "agent.status_changed",
      payload: { agentId: "a1", status: "running", previousStatus: undefined },
    });
  });

  it("leaves actor/entity ids undefined when the envelope omits them", () => {
    const bridge = mapPluginEvent(
      makePluginEvent("agent.status_changed", { status: "idle" }, {
        actorId: undefined,
        actorType: undefined,
        entityId: undefined,
        entityType: undefined,
      }),
    ) as BridgeInputEvent;
    expect(bridge.actor).toEqual({ id: undefined, type: undefined });
    expect(bridge.entity).toEqual({ id: undefined, type: undefined });
  });

  const cases: Array<{ label: string; eventType: import("@paperclipai/plugin-sdk").PluginEvent["eventType"]; payload: Record<string, unknown>; expected: unknown }> = [
    {
      label: "agent.status_changed",
      eventType: "agent.status_changed",
      payload: { agentId: "a1", status: "running", previousStatus: "idle" },
      expected: {
        kind: "agent.status_changed",
        payload: { agentId: "a1", status: "running", previousStatus: "idle" },
      },
    },
    {
      label: "agent.run.started",
      eventType: "agent.run.started" as const,
      payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", invocationSource: "web" },
      expected: {
        kind: "agent.run.started",
        payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", invocationSource: "web", startedAt: "2026-08-22T00:00:00.000Z" },
      },
    },
    {
      label: "agent.run.finished",
      eventType: "agent.run.finished" as const,
      payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", status: "success", durationMs: 1234 },
      expected: {
        kind: "agent.run.finished",
        payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", status: "success", finishedAt: "2026-08-22T00:00:00.000Z", durationMs: 1234 },
      },
    },
    {
      label: "agent.run.failed",
      eventType: "agent.run.failed" as const,
      payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", error: "boom" },
      expected: {
        kind: "agent.run.failed",
        payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", error: "boom", finishedAt: "2026-08-22T00:00:00.000Z" },
      },
    },
    {
      label: "agent.run.cancelled",
      eventType: "agent.run.cancelled" as const,
      payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1" },
      expected: {
        kind: "agent.run.cancelled",
        payload: { runId: "r1", agentId: "a1", issueId: "i1", projectId: "p1", finishedAt: "2026-08-22T00:00:00.000Z" },
      },
    },
    {
      label: "issue.updated",
      eventType: "issue.updated" as const,
      payload: { issueId: "i1", projectId: "p1", status: "in_progress", title: "New title", assigneeAgentId: "a9", blocked: true },
      expected: {
        kind: "issue.updated",
        payload: { issueId: "i1", projectId: "p1", status: "in_progress", title: "New title", assigneeAgentId: "a9", blocked: true },
      },
    },
    {
      label: "issue.comment.created",
      eventType: "issue.comment.created" as const,
      payload: { commentId: "c1", issueId: "i1", userId: "u-7", body: "asking?", isQuestion: true },
      expected: {
        kind: "issue.comment.created",
        payload: { commentId: "c1", issueId: "i1", userId: "u-7", body: "asking?", isQuestion: true },
      },
    },
    {
      label: "approval.created",
      eventType: "approval.created" as const,
      payload: { approvalId: "app1", issueId: "i1", agentId: "a1", type: "request_board_approval" },
      expected: {
        kind: "approval.created",
        payload: { approvalId: "app1", issueId: "i1", agentId: "a1", type: "request_board_approval", status: "pending" },
      },
    },
    {
      label: "approval.decided",
      eventType: "approval.decided" as const,
      payload: { approvalId: "app1", issueId: "i1", decision: "approve" },
      expected: {
        kind: "approval.decided",
        payload: { approvalId: "app1", issueId: "i1", decision: "approve", decidedAt: "2026-08-22T00:00:00.000Z" },
      },
    },
    {
      label: "budget.incident.opened",
      eventType: "budget.incident.opened" as const,
      payload: { incidentId: "inc1", scopeType: "company", scopeId: "c1", metric: "cost" },
      expected: {
        kind: "budget.incident.opened",
        payload: { incidentId: "inc1", scopeType: "company", scopeId: "c1", metric: "cost", status: "open" },
      },
    },
    {
      label: "budget.incident.resolved",
      eventType: "budget.incident.resolved" as const,
      payload: { incidentId: "inc1", scopeType: "company", scopeId: "c1" },
      expected: {
        kind: "budget.incident.resolved",
        payload: { incidentId: "inc1", scopeType: "company", scopeId: "c1", status: "resolved" },
      },
    },
    {
      label: "cost_event.created",
      eventType: "cost_event.created",
      payload: { costEventId: "ce1", agentId: "a1", runId: "r1", issueId: "i1", projectId: "p1", costCents: 42, inputTokens: 100, outputTokens: 5 },
      expected: {
        kind: "cost_event.created",
        payload: { costEventId: "ce1", agentId: "a1", runId: "r1", issueId: "i1", projectId: "p1", costCents: 42, inputTokens: 100, outputTokens: 5 },
      },
    },
  ];

  for (const testCase of cases) {
    it(`maps ${testCase.label} fully`, () => {
      const bridge = mapPluginEvent(
        makePluginEvent(testCase.eventType as PluginEventType, testCase.payload),
      );
      expect(bridge).toMatchObject(testCase.expected as object);
      expect(bridge?.kind).toBe((testCase.expected as { kind: string }).kind);
    });
  }

  describe("fallbacks and defensiveness", () => {
    it("falls back to the entity id for agent.status_changed", () => {
      const bridge = mapPluginEvent(
        makePluginEvent("agent.status_changed", { status: "running" }, { entityId: "a7" }),
      );
      expect(payloadOf<{ agentId: string }>(bridge).agentId).toBe("a7");
    });

    it("falls back to the entity id for issue.updated", () => {
      const bridge = mapPluginEvent(
        makePluginEvent("issue.updated", { status: "done" }, { entityId: "i9" }),
      );
      expect(payloadOf<{ issueId: string }>(bridge).issueId).toBe("i9");
      expect(payloadOf<{ status: string }>(bridge).status).toBe("done");
    });

    it("defaults unknown statuses and timestamps", () => {
      const bridge = mapPluginEvent(makePluginEvent("agent.status_changed", {}));
      expect(payloadOf<{ agentId: string; status: string }>(bridge)).toMatchObject({ agentId: "", status: "unknown" });

      const started = mapPluginEvent(
        makePluginEvent("agent.run.started", { runId: "r1", agentId: "a1" }, { occurredAt: "2026-08-22T00:05:00.000Z" }),
      );
      expect(payloadOf<{ startedAt: string }>(started).startedAt).toBe("2026-08-22T00:05:00.000Z");
    });

    it("coerces numeric-equivalent strings away (asNumber keeps them undefined)", () => {
      const bridge = mapPluginEvent(
        makePluginEvent("agent.run.finished", { runId: "r1", agentId: "a1", durationMs: "1234" }),
      );
      expect(payloadOf<{ durationMs: number | undefined }>(bridge).durationMs).toBeUndefined();
    });

    it("returns null for unhandled event types", () => {
      expect(mapPluginEvent(makePluginEvent("company.updated", {}))).toBeNull();
    });
  });

  // Added 2026-08-31: six additional PLUGIN_EVENT_TYPES entries subscribed to
  // enrich the bridge's simulation of real Paperclip activity (see
  // event-mapper.ts's mapSnapshot/mapEvent doc comments for the visual side).
  // agent.created/agent.error_cleared/issue.checked_out/
  // issue.assignment_wakeup_requested carry their real subject only as the
  // envelope's top-level entityId, never payload.agentId (the host's generic
  // activity-log payload construction always overwrites that field with the
  // *actor*, confirmed by reading server/src/services/activity-log.ts) — so
  // these fixtures exercise entityId explicitly rather than relying on the
  // table runner above.
  describe("new event types (2026-08-31)", () => {
    it("maps agent.created from entityId, never payload.agentId", () => {
      const bridge = mapPluginEvent(
        makePluginEvent(
          "agent.created",
          { name: "Full-Stack Engineer", role: "engineer", agentId: "actor-who-hired-them" },
          { entityId: "new-agent-1" },
        ),
      );
      expect(bridge?.kind).toBe("agent.created");
      expect(payloadOf<{ agentId: string; name?: string; role?: string }>(bridge)).toEqual({
        agentId: "new-agent-1",
        name: "Full-Stack Engineer",
        role: "engineer",
      });
    });

    it("maps agent.error_cleared from entityId with no other payload required", () => {
      const bridge = mapPluginEvent(
        makePluginEvent("agent.error_cleared", {}, { entityId: "agent-7" }),
      );
      expect(bridge?.kind).toBe("agent.error_cleared");
      expect(payloadOf<{ agentId: string }>(bridge)).toEqual({ agentId: "agent-7" });
    });

    it("maps issue.checked_out with issueId from entityId and agentId from payload", () => {
      const bridge = mapPluginEvent(
        makePluginEvent("issue.checked_out", { agentId: "agent-dev" }, { entityId: "issue-42" }),
      );
      expect(bridge?.kind).toBe("issue.checked_out");
      expect(payloadOf<{ issueId: string; agentId?: string | null }>(bridge)).toEqual({
        issueId: "issue-42",
        agentId: "agent-dev",
      });
    });

    it("maps issue.assignment_wakeup_requested with issueId from entityId", () => {
      const bridge = mapPluginEvent(
        makePluginEvent(
          "issue.assignment_wakeup_requested",
          { assigneeAgentId: "agent-dev", reason: "plugin_issue_wakeup_requested" },
          { entityId: "issue-42" },
        ),
      );
      expect(bridge?.kind).toBe("issue.assignment_wakeup_requested");
      expect(payloadOf<{ issueId: string; assigneeAgentId?: string | null; reason?: string }>(bridge)).toEqual({
        issueId: "issue-42",
        assigneeAgentId: "agent-dev",
        reason: "plugin_issue_wakeup_requested",
      });
    });

    it("maps issue.document.created with issueId from entityId", () => {
      const bridge = mapPluginEvent(
        makePluginEvent(
          "issue.document.created",
          { documentId: "doc-1", title: "PR Description", agentId: "agent-dev" },
          { entityId: "issue-42" },
        ),
      );
      expect(bridge?.kind).toBe("issue.document.created");
      expect(payloadOf<{ issueId: string; documentId?: string; title?: string; agentId?: string | null }>(bridge)).toEqual({
        issueId: "issue-42",
        documentId: "doc-1",
        title: "PR Description",
        agentId: "agent-dev",
      });
    });

    it("maps issue.document.updated the same shape as issue.document.created", () => {
      const bridge = mapPluginEvent(
        makePluginEvent(
          "issue.document.updated",
          { documentId: "doc-1", title: "PR Description v2", agentId: "agent-dev" },
          { entityId: "issue-42" },
        ),
      );
      expect(bridge?.kind).toBe("issue.document.updated");
      expect(payloadOf<{ title?: string }>(bridge).title).toBe("PR Description v2");
    });
  });
});
