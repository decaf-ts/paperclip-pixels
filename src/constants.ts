/** Unique identifier for this Paperclip plugin. */
export const PLUGIN_ID = "paperclip-pixel.paperclip-plugin";
/** Semantic version of the plugin package. */
export const PLUGIN_VERSION = "0.2.1";
/** Version of the Paperclip Plugin API this manifest conforms to. */
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

/** Job identifiers used by the plugin's scheduled tasks. */
export const JOB_KEYS = {
  reconciliation: "bridge-reconcile",
} as const;

/** Action identifiers for UI interactions and plugin commands. */
export const ACTION_KEYS = {
  companySendMessage: "company.send-message",
  agentReplyToFeedback: "agent.reply-to-feedback",
} as const;

/** Data endpoint keys exposed by the plugin for external consumption. */
export const DATA_KEYS = {
  bridgeSnapshot: "bridge-snapshot",
  companySummary: "company-summary",
  agentBehavior: "agent-behavior",
  outstandingFeedback: "outstanding-feedback",
} as const;

/** Stream channel names used for emitting plugin events. */
export const STREAM_CHANNELS = {
  bridge: "bridge",
  behavior: "behavior",
} as const;

/** Returns the company‑scoped behavior stream channel name. */
export function behaviorChannel(companyId: string): string {
  return `behavior:${companyId}`;
}

/** Keys for plugin persisted state entries. */
export const STATE_KEYS = {
  compactBuckets: "compact-buckets",
  lastReconciledAt: "last-reconciled-at",
  schemaVersion: "schema-version",
  leadershipAgentId: "leadership-agent-id",
} as const;

/** Namespaces used for grouping plugin persisted state. */
export const STATE_NAMESPACES = {
  bridge: "bridge",
} as const;

/** Default interval (in ms) for the bridge reconciliation job. */
export const RECONCILIATION_DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * List of Paperclip event types this plugin subscribes to. Cross-referenced
 * 2026-08-31 against the host's full, authoritative catalog
 * (`@paperclipai/shared`'s `PLUGIN_EVENT_TYPES`, 33 entries total) to find
 * additional signal worth carrying into the bridge beyond the original 12.
 * Deliberately still NOT subscribed: `company.*`, `project.*` (organizational,
 * not agent-scoped — better fits Paperclip's own embedded UI than a
 * per-character animation), `goal.*` (same reasoning), `issue.created`
 * (no assignee yet, nothing agent-visual to say), `issue.relations.updated`
 * (dependency-graph detail, sidecar-appropriate at best),
 * `issue.document.deleted` (no honest "undo a Write" animation), and
 * `activity.logged` (a generic catch-all for actions with no dedicated event
 * type — subscribing risks duplicating the specific types below with noise).
 */
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
  "agent.created",
  "agent.error_cleared",
  "issue.checked_out",
  "issue.assignment_wakeup_requested",
  "issue.document.created",
  "issue.document.updated",
] as const;

/** Capability identifiers required by the plugin manifest. */
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
  // Required to resolve the operator-bound `pixelAgentsTokenRef` secret
  // reference into the bearer token used by the relay's HttpPushSink. The raw
  // token is never persisted in plugin config; only the secret_ref binding is.
  "secrets.read-ref",
  // The relay's outbound push to the Pixel Agents hook endpoint is routed
  // through the SDK-gated `ctx.http.fetch` (never the Node global fetch), so
  // the host's capability validator and audit tracing cover it like any other
  // outbound request. Push is operator-gated per company (see relay.ts).
  "http.outbound",
  "ui.page.register",
  "ui.sidebar.register",
  // Required by the host's plugin-capability-validator: any non-empty
  // manifest.jobs requires the `jobs.schedule` capability to be declared.
  // The bridge schedules the `bridge-reconcile` job (see manifest.ts).
  "jobs.schedule",
] as const;
