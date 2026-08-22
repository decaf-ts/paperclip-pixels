import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AgentInput,
  ApprovalInput,
  AuthoritativeSnapshotInput,
  CompanyInput,
  IssueInput,
  ProjectInput,
  RunSummaryInput,
} from "@paperclip-pixel/core";
import type { Agent, Approval, Company, Issue, Project } from "@paperclipai/shared";

function mapCompany(c: Company): CompanyInput {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    status: c.status,
  };
}

function mapProject(p: Project): ProjectInput {
  return {
    id: p.id,
    companyId: p.companyId,
    name: p.name,
    status: p.status,
    leadAgentId: p.leadAgentId,
  };
}

function mapAgent(a: Agent): AgentInput {
  return {
    id: a.id,
    companyId: a.companyId,
    name: a.name,
    status: a.status,
    role: a.role,
    title: a.title,
    activeRuns: [],
  };
}

function mapIssue(i: Issue): IssueInput {
  const blocked = i.status === "blocked" || (i.blockedBy != null && i.blockedBy.length > 0);
  return {
    id: i.id,
    companyId: i.companyId,
    projectId: i.projectId,
    title: i.title,
    status: i.status,
    assigneeAgentId: i.assigneeAgentId,
    identifier: i.identifier,
    blocked,
    blockedByIssueIds: i.blockedBy?.map((r) => r.id) ?? [],
  };
}

function mapApproval(a: Approval): ApprovalInput {
  return {
    id: a.id,
    companyId: a.companyId,
    issueId: null,
    agentId: a.requestedByAgentId,
    type: a.type,
    status: a.status,
    requestedByAgentId: a.requestedByAgentId,
    decidedAt: a.decidedAt ? new Date(a.decidedAt).toISOString() : null,
  };
}

export interface SnapshotBootstrapResult {
  snapshot: AuthoritativeSnapshotInput;
  companyId: string;
  activeRuns: RunSummaryInput[];
}

/**
 * Bootstraps a snapshot for the specified company.
 *
 * Retrieves company data from the plugin context and maps it into an
 * `AuthoritativeSnapshotInput` structure suitable for core ingestion.
 *
 * @param ctx - The plugin execution context.
 * @param companyId - The ID of the company to bootstrap.
 * @returns A promise resolving to the snapshot and metadata for the company.
 */
export async function bootstrapSnapshot(
  ctx: PluginContext,
  companyId: string,
): Promise<SnapshotBootstrapResult> {
  const company = await ctx.companies.get(companyId);
  if (!company) {
    throw new Error(`Company ${companyId} not found`);
  }

  const [agents, projects, approvalsResp] = await Promise.all([
    ctx.agents.list({ companyId, limit: 1000 }),
    ctx.projects.list({ companyId, limit: 1000 }),
    ctx.approvals.list({ companyId, status: null }),
  ]);

  const projectIds = projects.map((p) => p.id);
  const issueBatches = await Promise.all(
    projectIds.map((pid) =>
      ctx.issues.list({ companyId, projectId: pid, limit: 1000 }),
    ),
  );
  const issues = issueBatches.flat();

  const observedAt = new Date().toISOString();

  const snapshot: AuthoritativeSnapshotInput = {
    company: mapCompany(company),
    agents: agents.map(mapAgent),
    projects: projects.map(mapProject),
    issues: issues.map(mapIssue),
    approvals: (approvalsResp as Approval[]).map(mapApproval),
    observedAt,
  };

  return {
    snapshot,
    companyId,
    activeRuns: [],
  };
}

/**
 * Bootstraps snapshots for all companies available via the plugin context.
 *
 * Iterates over each company, invoking `bootstrapSnapshot` and collecting the
 * results. Errors are logged but do not abort the overall process.
 *
 * @param ctx - The plugin execution context.
 * @returns An array of results for each processed company.
 */
export async function bootstrapAllCompanies(
  ctx: PluginContext,
): Promise<SnapshotBootstrapResult[]> {
  const companies = await ctx.companies.list({ limit: 1000 });
  const results: SnapshotBootstrapResult[] = [];
  for (const company of companies) {
    try {
      const result = await bootstrapSnapshot(ctx, company.id);
      results.push(result);
    } catch (err) {
      ctx.logger.warn("Failed to bootstrap company snapshot", {
        companyId: company.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return results;
}
