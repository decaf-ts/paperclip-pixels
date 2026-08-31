import type { PluginContext } from "@paperclipai/plugin-sdk";
import type {
  AgentInput,
  ApprovalInput,
  AuthoritativeSnapshotInput,
  CompanyInput,
  IssueInput,
  ProjectInput,
  RunSummaryInput,
} from "./core/index.js";
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

function mapAgent(a: Agent, activeRuns: RunSummaryInput[]): AgentInput {
  return {
    id: a.id,
    companyId: a.companyId,
    name: a.name,
    status: a.status,
    role: a.role,
    title: a.title,
    activeRuns,
  };
}

function mapRun(
  run: {
    id: string;
    agentId: string;
    issueId: string | null;
    status: string;
    invocationSource: string;
    startedAt: string | null;
    finishedAt: string | null;
    error: string | null;
  },
  issuesById: ReadonlyMap<string, Issue>,
): RunSummaryInput {
  return {
    id: run.id,
    agentId: run.agentId,
    issueId: run.issueId,
    projectId: run.issueId ? issuesById.get(run.issueId)?.projectId ?? null : null,
    status: run.status,
    invocationSource: run.invocationSource,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
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

/** Page size for {@link listAllIssues}'s offset-based pagination. */
const ISSUE_PAGE_SIZE = 1000;

/**
 * Fetch every issue for a company via offset-based pagination, rather than a
 * single capped `limit` call.
 *
 * Confirmed live 2026-08-31 against a mature company (400+ issues, deep
 * nested "corrective re-do" chains, e.g. an issue several levels under a
 * root spawned to redo an earlier defect's fix): a single `limit: 1000` fetch
 * can silently exclude an issue's actual root ancestor once total issue count
 * grows past the cap. `bootstrapSnapshot` only walks subtrees rooted at
 * issues present in this list (see its `rootIssues` filter below), so an
 * excluded root's entire subtree — including any genuinely active run inside
 * it — never gets visited. The affected agent then renders permanently idle
 * in Pixel Agents regardless of what Paperclip itself reports, with no error
 * anywhere (this is a silent data-completeness gap, not a thrown exception).
 *
 * `issues.list` has no cursor/hasMore field (see the SDK's `WorkerToHostMethods`
 * protocol), so a page shorter than `ISSUE_PAGE_SIZE` is the exhaustion signal.
 *
 * @param ctx - The plugin execution context.
 * @param companyId - Identifier of the company whose issues to fetch.
 * @returns Every issue belonging to the company.
 */
async function listAllIssues(
  ctx: PluginContext,
  companyId: string,
): Promise<Issue[]> {
  const all: Issue[] = [];
  let offset = 0;
  for (;;) {
    const page = await ctx.issues.list({ companyId, limit: ISSUE_PAGE_SIZE, offset });
    all.push(...page);
    if (page.length < ISSUE_PAGE_SIZE) break;
    offset += ISSUE_PAGE_SIZE;
  }
  return all;
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

  const issues = await listAllIssues(ctx, companyId);
  const issuesById = new Map(issues.map((issue) => [issue.id, issue]));
  const rootIssues = issues.filter(
    (issue) => issue.parentId == null || !issuesById.has(issue.parentId),
  );
  const subtrees = await Promise.all(
    rootIssues.map((issue) =>
      ctx.issues.getSubtree(issue.id, companyId, {
        includeRoot: true,
        includeActiveRuns: true,
      }),
    ),
  );
  const activeRunsById = new Map<string, RunSummaryInput>();
  for (const subtree of subtrees) {
    for (const runs of Object.values(subtree.activeRuns ?? {})) {
      for (const run of runs) {
        activeRunsById.set(run.id, mapRun(run, issuesById));
      }
    }
  }
  const activeRuns = [...activeRunsById.values()];
  const activeRunsByAgent = new Map<string, RunSummaryInput[]>();
  for (const run of activeRuns) {
    const agentRuns = activeRunsByAgent.get(run.agentId) ?? [];
    agentRuns.push(run);
    activeRunsByAgent.set(run.agentId, agentRuns);
  }

  const observedAt = new Date().toISOString();

  const snapshot: AuthoritativeSnapshotInput = {
    company: mapCompany(company),
    agents: agents.map((agent) => mapAgent(agent, activeRunsByAgent.get(agent.id) ?? [])),
    projects: projects.map(mapProject),
    issues: issues.map(mapIssue),
    approvals: (approvalsResp as Approval[]).map(mapApproval),
    observedAt,
  };

  return {
    snapshot,
    companyId,
    activeRuns,
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
