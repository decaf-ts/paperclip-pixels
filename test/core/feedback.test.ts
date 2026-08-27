import { BridgeStore } from "../../src/core/index.js";
import {
  commentCreated,
  approvalCreated,
  approvalDecided,
  issueUpdated,
  runFailed,
  runFinished,
  runStarted,
  budgetIncidentOpened,
  snapshot,
  AGENT_A,
  ISSUE_1,
} from "./fixtures";

describe("feedback classification (§9.4, §31.1)", () => {
  it("classifies a question comment as a question requiring response", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e0", 0, "r1"));

    await store.applyPaperclipEvent(
      commentCreated("e1", 10, "Need clarification on staging credentials", { isQuestion: true }),
    );

    const fb = store.getFeedback(ISSUE_1);
    expect(fb.length).toBeGreaterThan(0);
    const q = fb.find((f) => f.kind === "question");
    expect(q).toBeDefined();
    expect(q?.requiresResponse).toBe(true);
    expect(q?.existingWorkContext).toBe(true);
    expect(q?.issueId).toBe(ISSUE_1);
  });

  it("sets existingWorkContext false when feedback is not bound to known work", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    // Comment on an issue that is NOT in the derived state.
    await store.applyPaperclipEvent(
      commentCreated("e1", 10, "hello", { issueId: "unknown-issue", agentId: AGENT_A, isQuestion: true }),
    );

    const fb = store.getFeedback("unknown-issue");
    expect(fb.length).toBe(1);
    expect(fb[0].existingWorkContext).toBe(false);
  });

  it("classifies approval.created as approval feedback", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e0", 0, "r1"));

    await store.applyPaperclipEvent(approvalCreated("e1", 10, "ap1"));

    const fb = store.getFeedback(AGENT_A).find((f) => f.kind === "approval");
    expect(fb).toBeDefined();
    expect(fb?.requiresResponse).toBe(true);
    expect(fb?.existingWorkContext).toBe(true);
  });

  it("classifies a blocked issue as blocked feedback", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());

    await store.applyPaperclipEvent(issueUpdated("e1", 10, ISSUE_1, "blocked", { blocked: true }));

    const fb = store.getFeedback(AGENT_A).find((f) => f.kind === "blocked");
    expect(fb).toBeDefined();
    expect(fb?.requiresResponse).toBe(true);
  });

  it("classifies run.failed as failure feedback", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e0", 0, "r1"));
    await store.applyPaperclipEvent(runFailed("e1", 10, "r1"));

    const fb = store.getFeedback(AGENT_A).find((f) => f.kind === "failure");
    expect(fb).toBeDefined();
    expect(fb?.existingWorkContext).toBe(true);
  });

  it("classifies run.finished as result feedback", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(runStarted("e0", 0, "r1"));
    await store.applyPaperclipEvent(runFinished("e1", 10, "r1"));

    const fb = store.getFeedback(AGENT_A).find((f) => f.kind === "result");
    expect(fb).toBeDefined();
  });

  it("classifies budget.incident.opened as warning feedback", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(budgetIncidentOpened("e1", 10));

    const fb = store.getFeedback(AGENT_A).find((f) => f.kind === "warning");
    expect(fb).toBeDefined();
  });

  it("marks approval feedback resolved after a decision event", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(approvalCreated("e1", 10, "ap1"));
    await store.applyPaperclipEvent(approvalDecided("e2", 20, "ap1", "approved"));

    const ap = store.getRawSnapshot().approvals.find((a) => a.id === "ap1");
    expect(ap?.status).toBe("approved");
  });

  it("every feedback carries provenance with an eventId", async () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    await store.applyPaperclipEvent(
      commentCreated("e1", 10, "progress update"),
    );
    const fb = store.getFeedback(ISSUE_1)[0];
    expect(fb.provenance.eventIds).toContain("e1");
  });
});
