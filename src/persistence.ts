import type { PluginContext } from "@paperclipai/plugin-sdk";
import type { CompactAgentBuckets } from "./core/index.js";
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
