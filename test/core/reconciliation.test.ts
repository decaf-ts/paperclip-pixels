import { BridgeStore } from "../../src/core/index.js";
import {
  runStarted,
  snapshot,
  AGENT_A,
  AGENT_B,
  ISSUE_1,
  PROJECT_X,
  PROJECT_Y,
} from "./fixtures";

describe("reconciliation repairs drift (§12.4, §31.5 policy 7)", () => {
  it("repairs an agent status that drifted from authoritative state", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    // Simulate drift: authoritative says agent B is "paused".
    const auth = snapshot({
      agents: [
        { id: AGENT_A, companyId: snapshot().company.id, name: "Alice", status: "idle" },
        { id: AGENT_B, companyId: snapshot().company.id, name: "Bob", status: "paused" },
      ],
    });
    const result = store.reconcile(auth);
    expect(result.changedEntities).toContain(`agent:${AGENT_B}`);
    expect(store.getAgentProjection(AGENT_B)?.status).toBe("paused");
  });

  it("removes entities no longer present in the authoritative snapshot", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    expect(store.getAgentProjection(AGENT_B)).toBeDefined();

    const auth = snapshot({
      agents: [{ id: AGENT_A, companyId: snapshot().company.id, name: "Alice", status: "idle" }],
      issues: [],
    });
    const result = store.reconcile(auth);
    expect(result.changedEntities.some((e) => e.startsWith("agent:agent-b"))).toBe(true);
    expect(store.getAgentProjection(AGENT_B)).toBeUndefined();
  });

  it("repairs active-run drift against the authoritative run set", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));

    // Authoritative snapshot says r1 is gone (it finished upstream).
    const auth = snapshot({
      agents: [
        {
          id: AGENT_A,
          companyId: snapshot().company.id,
          name: "Alice",
          status: "idle",
          activeRuns: [],
        },
      ],
    });
    store.reconcile(auth);
    expect(store.getAgentProjection(AGENT_A)?.activeRunCount).toBe(0);
  });

  it("repairs issue status drift", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    const auth = snapshot({
      issues: [
        {
          id: ISSUE_1,
          companyId: snapshot().company.id,
          projectId: PROJECT_X,
          title: "Issue 1",
          status: "done",
          assigneeAgentId: AGENT_A,
          blocked: true,
        },
      ],
    });
    const result = store.reconcile(auth);
    expect(result.changedEntities).toContain(`issue:${ISSUE_1}`);
    expect(store.getRawSnapshot().issues[0].status).toBe("done");
    expect(store.getRawSnapshot().issues[0].blocked).toBe(true);
  });

  it("returns no changed entities when state already matches", () => {
    const store = new BridgeStore();
    const snap = snapshot();
    store.replaceAuthoritativeSnapshot(snap);
    const result = store.reconcile(snap);
    expect(result.changedEntities).toHaveLength(0);
  });

  it("drops a project removed upstream", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    const auth = snapshot({
      projects: [{ id: PROJECT_X, companyId: snapshot().company.id, name: "Project X", status: "active" }],
    });
    const result = store.reconcile(auth);
    expect(result.changedEntities.some((e) => e.includes(`project:${PROJECT_Y}`))).toBe(true);
  });
});
