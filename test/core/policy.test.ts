import {
  BridgeStore,
  evaluateAgentReply,
  assertExistingWorkContext,
  validateIntake,
  looksLikeNewWork,
  type AgentFeedback,
} from "../../src/core/index.js";
import { snapshot, AGENT_A, COMPANY_ID } from "./fixtures";

function feedback(overrides: Partial<AgentFeedback> = {}): AgentFeedback {
  return {
    id: "fb-1",
    companyId: COMPANY_ID,
    agentId: AGENT_A,
    issueId: "issue-1",
    kind: "question",
    summary: "Need clarification",
    requiresResponse: true,
    existingWorkContext: true,
    createdAt: "2026-01-01T00:00:00.000Z",
    provenance: { eventIds: ["e1"] },
    ...overrides,
  };
}

describe("new-work action gating (§5.2, §18, §31.5 policy tests)", () => {
  it("policy 1: an individual-agent reply cannot create a Paperclip issue", () => {
    // The reply evaluator is pure and holds no issues.create capability.
    const result = evaluateAgentReply({
      companyId: COMPANY_ID,
      feedbackId: "fb-1",
      text: "Use the staging credential already approved for this issue.",
      feedback: feedback(),
    });
    expect(result.kind).toBe("sent");
    // There is no code path that creates an issue here.
    expect(result).not.toHaveProperty("issueCreated");
  });

  it("policy 1b: a new-work-looking reply returns route-to-company", () => {
    const result = evaluateAgentReply({
      companyId: COMPANY_ID,
      feedbackId: "fb-1",
      text: "Great. Also redesign the entire billing dashboard.",
      feedback: feedback(),
    });
    expect(result.kind).toBe("route-to-company");
    if (result.kind === "route-to-company") {
      expect(result.reason).toBe("new-work");
      expect(result.suggestedText).toContain("billing");
    }
  });

  it("policy 3: a reply without existing work context fails closed", () => {
    const result = evaluateAgentReply({
      companyId: COMPANY_ID,
      feedbackId: "fb-1",
      text: "thanks",
      feedback: feedback({ existingWorkContext: false, issueId: undefined, runId: undefined }),
    });
    expect(result.kind).toBe("route-to-company");
    if (result.kind === "route-to-company") expect(result.reason).toBe("missing-context");
  });

  it("policy 3b: feedback bound to existing context but no issue/run id fails closed", () => {
    const result = evaluateAgentReply({
      companyId: COMPANY_ID,
      feedbackId: "fb-1",
      text: "thanks",
      feedback: feedback({ issueId: undefined, runId: undefined }),
    });
    expect(result.kind).toBe("route-to-company");
  });

  it("assertExistingWorkContext throws for missing context", () => {
    expect(() => assertExistingWorkContext(feedback({ existingWorkContext: false }))).toThrow();
    expect(() =>
      assertExistingWorkContext(feedback({ existingWorkContext: true, issueId: undefined, runId: undefined })),
    ).toThrow();
  });

  it("policy 2: new-work creation exists only in company/intake action paths", () => {
    const accepted = validateIntake(
      { companyId: COMPANY_ID, text: "Build a brand new CRM" },
      { leadershipAgentId: "ceo-1" },
    );
    expect(accepted.kind).toBe("accepted");
    // Intake is the unrestricted new-work path.
    if (accepted.kind === "accepted") expect(accepted.leadershipAgentId).toBe("ceo-1");
  });

  it("intake rejects empty text and missing leadership agent", () => {
    expect(validateIntake({ companyId: COMPANY_ID, text: "  " }, { leadershipAgentId: "ceo-1" }).kind).toBe("rejected");
    expect(validateIntake({ companyId: COMPANY_ID, text: "hi" }, { leadershipAgentId: "" }).kind).toBe("rejected");
  });

  it("the classifier is advisory only and never the sole boundary", () => {
    // looksLikeNewWork may suggest, but evaluateAgentReply is the guarantee.
    expect(looksLikeNewWork("also build a dashboard")).toBe(true);
    expect(looksLikeNewWork("got it, thanks")).toBe(false);
  });

  it("the BridgeStore does not expose any issue-creation API", () => {
    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot());
    const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(store)).concat(
      Object.getOwnPropertyNames(BridgeStore.prototype),
    );
    const createLike = methods.filter((m) => /create.*issue|issue.*create/i.test(m));
    expect(createLike).toHaveLength(0);
  });
});
