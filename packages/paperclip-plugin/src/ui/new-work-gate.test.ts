/**
 * New-work gate tests (spec PAPERCLIP_PIXELS-1, §5.2, §18.1/§18.3, FR-7,
 * FR-8). The individual-agent reply path must fail closed: no reply if the
 * feedback is not bound to existing work, and no reply if the text looks like
 * new work.
 */

import {
  BRIDGE_MESSAGE_MAX_LENGTH,
  gateAgentReply,
  validateIntakeText,
  validateReplyText,
} from "./new-work-gate";
import { makeFeedback } from "./test-utils/fixtures";

describe("gateAgentReply — missing existing work context", () => {
  it("routes to company when existingWorkContext is false", () => {
    const feedback = makeFeedback({ existingWorkContext: false });
    expect(gateAgentReply(feedback, "Just a small question")).toEqual({
      kind: "route-to-company",
      reason: "missing-context",
    });
  });

  it("routes to company when bound-flag on but no issueId and no runId", () => {
    const feedback = makeFeedback({
      existingWorkContext: true,
      issueId: undefined,
      runId: undefined,
    });
    expect(gateAgentReply(feedback, "Merci beaucoup")).toEqual({
      kind: "route-to-company",
      reason: "missing-context",
    });
  });

  it("an issueId alone is enough binding", () => {
    const feedback = makeFeedback({ runId: undefined });
    expect(gateAgentReply(feedback, "Sounds good").kind).toBe("reply");
  });

  it("a runId alone is enough binding", () => {
    const feedback = makeFeedback({ issueId: undefined, runId: "run-9" });
    expect(gateAgentReply(feedback, "Sounds good").kind).toBe("reply");
  });
});

describe("gateAgentReply — new-work detection (§18.3)", () => {
  it("routes new-work-looking text to company intake", () => {
    const feedback = makeFeedback();
    expect(
      gateAgentReply(feedback, "Also build a brand new CRM"),
    ).toEqual({ kind: "route-to-company", reason: "new-work" });
  });

  it("routes any explicitly brand-new project text to company intake", () => {
    const feedback = makeFeedback();
    expect(gateAgentReply(feedback, "Please build a landing page too")).toEqual({
      kind: "route-to-company",
      reason: "new-work",
    });
  });

  it("allows an ordinary reply bound to existing work", () => {
    const feedback = makeFeedback({
      issueId: "iss-1",
      runId: "run-1",
    });
    expect(gateAgentReply(feedback, "Thanks — continuing on this")).toEqual({
      kind: "reply",
      issueId: "iss-1",
      runId: "run-1",
    });
  });
});

describe("validateIntakeText", () => {
  it("rejects empty/whitespace-only text", () => {
    expect(validateIntakeText("")).not.toBeNull();
    expect(validateIntakeText("   \n\t  ")).not.toBeNull();
  });

  it("rejects text over the maximum length", () => {
    const long = "x".repeat(BRIDGE_MESSAGE_MAX_LENGTH + 1);
    expect(validateIntakeText(long)).toMatch(/4000/);
  });

  it("accepts valid text", () => {
    expect(validateIntakeText("Build a new billing page")).toBeNull();
  });

  it("accepts text exactly at the boundary", () => {
    expect(validateIntakeText("x".repeat(BRIDGE_MESSAGE_MAX_LENGTH))).toBeNull();
  });
});

describe("validateReplyText", () => {
  it("rejects empty/whitespace-only text", () => {
    expect(validateReplyText("")).not.toBeNull();
    expect(validateReplyText("   ")).not.toBeNull();
  });

  it("rejects text over the maximum length", () => {
    const long = "y".repeat(BRIDGE_MESSAGE_MAX_LENGTH + 1);
    expect(validateReplyText(long)).toMatch(/4000/);
  });

  it("accepts valid text", () => {
    expect(validateReplyText("Ok, continuing in this issue")).toBeNull();
  });
});
