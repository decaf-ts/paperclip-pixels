import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { AgentCharacterAssignment, CompactAgentBuckets } from "./core/index.js";
import { isAgentCharacterAssignment } from "./core/index.js";
import { STATE_KEYS, STATE_NAMESPACES } from "./constants.js";

function companyScope(companyId: string, stateKey: string) {
  return {
    scopeKind: "company" as const,
    scopeId: companyId,
    namespace: STATE_NAMESPACES.bridge,
    stateKey,
  };
}

const instanceScope = (stateKey: string) => ({
  scopeKind: "instance" as const,
  namespace: STATE_NAMESPACES.bridge,
  stateKey,
});

/**
 * Agent-scoped state key (WS3, spec PAPERCLIP_PIXELS-2 FR-13). The plugin SDK
 * supports `scopeKind: "agent"` (scopeId = the Paperclip agent id); this was
 * unused before the per-agent character system. Same shape as the existing
 * company/instance scope helpers so all three read identically.
 */
function agentScope(agentId: string, stateKey: string) {
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: STATE_NAMESPACES.characters,
    stateKey,
  };
}

export async function persistCompactBuckets(
  ctx: PluginContext,
  companyId: string,
  buckets: Record<string, CompactAgentBuckets>,
): Promise<void> {
  if (!buckets || Object.keys(buckets).length === 0) return;
  await ctx.state.set(companyScope(companyId, STATE_KEYS.compactBuckets), buckets);
}

export async function loadCompactBuckets(
  ctx: PluginContext,
  companyId: string,
): Promise<Record<string, CompactAgentBuckets> | null> {
  const data = await ctx.state.get(companyScope(companyId, STATE_KEYS.compactBuckets));
  if (data == null) return null;
  if (typeof data !== "object" || Array.isArray(data)) return null;
  return data as Record<string, CompactAgentBuckets>;
}

export async function persistLastReconciledAt(
  ctx: PluginContext,
  companyId: string,
  timestamp: string,
): Promise<void> {
  await ctx.state.set(companyScope(companyId, STATE_KEYS.lastReconciledAt), timestamp);
}

export async function loadLastReconciledAt(
  ctx: PluginContext,
  companyId: string,
): Promise<string | null> {
  const data = await ctx.state.get(companyScope(companyId, STATE_KEYS.lastReconciledAt));
  return typeof data === "string" ? data : null;
}

export async function persistLeadershipAgentId(
  ctx: PluginContext,
  companyId: string,
  agentId: string,
): Promise<void> {
  await ctx.state.set(companyScope(companyId, STATE_KEYS.leadershipAgentId), agentId);
}

export async function loadLeadershipAgentId(
  ctx: PluginContext,
  companyId: string,
): Promise<string | null> {
  const data = await ctx.state.get(companyScope(companyId, STATE_KEYS.leadershipAgentId));
  return typeof data === "string" ? data : null;
}

export async function persistSchemaVersion(ctx: PluginContext): Promise<void> {
  await ctx.state.set(instanceScope(STATE_KEYS.schemaVersion), 1);
}

export async function loadSchemaVersion(ctx: PluginContext): Promise<number | null> {
  const data = await ctx.state.get(instanceScope(STATE_KEYS.schemaVersion));
  return typeof data === "number" ? data : null;
}

/**
 * Persist one agent's character assignment in the plugin SDK's `agent` state
 * scope (WS3). This is the single source of truth for per-agent appearance —
 * the relay's former `~/.pixel-agents/paperclip-appearance.json` file is
 * retired and only receives write-through pushes from here.
 */
export async function persistAgentCharacterAssignment(
  ctx: PluginContext,
  agentId: string,
  assignment: AgentCharacterAssignment,
): Promise<void> {
  await ctx.state.set(agentScope(agentId, STATE_KEYS.agentCharacter), assignment);
}

/**
 * Load one agent's character assignment. Returns `null` when the agent has no
 * assignment yet (caller materializes a diverse-random default) or when the
 * stored value is malformed (fail-closed to a fresh default rather than
 * serving an unvalidated shape to the UI or the relay).
 */
export async function loadAgentCharacterAssignment(
  ctx: PluginContext,
  agentId: string,
): Promise<AgentCharacterAssignment | null> {
  const data = await ctx.state.get(agentScope(agentId, STATE_KEYS.agentCharacter));
  if (data == null) return null;
  return isAgentCharacterAssignment(data) ? data : null;
}

/**
 * Bulk-load the per-agent assignment map for a known set of agent ids. The
 * plugin state API has no "list all agent-scoped keys" operation, so the
 * caller supplies the roster (the worker always has it from the authoritative
 * snapshot). Malformed entries are skipped (fail-closed to defaults).
 */
export async function loadAgentCharacterAssignments(
  ctx: PluginContext,
  agentIds: string[],
): Promise<Record<string, AgentCharacterAssignment>> {
  const map: Record<string, AgentCharacterAssignment> = {};
  for (const agentId of agentIds) {
    const assignment = await loadAgentCharacterAssignment(ctx, agentId);
    if (assignment) map[agentId] = assignment;
  }
  return map;
}
