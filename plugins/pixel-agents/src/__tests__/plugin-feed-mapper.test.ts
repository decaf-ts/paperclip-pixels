import { describe, expect, it } from "vitest";
import type {
  AuthoritativeSnapshotInput,
  BridgeInputEvent,
} from "paperclip-pixels-common";
import { PluginFeedMapper } from "../index.js";

/**
 * Unit tests for `src/pixel-agents-plugin/feed-mapper.ts` — the stateful
 * translator from canonical bridge events/snapshots/appearance maps to
 * plugin feed operations (spec PAPERCLIP_PIXELS-2, WS2-C).
 *
 * These pin the semantic contract the SAA-536 port introduced (the re-pinned
 * `test/relay.test.ts` batch-shape assertions stay mechanical by design —
 * this file owns the deep semantics):
 *
 * - declare-on-first-sight; re-declare only on name/seat change
 * - per-agent unique, restart-deterministic `teamName` (djb2 hex)
 * - run rising/falling edges, incl. the checked_out/run.started no-double-count rule
 * - stuck-agent parity (human question comment / pending approval → waiting + awaitingInput)
 * - offline statuses → removeAgents (declared agents only)
 * - snapshot self-heal (honest first-sight idle; a snapshot never clobbers awaitingInput)
 * - setAppearances seated upserts; the appearance map survives reset()
 * - mapToolActivity replaces the caption without touching the run-lifecycle flag
 *
 * Where a test pins behavior that could be read as an implementation quirk
 * (e.g. the stuck transition leaving the last caption on the wire), the
 * assertion is commented as as-implemented and was reported to the SAA-536
 * owner rather than silently treated as the intended spec.
 */

const COMPANY_ID = "company-acme";
const AGENT_A = "agent-a";
const AGENT_B = "agent-b";
const ISO = "2026-09-01T00:00:00.000Z";

// djb2("agent-a") = 0x1024a250, djb2("agent-b") = 0x1024a253 — precomputed
// pins so any drift in the hash formula fails these tests.
const TEAM_A = "paperclip-bridge-1024a250";
const TEAM_B = "paperclip-bridge-1024a253";

let eventCounter = 0;

function ev(
  kind: string,
  payload: Record<string, unknown>,
  companyId: string = COMPANY_ID,
): BridgeInputEvent {
  eventCounter += 1;
  return {
    eventId: `evt-${eventCounter}`,
    timestamp: ISO,
    companyId,
    kind,
    payload,
  } as unknown as BridgeInputEvent;
}

function runStarted(agentId: string, issueId?: string, runId = "run-1"): BridgeInputEvent {
  return ev("agent.run.started", { runId, agentId, issueId: issueId ?? null });
}

function runEnded(
  kind: "agent.run.finished" | "agent.run.failed" | "agent.run.cancelled",
  agentId: string,
  runId = "run-1",
): BridgeInputEvent {
  return ev(kind, { runId, agentId, issueId: null });
}

function checkedOut(agentId: string, issueId: string): BridgeInputEvent {
  return ev("issue.checked_out", { issueId, agentId });
}

function issueUpdated(fields: {
  issueId: string;
  title?: string;
  assigneeAgentId?: string | null;
}): BridgeInputEvent {
  return ev("issue.updated", {
    issueId: fields.issueId,
    status: "in_progress",
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(fields.assigneeAgentId !== undefined ? { assigneeAgentId: fields.assigneeAgentId } : {}),
  });
}

function snapshotOf(
  agents: Array<{ id: string; name?: string; activeRuns?: Array<{ id: string; issueId?: string | null }> }>,
  issues: Array<{ id: string; title?: string; assigneeAgentId?: string | null }> = [],
): AuthoritativeSnapshotInput {
  return {
    company: { id: COMPANY_ID, name: "Acme Corp", status: "active" },
    agents: agents.map((a) => ({
      id: a.id,
      companyId: COMPANY_ID,
      name: a.name ?? a.id,
      status: "active",
      activeRuns: (a.activeRuns ?? []).map((r) => ({
        id: r.id,
        agentId: a.id,
        issueId: r.issueId ?? null,
        projectId: null,
        status: "running",
      })),
    })),
    projects: [],
    issues: issues.map((i) => ({
      id: i.id,
      companyId: COMPANY_ID,
      projectId: null,
      title: i.title,
      status: "in_progress",
      assigneeAgentId: i.assigneeAgentId ?? null,
    })),
    approvals: [],
    observedAt: ISO,
  } as unknown as AuthoritativeSnapshotInput;
}

const declareOf = (agentId: string, name: string, extra: Record<string, unknown> = {}) => ({
  op: "declareAgents",
  agents: [{ key: agentId, name, teamName: TEAM_A, ...extra }],
});

const statusOf = (agentId: string, status: "active" | "waiting", awaitingInput?: boolean) => ({
  op: "updateAgentStatus",
  key: agentId,
  status,
  ...(status === "waiting" ? { awaitingInput: awaitingInput ?? false } : {}),
});

const activityOf = (agentId: string, activity: string | null) => ({
  op: "updateAgentActivity",
  key: agentId,
  activity,
});

// WS4-C: one dialog-pane line op (the mapper composes + clamps the text).
const dialogLineOf = (text: string) => ({ op: "dialogLines", lines: [{ text }] });

// -- declaration semantics --------------------------------------------------

describe("PluginFeedMapper — declaration", () => {
  it("declares an agent on first sight with name falling back to the agent id", () => {
    const mapper = new PluginFeedMapper();
    const ops = mapper.mapEvent(runStarted(AGENT_A));
    expect(ops).toEqual([
      declareOf(AGENT_A, AGENT_A),
      activityOf(AGENT_A, "Task: Paperclip work"),
      statusOf(AGENT_A, "active"),
      dialogLineOf(`${AGENT_A} started a run`),
    ]);
  });

  it("agent.created declares with the provided name and an honest waiting status", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(ev("agent.created", { agentId: AGENT_A, name: "Dev Agent" }))).toEqual([
      declareOf(AGENT_A, "Dev Agent"),
      statusOf(AGENT_A, "waiting", false),
    ]);
    // Same name again: no declare, and the pushed status dedupes too.
    expect(mapper.mapEvent(ev("agent.created", { agentId: AGENT_A, name: "Dev Agent" }))).toEqual([]);
  });

  it("issue.assignment_wakeup_requested declares and idles an unknown assignee", () => {
    const mapper = new PluginFeedMapper();
    expect(
      mapper.mapEvent(
        ev("issue.assignment_wakeup_requested", { issueId: "issue-1", assigneeAgentId: AGENT_A }),
      ),
    ).toEqual([declareOf(AGENT_A, AGENT_A), statusOf(AGENT_A, "waiting", false)]);
  });

  it("re-declares when the name changes (snapshot-driven rename)", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Old Name" }]));
    const ops = mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "New Name" }]));
    expect(ops).toEqual([declareOf(AGENT_A, "New Name")]);
  });

  it("assigns a per-agent unique teamName: djb2 hex, deterministic, never grouping", () => {
    const mapper = new PluginFeedMapper();
    const [declare] = mapper.mapEvent(ev("agent.created", { agentId: AGENT_A })) as Array<{
      agents: Array<{ teamName: string }>;
    }>;
    expect(declare.agents[0].teamName).toBe(TEAM_A);

    const second = new PluginFeedMapper();
    const [declareB] = second.mapEvent(ev("agent.created", { agentId: AGENT_B })) as Array<{
      agents: Array<{ teamName: string }>;
    }>;
    expect(declareB.agents[0].teamName).toBe(TEAM_B);
    expect(declareB.agents[0].teamName).not.toBe(declare.agents[0].teamName);

    // Deterministic across a full reset (relay re-sync) for the same id.
    const third = new PluginFeedMapper();
    const [afterReset] = third.mapEvent(ev("agent.created", { agentId: AGENT_A })) as Array<{
      agents: Array<{ teamName: string }>;
    }>;
    expect(afterReset.agents[0].teamName).toBe(TEAM_A);
  });

  it("gives every agent id in a corpus a distinct, pattern-conforming teamName", () => {
    const mapper = new PluginFeedMapper();
    const teamNames = new Set<string>();
    for (let i = 0; i < 50; i += 1) {
      const agentId = `agent-${String(i).padStart(3, "0")}`;
      const [declare] = mapper.mapEvent(ev("agent.created", { agentId })) as Array<{
        agents: Array<{ teamName: string }>;
      }>;
      const teamName = declare.agents[0].teamName;
      expect(teamName).toMatch(/^paperclip-bridge-[0-9a-f]+$/);
      teamNames.add(teamName);
    }
    expect(teamNames.size).toBe(50);
  });
});

// -- run rising/falling edges ------------------------------------------------

describe("PluginFeedMapper — run lifecycle edges", () => {
  it("opens a `Task: <title>` caption with active status on run.started when the title is known", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", title: "Ship the bridge" }));
    const ops = mapper.mapEvent(runStarted(AGENT_A, "issue-1"));
    expect(ops).toEqual([
      declareOf(AGENT_A, AGENT_A),
      activityOf(AGENT_A, "Task: Ship the bridge"),
      statusOf(AGENT_A, "active"),
      dialogLineOf(`${AGENT_A} started a run: Ship the bridge`),
    ]);
  });

  it("checkout + run.started pair counts as ONE run: single caption open, single close", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", title: "Fix the flux capacitor" }));

    // checked_out opens the caption at the earliest honest point but must NOT
    // touch the run counter (and emits no dialog line — only run.started does).
    expect(mapper.mapEvent(checkedOut(AGENT_A, "issue-1"))).toEqual([
      declareOf(AGENT_A, AGENT_A),
      activityOf(AGENT_A, "Task: Fix the flux capacitor"),
      statusOf(AGENT_A, "active"),
    ]);

    // The paired run.started arrives next: caption already open, so it adds
    // no declare/caption/status — only the run-scoped dialog line.
    expect(mapper.mapEvent(runStarted(AGENT_A, "issue-1"))).toEqual([
      dialogLineOf(`${AGENT_A} started a run: Fix the flux capacitor`),
    ]);

    // One falling edge closes what one logical run opened.
    expect(mapper.mapEvent(runEnded("agent.run.finished", AGENT_A))).toEqual([
      activityOf(AGENT_A, null),
      statusOf(AGENT_A, "waiting", false),
      dialogLineOf(`${AGENT_A} finished a run`),
    ]);
  });

  it("issue.checked_out with a null agent id is a no-op", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(ev("issue.checked_out", { issueId: "issue-1", agentId: null }))).toEqual([]);
  });

  it("stacks concurrent runs in one caption slot: only the last falling edge closes it", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(runStarted(AGENT_A, undefined, "run-1"));
    // Second concurrent run: no new caption, no new status — but a second
    // run-scoped dialog line (each real run start is conversation).
    expect(mapper.mapEvent(runStarted(AGENT_A, undefined, "run-2"))).toEqual([
      dialogLineOf(`${AGENT_A} started a run`),
    ]);
    // First run ends: one still active, nothing closes — the finish is
    // still a dialog line.
    expect(mapper.mapEvent(runEnded("agent.run.finished", AGENT_A, "run-1"))).toEqual([
      dialogLineOf(`${AGENT_A} finished a run`),
    ]);
    // Last run fails: caption cleared, back to waiting.
    expect(mapper.mapEvent(runEnded("agent.run.failed", AGENT_A, "run-2"))).toEqual([
      activityOf(AGENT_A, null),
      statusOf(AGENT_A, "waiting", false),
      dialogLineOf(`${AGENT_A} failed a run`),
    ]);
  });

  it.each(["agent.run.finished", "agent.run.cancelled"] as const)(
    "a lone %s clears the caption and returns the agent to waiting",
    (kind) => {
      const mapper = new PluginFeedMapper();
      mapper.mapEvent(runStarted(AGENT_A));
      const verb = kind === "agent.run.finished" ? "finished" : "cancelled";
      expect(mapper.mapEvent(runEnded(kind, AGENT_A))).toEqual([
        activityOf(AGENT_A, null),
        statusOf(AGENT_A, "waiting", false),
        dialogLineOf(`${AGENT_A} ${verb} a run`),
      ]);
    },
  );

  it("a falling edge with no prior run is a no-op (never goes negative)", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(runEnded("agent.run.finished", AGENT_A))).toEqual([]);
  });
});

// -- stuck-agent parity -------------------------------------------------------

describe("PluginFeedMapper — stuck-agent parity", () => {
  it("a human question comment on an assigned issue → waiting + awaitingInput", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", assigneeAgentId: AGENT_A }));

    const ops = mapper.mapEvent(
      ev("issue.comment.created", {
        commentId: "c1",
        issueId: "issue-1",
        agentId: null,
        userId: "user-1",
        body: "Which database?",
        isQuestion: true,
      }),
    );
    expect(ops).toEqual([
      dialogLineOf("Human (question): Which database?"),
      declareOf(AGENT_A, AGENT_A),
      statusOf(AGENT_A, "waiting", true),
    ]);
  });

  it("AS-IMPLEMENTED: the stuck transition keeps the last caption on the wire and consumes the run's falling-edge clear", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", title: "T1", assigneeAgentId: AGENT_A }));
    mapper.mapEvent(runStarted(AGENT_A, "issue-1"));

    // Stuck: status flips to waiting+awaitingInput with NO caption clear —
    // the run caption stays visible while the agent waits on the human.
    expect(
      mapper.mapEvent(
        ev("issue.comment.created", {
          commentId: "c1",
          issueId: "issue-1",
          agentId: null,
          userId: "user-1",
          body: "?",
          isQuestion: true,
        }),
      ),
    ).toEqual([dialogLineOf("Human (question): ?"), statusOf(AGENT_A, "waiting", true)]);

    // The run's own falling edge then emits only its dialog line: the stuck
    // transition already claimed the caption clear (runCaptionOpen was
    // consumed). Reported to the SAA-536 owner as an observation; pinned
    // as-implemented.
    expect(mapper.mapEvent(runEnded("agent.run.finished", AGENT_A))).toEqual([
      dialogLineOf(`${AGENT_A} finished a run`),
    ]);
  });

  it.each([
    ["an agent-authored comment", { agentId: AGENT_B, userId: "user-1", isQuestion: true }],
    ["a non-question human comment", { agentId: null, userId: "user-1", isQuestion: false }],
    ["a comment with no user", { agentId: null, userId: null, isQuestion: true }],
  ])("%s triggers no stuck transition (only its dialog line)", (_label, payload) => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", assigneeAgentId: AGENT_A }));
    const author = "agentId" in payload && payload.agentId ? AGENT_B : "Human";
    const suffix = payload.isQuestion ? " (question)" : "";
    expect(
      mapper.mapEvent(
        ev("issue.comment.created", { commentId: "c1", issueId: "issue-1", body: "hi", ...payload }),
      ),
    ).toEqual([dialogLineOf(`${author}${suffix}: hi`)]);
  });

  it("a question comment on an issue with no recorded assignee: only the dialog line (no stuck target)", () => {
    const mapper = new PluginFeedMapper();
    expect(
      mapper.mapEvent(
        ev("issue.comment.created", {
          commentId: "c1",
          issueId: "issue-unassigned",
          agentId: null,
          userId: "user-1",
          body: "?",
          isQuestion: true,
        }),
      ),
    ).toEqual([dialogLineOf("Human (question): ?")]);
  });

  it.each(["pending", "open", "requested", "awaiting", "undecided"])(
    "a %s approval on the agent → waiting + awaitingInput",
    (status) => {
      const mapper = new PluginFeedMapper();
      const ops = mapper.mapEvent(
        ev("approval.created", { approvalId: "ap-1", issueId: null, agentId: AGENT_A, status }),
      );
      expect(ops).toEqual([
        declareOf(AGENT_A, AGENT_A),
        statusOf(AGENT_A, "waiting", true),
        dialogLineOf(`${AGENT_A} is waiting for an approval`),
      ]);
    },
  );

  it("a pending approval without an agent id routes to the issue's assignee", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", assigneeAgentId: AGENT_A }));
    expect(
      mapper.mapEvent(
        ev("approval.created", { approvalId: "ap-1", issueId: "issue-1", agentId: null, status: "pending" }),
      ),
    ).toEqual([
      declareOf(AGENT_A, AGENT_A),
      statusOf(AGENT_A, "waiting", true),
      dialogLineOf(`${AGENT_A} is waiting for an approval`),
    ]);
  });

  it("ignores a pending approval with neither agent id nor assignable issue, and any decided approval", () => {
    const mapper = new PluginFeedMapper();
    expect(
      mapper.mapEvent(
        ev("approval.created", { approvalId: "ap-1", issueId: null, agentId: null, status: "pending" }),
      ),
    ).toEqual([]);
    expect(
      mapper.mapEvent(
        ev("approval.created", { approvalId: "ap-2", issueId: null, agentId: AGENT_A, status: "approved" }),
      ),
    ).toEqual([]);
  });
});

// -- offline statuses ----------------------------------------------------------

describe("PluginFeedMapper — offline statuses", () => {
  it.each(["offline", "removed", "deleted", "archived", "offboarded"])(
    "a declared agent going %s is removed from the feed",
    (status) => {
      const mapper = new PluginFeedMapper();
      mapper.mapEvent(ev("agent.created", { agentId: AGENT_A, name: "Dev" }));
      expect(mapper.mapEvent(ev("agent.status_changed", { agentId: AGENT_A, status }))).toEqual([
        { op: "removeAgents", keys: [AGENT_A] },
      ]);
    },
  );

  it("an offline status for a never-declared agent is a no-op, and the agent can still be declared later", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(ev("agent.status_changed", { agentId: AGENT_A, status: "offline" }))).toEqual([]);
    const ops = mapper.mapEvent(ev("agent.created", { agentId: AGENT_A, name: "Back Again" }));
    expect(ops).toEqual([declareOf(AGENT_A, "Back Again"), statusOf(AGENT_A, "waiting", false)]);
  });

  it("a non-offline status change emits nothing on the feed", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(ev("agent.created", { agentId: AGENT_A, name: "Dev" }));
    expect(mapper.mapEvent(ev("agent.status_changed", { agentId: AGENT_A, status: "paused" }))).toEqual([]);
  });
});

// -- snapshot self-heal ---------------------------------------------------------

describe("PluginFeedMapper — snapshot self-heal", () => {
  it("an idle first-sight snapshot declares the agent and pushes an honest waiting status", () => {
    const mapper = new PluginFeedMapper();
    const ops = mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Dev Agent" }]));
    expect(ops).toEqual([
      declareOf(AGENT_A, "Dev Agent"),
      statusOf(AGENT_A, "waiting", false),
    ]);
  });

  it("an identical repeat snapshot is fully idempotent (no ops)", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Dev Agent" }]));
    expect(mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Dev Agent" }]))).toEqual([]);
  });

  it("a snapshot with an active run opens the caption with the title recorded in the same snapshot", () => {
    const mapper = new PluginFeedMapper();
    const ops = mapper.mapSnapshot(
      snapshotOf(
        [{ id: AGENT_A, name: "Dev Agent", activeRuns: [{ id: "run-1", issueId: "issue-1" }] }],
        [{ id: "issue-1", title: "Snapshot Title" }],
      ),
    );
    expect(ops).toEqual([
      declareOf(AGENT_A, "Dev Agent"),
      activityOf(AGENT_A, "Task: Snapshot Title"),
      statusOf(AGENT_A, "active"),
    ]);
  });

  it("falls back to the generic caption when the active run's issue title is unknown", () => {
    const mapper = new PluginFeedMapper();
    const ops = mapper.mapSnapshot(
      snapshotOf([{ id: AGENT_A, name: "Dev", activeRuns: [{ id: "run-1", issueId: "issue-mystery" }] }]),
    );
    expect(ops).toEqual([
      declareOf(AGENT_A, "Dev"),
      activityOf(AGENT_A, "Task: Paperclip work"),
      statusOf(AGENT_A, "active"),
    ]);
  });

  it("a snapshot closes an event-opened run: caption cleared, back to waiting", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(runStarted(AGENT_A));
    const ops = mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: AGENT_A }]));
    expect(ops).toEqual([activityOf(AGENT_A, null), statusOf(AGENT_A, "waiting", false)]);
  });

  it("a snapshot NEVER clobbers awaitingInput on an agent stuck waiting for a human", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(issueUpdated({ issueId: "issue-1", assigneeAgentId: AGENT_A }));
    mapper.mapEvent(
      ev("issue.comment.created", {
        commentId: "c1",
        issueId: "issue-1",
        agentId: null,
        userId: "user-1",
        body: "?",
        isQuestion: true,
      }),
    );
    // Reconcile while stuck: the snapshot repairs nothing here — the
    // waiting+awaitingInput state is authoritative until the human replies.
    expect(mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: AGENT_A }]))).toEqual([]);
  });

  it("reset() drops all state: the next snapshot re-declares everyone (bounded-time self-heal)", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Dev Agent" }]));
    mapper.reset();
    const ops = mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Dev Agent" }]));
    expect(ops).toEqual([
      declareOf(AGENT_A, "Dev Agent"),
      statusOf(AGENT_A, "waiting", false),
    ]);
  });
});

// -- appearances ---------------------------------------------------------------

describe("PluginFeedMapper — appearance map", () => {
  const entryA = {
    agentId: AGENT_A,
    agentName: "Display A",
    characterId: "pixel-agents:char-3",
    palette: 3,
    hueShift: 45,
  };
  const assignOf = (agentId: string, characterId: string | null) => ({
    op: "assignAgentAppearance",
    key: agentId,
    characterId,
  });

  it("AS-IMPLEMENTED: setAppearances re-emits the upsert on every call — this path records no `declared` state to diff against", () => {
    const mapper = new PluginFeedMapper();
    const seatedDeclare = {
      op: "declareAgents",
      agents: [{ key: AGENT_A, name: "Display A", teamName: TEAM_A, palette: 3, hueShift: 45 }],
    };
    // First call: the seated upsert plus the first-class appearance
    // assignment (WS4-C) — the characterId is new state, so it emits once.
    expect(mapper.setAppearances([entryA])).toEqual([
      seatedDeclare,
      assignOf(AGENT_A, "pixel-agents:char-3"),
    ]);
    // Unlike the event path (which diffs against state.declared and stays
    // quiet when nothing changed), setAppearances never records `declared`,
    // so an unchanged repeat re-emits the same upsert. The assignment,
    // however, diffs against its own recorded state and stays quiet.
    // Harmless at the host (declares are idempotent upserts by key);
    // reported to the SAA-536 owner as an observation, pinned as-implemented.
    expect(mapper.setAppearances([entryA])).toEqual([seatedDeclare]);
    // Seat change: upsert with the new palette. The characterId is
    // unchanged, so no second assignment op rides the batch.
    expect(mapper.setAppearances([{ ...entryA, palette: 5 }])).toEqual([
      {
        op: "declareAgents",
        agents: [{ key: AGENT_A, name: "Display A", teamName: TEAM_A, palette: 5, hueShift: 45 }],
      },
    ]);
    // Character change (a picker write): a new assignment op, and only that
    // when the seat is unchanged.
    expect(mapper.setAppearances([{ ...entryA, characterId: "pixel-agents:char-7" }])).toEqual([
      seatedDeclare,
      assignOf(AGENT_A, "pixel-agents:char-7"),
    ]);
  });

  it("a name change through setAppearances re-declares with the new name", () => {
    const mapper = new PluginFeedMapper();
    mapper.setAppearances([entryA]);
    expect(mapper.setAppearances([{ ...entryA, agentName: "Renamed A" }])).toEqual([
      {
        op: "declareAgents",
        agents: [{ key: AGENT_A, name: "Renamed A", teamName: TEAM_A, palette: 3, hueShift: 45 }],
      },
    ]);
  });

  it("SAA-694: a catalog seat palette beyond the built-in sheet count is cycled into the built-in range (seat/fallback stays declarable everywhere)", () => {
    // The declaration's palette is the SEAT/fallback index into Pixel
    // Agents' built-in sheets; catalog indices >= 6 are rejected fail-closed
    // by the embedding host when no external asset grant widened the palette
    // (every docker deployment). char-7 (palette 7) falls back to its
    // built-in counterpart sheet 1; hueShift still rides for the WS4-A path.
    const mapper = new PluginFeedMapper();
    const ops = mapper.setAppearances([
      { ...entryA, characterId: "pixel-agents:char-7", palette: 7 },
    ]);
    expect(ops).toEqual([
      {
        op: "declareAgents",
        agents: [{ key: AGENT_A, name: "Display A", teamName: TEAM_A, palette: 1, hueShift: 45 }],
      },
      assignOf(AGENT_A, "pixel-agents:char-7"),
    ]);
  });

  it("the appearance map survives reset(): post-reset declarations keep name/seat", () => {
    const mapper = new PluginFeedMapper();
    mapper.setAppearances([entryA]);
    mapper.reset();
    const ops = mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Ignored Snapshot Name" }]));
    expect(ops).toEqual([
      {
        op: "declareAgents",
        agents: [{ key: AGENT_A, name: "Display A", teamName: TEAM_A, palette: 3, hueShift: 45 }],
      },
      statusOf(AGENT_A, "waiting", false),
    ]);
  });

  it("AS-IMPLEMENTED: run.started after a setAppearances-only declaration re-declares (with the appearance name and seat)", () => {
    const mapper = new PluginFeedMapper();
    mapper.setAppearances([entryA]);
    // state.declared was never recorded by setAppearances, so the event path
    // treats the agent as first-sight and declares again. Reported to the
    // SAA-536 owner as an observation; pinned as-implemented.
    const ops = mapper.mapEvent(runStarted(AGENT_A));
    expect(ops).toEqual([
      {
        op: "declareAgents",
        agents: [{ key: AGENT_A, name: "Display A", teamName: TEAM_A, palette: 3, hueShift: 45 }],
      },
      activityOf(AGENT_A, "Task: Paperclip work"),
      statusOf(AGENT_A, "active"),
      dialogLineOf("Display A started a run"),
    ]);
  });

  it("an offline removal drops the appearance too: a later re-declare carries no seat until setAppearances runs again", () => {
    const mapper = new PluginFeedMapper();
    mapper.setAppearances([entryA]);
    // The event-path declare (agent.created) is what records state.declared;
    // it resolves the agent's name from the appearance map.
    mapper.mapEvent(ev("agent.created", { agentId: AGENT_A }));

    expect(mapper.mapEvent(ev("agent.status_changed", { agentId: AGENT_A, status: "offline" }))).toEqual([
      { op: "removeAgents", keys: [AGENT_A] },
    ]);

    const ops = mapper.mapSnapshot(snapshotOf([{ id: AGENT_A, name: "Snapshot Name" }]));
    expect(ops).toEqual([
      declareOf(AGENT_A, "Snapshot Name"),
      statusOf(AGENT_A, "waiting", false),
    ]);
  });

  it("AS-IMPLEMENTED: an agent declared ONLY via setAppearances is not removed on offline status", () => {
    const mapper = new PluginFeedMapper();
    mapper.setAppearances([entryA]);
    // removeAgents is gated on state?.declared, which setAppearances never
    // records — so an agent whose only declaration rode setAppearances stays
    // in the office on offline. Exposure is bounded (the first event-path
    // declare or snapshot closes the window); reported to the SAA-536 owner,
    // pinned as-implemented.
    expect(mapper.mapEvent(ev("agent.status_changed", { agentId: AGENT_A, status: "offline" }))).toEqual([]);
  });
});

// -- tool activity ----------------------------------------------------------------

describe("PluginFeedMapper — tool activity captions", () => {
  it("mapToolActivity replaces the caption and declares an unknown agent first", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapToolActivity(AGENT_A, "Reading src/relay.ts")).toEqual([
      declareOf(AGENT_A, AGENT_A),
      activityOf(AGENT_A, "Reading src/relay.ts"),
    ]);
    expect(mapper.mapToolActivity(AGENT_A, "Editing src/relay.ts")).toEqual([
      activityOf(AGENT_A, "Editing src/relay.ts"),
    ]);
  });

  it("mapToolActivity never touches the run-lifecycle flag: the run's falling edge still clears the caption", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(runStarted(AGENT_A));
    expect(mapper.mapToolActivity(AGENT_A, "Running vitest")).toEqual([
      activityOf(AGENT_A, "Running vitest"),
    ]);
    expect(mapper.mapEvent(runEnded("agent.run.finished", AGENT_A))).toEqual([
      activityOf(AGENT_A, null),
      statusOf(AGENT_A, "waiting", false),
      dialogLineOf(`${AGENT_A} finished a run`),
    ]);
  });

  it("mapToolActivity emits no status operation", () => {
    const mapper = new PluginFeedMapper();
    const ops = mapper.mapToolActivity(AGENT_A, "Compiling");
    expect(ops.some((op) => op.op === "updateAgentStatus")).toBe(false);
  });
});

// -- quiet event kinds -------------------------------------------------------------

describe("PluginFeedMapper — events with no feed correspondence", () => {
  it.each([
    ["issue.document.created", { issueId: "issue-1", documentId: "doc-1", title: "Plan" }],
    ["issue.document.updated", { issueId: "issue-1", documentId: "doc-1" }],
    ["approval.decided", { approvalId: "ap-1", decision: "approved" }],
    ["agent.error_cleared", { agentId: AGENT_A }],
    ["budget.incident.opened", { incidentId: "in-1", scopeType: "company", scopeId: "c", metric: "m", status: "open" }],
    ["budget.incident.resolved", { incidentId: "in-1", scopeType: "company", scopeId: "c", metric: "m", status: "resolved" }],
    ["cost_event.created", { costEventId: "ce-1", costCents: 10 }],
    ["issue.assignment_wakeup_requested", { issueId: "issue-1", assigneeAgentId: null }],
  ])("%s with a null/absent target maps to no operations", (kind, payload) => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(ev(kind, payload))).toEqual([]);
  });

  it("an unknown event kind maps to nothing, never faked", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(ev("totally.bogus", {}))).toEqual([]);
  });

  it("issue.updated records the title for later captions but emits nothing itself (no reassignment blips)", () => {
    const mapper = new PluginFeedMapper();
    expect(mapper.mapEvent(issueUpdated({ issueId: "issue-1", title: "T", assigneeAgentId: AGENT_A }))).toEqual([]);
    expect(mapper.mapEvent(issueUpdated({ issueId: "issue-1", assigneeAgentId: null }))).toEqual([]);
  });
});
