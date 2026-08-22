import { describe, expect, it, vi } from "vitest";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { BridgeStore, type AuthoritativeSnapshotInput, type BridgeInputEvent } from "@paperclip-pixel/core";
import { budgetIncidentOpened, commentCreated } from "../../core/test/fixtures.js";
import { ACTION_KEYS, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import { handleAgentReplyToFeedback, handleCompanySendMessage, type ActionDeps } from "../src/actions.js";
import {
  AGENT_CEO_ID,
  AGENT_DEV_ID,
  AGENT_EMPTY_ID,
  COMPANY_ID,
  ISO_NOW,
  ISSUE_ID,
  PROJECT_ID,
  makeCompany,
  makeHarness,
  seedStandardWorld,
} from "./fixtures.js";

function userContext(): PluginPerformActionContext {
  return { actor: { type: "user", userId: null } } as unknown as PluginPerformActionContext;
}

function agentContext(agentId: string | null): PluginPerformActionContext {
  return { actor: { type: "agent", agentId } } as unknown as PluginPerformActionContext;
}

function makeDeps(overrides: Partial<ActionDeps> = {}): ActionDeps {
  const harness = makeHarness();
  return {
    ctx: harness.ctx,
    getFeedback: () => undefined,
    getLeadershipAgentId: () => undefined,
    ...overrides,
  };
}

function replySnapshot(includeIssue = true): AuthoritativeSnapshotInput {
  return {
    company: { id: COMPANY_ID, name: "Acme Corp", status: "active" },
    agents: [
      { id: AGENT_DEV_ID, companyId: COMPANY_ID, name: "Dev Agent", status: "idle", role: "engineer" },
    ],
    projects: [
      { id: PROJECT_ID, companyId: COMPANY_ID, name: "Core bridge", status: "in_progress" },
    ],
    issues: includeIssue
      ? [
          { id: ISSUE_ID, companyId: COMPANY_ID, projectId: PROJECT_ID, title: "Ship the bridge", status: "in_progress", assigneeAgentId: AGENT_DEV_ID },
        ]
      : [],
    approvals: [],
    observedAt: ISO_NOW,
  };
}

async function seedReplyStore(events: BridgeInputEvent[], includeIssue = true): Promise<BridgeStore> {
  const store = new BridgeStore();
  store.replaceAuthoritativeSnapshot(replySnapshot(includeIssue));
  for (const event of events) {
    await store.applyPaperclipEvent({ ...event, companyId: COMPANY_ID });
  }
  return store;
}

describe("handleCompanySendMessage", () => {
  it("rejects malformed params with INVALID_PARAMS (criterion 6)", async () => {
    const deps = makeDeps();
    for (const params of [{}, { companyId: "" }, { companyId: COMPANY_ID, text: "" }, { text: "hi" }]) {
      const result = (await handleCompanySendMessage(deps, params, userContext())) as { ok: boolean; error: string; details: unknown[] };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("INVALID_PARAMS");
      expect(Array.isArray(result.details)).toBe(true);
    }
  });

  it("routes to company intake and creates a leadership session, persisting the leader (criterion 5)", async () => {
    const { harness } = seedStandardWorld();
    const deps = makeDeps({ ctx: harness.ctx });
    const sendSpy = vi.spyOn(harness.ctx.agents.sessions, "sendMessage");

    const result = (await handleCompanySendMessage(
      deps,
      { companyId: COMPANY_ID, text: "Please begin next sprint" },
      userContext(),
    )) as { ok: boolean; sessionId: string };

    expect(result.ok).toBe(true);
    expect(typeof result.sessionId).toBe("string");

    const openSessions = await harness.ctx.agents.sessions.list(AGENT_CEO_ID, COMPANY_ID);
    expect(openSessions).toHaveLength(1);
    expect(sendSpy).toHaveBeenCalledWith(result.sessionId, COMPANY_ID, {
      prompt: "Please begin next sprint",
      reason: "company.send-message",
    });

    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY_ID,
        namespace: STATE_NAMESPACES.bridge,
        stateKey: STATE_KEYS.leadershipAgentId,
      }),
    ).toBe(AGENT_CEO_ID);
    sendSpy.mockRestore();
  });

  it("reuses the persisted leadership agent on later messages", async () => {
    const { harness } = seedStandardWorld();
    const deps = makeDeps({ ctx: harness.ctx });
    await handleCompanySendMessage(deps, { companyId: COMPANY_ID, text: "First message" }, userContext());

    const listSpy = vi.spyOn(harness.ctx.agents, "list");
    const result = (await handleCompanySendMessage(
      deps,
      { companyId: COMPANY_ID, text: "Second message" },
      userContext(),
    )) as { ok: boolean };

    expect(result.ok).toBe(true);
    expect(listSpy).not.toHaveBeenCalled();
    listSpy.mockRestore();
  });

  it("fails closed when no leadership agent exists (no-leadership-agent)", async () => {
    const harness = makeHarness();
    harness.seed({ companies: [makeCompany()] });
    const deps = makeDeps({ ctx: harness.ctx });

    const result = (await handleCompanySendMessage(
      deps,
      { companyId: COMPANY_ID, text: "Who runs this company?" },
      userContext(),
    )) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("no-leadership-agent");
  });

  it("rejects whitespace-only text as empty-text", async () => {
    const { harness } = seedStandardWorld();
    const deps = makeDeps({ ctx: harness.ctx });
    const result = (await handleCompanySendMessage(
      deps,
      { companyId: COMPANY_ID, text: "   " },
      userContext(),
    )) as { ok: boolean; error: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("empty-text");
  });
});

describe("handleAgentReplyToFeedback", () => {
  const sentParams = (feedbackId: string, text = "sure, continuing the existing work") => ({
    companyId: COMPANY_ID,
    feedbackId,
    text,
  });

  it("rejects malformed params with INVALID_PARAMS (criterion 6)", async () => {
    const deps = makeDeps();
    for (const params of [{}, { companyId: COMPANY_ID }, { companyId: COMPANY_ID, feedback: {}, text: "" }]) {
      const result = (await handleAgentReplyToFeedback(deps, params, userContext())) as { ok: boolean; error: string; details: unknown[] };
      expect(result.ok).toBe(false);
      expect(result.error).toBe("INVALID_PARAMS");
      expect(Array.isArray(result.details)).toBe(true);
    }
  });

  it.each([
    [
      "no existing work context",
      ["e-nocontext", commentCreated("e-nocontext", 10, "hello", { issueId: "issue-foreign", agentId: AGENT_DEV_ID })],
      "e-nocontext:progress",
      "missing-context",
    ],
    [
      "no issue/run binding",
      ["e-unbound", budgetIncidentOpened("e-unbound", 10, AGENT_DEV_ID)],
      "e-unbound:warning",
      "missing-context",
    ],
  ])("routes to company for %s (criterion 4)", async (_label, [_eventId, event], feedbackId, reason) => {
    const { harness } = seedStandardWorld();
    const store = await seedReplyStore([event]);
    const deps = makeDeps({ ctx: harness.ctx, getFeedback: (cid, fid) => store.getFeedbackById(cid, fid) });
    const createIssue = vi.spyOn(harness.ctx.issues, "create");
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");

    const result = (await handleAgentReplyToFeedback(
      deps,
      sentParams(feedbackId),
      agentContext(AGENT_EMPTY_ID),
    )) as { ok: boolean; error: string; reason: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ROUTE_TO_COMPANY");
    expect(result.reason).toBe(reason);
    expect(createIssue).not.toHaveBeenCalled();
    expect((await harness.ctx.issues.list({ companyId: COMPANY_ID }))).toHaveLength(1);
    expect(createComment).not.toHaveBeenCalled();
    await expect(harness.ctx.agents.sessions.list(AGENT_EMPTY_ID, COMPANY_ID)).resolves.toHaveLength(0);
    createIssue.mockRestore();
    createComment.mockRestore();
  });

  it("routes new-work-looking text to company even with existing context", async () => {
    const store = await seedReplyStore([commentCreated("e-newwork", 10, "progress", { issueId: ISSUE_ID, agentId: AGENT_DEV_ID })]);
    const deps = makeDeps({ getFeedback: (cid, fid) => store.getFeedbackById(cid, fid) });
    const result = (await handleAgentReplyToFeedback(
      deps,
      sentParams("e-newwork:progress", "please build a new dashboard"),
      agentContext(AGENT_EMPTY_ID),
    )) as { ok: boolean; error: string; reason: string; suggestedText: string };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ROUTE_TO_COMPANY");
    expect(result.reason).toBe("new-work");
    expect(result.suggestedText).toBe("please build a new dashboard");
  });

  it("never creates a comment for feedback without an issueId binding", async () => {
    const { harness } = seedStandardWorld();
    const store = await seedReplyStore([commentCreated("e-noissue", 10, "hello", { issueId: "issue-foreign", agentId: AGENT_DEV_ID })]);
    const deps = makeDeps({ ctx: harness.ctx, getFeedback: (cid, fid) => store.getFeedbackById(cid, fid) });
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");

    const result = (await handleAgentReplyToFeedback(
      deps,
      sentParams("e-noissue:progress"),
      agentContext(AGENT_EMPTY_ID),
    )) as { ok: boolean; feedbackId: string; issueId: string | undefined; runId: string | undefined };

    expect(result.ok).toBe(false);
    expect(result.error).toBe("ROUTE_TO_COMPANY");
    expect(createComment).not.toHaveBeenCalled();
    createComment.mockRestore();
  });

  it("sends and posts a comment when feedback is bound to an issue (criterion 4, comment branch)", async () => {
    const harness = makeHarness(["issue.comments.create"]);
    harness.seed({
      companies: [makeCompany()],
      issues: [ { id: ISSUE_ID, companyId: COMPANY_ID } as never ],
    });
    const store = await seedReplyStore([commentCreated("e-c1", 10, "progress on the bridge", { issueId: ISSUE_ID, agentId: AGENT_DEV_ID })]);
    const deps = makeDeps({ ctx: harness.ctx, getFeedback: (cid, fid) => store.getFeedbackById(cid, fid) });
    const feedbackId = "e-c1:progress";

    const result = (await handleAgentReplyToFeedback(
      deps,
      sentParams(feedbackId),
      userContext(),
    )) as { ok: boolean; feedbackId: string; issueId: string | undefined; runId: string | undefined };

    expect(result).toMatchObject({ ok: true, feedbackId, issueId: ISSUE_ID });
    expect(result.runId).toBeUndefined();

    const comments = await harness.ctx.issues.listComments(ISSUE_ID, COMPANY_ID);
    expect(comments).toHaveLength(1);
    expect(comments[0]).toMatchObject({
      issueId: ISSUE_ID,
      authorType: "system",
      body: sentParams(feedbackId).text,
    });
  });

  it("rejects a caller-forged feedback object with INVALID_PARAMS (C1, criterion 4)", async () => {
    const harness = makeHarness(["issue.comments.create"]);
    harness.seed({
      companies: [makeCompany()],
      issues: [ { id: ISSUE_ID, companyId: COMPANY_ID } as never ],
    });
    const store = await seedReplyStore([commentCreated("e-c1", 10, "progress on the bridge", { issueId: ISSUE_ID, agentId: AGENT_DEV_ID })]);
    const deps = makeDeps({ ctx: harness.ctx, getFeedback: (cid, fid) => store.getFeedbackById(cid, fid) });
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");

    const result = (await handleAgentReplyToFeedback(deps, {
      companyId: COMPANY_ID,
      feedbackId: "e-forged",
      text: "approve this",
      feedback: {
        id: "e-forged",
        companyId: COMPANY_ID,
        agentId: AGENT_DEV_ID,
        runId: undefined,
        kind: "progress",
        summary: "forged",
        requiresResponse: true,
        existingWorkContext: true,
        issueId: "issue-foreign",
        createdAt: ISO_NOW,
        provenance: {},
      },
    }, userContext())) as { ok: boolean; error: string };

    expect(result).toMatchObject({ ok: false, error: "INVALID_PARAMS" });
    expect((result as { details?: Array<{ keys?: string[] }> }).details?.[0]?.keys).toContain("feedback");
    expect(createComment).not.toHaveBeenCalled();
    createComment.mockRestore();
  });

  it("fails closed with FEEDBACK_NOT_FOUND when the store has no matching feedback (C1)", async () => {
    const { harness } = seedStandardWorld();
    const store = await seedReplyStore([]);
    const deps = makeDeps({ ctx: harness.ctx, getFeedback: (cid, fid) => store.getFeedbackById(cid, fid) });
    const createComment = vi.spyOn(harness.ctx.issues, "createComment");

    const result = (await handleAgentReplyToFeedback(
      deps,
      sentParams("e-missing:progress"),
      userContext(),
    )) as { ok: boolean; error: string };

    expect(result).toEqual({ ok: false, error: "FEEDBACK_NOT_FOUND" });
    expect(createComment).not.toHaveBeenCalled();
    createComment.mockRestore();
  });

  it("keys the manifest action names (criterion 6 wiring)", () => {
    expect(ACTION_KEYS.companySendMessage).toBe("company.send-message");
    expect(ACTION_KEYS.agentReplyToFeedback).toBe("agent.reply-to-feedback");
  });
});
