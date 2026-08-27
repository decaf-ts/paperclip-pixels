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
