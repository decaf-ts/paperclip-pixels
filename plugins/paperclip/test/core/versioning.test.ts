import {
  BridgeStore,
  SCHEMA_VERSION,
  type BridgeUiEvent,
} from "../../src/core/index.js";
import { runStarted, snapshot, AGENT_A, BASE_MS } from "./fixtures";

const NOW = BASE_MS + 60_000;

describe("versioning (§33.1, NFR-6)", () => {
  it("exports schemaVersion 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
  });

  it("raw snapshot carries schemaVersion 1", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    expect(store.getRawSnapshot().schemaVersion).toBe(1);
  });

  it("company summary carries schemaVersion 1", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    expect(store.getCompanySummary().schemaVersion).toBe(1);
  });

  it("behavior vector carries schemaVersion 1", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    expect(store.getBehaviorVector(AGENT_A, NOW).schemaVersion).toBe(1);
  });

  it("behavior changed events carry schemaVersion 1", async () => {
    const store = new BridgeStore({ minPublishMs: 0, maxPublishMs: 0 });
    store.replaceAuthoritativeSnapshot(snapshot());
    const events: BridgeUiEvent[] = [];
    store.on("agentBehaviorChanged", (e) => events.push(e));
    await store.applyPaperclipEvent(runStarted("e1", 0, "r1"));
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) expect(e.schemaVersion).toBe(1);
  });
});
