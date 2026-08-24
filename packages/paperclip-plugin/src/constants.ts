export const PLUGIN_ID = "paperclip-pixel.paperclip-plugin";
export const PLUGIN_VERSION = "0.1.0";
export const PLUGIN_API_VERSION = 1 as const;

/** UI slot identifiers used by the plugin to register UI slots with the host. */
export const UI_SLOT_IDS = {
  page: "pixel-office-page",
  sidebar: "pixel-office-sidebar",
} as const;

/** Export names that correspond to each UI slot's React component. */
export const UI_EXPORT_NAMES = {
  page: "PixelOfficePage",
  sidebar: "PixelOfficeSidebar",
} as const;

/** Route segment under which the Pixel Office page is mounted in the host UI. */
export const PIXEL_OFFICE_PAGE_ROUTE = "pixel-office";

export const JOB_KEYS = {
  reconciliation: "bridge-reconcile",
} as const;

export const ACTION_KEYS = {
  companySendMessage: "company.send-message",
  agentReplyToFeedback: "agent.reply-to-feedback",
} as const;

export const DATA_KEYS = {
  bridgeSnapshot: "bridge-snapshot",
  companySummary: "company-summary",
  agentBehavior: "agent-behavior",
  outstandingFeedback: "outstanding-feedback",
} as const;

export const STREAM_CHANNELS = {
  bridge: "bridge",
  behavior: "behavior",
} as const;

/** Returns the company‑scoped behavior stream channel name. */
export function behaviorChannel(companyId: string): string {
  return `behavior:${companyId}`;
}

export const STATE_KEYS = {
  compactBuckets: "compact-buckets",
  lastReconciledAt: "last-reconciled-at",
  schemaVersion: "schema-version",
  leadershipAgentId: "leadership-agent-id",
} as const;

export const STATE_NAMESPACES = {
  bridge: "bridge",
} as const;

export const RECONCILIATION_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

export const SUBSCRIBED_EVENT_TYPES = [
  "agent.status_changed",
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
  "issue.updated",
  "issue.comment.created",
  "approval.created",
  "approval.decided",
  "budget.incident.opened",
  "budget.incident.resolved",
  "cost_event.created",
] as const;

export const MANIFEST_CAPABILITIES = [
  "companies.read",
  "projects.read",
  "issues.read",
  "issue.comments.read",
  // L1: the reply action posts comments via ctx.issues.createComment.
  // `issue.comments.create` covers plugin-agent-attributed comments; the
  // handler relays a paired board user's reply with `actorUserId`, which the
  // SDK gates behind `issue.comments.create_human_attributed` (the host
  // independently re-verifies the user is an active company member).
  "issue.comments.create",
  "issue.comments.create_human_attributed",
  "agents.read",
  "approvals.read",
  "goals.read",
  "costs.read",
  "events.subscribe",
  "plugin.state.read",
  "plugin.state.write",
  "agent.sessions.create",
  "agent.sessions.list",
  "agent.sessions.send",
  "agent.sessions.close",
  "ui.page.register",
  "ui.sidebar.register",
  // Required by the host's plugin-capability-validator: any non-empty
  // manifest.jobs requires the `jobs.schedule` capability to be declared.
  // The bridge schedules the `bridge-reconcile` job (see manifest.ts).
  "jobs.schedule",
] as const;
