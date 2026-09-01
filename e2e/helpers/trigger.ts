/**
 * Real-state-change triggers for the Pixel Office e2e suite (spec
 * PAPERCLIP_PIXELS-1, SAA-231).
 *
 * Each trigger produces a genuine Paperclip state change that the bridge
 * observes (via its event subscriptions / reconciliation) and reflects in the
 * Pixel Office UI — never a mocked UI update.
 */

import { PaperclipApi } from "./api-client";
import type { SeedResult } from "./seed";

export interface TriggerRunResult {
  started: boolean;
  reason?: string;
}

/** A run must stay live this long before we treat it as truly renderable. */
export const LIVE_STEADY_MS = 8_000;

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
 * Wake the seeded agent on its issue and verify a run actually went live AND
 * stayed live long enough to be asserted in the UI.
 *
 * The host accepts the wakeup (`202` + queued run JSON) even when the run can
 * never start — and on this stack the seeded agent's adapter is not
 * authenticated, so every run transitions queued -> running -> failed
 * ("Authentication required") within ~1-3s. Two fixture failure modes result
 * from conflating that transient liveness with "run started":
 *  1. the active-run ROW never renders — the worker emits summary/behavior
 *     stream deltas only, never `agent.projection.changed`, so a card row
 *     requires a full snapshot refetch (Refresh), and a sub-second run is
 *     gone before any refetch;
 *  2. a `liveRuns` hit during that ~2s window returns `true` and the spec then
 *     90s-timeouts on the row.
 *
 * Deterministic check: require the run to remain live (queued/running) for a
 * sustained window (`LIVE_STEADY_MS`). Returns `{ started: true }` only on
 * that positive evidence; if the run terminates during the steady window —
 * the deployed-stack norm — returns `{ started: false }` with a precise
 * reason referencing the observed run outcome so the spec can skip with a
 * documented cause rather than fail on a fixture defect.
 */
export async function tryTriggerAgentRun(api: PaperclipApi, seed: SeedResult): Promise<TriggerRunResult> {
  await api.wakeupAgent(seed.agent.id, { issueId: seed.issue.id, reason: "e2e: assert live signals" });

  const deadline = Date.now() + 60_000;
  let firstLiveAt: number | null = null;
  while (Date.now() < deadline) {
    const live = await api.liveRuns(seed.company.id, seed.agent.id).catch(() => []);
    if (live.length > 0) {
      if (firstLiveAt === null) firstLiveAt = Date.now();
      if (Date.now() - firstLiveAt >= LIVE_STEADY_MS) {
        return { started: true };
      }
    } else if (firstLiveAt !== null) {
      // The run went live but terminated before the steady window. Break and
      // report precisely instead of claiming a renderable run started.
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }

  const recent = await api.listHeartbeatRuns(seed.company.id, seed.agent.id, 3).catch(() => []);
  const last = recent[0];
  let reason: string;
  if (firstLiveAt !== null) {
    reason =
      `agent run went live but terminated during the ${LIVE_STEADY_MS}ms steady window before it could be asserted as an ` +
      `active-run row — the seed agent's adapter (${seed.agent.adapterType ?? "unknown"}) is not authenticated for a real run ` +
      `on this stack (most recent run: status "${last?.status ?? "unknown"}"${last?.error ? `, error "${last.error}"` : ""}); ` +
      "wakeup is accepted but no persistent run is produced";
  } else if (last) {
    reason =
      `agent run never reached a sustained live (queued/running) state within 60s: the seed agent's most recent run has status ` +
      `"${last.status ?? "unknown"}"${last.error ? ` (${last.error})` : ""} — wakeup accepted but no adapter-authenticated run ` +
      "started on this stack";
  } else {
    reason = "agent run never reached a sustained live (queued/running) state within 60s of wakeup";
  }

  return { started: false, reason };
}
