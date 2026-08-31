import { EventMapper, ID_NAMESPACE, syntheticCwd, syntheticSessionId } from "../../src/pixel-agents-provider/index.js";
import {
  AGENT_A,
  AGENT_B,
  AGENT_NEW,
  COMPANY_ID,
  ISSUE_1,
  ISSUE_2,
  PROJECT_X,
  agentCreated,
  agentErrorCleared,
  approvalCreated,
  approvalDecided,
  budgetIncidentOpened,
  budgetIncidentResolved,
  commentCreated,
  costEvent,
  issueAssignmentWakeupRequested,
  issueCheckedOut,
  issueDocumentCreated,
  issueDocumentUpdated,
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

  it("never emits subagent*/progress for any valid bridge kind (no genuine Paperclip subagent correspondence)", () => {
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

    // toolStart/toolEnd("PaperclipWork") ARE allowed (§21.4) for genuine
    // active-work evidence; subagent*/progress never are (no correspondence).
    const ALLOWED = new Set([
      "sessionStart",
      "sessionEnd",
      "turnEnd",
      "permissionRequest",
      "toolStart",
      "toolEnd",
    ]);

    for (const [kind, event] of representative) {
      // A fresh mapper per kind models first-sight (leading sessionStart included).
      const mapper = new EventMapper();
      const { agentEvents, sidecar } = mapper.mapEvent(event);
      for (const se of agentEvents) {
        expect(se.event.kind).not.toMatch(/^(subagent|progress)/);
        expect(ALLOWED.has(se.event.kind)).toBe(true);
        // A real toolStart always carries the honest synthetic name, never a
        // fabricated specific tool (FR-14).
        if (se.event.kind === "toolStart") {
          expect(se.event.toolName).toBe("PaperclipWork");
        }
      }
      expect(sidecar).not.toBeNull();
      expect(typeof kind).toBe("string");
    }
  });

  it("agent.run.started maps to sessionStart + toolStart(PaperclipWork) on first sight (§21.4)", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A));
    expect(res.agentEvents.map((e) => e.event.kind)).toEqual(["sessionStart", "toolStart"]);
    expect(res.sidecar?.kind).toBe("run-activity");
  });

  it("does not re-fire toolStart while further concurrent runs stack on an already-active agent", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A));
    const res = mapper.mapEvent(runStarted("e2", 10, "r2", AGENT_A));
    expect(res.agentEvents).toHaveLength(0);
    expect(res.sidecar?.kind).toBe("run-activity");
  });

  it("emits toolEnd only when the falling edge actually closes an open tool (out-of-order safe, §12.3/§31.1)", () => {
    // run.finished with no matching run.started: sessionStart fires (first
    // sight) but no toolEnd is fabricated for a tool that was never opened.
    const mapper = new EventMapper();
    const res = mapper.mapEvent(runFinished("e1", 0, "r1", AGENT_A));
    expect(res.agentEvents.map((e) => e.event.kind)).toEqual(["sessionStart", "turnEnd"]);
  });

  it("closes the tool only on the last concurrent run finishing, not each one", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A));
    mapper.mapEvent(runStarted("e2", 1, "r2", AGENT_A));
    const first = mapper.mapEvent(runFinished("e3", 2, "r1", AGENT_A));
    // One run still active: turnEnd(idle between runs) but no toolEnd yet.
    expect(first.agentEvents.map((e) => e.event.kind)).toEqual(["turnEnd"]);
    const second = mapper.mapEvent(runFinished("e4", 3, "r2", AGENT_A));
    expect(second.agentEvents.map((e) => e.event.kind)).toEqual(["toolEnd", "turnEnd"]);
  });
});

describe("synthetic session ids are deterministic and namespaced (§31.4, §21.3)", () => {
  it("uses the real Paperclip agent name as Pixel Agents' folder label", () => {
    expect(syntheticCwd("company-1", "agent-opaque", "Front-End Developer")).toBe(
      "/paperclip/company-1/Front-End Developer",
    );
    expect(syntheticCwd("company-1", "agent-opaque", "QA/Release\\Lead")).toBe(
      "/paperclip/company-1/QA-Release-Lead",
    );
  });

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

// Added 2026-08-31: real-issue-title-aware toolStart captions, the six new
// subscribed event types, and the reassignment handoff blip — see this
// file's own event-mapper.ts doc comment for the full design rationale.
describe("visible PaperclipWork markers carry the real issue title in their input", () => {
  it("agent.run.started uses the title cached from a prior snapshot", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot()); // learns ISSUE_1 -> "Issue 1", spawns+idles AGENT_A
    const res = mapper.mapEvent(runStarted("e1", 10, "r1", AGENT_A, ISSUE_1, PROJECT_X));
    const toolStart = res.agentEvents.find((e) => e.event.kind === "toolStart");
    expect(toolStart?.event).toEqual({
      kind: "toolStart",
      toolId: `${ID_NAMESPACE}:work:${COMPANY_ID}:${AGENT_A}`,
      toolName: "PaperclipWork",
      input: { description: "Issue 1" },
    });
  });

  it("falls back to the generic PaperclipWork name when the issue title is unknown", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_NEW, ISSUE_2, PROJECT_X));
    const toolStart = res.agentEvents.find((e) => e.event.kind === "toolStart");
    expect(toolStart?.event).toEqual({
      kind: "toolStart",
      toolId: `${ID_NAMESPACE}:work:${COMPANY_ID}:${AGENT_NEW}`,
      toolName: "PaperclipWork",
    });
  });

  it("mapSnapshot's already-active-run branch is also title-aware", () => {
    const mapper = new EventMapper();
    const withActiveRun = snapshot({
      agents: [
        {
          id: AGENT_A,
          companyId: COMPANY_ID,
          name: "Alice",
          status: "running",
          activeRuns: [{ id: "r1", agentId: AGENT_A, issueId: ISSUE_1, projectId: PROJECT_X, status: "running" }],
        },
      ],
    });
    const res = mapper.mapSnapshot(withActiveRun);
    const toolStart = res.agentEvents.find((e) => e.event.kind === "toolStart");
    expect(toolStart?.event).toMatchObject({ toolName: "PaperclipWork", input: { description: "Issue 1" } });
  });

  it("authoritative re-snapshots repair missed run starts and finishes", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot());

    const working = snapshot({
      agents: [
        {
          id: AGENT_A,
          companyId: COMPANY_ID,
          name: "Alice",
          status: "running",
          activeRuns: [
            {
              id: "r-reconciled",
              agentId: AGENT_A,
              issueId: ISSUE_1,
              projectId: PROJECT_X,
              status: "running",
            },
          ],
        },
      ],
    });
    const started = mapper.mapSnapshot(working);
    expect(started.agentEvents.map((entry) => entry.event.kind)).toEqual(["toolStart"]);

    const stopped = mapper.mapSnapshot(snapshot({ agents: [working.agents[0]!] }));
    expect(stopped.agentEvents).toEqual([]);

    const idle = snapshot({
      agents: [{ ...working.agents[0]!, status: "idle", activeRuns: [] }],
    });
    const finished = mapper.mapSnapshot(idle);
    expect(finished.agentEvents.map((entry) => entry.event.kind)).toEqual(["toolEnd", "turnEnd"]);
  });

  it("learns a title from issue.updated too, for a run that starts afterward", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(issueUpdated("e0", 0, ISSUE_2, "todo", { title: "Fix the thing" }));
    const res = mapper.mapEvent(runStarted("e1", 10, "r1", AGENT_NEW, ISSUE_2, PROJECT_X));
    const toolStart = res.agentEvents.find((e) => e.event.kind === "toolStart");
    expect(toolStart?.event).toMatchObject({ toolName: "PaperclipWork", input: { description: "Fix the thing" } });
  });
});

describe("issue.checked_out opens the work slot ahead of agent.run.started (§21.4)", () => {
  it("checked_out spawns the character and opens toolActive with the issue title", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot()); // learns ISSUE_1 -> "Issue 1"
    const res = mapper.mapEvent(issueCheckedOut("e1", 10, ISSUE_1, AGENT_A));
    const toolStart = res.agentEvents.find((e) => e.event.kind === "toolStart");
    expect(toolStart?.event).toMatchObject({ toolName: "PaperclipWork", input: { description: "Issue 1" } });
  });

  it("the later agent.run.started for the same agent becomes a no-op fallback, never a second toolStart", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot());
    mapper.mapEvent(issueCheckedOut("e1", 10, ISSUE_1, AGENT_A));
    const res = mapper.mapEvent(runStarted("e2", 20, "r1", AGENT_A, ISSUE_1, PROJECT_X));
    expect(res.agentEvents.some((e) => e.event.kind === "toolStart")).toBe(false);
  });
});

describe("agent.created spawns immediately, idle (never fabricates a running state)", () => {
  it("spawns a sessionStart + turnEnd(false) pair for a brand-new agent", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(agentCreated("e1", 0, AGENT_NEW, { name: "Fresh Hire", role: "engineer" }));
    expect(res.agentEvents.map((e) => e.event.kind)).toEqual(["sessionStart", "turnEnd"]);
    expect(res.agentEvents[0].event).toMatchObject({ kind: "sessionStart" });
    expect(res.agentEvents[1].event).toEqual({ kind: "turnEnd", awaitingInput: false });
    for (const e of res.agentEvents) {
      expect(e.sessionId).toBe(syntheticSessionId(COMPANY_ID, AGENT_NEW));
    }
  });

  it("never re-spawns the same agent twice", () => {
    const mapper = new EventMapper();
    mapper.mapEvent(agentCreated("e1", 0, AGENT_NEW));
    const res = mapper.mapEvent(agentCreated("e2", 10, AGENT_NEW));
    expect(res.agentEvents).toHaveLength(0);
  });
});

describe("agent.error_cleared is sidecar-less and never fabricates a session boundary", () => {
  it("emits no AgentEvent and no sidecar", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(agentErrorCleared("e1", 0, AGENT_A));
    expect(res.agentEvents).toHaveLength(0);
    expect(res.sidecar).toBeNull();
  });
});

describe("issue.assignment_wakeup_requested ensures the character exists without fabricating work", () => {
  it("spawns the assignee if unseen, with no busy/toolStart signal", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(issueAssignmentWakeupRequested("e1", 0, ISSUE_1, AGENT_NEW));
    expect(res.agentEvents.map((e) => e.event.kind)).toEqual(["sessionStart", "turnEnd"]);
  });

  it("is a no-op for an already-seen agent", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot());
    const res = mapper.mapEvent(issueAssignmentWakeupRequested("e1", 10, ISSUE_1, AGENT_A));
    expect(res.agentEvents).toHaveLength(0);
  });
});

describe("issue.document.created/updated map to an honest, transient Write blip (§21.4 isolation)", () => {
  it("emits a toolStart+toolEnd pair on a document-scoped toolId, captioned with the document title", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(
      issueDocumentCreated("e1", 0, { issueId: ISSUE_1, documentId: "doc-1", title: "PR Description", agentId: AGENT_NEW }),
    );
    const [sessionStart, toolStart, toolEnd] = res.agentEvents;
    expect(sessionStart.event.kind).toBe("sessionStart");
    const expectedToolId = `${ID_NAMESPACE}:blip:${COMPANY_ID}:${AGENT_NEW}:doc:doc-1`;
    expect(toolStart.event).toEqual({
      kind: "toolStart",
      toolId: expectedToolId,
      toolName: "Write",
      input: { file_path: "PR Description" },
    });
    expect(toolEnd.event).toEqual({ kind: "toolEnd", toolId: expectedToolId });
  });

  it("never touches the main run-tracking toolId, even mid-run", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot());
    mapper.mapEvent(runStarted("e1", 0, "r1", AGENT_A, ISSUE_1, PROJECT_X));
    const res = mapper.mapEvent(
      issueDocumentUpdated("e2", 10, { issueId: ISSUE_1, documentId: "doc-1", agentId: AGENT_A }),
    );
    const mainToolId = `${ID_NAMESPACE}:work:${COMPANY_ID}:${AGENT_A}`;
    expect(res.agentEvents.some((e) => "toolId" in e.event && e.event.toolId === mainToolId)).toBe(false);
    // The run's own toolEnd (when it later finishes) must still fire — the
    // blip must not have corrupted `state.toolActive`.
    const finished = mapper.mapEvent(runFinished("e3", 20, "r1", AGENT_A));
    expect(finished.agentEvents.some((e) => e.event.kind === "toolEnd" && "toolId" in e.event && e.event.toolId === mainToolId)).toBe(true);
  });
});

describe("issue.updated reassignment emits a SendMessage handoff blip on the previous assignee (§21.4 isolation)", () => {
  it("emits the blip on the previous assignee, captioned with the new assignee's name", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot()); // AGENT_A ("Alice") and AGENT_B ("Bob") both spawned+idled, ISSUE_1 -> AGENT_A
    const res = mapper.mapEvent(
      issueUpdated("e1", 10, ISSUE_1, "in_progress", { assigneeAgentId: AGENT_B }),
    );
    const blipStart = res.agentEvents.find(
      (e) => e.event.kind === "toolStart" && (e.event as { toolName: string }).toolName === "SendMessage",
    );
    expect(blipStart?.sessionId).toBe(syntheticSessionId(COMPANY_ID, AGENT_A));
    expect(blipStart?.event).toMatchObject({ toolName: "SendMessage", input: { recipient: "Bob" } });
    const toolId = (blipStart!.event as { toolId: string }).toolId;
    expect(
      res.agentEvents.some((e) => e.event.kind === "toolEnd" && "toolId" in e.event && e.event.toolId === toolId),
    ).toBe(true);
  });

  it("does not fire when there was no previous assignee", () => {
    const mapper = new EventMapper();
    const res = mapper.mapEvent(issueUpdated("e1", 0, ISSUE_2, "in_progress", { assigneeAgentId: AGENT_A }));
    expect(res.agentEvents.some((e) => e.event.kind === "toolStart")).toBe(false);
  });

  it("does not fire when reassigned to the same agent", () => {
    const mapper = new EventMapper();
    mapper.mapSnapshot(snapshot());
    const res = mapper.mapEvent(issueUpdated("e1", 10, ISSUE_1, "in_progress", { assigneeAgentId: AGENT_A }));
    expect(res.agentEvents.some((e) => e.event.kind === "toolStart")).toBe(false);
  });

  it("does not fire when the previous assignee was never actually seen/spawned", () => {
    const mapper = new EventMapper();
    // Learn the assignment without ever spawning AGENT_A (no snapshot, no run event).
    mapper.mapEvent(issueUpdated("e1", 0, ISSUE_1, "todo", { assigneeAgentId: AGENT_A }));
    const res = mapper.mapEvent(issueUpdated("e2", 10, ISSUE_1, "in_progress", { assigneeAgentId: AGENT_B }));
    expect(res.agentEvents.some((e) => e.event.kind === "toolStart")).toBe(false);
  });
});
