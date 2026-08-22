import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import type { TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginCapability, PluginEvent } from "@paperclipai/plugin-sdk";
import type { Agent, Approval, Company, Issue, Project } from "@paperclipai/shared";
import type { AgentFeedback } from "@paperclip-pixel/core";
import manifest from "../src/manifest.js";

export const COMPANY_ID = "company-acme";
export const COMPANY_2_ID = "company-betel";
export const AGENT_CEO_ID = "agent-ceo";
export const AGENT_DEV_ID = "agent-dev";
export const AGENT_EMPTY_ID = "agent-empty";
export const PROJECT_ID = "project-core";
export const ISSUE_ID = "issue-42";
export const ISSUE_BLOCKED_ID = "issue-99";
export const APPROVAL_ID = "approval-7";

export const ISO_NOW = "2026-08-22T00:00:00.000Z";
export const ISO_LATER = "2026-08-22T00:01:00.000Z";

/** The worker's manifest plus the extra capability the test harness needs to
 *  exercise the reconciliation job registration (jobs.schedule). The harness
 *  enforces capabilities on job registration; the production host does not. */
export function makeHarness(extra: PluginCapability[] = []): TestHarness {
  return createTestHarness({
    manifest,
    capabilities: [...manifest.capabilities, "jobs.schedule", ...extra],
  });
}

export function makeCompany(
  overrides: Partial<Pick<Company, "id" | "name" | "description" | "status">> = {},
): Company {
  return {
    id: COMPANY_ID,
    name: "Acme Corp",
    description: "Fixture company for bridge tests",
    status: "active",
    ...overrides,
  } as unknown as Company;
}

export function makeAgent(
  overrides: Partial<Pick<Agent, "id" | "companyId" | "name" | "status" | "role" | "title" | "reportsTo">> = {},
): Agent {
  return {
    id: AGENT_DEV_ID,
    companyId: COMPANY_ID,
    name: "Dev Agent",
    status: "idle",
    role: "engineer",
    title: null,
    reportsTo: AGENT_CEO_ID,
    ...overrides,
  } as unknown as Agent;
}

export function makeCeoAgent(): Agent {
  return makeAgent({
    id: AGENT_CEO_ID,
    name: "CEO Agent",
    role: "ceo",
    reportsTo: null,
  });
}

export function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    companyId: COMPANY_ID,
    goalId: null,
    urlKey: "core",
    name: "Core bridge",
    description: null,
    status: "in_progress",
    leadAgentId: AGENT_CEO_ID,
    ...overrides,
  } as unknown as Project;
}

export function makeIssue(overrides: Partial<Issue> = {}): Issue {
  return {
    id: ISSUE_ID,
    companyId: COMPANY_ID,
    projectId: PROJECT_ID,
    title: "Ship the bridge",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: AGENT_DEV_ID,
    assigneeUserId: null,
    identifier: "ACME-42",
    originKind: null,
    workMode: "standard",
    blockedBy: [],
    parentId: null,
    ...overrides,
  } as unknown as Issue;
}

export function makeBlockingIssue(): Issue {
  return makeIssue({
    id: "issue-blocker",
    title: "Blocker",
    status: "done",
    assigneeAgentId: AGENT_CEO_ID,
    identifier: "ACME-41",
  });
}

export function makeBlockedIssue(): Issue {
  return makeIssue({
    id: ISSUE_BLOCKED_ID,
    title: "Blocked by relation",
    status: "in_progress",
    blockedBy: [makeBlockingIssue()],
  });
}

export function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: APPROVAL_ID,
    companyId: COMPANY_ID,
    type: "request_board_approval",
    requestedByAgentId: AGENT_DEV_ID,
    requestedByUserId: null,
    status: "pending",
    payload: {},
    decisionNote: null,
    decidedByUserId: null,
    decidedAt: null,
    ...overrides,
  } as unknown as Approval;
}

export function makeFeedback(
  overrides: Partial<AgentFeedback> = {},
): AgentFeedback {
  return {
    id: "feedback-1",
    companyId: COMPANY_ID,
    agentId: AGENT_DEV_ID,
    runId: "run-1",
    kind: "progress",
    summary: "Progress on the bridge",
    detail: undefined,
    requiresResponse: true,
    existingWorkContext: true,
    createdAt: ISO_NOW,
    provenance: {},
    ...overrides,
  } as unknown as AgentFeedback;
}

export interface PluginEventOverrides extends Partial<PluginEvent> {
  eventType: PluginEvent["eventType"];
}

export function makePluginEvent(
  eventType: PluginEvent["eventType"],
  payload: Record<string, unknown>,
  overrides: Partial<Pick<PluginEvent, "eventId" | "occurredAt" | "actorId" | "actorType" | "entityId" | "entityType" | "companyId">> = {},
): PluginEvent {
  return {
    eventId: `evt-${eventType}`,
    eventType,
    occurredAt: ISO_NOW,
    actorId: AGENT_DEV_ID,
    actorType: "agent",
    entityId: undefined,
    entityType: undefined,
    companyId: COMPANY_ID,
    payload,
    ...overrides,
  } as unknown as PluginEvent;
}

export interface StandardWorldOptions {
  companyId?: string;
  projectId?: string;
  issueId?: string;
  issueStatus?: Issue["status"] | undefined;
  agentStatus?: string;
  includeApproval?: boolean;
  includeBlockedIssue?: boolean;
  includeSecondCompany?: boolean;
}

export interface StandardWorld {
  harness: TestHarness;
  company: Company;
  agents: Agent[];
  projects: Project[];
  issues: Issue[];
  approvals: Approval[];
}

export function seedStandardWorld(options: StandardWorldOptions = {}): StandardWorld {
  const harness = makeHarness();
  const company = makeCompany({ id: options.companyId ?? COMPANY_ID });
  const agents = [makeCeoAgent(), makeAgent()];
  const projects = [makeProject({ id: options.projectId ?? PROJECT_ID })];
  const issues = [makeIssue({ id: options.issueId ?? ISSUE_ID, status: options.issueStatus ?? "todo" })];
  if (options.includeBlockedIssue) issues.push(makeBlockedIssue());
  if (options.includeSecondCompany) {
    const otherCompany = makeCompany({ id: COMPANY_2_ID, name: "Betelgeuse Labs" });
    const otherProject = makeProject({ id: "project-other", companyId: COMPANY_2_ID, name: "Other project" });
    const otherIssue = makeIssue({ id: "issue-other", companyId: COMPANY_2_ID, projectId: "project-other" });
    harness.seed({
      companies: [company, otherCompany],
      agents,
      projects: [...projects, otherProject],
      issues: [...issues, otherIssue],
    });
    return { harness, company, agents, projects, issues, approvals: [] };
  }
  const approvals = options.includeApproval ? [makeApproval()] : [];
  harness.seed({ companies: [company], agents, projects, issues, approvals });
  return { harness, company, agents, projects, issues, approvals };
}
