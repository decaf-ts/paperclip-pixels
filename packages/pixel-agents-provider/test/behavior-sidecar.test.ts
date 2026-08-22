import { BehaviorSidecar, EventMapper } from "../src";
import type { SidecarEntry } from "../src";
import {
  AGENT_A,
  AGENT_B,
  COMPANY_ID,
  PROJECT_X,
  PROJECT_Y,
  behaviorVector,
  budgetIncidentOpened,
  costEvent,
  feedback,
  runFinished,
  runStarted,
  windowedMetrics,
} from "./fixtures";

function ingestThrough(
  sidecar: BehaviorSidecar,
  mapper: EventMapper,
  ev: Parameters<EventMapper["mapEvent"]>[0],
): void {
  const { sidecar: entry } = mapper.mapEvent(ev);
  if (entry) sidecar.ingestEntry(entry);
}

describe("sidecar retains richer semantics (§31.4, §21.5)", () => {
  it("carries concurrency.activeRunCount, runs, and projectIds in the snapshot", () => {
    const sidecar = new BehaviorSidecar();
    const mapper = new EventMapper();

    ingestThrough(
      sidecar,
      mapper,
      runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X),
    );
    ingestThrough(
      sidecar,
      mapper,
      runStarted("e2", 10, "r2", AGENT_A, null, PROJECT_Y),
    );

    let agent = sidecar.snapshot().agents.find((a) => a.agentId === AGENT_A);
    expect(agent).toBeDefined();
    expect(agent!.concurrency.activeRunCount).toBe(2);
    expect(agent!.concurrency.runs.map((r) => r.runId).sort()).toEqual([
      "r1",
      "r2",
    ]);
    expect(agent!.projectIds.sort()).toEqual([PROJECT_X, PROJECT_Y]);

    // Finishing one run leaves the other active and decrements activeRunCount.
    ingestThrough(sidecar, mapper, runFinished("e3", 50, "r1", AGENT_A));
    agent = sidecar.snapshot().agents.find((a) => a.agentId === AGENT_A);
    expect(agent!.concurrency.activeRunCount).toBe(1);
    expect(agent!.concurrency.runs.map((r) => r.runId)).toEqual(["r2"]);
    expect(agent!.projectIds.sort()).toEqual([PROJECT_X, PROJECT_Y]);
  });

  it("reflects setBehavior / setMetrics / setFeedback in the snapshot", () => {
    const sidecar = new BehaviorSidecar();
    sidecar.setBehavior(AGENT_A, behaviorVector());
    sidecar.setMetrics(AGENT_A, [
      windowedMetrics({ window: "5m", runStarts: 3 }),
      windowedMetrics({ window: "30m", runStarts: 7 }),
    ]);
    sidecar.setFeedback(AGENT_A, [
      feedback("blocked", { summary: "needs decision" }),
    ]);

    const agent = sidecar.snapshot().agents.find((a) => a.agentId === AGENT_A);
    expect(agent).toBeDefined();
    expect(agent!.behavior?.schemaVersion).toBe(1);
    expect(agent!.behavior?.load.value).toBe(0.4);
    expect(agent!.metrics?.map((m) => m.window)).toEqual(["5m", "30m"]);
    expect(agent!.feedback?.map((f) => f.kind)).toEqual(["blocked"]);
  });

  it("bounds `recent` per agent to maxRecentPerAgent", () => {
    const sidecar = new BehaviorSidecar({ maxRecentPerAgent: 3 });
    const mapper = new EventMapper();
    for (let i = 0; i < 5; i += 1) {
      ingestThrough(
        sidecar,
        mapper,
        runStarted(`e${i}`, i, `r${i}`, AGENT_A, null, PROJECT_X),
      );
    }
    const agent = sidecar.snapshot().agents.find((a) => a.agentId === AGENT_A);
    expect(agent!.recent).toHaveLength(3);
    const recentRunIds = agent!.recent
      .filter((e) => e.kind === "run-activity")
      .map((e) => (e as { runId: string }).runId);
    expect(recentRunIds).toEqual(["r2", "r3", "r4"]);
  });

  it("keeps agents independent (one agent's activity does not leak into another)", () => {
    const sidecar = new BehaviorSidecar();
    const mapper = new EventMapper();
    ingestThrough(sidecar, mapper, runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X));
    ingestThrough(sidecar, mapper, runStarted("e2", 10, "r-bob", AGENT_B, null, PROJECT_Y));

    const snap = sidecar.snapshot();
    const a = snap.agents.find((x) => x.agentId === AGENT_A)!;
    const b = snap.agents.find((x) => x.agentId === AGENT_B)!;
    expect(a.concurrency.runs).toHaveLength(1);
    expect(a.concurrency.runs[0].runId).toBe("r1");
    expect(a.projectIds).toEqual([PROJECT_X]);
    expect(b.concurrency.runs.map((r) => r.runId)).toEqual(["r-bob"]);
    expect(b.projectIds).toEqual([PROJECT_Y]);
  });

  it("budget entries carry no per-agent view; cost entries attributed to an agent stay in that agent's recent", () => {
    const sidecar = new BehaviorSidecar();
    const mapper = new EventMapper();
    const b = mapper.mapEvent(budgetIncidentOpened("e1", 0, AGENT_A));
    sidecar.ingestEntry(b.sidecar as SidecarEntry);

    let snap = sidecar.snapshot();
    expect(snap.companyId).toBe(COMPANY_ID);
    expect(snap.agents).toHaveLength(0);

    const c = mapper.mapEvent(costEvent("e2", 10, 42, AGENT_A));
    sidecar.ingestEntry(c.sidecar as SidecarEntry);
    snap = sidecar.snapshot();
    expect(snap.companyId).toBe(COMPANY_ID);
    const agent = snap.agents.find((a) => a.agentId === AGENT_A);
    expect(agent).toBeDefined();
    // Cost is retained as a recent entry only; it never fabricates concurrency.
    expect(agent!.concurrency.activeRunCount).toBe(0);
    expect(agent!.recent.map((e) => e.kind)).toEqual(["cost"]);
  });
});

describe("sidecar staleness and schema version (§31.4, §30)", () => {
  it("snapshot always carries schemaVersion 1 and serializes the stale triplet", () => {
    const sidecar = new BehaviorSidecar();
    sidecar.ingestEntry(
      new EventMapper().mapEvent(runStarted("e1", 0, "r1"))
        .sidecar as SidecarEntry,
    );
    let snap = sidecar.snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.stale).toBe(false);
    expect(snap.staleReason).toBeUndefined();
    expect(snap.staleSince).toBeUndefined();
    expect(snap.agents).toHaveLength(1);

    sidecar.markStale("bridge down", new Date(5).toISOString());
    snap = sidecar.snapshot();
    expect(snap.schemaVersion).toBe(1);
    expect(snap.stale).toBe(true);
    expect(snap.staleReason).toBe("bridge down");
    expect(snap.staleSince).toBe(new Date(5).toISOString());
  });

  it("markStale/clearStale toggle stale and clear the reason/since fields", () => {
    const sidecar = new BehaviorSidecar();
    expect(sidecar.isStale()).toBe(false);

    sidecar.markStale("reconnecting");
    expect(sidecar.isStale()).toBe(true);
    let snap = sidecar.snapshot();
    expect(snap.stale).toBe(true);
    expect(snap.staleReason).toBe("reconnecting");
    expect(typeof snap.staleSince).toBe("string");

    sidecar.clearStale();
    expect(sidecar.isStale()).toBe(false);
    snap = sidecar.snapshot();
    expect(snap.stale).toBe(false);
    expect(snap.staleReason).toBeUndefined();
    expect(snap.staleSince).toBeUndefined();
  });

  it("clear() resets agents and staleness together", () => {
    const sidecar = new BehaviorSidecar();
    sidecar.setBehavior(AGENT_A, behaviorVector());
    sidecar.markStale("x");
    sidecar.clear();
    const snap = sidecar.snapshot();
    expect(snap.agents).toHaveLength(0);
    expect(snap.stale).toBe(false);
    expect(snap.staleReason).toBeUndefined();
  });
});
