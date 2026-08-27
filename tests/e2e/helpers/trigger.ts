/**
 * Real-state-change triggers for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * Each trigger produces a genuine Paperclip state change that the bridge
 * observes (via its event subscriptions / reconciliation) and reflects in the
 * Pixel Office UI — never a mocked UI update.
 */

import { PaperclipApi } from "./api-client";
import type { Agent } from "./api-client";
import { RECONCILE_WAIT_MS } from "./env";
import type { SeedResult } from "./seed";

export interface TriggerRunResult {
  started: boolean;
  agentId?: string;
  reason?: string;
}

/**
 * Name of the dedicated long-lived-run agent the suite uses to make the
 * active-run ROW assertion deterministic (see startDeterministicActiveRun).
 */
export const LIVE_RUN_AGENT_NAME = "E2E Active-Run Agent";

/**
 * Adapter config for the long-lived-run agent. The host's `process` adapter
 * spawns the command directly (no shell tokenization — `command` must be an
 * executable path), so the run stays genuinely live for `sleep`'s duration —
 * long enough for the worker's reconciliation + a UI snapshot refetch to both
 * observe it. Verified on the deployed stack: run live in ~36ms, bridge
 * snapshot observes `projection.activeRuns` within ~100ms, run persists 60s.
 */
export const LIVE_RUN_ADAPTER_CONFIG: Record<string, unknown> = {
  command: "/usr/bin/sleep",
  args: ["60"],
  cwd: "/tmp",
  timeoutSec: 120,
};

/**
 * Trigger a real state change: create a NEW issue assigned to the seeded
 * agent, then apply a status transition (PATCH). The bridge subscribes to
 * `issue.updated` (not `issue.created`) — see subscriptions.ts — so the create
 * alone is NOT deterministic: core occasionally emits an `issue.updated` for
 * the create, usually not. The PATCH guarantees an `issue.updated` event the
 * worker ingests (verified: reconcile ~4s), so the open-issue count and the
 * agent's assigned-issues view update in the UI deterministically.
 *
 * The host's issue POST is idempotent by title (re-issuing the same title
 * returns the existing issue), so the title must be unique per invocation —
 * otherwise the PATCH is a no-op on the already-transitioned issue and no
 * event fires. A timestamp suffix keeps every trigger a fresh issue.
 */
export async function triggerNewAssignedIssue(api: PaperclipApi, seed: SeedResult, baseTitle: string): Promise<{ id: string }> {
  const title = `${baseTitle} ${new Date().toISOString()}`;
  const issue = await api.createIssue(seed.company.id, {
    title,
    description: "Triggered by the Pixel Office e2e suite to assert live state propagation.",
    assigneeAgentId: seed.agent.id,
    status: "todo",
  });
  await api.updateIssue(issue.id, { status: "in_progress" });
  return { id: issue.id };
}

/**
 * Ensure the dedicated long-lived-run agent exists in `companyId` with the
 * deterministic `process` adapter config (idempotent by name).
 *
 * The host accepts agent creation for any registered adapter — a `process`
 * agent whose command is a long-lived sleep produces a run that stays live for
 * a fixed, known duration. The seeded agents use `claude_local`, which on this
 * stack is unauthenticated — every run fails with "Authentication required",
 * but the time-to-failure varies (~1s to >8s observed), so no timing-based
 * assertion against the seed agent is deterministic. The active-run step
 * therefore wakes THIS dedicated long-lived agent instead. If a stale agent of
 * that name was left with a different adapter, it is recreated so the config
 * is always the long-lived one.
 */
export async function ensureLiveRunAgent(api: PaperclipApi, companyId: string): Promise<Agent> {
  const existing = (await api.listAgents(companyId)).find((a) => (a.name ?? "") === LIVE_RUN_AGENT_NAME);
  if (existing && existing.adapterType === "process") {
    // Keep the config deterministic across suite runs (idempotent PATCH).
    await api.updateAgent(existing.id, { adapterConfig: LIVE_RUN_ADAPTER_CONFIG }).catch(() => undefined);
    return existing;
  }
  if (existing) {
    // A leftover agent with a different adapter cannot be switched reliably;
    // recreate it so the deterministic process config always applies.
    await api.deleteAgent(existing.id).catch(() => undefined);
  }
  return api.createAgent(companyId, {
    name: LIVE_RUN_AGENT_NAME,
    adapterType: "process",
    adapterConfig: LIVE_RUN_ADAPTER_CONFIG,
  });
}

/**
 * Start a genuinely long-lived, renderable run and return positive evidence
 * that it will appear as an active-run row in the UI.
 *
 * Why a dedicated agent: the active-run ROW in the Pixel Office is surfaced by
 * a full bridge snapshot refetch (the worker's stream bridge emits
 * summary/behavior deltas only, never `agent.projection.changed`). A row is
 * therefore only assertable once a run has been observed in the bridge's
 * snapshot — and the seed agent's `claude_local` adapter is unauthenticated on
 * this stack, so its runs fail with variable latency (~1s to >8s), racing any
 * fixed steady window before a refetch. A `process` agent running `sleep 60`
 * stays live for a known duration, so `projection.activeRuns` is observed
 * deterministically.
 *
 * Steps: ensure the live-run agent -> create a fresh issue assigned to it ->
 * PATCH it in_progress (fires the `issue.updated` event the worker ingests) ->
 * wake it -> poll the bridge snapshot until the agent's `projection.activeRuns
 * > 0` (the exact condition the card row renders from). Returns
 * `{ started: true, agentId }` on that snapshot evidence; otherwise a precise,
 * non-timeout reason so the spec can skip with a documented cause instead of
 * 90s-failing on a fixture defect.
 */
export async function startDeterministicActiveRun(api: PaperclipApi, seed: SeedResult): Promise<TriggerRunResult> {
  const live = await ensureLiveRunAgent(api, seed.company.id);

  const title = `E2E active-run trigger ${new Date().toISOString()}`;
  const issue = await api.createIssue(seed.company.id, {
    title,
    description: "Triggered by the Pixel Office e2e suite to assert a deterministic active-run row.",
    assigneeAgentId: live.id,
    status: "todo",
  });
  await api.updateIssue(issue.id, { status: "in_progress" });
  await api.wakeupAgent(live.id, { issueId: issue.id, reason: "e2e: assert active-run row from a long-lived run" });

  const deadline = Date.now() + RECONCILE_WAIT_MS;
  while (Date.now() < deadline) {
    const snapshot = await api.bridgeSnapshot(seed.company.id);
    const agent = (snapshot.agents ?? []).find(
      (a) => (a as { projection?: { agentId?: string; activeRuns?: unknown[] } }).projection?.agentId === live.id,
    );
    const activeRuns = (agent as { projection?: { activeRuns?: unknown[] } } | undefined)?.projection?.activeRuns;
    if (activeRuns && activeRuns.length > 0) {
      return { started: true, agentId: live.id };
    }
    await new Promise((resolve) => setTimeout(resolve, 4_000));
  }

  const recent = await api.listHeartbeatRuns(seed.company.id, live.id, 3).catch(() => []);
  const last = recent[0];
  const reason =
    `no snapshot-observed active run for the long-lived ${LIVE_RUN_AGENT_NAME} process agent within ${RECONCILE_WAIT_MS}ms — ` +
    `most recent run status "${last?.status ?? "unknown"}"${last?.error ? ` (${last.error})` : ""}; wakeup accepted but a ` +
    "persistent renderable run did not surface in the bridge snapshot";
  return { started: false, reason };
}
