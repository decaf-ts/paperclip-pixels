/**
 * Idempotent seed data for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * The deployed instance starts with 0 companies / 0 agents. The suite seeds a
 * deterministic test company + ≥1 agent (with an issue assigned) via the
 * Paperclip API, reusing them if already present.
 *
 * NOTE (run-time verification): agent creation requires a valid `adapterType`
 * for the deployed instance. The default is overridable via
 * PAPERCLIP_PIXEL_E2E_ADAPTER_TYPE; verify against the live API when the run
 * gate (SAA-230) lifts.
 */

import { PaperclipApi } from "./api-client";
import {
  RECONCILE_WAIT_MS,
  SEED_AGENT_NAME,
  SEED_COMPANY_NAME,
  SEED_ISSUE_TITLE,
} from "./env";

export interface SeedResult {
  company: { id: string; name: string };
  agent: { id: string; name?: string; adapterType?: string };
  issue: { id: string; identifier?: string; title: string; status: string };
}

function adapterType(): string {
  // "mock" is not a valid adapter on the deployed instance; the seed company
  // agents use "claude_local". Default to the valid type so the suite is
  // self-contained (overridable via PAPERCLIP_PIXEL_E2E_ADAPTER_TYPE).
  return process.env.PAPERCLIP_PIXEL_E2E_ADAPTER_TYPE ?? "claude_local";
}

/** Seed (idempotently) a company + agent + assigned issue. */
export async function seedCompanyAgentIssue(api: PaperclipApi): Promise<SeedResult> {
  const company = await api.findOrCreateCompany(SEED_COMPANY_NAME);

  let agent = await api.findOrCreateAgent(company.id, SEED_AGENT_NAME, adapterType());
  if (!agent.id) {
    agent = await api.createAgent(company.id, { name: SEED_AGENT_NAME, adapterType: adapterType() });
  }

  const issues = await api.listIssues(company.id);
  let issue = issues.find((i) => i.title === SEED_ISSUE_TITLE && i.assigneeAgentId === agent.id);
  if (!issue) {
    issue = await api.createIssue(company.id, {
      title: SEED_ISSUE_TITLE,
      description: "Seeded by the Pixel Office e2e suite for live state-change verification.",
      assigneeAgentId: agent.id,
      status: "todo",
    });
  }

  return { company, agent, issue };
}

/**
 * Deterministic bound-feedback seed (spec PAPERCLIP_PIXELS-1, §9.4).
 *
 * The bridge produces `AgentFeedback` from observed Paperclip events. A
 * `question` comment event never reaches the store for this seeded agent (the
 * deployed host's comment events carry no agent binding; see SAA-333 notes), so
 * the reliable deterministic source is a wakeup run on the seeded ISSUE: the
 * host accepts the wakeup (`202` + queued run), the run immediately fails with
 * "Authentication required" on this stack (adapter not authenticated), and the
 * worker ingests `agent.run.failed` with `issueId: seed.issue.id` — which the
 * reducer records as a `failure` feedback bound to the seed issue with
 * `existingWorkContext: true`.
 *
 * Same result on a healthy stack: a real run on the seed issue ends and emits
 * run.finished/failed carrying issueId, likewise producing bound feedback.
 * Either way the feedback is bound to `seed.issue.id`, so a reply via
 * `agent.reply-to-feedback` comments on that exact issue (deterministic
 * read-back, no fixture-caused false failure from latching onto feedback bound
 * to a different leftover issue).
 */
export async function trySeedBoundFeedback(
  api: PaperclipApi,
  seed: SeedResult,
): Promise<{ id: string; issueId?: string; runId?: string } | null> {
  const bound = (snapshot: { feedback?: unknown[] }) =>
    (snapshot.feedback ?? []).find((f) => {
      const fb = f as { issueId?: string; existingWorkContext?: boolean };
      return fb.existingWorkContext === true && fb.issueId === seed.issue.id;
    });

  // Reuse an already-bound feedback if the store already has one for the seed
  // issue (idempotent across runs / prior wakes).
  const existing = bound(await api.bridgeSnapshot(seed.company.id));
  if (existing) {
    return { id: (existing as { id: string }).id, issueId: seed.issue.id };
  }

  // Otherwise wake the agent on the seed issue and poll the bridge until the
  // bound feedback appears (run fails ~1s; reconcile/delta ~seconds).
  await api.wakeupAgent(seed.agent.id, {
    issueId: seed.issue.id,
    reason: "e2e: seed deterministic bound feedback",
  });

  const deadline = Date.now() + RECONCILE_WAIT_MS;
  while (Date.now() < deadline) {
    const fb = bound(await api.bridgeSnapshot(seed.company.id));
    if (fb) {
      return { id: (fb as { id: string }).id, issueId: seed.issue.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }

  return null;
}
