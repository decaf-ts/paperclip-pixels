import type { BridgeInputEvent } from "./core/index.js";
import type { PluginEvent } from "@paperclipai/plugin-sdk";

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function asStringOrNull(v: unknown): string | null | undefined {
  if (v === null || v === undefined) return v === null ? null : undefined;
  return typeof v === "string" ? v : undefined;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === "number" ? v : undefined;
}

function actorFromEvent(event: PluginEvent): { id?: string; type?: "user" | "agent" | "system" | "plugin" } {
  return {
    id: asString(event.actorId),
    type: event.actorType,
  };
}

function entityFromEvent(event: PluginEvent): { id?: string; type?: string } {
  return {
    id: asString(event.entityId),
    type: event.entityType,
  };
}

function baseFields(event: PluginEvent): {
  eventId: string;
  timestamp: string;
  companyId: string;
  actor: { id?: string; type?: "user" | "agent" | "system" | "plugin" };
  entity: { id?: string; type?: string };
} {
  return {
    eventId: event.eventId,
    timestamp: event.occurredAt,
    companyId: event.companyId,
    actor: actorFromEvent(event),
    entity: entityFromEvent(event),
  };
}

export function mapPluginEvent(event: PluginEvent): BridgeInputEvent | null {
  const base = baseFields(event);
  const p = (event.payload ?? {}) as Record<string, unknown>;

  switch (event.eventType) {
    case "agent.status_changed": {
      return {
        ...base,
        kind: "agent.status_changed",
        payload: {
          agentId: asString(p.agentId) ?? event.entityId ?? "",
          status: asString(p.status) ?? "unknown",
          previousStatus: asString(p.previousStatus),
        },
      };
    }
    case "agent.run.started": {
      return {
        ...base,
        kind: "agent.run.started",
        payload: {
          runId: asString(p.runId) ?? "",
          agentId: asString(p.agentId) ?? "",
          issueId: asStringOrNull(p.issueId),
          projectId: asStringOrNull(p.projectId),
          invocationSource: asStringOrNull(p.invocationSource),
          startedAt: asStringOrNull(p.startedAt) ?? event.occurredAt,
        },
      };
    }
    case "agent.run.finished": {
      return {
        ...base,
        kind: "agent.run.finished",
        payload: {
          runId: asString(p.runId) ?? "",
          agentId: asString(p.agentId) ?? "",
          issueId: asStringOrNull(p.issueId),
          projectId: asStringOrNull(p.projectId),
          status: asString(p.status) ?? "finished",
          finishedAt: asStringOrNull(p.finishedAt) ?? event.occurredAt,
          durationMs: asNumber(p.durationMs),
        },
      };
    }
    case "agent.run.failed": {
      return {
        ...base,
        kind: "agent.run.failed",
        payload: {
          runId: asString(p.runId) ?? "",
          agentId: asString(p.agentId) ?? "",
          issueId: asStringOrNull(p.issueId),
          projectId: asStringOrNull(p.projectId),
          error: p.error,
          finishedAt: asStringOrNull(p.finishedAt) ?? event.occurredAt,
        },
      };
    }
    case "agent.run.cancelled": {
      return {
        ...base,
        kind: "agent.run.cancelled",
        payload: {
          runId: asString(p.runId) ?? "",
          agentId: asString(p.agentId) ?? "",
          issueId: asStringOrNull(p.issueId),
          projectId: asStringOrNull(p.projectId),
          finishedAt: asStringOrNull(p.finishedAt) ?? event.occurredAt,
        },
      };
    }
    case "issue.updated": {
      return {
        ...base,
        kind: "issue.updated",
        payload: {
          issueId: asString(p.issueId) ?? event.entityId ?? "",
          projectId: asStringOrNull(p.projectId),
          status: asString(p.status) ?? "unknown",
          title: asString(p.title),
          assigneeAgentId: asStringOrNull(p.assigneeAgentId),
          blocked: typeof p.blocked === "boolean" ? p.blocked : undefined,
        },
      };
    }
    case "issue.comment.created": {
      return {
        ...base,
        kind: "issue.comment.created",
        payload: {
          commentId: asString(p.commentId) ?? "",
          issueId: asString(p.issueId) ?? event.entityId ?? "",
          agentId: asStringOrNull(p.agentId),
          userId: asStringOrNull(p.userId),
          body: asString(p.body) ?? "",
          isQuestion: typeof p.isQuestion === "boolean" ? p.isQuestion : undefined,
        },
      };
    }
    case "approval.created": {
      return {
        ...base,
        kind: "approval.created",
        payload: {
          approvalId: asString(p.approvalId) ?? event.entityId ?? "",
          issueId: asStringOrNull(p.issueId),
          agentId: asStringOrNull(p.agentId),
          type: asString(p.type),
          status: asString(p.status) ?? "pending",
        },
      };
    }
    case "approval.decided": {
      return {
        ...base,
        kind: "approval.decided",
        payload: {
          approvalId: asString(p.approvalId) ?? event.entityId ?? "",
          issueId: asStringOrNull(p.issueId),
          decision: asString(p.decision) ?? "decided",
          decidedAt: asStringOrNull(p.decidedAt) ?? event.occurredAt,
        },
      };
    }
    case "budget.incident.opened": {
      return {
        ...base,
        kind: "budget.incident.opened",
        payload: {
          incidentId: asString(p.incidentId) ?? event.entityId ?? "",
          scopeType: asString(p.scopeType) ?? "",
          scopeId: asString(p.scopeId) ?? "",
          metric: asString(p.metric) ?? "",
          status: asString(p.status) ?? "open",
        },
      };
    }
    case "budget.incident.resolved": {
      return {
        ...base,
        kind: "budget.incident.resolved",
        payload: {
          incidentId: asString(p.incidentId) ?? event.entityId ?? "",
          scopeType: asString(p.scopeType) ?? "",
          scopeId: asString(p.scopeId) ?? "",
          status: asString(p.status) ?? "resolved",
        },
      };
    }
    case "cost_event.created": {
      return {
        ...base,
        kind: "cost_event.created",
        payload: {
          costEventId: asString(p.costEventId) ?? event.entityId ?? "",
          agentId: asStringOrNull(p.agentId),
          runId: asStringOrNull(p.runId),
          issueId: asStringOrNull(p.issueId),
          projectId: asStringOrNull(p.projectId),
          costCents: asNumber(p.costCents),
          inputTokens: asNumber(p.inputTokens),
          outputTokens: asNumber(p.outputTokens),
        },
      };
    }
    // The host's generic activity-log payload construction always overwrites
    // a `payload.agentId` field with the *actor* who performed the action
    // (confirmed by reading server/src/services/activity-log.ts), so the new
    // agent's own id is only reliably available as the envelope's top-level
    // `entityId` — never `p.agentId` here.
    case "agent.created": {
      return {
        ...base,
        kind: "agent.created",
        payload: {
          agentId: event.entityId ?? "",
          name: asString(p.name),
          role: asString(p.role),
        },
      };
    }
    case "agent.error_cleared": {
      return {
        ...base,
        kind: "agent.error_cleared",
        payload: {
          agentId: event.entityId ?? "",
        },
      };
    }
    case "issue.checked_out": {
      return {
        ...base,
        kind: "issue.checked_out",
        payload: {
          issueId: event.entityId ?? "",
          // Best-effort: this is the actor performing the checkout API call,
          // which equals the checking-out agent in the common self-checkout
          // pattern, but is not guaranteed for a human/system-triggered
          // checkout on another agent's behalf.
          agentId: asStringOrNull(p.agentId),
        },
      };
    }
    case "issue.assignment_wakeup_requested": {
      return {
        ...base,
        kind: "issue.assignment_wakeup_requested",
        payload: {
          issueId: event.entityId ?? "",
          assigneeAgentId: asStringOrNull(p.assigneeAgentId),
          reason: asString(p.reason),
        },
      };
    }
    case "issue.document.created": {
      return {
        ...base,
        kind: "issue.document.created",
        payload: {
          issueId: event.entityId ?? "",
          documentId: asString(p.documentId),
          title: asString(p.title),
          agentId: asStringOrNull(p.agentId),
        },
      };
    }
    case "issue.document.updated": {
      return {
        ...base,
        kind: "issue.document.updated",
        payload: {
          issueId: event.entityId ?? "",
          documentId: asString(p.documentId),
          title: asString(p.title),
          agentId: asStringOrNull(p.agentId),
        },
      };
    }
    default:
      return null;
  }
}
