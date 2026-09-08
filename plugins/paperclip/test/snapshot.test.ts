import { describe, expect, it, vi } from "vitest";
import { BridgeStore } from "../src/core/index.js";
import { bootstrapAllCompanies, bootstrapSnapshot } from "../src/snapshot.js";
import {
  AGENT_CEO_ID,
  AGENT_DEV_ID,
  APPROVAL_ID,
  COMPANY_2_ID,
  COMPANY_ID,
  ISSUE_ID,
  PROJECT_ID,
  makeCompany,
  makeIssue,
  seedStandardWorld,
} from "./fixtures.js";

describe("bootstrapSnapshot", () => {
  it("loads company, agents, projects, issues, and approvals into a snapshot (criterion 1)", async () => {
    const { harness } = seedStandardWorld({ includeApproval: true });
    const result = await bootstrapSnapshot(harness.ctx, COMPANY_ID);

    expect(result.companyId).toBe(COMPANY_ID);
    expect(result.activeRuns).toEqual([]);

    const { snapshot } = result;
    expect(snapshot.company).toEqual({
      id: COMPANY_ID,
      name: "Acme Corp",
      description: "Fixture company for bridge tests",
      status: "active",
    });
    expect(snapshot.agents).toHaveLength(2);
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: AGENT_CEO_ID, role: "ceo", title: null, activeRuns: [] }),
        expect.objectContaining({ id: AGENT_DEV_ID, companyId: COMPANY_ID }),
      ]),
    );
    expect(snapshot.projects).toEqual([
      expect.objectContaining({ id: PROJECT_ID, leadAgentId: AGENT_CEO_ID, status: "in_progress" }),
    ]);
    expect(snapshot.issues).toEqual([
      expect.objectContaining({ id: ISSUE_ID, status: "todo", blocked: false, blockedByIssueIds: [] }),
    ]);
    expect(snapshot.approvals).toEqual([
      expect.objectContaining({
        id: APPROVAL_ID,
        issueId: null,
        agentId: AGENT_DEV_ID,
        requestedByAgentId: AGENT_DEV_ID,
        status: "pending",
        decidedAt: null,
      }),
    ]);
    expect(typeof snapshot.observedAt).toBe("string");
    expect(new Date(snapshot.observedAt).getTime()).not.toBeNaN();
  });

  it("derives blocked from status or blocked-by relations", async () => {
    const { harness } = seedStandardWorld();
    const blockedByStatus = makeIssue({ id: "issue-status-blocked", status: "blocked" });
    const blockedByRelation = makeIssue({ id: "issue-relation-blocked", blockedBy: [makeIssue({ id: "blocker-1" })] });
    harness.seed({ issues: [blockedByStatus, blockedByRelation] });

    const { snapshot } = await bootstrapSnapshot(harness.ctx, COMPANY_ID);
    const statusBlocked = snapshot.issues.find((i) => i.id === blockedByStatus.id);
    const relationBlocked = snapshot.issues.find((i) => i.id === blockedByRelation.id);
    expect(statusBlocked?.blocked).toBe(true);
    expect(statusBlocked?.blockedByIssueIds).toEqual([]);
    expect(relationBlocked?.blocked).toBe(true);
    expect(relationBlocked?.blockedByIssueIds).toEqual(["blocker-1"]);
  });

  it("throws for an unknown company", async () => {
    const { harness } = seedStandardWorld();
    await expect(bootstrapSnapshot(harness.ctx, "company-nope")).rejects.toThrow(
      "Company company-nope not found",
    );
  });

  it("materializes into a BridgeStore via replaceAuthoritativeSnapshot (criterion 1)", async () => {
    const { harness, agents, projects, issues, approvals } = seedStandardWorld({ includeApproval: true });
    const { snapshot } = await bootstrapSnapshot(harness.ctx, COMPANY_ID);

    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(snapshot);
    const raw = store.getRawSnapshot();
    expect(raw.company?.id).toBe(COMPANY_ID);
    expect(raw.agents.map((a) => a.agentId).sort()).toEqual(agents.map((a) => a.id).sort());
    expect(raw.projects.map((p) => p.id)).toEqual(projects.map((p) => p.id));
    expect(raw.issues.map((i) => i.id)).toEqual(issues.map((i) => i.id));
    expect(raw.approvals.map((a) => a.id)).toEqual(approvals.map((a) => a.id));
    expect(raw.schemaVersion).toBe(1);
  });

  it("preserves active issue runs across bootstrap and reconciliation", async () => {
    const { harness } = seedStandardWorld();
    vi.spyOn(harness.ctx.issues, "getSubtree").mockResolvedValue({
      rootIssueId: ISSUE_ID,
      companyId: COMPANY_ID,
      issueIds: [ISSUE_ID],
      issues: [makeIssue()],
      activeRuns: {
        [ISSUE_ID]: [
          {
            id: "run-active",
            issueId: ISSUE_ID,
            agentId: AGENT_DEV_ID,
            status: "running",
            invocationSource: "heartbeat",
            triggerDetail: null,
            startedAt: "2026-08-22T00:00:00.000Z",
            finishedAt: null,
            error: null,
            createdAt: "2026-08-22T00:00:00.000Z",
          },
        ],
      },
    });

    const result = await bootstrapSnapshot(harness.ctx, COMPANY_ID);
    const activeRun = expect.objectContaining({
      id: "run-active",
      agentId: AGENT_DEV_ID,
      issueId: ISSUE_ID,
      projectId: PROJECT_ID,
      status: "running",
    });
    expect(result.activeRuns).toEqual([activeRun]);
    expect(result.snapshot.agents.find((agent) => agent.id === AGENT_DEV_ID)?.activeRuns).toEqual([activeRun]);
    expect(harness.ctx.issues.getSubtree).toHaveBeenCalledWith(ISSUE_ID, COMPANY_ID, {
      includeRoot: true,
      includeActiveRuns: true,
    });

    const store = new BridgeStore();
    store.replaceAuthoritativeSnapshot(result.snapshot);
    expect(store.getRawSnapshot().agents.find((agent) => agent.agentId === AGENT_DEV_ID)?.activeRuns).toEqual([
      expect.objectContaining({ runId: "run-active", status: "running" }),
    ]);
  });
});

describe("bootstrapSnapshot issue pagination (SAA gap: mature companies)", () => {
  it("pages past a single 1000-issue cap so a later root issue's active run is still discovered", async () => {
    // Regression for a live gap confirmed 2026-08-31 against a mature company
    // (400+ issues, deep nested "corrective re-do" chains): a single capped
    // `issues.list` call could silently exclude an issue's actual root
    // ancestor once total issue count grew past the cap, so bootstrapSnapshot
    // never walked that subtree at all -- a genuinely active run inside it
    // rendered permanently idle in Pixel Agents with no error anywhere.
    // listAllIssues (snapshot.ts) now pages with `offset` until a short page
    // signals exhaustion (the SDK's issues.list has no cursor/hasMore field).
    const { harness } = seedStandardWorld();
    const lateRootId = "issue-late-root";
    // Only filler[0] is a root (parentId: null); filler[1..999] are its
    // children, so bootstrapSnapshot's rootIssues filter excludes them and
    // this test only pays for 2 getSubtree calls, not 1000.
    const fillerRootId = "issue-filler-root";
    const filler = Array.from({ length: 1000 }, (_, i) =>
      makeIssue({
        id: i === 0 ? fillerRootId : `issue-filler-${i}`,
        parentId: i === 0 ? null : fillerRootId,
      }),
    );
    const lateRoot = makeIssue({ id: lateRootId });

    const listSpy = vi.spyOn(harness.ctx.issues, "list").mockImplementation(async (input) => {
      const offset = input?.offset ?? 0;
      if (offset === 0) return filler;
      if (offset === 1000) return [lateRoot];
      return [];
    });
    const emptySubtree = (issueId: string) => ({
      rootIssueId: issueId,
      companyId: COMPANY_ID,
      issueIds: [issueId],
      issues: [],
      activeRuns: {},
    });
    const getSubtreeSpy = vi
      .spyOn(harness.ctx.issues, "getSubtree")
      .mockImplementation(async (issueId: string) => {
        if (issueId !== lateRootId) return emptySubtree(issueId);
        return {
          rootIssueId: lateRootId,
          companyId: COMPANY_ID,
          issueIds: [lateRootId],
          issues: [lateRoot],
          activeRuns: {
            [lateRootId]: [
              {
                id: "run-late",
                issueId: lateRootId,
                agentId: AGENT_DEV_ID,
                status: "running",
                invocationSource: "heartbeat",
                triggerDetail: null,
                startedAt: "2026-08-22T00:00:00.000Z",
                finishedAt: null,
                error: null,
                createdAt: "2026-08-22T00:00:00.000Z",
              },
            ],
          },
        };
      });

    const result = await bootstrapSnapshot(harness.ctx, COMPANY_ID);

    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, offset: 0, limit: 1000 }));
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, offset: 1000, limit: 1000 }));
    expect(result.snapshot.issues.some((i) => i.id === lateRootId)).toBe(true);
    expect(getSubtreeSpy).toHaveBeenCalledWith(lateRootId, COMPANY_ID, { includeRoot: true, includeActiveRuns: true });
    expect(result.activeRuns).toEqual([expect.objectContaining({ id: "run-late", agentId: AGENT_DEV_ID })]);
    expect(
      result.snapshot.agents.find((agent) => agent.id === AGENT_DEV_ID)?.activeRuns,
    ).toEqual([expect.objectContaining({ id: "run-late" })]);

    listSpy.mockRestore();
    getSubtreeSpy.mockRestore();
  });

  it("stops after exactly one page when the company has fewer than 1000 issues (no wasted calls)", async () => {
    const { harness } = seedStandardWorld();
    const listSpy = vi.spyOn(harness.ctx.issues, "list");

    await bootstrapSnapshot(harness.ctx, COMPANY_ID);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(listSpy).toHaveBeenCalledWith(expect.objectContaining({ companyId: COMPANY_ID, offset: 0, limit: 1000 }));
    listSpy.mockRestore();
  });
});

describe("bootstrapAllCompanies", () => {
  it("bootstraps every seeded company, including project-less ones", async () => {
    const { harness } = seedStandardWorld();
    harness.seed({ companies: [makeCompany({ id: COMPANY_2_ID, name: "Project-less Co" })] });

    const results = await bootstrapAllCompanies(harness.ctx);
    expect(results.map((r) => r.companyId).sort()).toEqual([COMPANY_2_ID, COMPANY_ID].sort());
    for (const r of results) {
      expect(r.snapshot.company.name.length).toBeGreaterThan(0);
    }
    expect(results.find((r) => r.companyId === COMPANY_2_ID)?.snapshot.issues).toEqual([]);
  });

  it("skips a company whose bootstrap throws and logs a warning", async () => {
    const { harness } = seedStandardWorld();
    harness.seed({ companies: [makeCompany({ id: COMPANY_2_ID, name: "Doomed Co" })] });

    const listSpy = vi
      .spyOn(harness.ctx.agents, "list")
      .mockImplementation(async (input) => {
        if (input?.companyId === COMPANY_2_ID) {
          throw new Error("agent read failed");
        }
        return [];
      });

    const results = await bootstrapAllCompanies(harness.ctx);
    expect(results.map((r) => r.companyId)).toEqual([COMPANY_ID]);
    expect(
      harness.logs.some(
        (l) =>
          l.level === "warn" &&
          l.message === "Failed to bootstrap company snapshot" &&
          l.meta?.companyId === COMPANY_2_ID,
      ),
    ).toBe(true);
    listSpy.mockRestore();
  });
});
