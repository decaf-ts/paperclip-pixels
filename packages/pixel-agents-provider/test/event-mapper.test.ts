import { EventMapper, ID_NAMESPACE, syntheticSessionId } from "../src";
import {
  AGENT_A,
  AGENT_B,
  AGENT_NEW,
  COMPANY_ID,
  ISSUE_1,
  PROJECT_X,
  approvalCreated,
  approvalDecided,
  budgetIncidentOpened,
  budgetIncidentResolved,
  commentCreated,
  costEvent,
  issueUpdated,
  runCancelled,
  runFailed,
  runFinished,
  runStarted,
  snapshot,
  statusChanged,
} from "./fixtures";

const idFor = (companyId: string, agentId: string): string =>
  syntheticSessionId(companyId, agentId);

const PENDING_APPROVAL = [
  "pending",
  "open",
  "requested",
  "awaiting",
  "undecided",
];

const OFFLINE = ["offline", "removed", "deleted", "archived", "offboarded"];

describe("valid mappings produce correct AgentEvents (§31.4, §21.2, FR-14)", () => {
  it("spawns exactly one sessionStart per agent, preceding the primary event", () => {
    const mapper = new EventMapper();
    // First sight of the agent via `agent.run.finished`: sessionStart precedes turnEnd.
    const first = mapper.mapEvent(runFinished("e1", 0, "r1", AGENT_A));
    expect(first.agentEvents).toHaveLength(2);
    expect(first.agentEvents[0].event).toMatchObject({
      kind: "sessionStart",
      source: ID_NAMESPACE,
    });
    expect(first.agentEvents[0].sessionId).toBe(idFor(COMPANY_ID, AGENT_A));
    expect(first.agentEvents[1].event).toEqual({
      kind: "turnEnd",
      awaitingInput: false,
    });
    expect(first.agentEvents[1].sessionId).toBe(idFor(COMPANY_ID, AGENT_A));

    // A later event for the same agent never re-emits sessionStart.
    const later = mapper.mapEvent(
      runStarted("e2", 10, "r2", AGENT_A, ISSUE_1, PROJECT_X),
    );
    expect(
      later.agentEvents.some((e) => e.event.kind === "sessionStart"),
    ).toBe(false);

    // A different agent gets its own independent sessionStart.
    const other = mapper.mapEvent(runStarted("e3", 20, "r3", AGENT_B));
    expect(other.agentEvents[0].event.kind).toBe("sessionStart");
    expect(other.agentEvents[0].sessionId).toBe(idFor(COMPANY_ID, AGENT_B));
  });

  it.each([
    ["agent.run.finished", runFinished("e1", 0, "r1", AGENT_A)],
    ["agent.run.failed", runFailed("e1", 0, "r2", AGENT_A)],
    ["agent.run.cancelled", runCancelled("e1", 0, "r3", AGENT_A)],
  ])(
    "%s maps to turnEnd(awaitingInput=false) bound to the agent session",
    (_kind, input) => {
      const mapper = new EventMapper();
      const res = mapper.mapEvent(input);
      const primary = res.agentEvents[res.agentEvents.length - 1];
      expect(primary.event).toEqual({ kind: "turnEnd", awaitingInput: false });
      expect(primary.sessionId).toBe(idFor(COMPANY_ID, AGENT_A));
      expect(res.sidecar?.kind).toBe("run-activity");
    },
  );

  it("routes a human question comment to the issue assignee as turnEnd(awaitingInput=true)", () => {
    const mapper = new EventMapper();
    // Assignee index is learned from a prior `issue.updated` carrying assigneeAgentId.
    mapper.mapEvent(
      issueUpdated("e1", 0, ISSUE_1, "in_progress", {
        assigneeAgentId: AGENT_A,
      }),
    );
    const res = mapper.mapEvent(
      commentCreated("e2", 10, "can you look?", {
        issueId: ISSUE_1,
        userId: "user-1",
        isQuestion: true,
      }),
    );
    const primary = res.agentEvents[res.agentEvents.length - 1];
    expect(primary.event).toEqual({ kind: "turnEnd", awaitingInput: true });
    expect(primary.sessionId).toBe(idFor(COMPANY_ID, AGENT_A));
    expect(res.sidecar?.kind).toBe("comment-feedback");
  });

  it("does not fabricate a human wait when the assignee is unknown or the author is an agent", () => {
    // Unknown assignee -> sidecar only.
    const known = new EventMapper();
    const res1 = known.mapEvent(
      commentCreated("e1", 0, "can you look?", {
        issueId: "unassigned",
        userId: "user-1",
        isQuestion: true,
      }),
    );
    expect(
      res1.agentEvents.some((e) => e.event.kind === "turnEnd"),
    ).toBe(false);
    expect(res1.sidecar?.kind).toBe("comment-feedback");

    // Agent-authored comment is not a human wait.
    const agent = new EventMapper();
    const res2 = agent.mapEvent(
      commentCreated("e2", 0, "self question", {
        issueId: "unassigned",
        agentId: AGENT_A,
        isQuestion: true,
      }),
    );
    expect(
      res2.agentEvents.some((e) => e.event.kind === "turnEnd"),
    ).toBe(false);
  });

  it.each(PENDING_APPROVAL)(
    "maps `approval.created` status=%s to permissionRequest for the target agent",
    (status) => {
      const mapper = new EventMapper();
      const res = mapper.mapEvent(
        approvalCreated("e1", 0, "ap1", { agentId: AGENT_B, status }),
      );
      const primary = res.agentEvents[res.agentEvents.length - 1];
      expect(primary.event).toEqual({ kind: "permissionRequest" });
      expect(primary.sessionId).toBe(idFor(COMPANY_ID, AGENT_B));
      expect(res.sidecar?.kind).toBe("approval");
    },
  );

  it("falls back to the issue assignee when `approval.created` carries no agentId", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(
      issueUpdated("e1", 0, ISSUE_1, "in_review", {
        assigneeAgentId: AGENT_A,
      }),
    );
    const res = mapper.mapEvent(
      approvalCreated("e2", 10, "ap1", {
        issueId: ISSUE_1,
        agentId: undefined,
        status: "pending",
      }),
    );
    const primary = res.agentEvents[res.agentEvents.length - 1];
    expect(primary.event).toEqual({ kind: "permissionRequest" });
    expect(primary.sessionId).toBe(idFor(COMPANY_ID, AGENT_A));
  });

  it("does not emit permissionRequest for a decided/resolved approval status", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(
      approvalCreated("e1", 0, "ap1", { agentId: AGENT_A, status: "declined" }),
    );
    expect(
      res.agentEvents.some((e) => e.event.kind === "permissionRequest"),
    ).toBe(false);
    expect(res.sidecar?.kind).toBe("approval");
  });

  it.each(OFFLINE)(
    "maps an offline status_changed (%s) for a previously seen agent into sessionEnd(reason=%s)",
    (status) => {
      const mapper = new EventMapper();
      mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A));
      const res = mapper.mapEvent(
        statusChanged("e2", 10, status, AGENT_A, "online"),
      );
      const primary = res.agentEvents[res.agentEvents.length - 1];
      expect(primary.event).toEqual({ kind: "sessionEnd", reason: status });
      expect(primary.sessionId).toBe(idFor(COMPANY_ID, AGENT_A));
      expect(res.sidecar?.kind).toBe("status");
    },
  );

  it("emits no event for an offline status when the agent was never seen", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(statusChanged("e1", 0, "deleted", AGENT_A));
    expect(res.agentEvents).toHaveLength(0);
    expect(res.sidecar?.kind).toBe("status");
    const res2 = mapper.mapEvent(statusChanged("e2", 1, "offline", AGENT_B));
    expect(res2.agentEvents).toHaveLength(0);
  });

  it("re-spawns an agent that despawned and then started working again", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A));
    mapper.mapEvent(statusChanged("e2", 10, "offline", AGENT_A));
    const res = mapper.mapEvent(runStarted("e3", 20, "r2", AGENT_A));
    expect(res.agentEvents[0].event.kind).toBe("sessionStart");
    expect(res.agentEvents[0].sessionId).toBe(idFor(COMPANY_ID, AGENT_A));
  });

  it("binds the synthetic session id on every emitted event", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(runFinished("e1", 0, "r1", AGENT_B));
    expect(res.agentEvents).toHaveLength(2);
    for (const e of res.agentEvents) {
      expect(e.sessionId).toBe(idFor(COMPANY_ID, AGENT_B));
    }
  });
});

describe("non-mappable bridge events stay sidecar-only (§31.4, FR-14)", () => {
  const SIDECAR_ONLY = [
    ["agent.run.started", runStarted("e1", 0, "r1", AGENT_A), "run-activity"],
    ["issue.updated", issueUpdated("e1", 0, ISSUE_1, "in_progress"), "issue"],
    ["approval.decided", approvalDecided("e1", 0, "ap1"), "approval"],
    ["budget.incident.opened", budgetIncidentOpened("e1", 0, AGENT_A), "budget"],
    ["budget.incident.resolved", budgetIncidentResolved("e1", 0), "budget"],
    ["cost_event.created", costEvent("e1", 0, 123, AGENT_A), "cost"],
    [
      "agent.status_changed(online)",
      statusChanged("e1", 0, "online", AGENT_A),
      "status",
    ],
  ] as const;

  it.each(SIDECAR_ONLY)(
    "%s emits no agent event (beyond a leading sessionStart on first sight) and retains the sidecar",
    (_kind, input, expectedSidecarKind) => {
      const mapper = new EventMapper();
      const res = mapper.mapEvent(input);
      const nonSpawn = res.agentEvents.filter(
        (e) => e.event.kind !== "sessionStart",
      );
      expect(nonSpawn).toHaveLength(0);
      expect(res.sidecar).not.toBeNull();
      expect(res.sidecar!.kind).toBe(expectedSidecarKind);
    },
  );

  it("never emits toolStart/toolEnd/subagent* for any valid bridge kind", () => {
    const representative: Array<[string, ReturnType<typeof runStarted>]> = [
      ["agent.status_changed", statusChanged("s1", 0, "online", AGENT_A)],
      ["agent.run.started", runStarted("e1", 0, "r1", AGENT_A)],
      ["agent.run.finished", runFinished("e2", 0, "r1", AGENT_A)],
      ["agent.run.failed", runFailed("e3", 0, "r2", AGENT_A)],
      ["agent.run.cancelled", runCancelled("e4", 0, "r3", AGENT_A)],
      ["issue.updated", issueUpdated("e5", 0, ISSUE_1, "in_progress")],
      [
        "issue.comment.created",
        commentCreated("e6", 0, "ping", { userId: "user-1", isQuestion: true }),
      ],
      [
        "approval.created",
        approvalCreated("e7", 0, "ap1", { agentId: AGENT_A }),
      ],
      ["approval.decided", approvalDecided("e8", 0, "ap1")],
      ["budget.incident.opened", budgetIncidentOpened("e9", 0, AGENT_A)],
      ["budget.incident.resolved", budgetIncidentResolved("e10", 0)],
      ["cost_event.created", costEvent("e11", 0, 123, AGENT_A)],
    ];

    const ALLOWED = new Set([
      "sessionStart",
      "sessionEnd",
      "turnEnd",
      "permissionRequest",
    ]);

    for (const [kind, event] of representative) {
      // A fresh mapper per kind models first-sight (leading sessionStart included).
      const mapper = new EventMapper();
      const { agentEvents, sidecar } = mapper.mapEvent(event);
      for (const se of agentEvents) {
        // No fabricated tool-hook semantics (FR-14).
        expect(se.event.kind).not.toMatch(/^(tool|subagent)/);
        expect(ALLOWED.has(se.event.kind)).toBe(true);
      }
      expect(sidecar).not.toBeNull();
      expect(typeof kind).toBe("string");
    }
  });

  it("does not alias an already-seen run.started into a tool event either", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A));
    const res = mapper.mapEvent(runStarted("e2", 10, "r2", AGENT_A));
    expect(res.agentEvents).toHaveLength(0);
    expect(res.sidecar?.kind).toBe("run-activity");
  });
});

describe("synthetic session ids are deterministic and namespaced (§31.4, §21.3)", () => {
  it("is a pure function of (companyId, agentId)", () => {
    expect(syntheticSessionId("c", "a")).toBe("paperclip-bridge:c:a");
    expect(syntheticSessionId("c", "a")).toBe(syntheticSessionId("c", "a"));
    expect(syntheticSessionId("c", "b")).not.toBe(syntheticSessionId("c", "a"));
    expect(syntheticSessionId("d", "a")).not.toBe(syntheticSessionId("c", "a"));
  });

  it("always carries the paperclip-bridge namespace prefix", () => {
    for (const companyId of ["c1", "c2"]) {
      for (const agentId of ["a", "b", "claude"]) {
        expect(syntheticSessionId(companyId, agentId)).toMatch(
          new RegExp(`^${ID_NAMESPACE}:`),
        );
      }
    }
  });

  it("never collides with a bare provider slug", () => {
    const slug = "claude";
    expect(syntheticSessionId("c", slug)).not.toBe(slug);
    expect(syntheticSessionId("c", slug)).toBe(`paperclip-bridge:c:${slug}`);
  });

  it("returns the same id across a reset() and re-snapshot", () => {
    const mapper = new EventMapper();
    const first = mapper.mapSnapshot(snapshot());
    const target = syntheticSessionId(COMPANY_ID, AGENT_A);
    const firstId = first.agentEvents.find(
      (e) => e.sessionId === target,
    )?.sessionId;
    expect(firstId).toBe(target);

    mapper.reset();
    const second = mapper.mapSnapshot(snapshot());
    const secondId = second.agentEvents.find(
      (e) => e.sessionId === target,
    )?.sessionId;
    expect(secondId).toBe(firstId);
    // reset() also re-enables spawning for the same characters.
    expect(second.agentEvents.length).toBe(first.agentEvents.length);
  });

  it("exposes the canonical namespace and never fabricates ids in the mapper", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_NEW));
    for (const e of res.agentEvents) {
      expect(e.sessionId.startsWith(`${ID_NAMESPACE}:`)).toBe(true);
    }
  });
});
