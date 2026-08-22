import { BridgeStore } from "../src";
import {
  runStarted,
  runFinished,
  snapshot,
  AGENT_A,
  BASE_MS,
  PROJECT_X,
  PROJECT_Y,
  PROJECT_Z,
} from "./fixtures";

const NOW = BASE_MS + 5 * 60 * 1000;

describe("multi-project concurrency (§10, §31.1, policy 8)", () => {
  it("preserves multiple concurrent runs without imposing a clone-per-run rule", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X));
    await store.applyPaperclipEvent(runStarted("e2", 10, "r2", AGENT_A, null, PROJECT_Y));
    await store.applyPaperclipEvent(runStarted("e3", 20, "r3", AGENT_A, null, PROJECT_X));

    const raw = store.getAgentProjection(AGENT_A);
    expect(raw?.activeRunCount).toBe(3);
    expect(raw?.activeRuns.map((r) => r.runId).sort()).toEqual(["r1", "r2", "r3"]);
    // No clone/position fields exist on the projection.
    expect(raw?.activeRuns.every((r) => !("x" in r) && !("y" in r))).toBe(true);
  });

  it("aggregates distinct projects across concurrent runs", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X));
    await store.applyPaperclipEvent(runStarted("e2", 10, "r2", AGENT_A, null, PROJECT_Y));

    const m = store.getWindowedMetrics(AGENT_A, "5m", NOW);
    expect(m.distinctProjects).toBe(2);
    expect(m.meanConcurrentRuns).toBeGreaterThan(1);
  });

  it("tracks concurrent runs across three distinct projects (§31.3 fixture)", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X));
    await store.applyPaperclipEvent(runStarted("e2", 10, "r2", AGENT_A, null, PROJECT_Y));
    await store.applyPaperclipEvent(runStarted("e3", 20, "r3", AGENT_A, null, PROJECT_Z));

    const raw = store.getAgentProjection(AGENT_A);
    expect(raw?.activeRunCount).toBe(3);
    expect(raw?.activeRuns.map((r) => r.runId).sort()).toEqual(["r1", "r2", "r3"]);
    expect(raw?.projectIds.sort()).toEqual([PROJECT_X, PROJECT_Y, PROJECT_Z]);

    const m = store.getWindowedMetrics(AGENT_A, "5m", NOW);
    expect(m.distinctProjects).toBe(3);

    const v = store.getBehaviorVector(AGENT_A, NOW);
    expect(v.projectSpread.value).toBeGreaterThan(0);
  });

  it("finishing one run leaves the others active", async () => {    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X));
    await store.applyPaperclipEvent(runStarted("e2", 10, "r2", AGENT_A, null, PROJECT_Y));
    await store.applyPaperclipEvent(runFinished("e3", 50, "r1"));

    const raw = store.getAgentProjection(AGENT_A);
    expect(raw?.activeRunCount).toBe(1);
    expect(raw?.activeRuns[0].runId).toBe("r2");
  });

  it("projectSpread increases with breadth of project involvement", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(runStarted("e1", 0, "r1", AGENT_A, null, PROJECT_X));
    await store.applyPaperclipEvent(runStarted("e2", 10, "r2", AGENT_A, null, PROJECT_Y));

    const v = store.getBehaviorVector(AGENT_A, NOW);
    expect(v.projectSpread.value).toBeGreaterThan(0);
  });
});
