import { z } from "zod";
import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import {
  evaluateAgentReply,
  validateIntake,
  type AgentFeedback,
} from "./core/index.js";
import {
  ACTION_KEYS,
} from "./constants.js";
import {
  loadLeadershipAgentId,
  persistLeadershipAgentId,
} from "./persistence.js";

const CompanySendMessageSchema = z.object({
  companyId: z.string().min(1),
  text: z.string().min(1),
});

// `.strict()` rejects any caller-supplied `feedback` (or other unexpected key)
// so the C1 exploit — a forged feedback object with existingWorkContext:true +
// a foreign issueId — is rejected by the schema with INVALID_PARAMS rather than
// silently ignored. The host's `handlePerformAction` (plugin-sdk worker-rpc-host)
// ALWAYS merges a `renderEnvironment` metadata key into the action params before
// the handler runs, so that key is explicitly allowlisted here (`unknown` value,
// never used by the handler) while every OTHER unexpected key — including a
// forged `feedback` — still fails the `.strict()` parse (SAA-339 Defect 1 fix;
// C1 property unchanged, security re-confirmed in SAA-339).
const AgentReplyToFeedbackSchema = z.object({
  companyId: z.string().min(1),
  feedbackId: z.string().min(1),
  text: z.string().min(1),
  renderEnvironment: z.unknown().optional(),
}).strict();

export interface ActionDeps {
  ctx: PluginContext;
  getFeedback: (companyId: string, feedbackId: string) => AgentFeedback | undefined;
  getLeadershipAgentId: (companyId: string) => string | undefined;
}

function actorFromContext(context: PluginPerformActionContext): { id?: string; type?: string } {
  const a = context.actor;
  if (a.type === "user") return { id: a.userId ?? undefined, type: "user" };
  if (a.type === "agent") return { id: a.agentId ?? undefined, type: "agent" };
  return { id: undefined, type: a.type };
}

// Mirrors `isAgentStatusInvokable` from @paperclipai/shared: an agent is only a
// viable intake/leadership target when it can actually run work. Paused,
// pending-approval, and terminated agents fail the host's session RPC with a
// raw `UNKNOWN "Agent is not invokable in its current state"` 502 (SAA-339
// Defect 3 observed on the deployed stack with a paused probe agent).
const INVOKABLE_AGENT_STATUSES = new Set(["active", "idle", "running", "error"]);

function isAgentInvokable(status: string | null | undefined): boolean {
  return status !== null && status !== undefined && INVOKABLE_AGENT_STATUSES.has(status);
}

/**
 * Resolve the authoritative company for an action (M1, spec §5.2, §15).
 *
 * The Paperclip plugin SDK exposes the host-authorized company on the action
 * context — `context.companyId` (a convenience alias for `context.actor.companyId`)
 * — which is set by the host from the authenticated actor, never from caller
 * params. The host additionally merges that same host-authorized `companyId`
 * into the handler params, overriding any caller-supplied value.
 *
 * When the host scopes the call (non-null context company), this asserts the
 * request's `companyId` matches it and fails closed on mismatch. When the host
 * does not scope the call (null — e.g. instance/global actions), it falls back
 * to the (host-overridden) request `companyId`.
 */
function resolveCompanyScope(
  parsedCompanyId: string,
  context: PluginPerformActionContext,
): { companyId: string } | { error: string } {
  const ctxCompanyId = context.companyId ?? context.actor.companyId ?? null;
  if (ctxCompanyId !== null && ctxCompanyId !== parsedCompanyId) {
    return { error: "COMPANY_SCOPE_MISMATCH" };
  }
  return { companyId: ctxCompanyId ?? parsedCompanyId };
}

export async function handleCompanySendMessage(
  deps: ActionDeps,
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
): Promise<unknown> {
  const parsed = CompanySendMessageSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, error: "INVALID_PARAMS", details: parsed.error.issues };
  }
  const { text } = parsed.data;
  const scope = resolveCompanyScope(parsed.data.companyId, context);
  if ("error" in scope) {
    return { ok: false, error: scope.error };
  }
  const { companyId } = scope;

  let leadershipAgentId = deps.getLeadershipAgentId(companyId);
  if (!leadershipAgentId) {
    const stored = await loadLeadershipAgentId(deps.ctx, companyId);
    leadershipAgentId = stored ?? undefined;
  }

  // Validate a persisted/in-memory leader is still invokable before use. On the
  // deployed stack the probe/seed roster included a paused "Reflection Coach"
  // that was picked as leadership, and the host session RPC then failed with a
  // raw `UNKNOWN "Agent is not invokable in its current state"` 502 (SAA-339
  // Defect 3). A paused/terminated/pending leader is dropped and re-resolved.
  if (leadershipAgentId) {
    const known = await deps.ctx.agents.get(leadershipAgentId, companyId);
    if (!known || !isAgentInvokable(known.status)) {
      leadershipAgentId = undefined;
    }
  }

  // Resolve from the roster only when no invokable leader is known: prefer a
  // leadership agent (ceo or org root) that can actually run work, and fail
  // closed with `no-leadership-agent` (validated below) when every leadership
  // candidate is paused/terminated/pending instead of surfacing a raw 502.
  if (!leadershipAgentId) {
    const agents = await deps.ctx.agents.list({ companyId, limit: 1000 });
    const leader = agents.find(
      (a) => (a.role === "ceo" || a.reportsTo === null) && isAgentInvokable(a.status),
    );
    if (leader) {
      leadershipAgentId = leader.id;
      await persistLeadershipAgentId(deps.ctx, companyId, leader.id);
    }
  }

  const result = validateIntake(
    { companyId, text, actor: actorFromContext(context) },
    { leadershipAgentId: leadershipAgentId ?? "" },
  );

  if (result.kind === "rejected") {
    return { ok: false, error: result.reason };
  }

  const session = await deps.ctx.agents.sessions.create(
    result.leadershipAgentId,
    result.companyId,
    { reason: "company-intake" },
  );

  await deps.ctx.agents.sessions.sendMessage(session.sessionId, result.companyId, {
    prompt: result.text,
    reason: "company.send-message",
  });

  return { ok: true, sessionId: session.sessionId };
}

export async function handleAgentReplyToFeedback(
  deps: ActionDeps,
  params: Record<string, unknown>,
  context: PluginPerformActionContext,
): Promise<unknown> {
  const parsed = AgentReplyToFeedbackSchema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, error: "INVALID_PARAMS", details: parsed.error.issues };
  }
  const { feedbackId, text } = parsed.data;

  const scope = resolveCompanyScope(parsed.data.companyId, context);
  if ("error" in scope) {
    return { ok: false, error: scope.error };
  }
  const { companyId } = scope;

  // C1 (spec §5.2, §18.3): resolve the feedback server-side from the store.
  // Never trust a caller-supplied feedback object — the schema no longer
  // accepts one. Missing feedback fails closed: no comment, no policy eval.
  const feedback = deps.getFeedback(companyId, feedbackId);
  if (!feedback) {
    return { ok: false, error: "FEEDBACK_NOT_FOUND" };
  }

  const result = evaluateAgentReply({
    companyId,
    feedbackId,
    text,
    feedback,
    actor: actorFromContext(context),
  });

  if (result.kind === "route-to-company") {
    return {
      ok: false,
      error: "ROUTE_TO_COMPANY",
      reason: result.reason,
      suggestedText: result.suggestedText,
    };
  }

  // Comment only on the server-derived feedback.issueId (never caller-supplied).
  if (feedback.issueId) {
    await deps.ctx.issues.createComment(feedback.issueId, text, companyId, {
      actorUserId: context.actor.userId ?? undefined,
    });
  }

  return { ok: true, feedbackId, issueId: result.issueId, runId: result.runId };
}

/**
 * Registers the plugin's actions with the Paperclip framework.
 *
 * This binds the `companySendMessage` and `agentReplyToFeedback` actions to
 * their respective handlers defined in this file.
 *
 * @param deps - Dependencies required for registration, including the plugin context.
 */
export function registerActions(deps: ActionDeps): void {
  deps.ctx.actions.register(ACTION_KEYS.companySendMessage, (params, context) =>
    handleCompanySendMessage(deps, params, context),
  );
  deps.ctx.actions.register(ACTION_KEYS.agentReplyToFeedback, (params, context) =>
    handleAgentReplyToFeedback(deps, params, context),
  );
}
