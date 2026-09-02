/**
 * Plugin feed apply side (spec PAPERCLIP_PIXELS-2, WS2-C).
 *
 * The embedding surface — whatever owns the Pixel Agents server process and
 * registered the Paperclip plugin through {@link registerPaperclipPixelPlugin}
 * — mounts this handler at `POST /api/plugin-feed`. It validates each pushed
 * batch (feed.ts) and applies the operations through the registered plugin's
 * sanctioned agent/team source (`PluginContext.agents`): declareAgents /
 * removeAgents / updateAgentStatus / updateAgentActivity. It is a framework-
 * agnostic body handler so the surface can mount it on any HTTP stack.
 *
 * It also maintains the declared-agent cache the plugin's `onStart`
 * re-declaration reads (`getDeclaredAgents`), so a plugin restart can
 * re-declare the roster. The cache is in-memory; an embedding surface that
 * wants cache survival across its own restarts persists it out-of-band (the
 * worker's next reconcile re-declares everyone regardless — declare is an
 * idempotent upsert).
 */

import type { PluginFeedOperation } from "./feed.js";
import { validatePluginFeedBatch } from "./feed.js";
import type { PluginAgentDeclaration, PluginAgentSource } from "./types.js";

/** Structural validation mirrors of the host's declaration gates
 * (pluginHost.ts AGENT_KEY_PATTERN etc.): the host re-validates everything
 * fail-closed; these cheap gates keep junk off the wire log. */
const AGENT_KEY_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_NAME_LENGTH = 100;
const MAX_ACTIVITY_LENGTH = 300;

export interface PluginFeedHandlerOptions {
  /** The registered plugin's agent source (from its PluginContext). */
  source: PluginAgentSource;
  /** Optional structured logger (ids/counts only, per the host's log rule). */
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

/** Result contract for the mounting surface. */
export type PluginFeedHandlerResult = {
  status: number;
  body: Record<string, unknown>;
};

/** In-memory declared-agent cache backing `getDeclaredAgents()`. */
export class DeclaredAgentCache {
  private readonly agents = new Map<string, PluginAgentDeclaration>();

  recordDeclare(agents: PluginAgentDeclaration[]): void {
    for (const agent of agents) this.agents.set(agent.key, agent);
  }

  recordRemove(keys: string[]): void {
    for (const key of keys) this.agents.delete(key);
  }

  getDeclaredAgents(): PluginAgentDeclaration[] {
    return [...this.agents.values()];
  }
}

function validDeclaration(value: unknown): value is PluginAgentDeclaration {
  if (typeof value !== "object" || value === null) return false;
  const decl = value as Record<string, unknown>;
  if (typeof decl.key !== "string" || !AGENT_KEY_PATTERN.test(decl.key)) return false;
  if (typeof decl.name !== "string" || decl.name.trim().length === 0) return false;
  if (decl.palette !== undefined && (typeof decl.palette !== "number" || !Number.isInteger(decl.palette) || decl.palette < 0)) {
    return false;
  }
  if (
    decl.hueShift !== undefined
    && (typeof decl.hueShift !== "number" || !Number.isInteger(decl.hueShift) || decl.hueShift < 0 || decl.hueShift > 360)
  ) {
    return false;
  }
  return true;
}

/** Validate every operation in a batch (all-or-nothing, host precedent). */
function validateOperations(operations: PluginFeedOperation[]): string[] {
  const errors: string[] = [];
  operations.forEach((op, index) => {
    switch (op.op) {
      case "declareAgents": {
        const agents = op.agents as unknown[];
        if (!Array.isArray(agents) || agents.length === 0) {
          errors.push(`operations[${index}].agents must be a non-empty array`);
          break;
        }
        for (const agent of agents) {
          if (!validDeclaration(agent)) {
            errors.push(`operations[${index}] has an invalid declaration`);
            break;
          }
        }
        break;
      }
      case "removeAgents": {
        if (!Array.isArray(op.keys) || op.keys.some((k) => typeof k !== "string")) {
          errors.push(`operations[${index}].keys must be an array of strings`);
        }
        break;
      }
      case "updateAgentStatus": {
        if (typeof op.key !== "string" || !AGENT_KEY_PATTERN.test(op.key)) {
          errors.push(`operations[${index}].key is invalid`);
        }
        if (op.status !== "active" && op.status !== "waiting") {
          errors.push(`operations[${index}].status must be 'active' or 'waiting'`);
        }
        break;
      }
      case "updateAgentActivity": {
        if (typeof op.key !== "string" || !AGENT_KEY_PATTERN.test(op.key)) {
          errors.push(`operations[${index}].key is invalid`);
        }
        if (
          op.activity !== null
          && (typeof op.activity !== "string" || op.activity.trim().length === 0)
        ) {
          errors.push(`operations[${index}].activity must be a non-empty string or null`);
        }
        break;
      }
      default:
        errors.push(`operations[${index}] has unknown op`);
    }
  });
  return errors;
}

/**
 * Create the `POST /api/plugin-feed` body handler. Framework-agnostic: the
 * surface reads the request body and calls `handle(rawBody)` with the parsed
 * JSON value.
 */
export function createPluginFeedHandler(options: PluginFeedHandlerOptions): {
  handle(rawBody: unknown): Promise<PluginFeedHandlerResult>;
  /** The declared-agent cache (wired into the plugin deps' getDeclaredAgents). */
  cache: DeclaredAgentCache;
} {
  const cache = new DeclaredAgentCache();

  const applyOperation = (op: PluginFeedOperation): void => {
    switch (op.op) {
      case "declareAgents": {
        // The host validates again (all-or-nothing per call) and assigns
        // seats through its sanctioned path.
        const agents = (op.agents as PluginAgentDeclaration[]).map((agent) => ({
          ...agent,
          name: agent.name.trim().slice(0, MAX_NAME_LENGTH),
        }));
        options.source.declareAgents(agents);
        cache.recordDeclare(agents);
        options.log?.("paperclip_feed_declare", { count: agents.length });
        break;
      }
      case "removeAgents":
        options.source.removeAgents(op.keys);
        cache.recordRemove(op.keys);
        options.log?.("paperclip_feed_remove", { count: op.keys.length });
        break;
      case "updateAgentStatus":
        options.source.updateAgentStatus(op.key, {
          status: op.status,
          ...(op.status === "waiting" ? { awaitingInput: op.awaitingInput === true } : {}),
        });
        break;
      case "updateAgentActivity": {
        const activity =
          op.activity === null ? null : op.activity.trim().slice(0, MAX_ACTIVITY_LENGTH);
        options.source.updateAgentActivity(op.key, activity);
        break;
      }
    }
  };

  return {
    cache,
    async handle(rawBody: unknown): Promise<PluginFeedHandlerResult> {
      const { errors, batch } = validatePluginFeedBatch(rawBody);
      if (errors.length > 0 || !batch) {
        options.log?.("paperclip_feed_rejected", { errorCount: errors.length });
        return { status: 400, body: { ok: false, error: "invalidFeedBatch", errors } };
      }
      const opErrors = validateOperations(batch.operations);
      if (opErrors.length > 0) {
        options.log?.("paperclip_feed_rejected", { errorCount: opErrors.length });
        return { status: 400, body: { ok: false, error: "invalidFeedOperations", errors: opErrors } };
      }
      // Auth/authorization is the mounting surface's concern (it owns the
      // same trust boundary the retired relay endpoint had).
      for (const op of batch.operations) {
        applyOperation(op);
      }
      return { status: 200, body: { ok: true, applied: batch.operations.length } };
    },
  };
}
