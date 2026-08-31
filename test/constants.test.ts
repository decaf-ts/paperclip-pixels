import { describe, expect, it } from "vitest";
import { BRIDGE_EVENT_KINDS } from "../src/core/index.js";
import {
  ACTION_KEYS,
  DATA_KEYS,
  JOB_KEYS,
  MANIFEST_CAPABILITIES,
  PLUGIN_API_VERSION,
  PLUGIN_ID,
  PLUGIN_VERSION,
  RECONCILIATION_DEFAULT_INTERVAL_MS,
  STATE_KEYS,
  STATE_NAMESPACES,
  STREAM_CHANNELS,
  SUBSCRIBED_EVENT_TYPES,
} from "../src/constants.js";

describe("constants", () => {
  it("identifies the plugin", () => {
    expect(PLUGIN_ID).toBe("paperclip-pixel.paperclip-plugin");
    // Bumped 2026-08-31 alongside package.json's own version (was drifted at
    // "0.1.0" while package.json had already moved to 0.2.0) as part of the
    // x-paperclip-advanced schema fix + ctx.http.fetch bypass release.
    expect(PLUGIN_VERSION).toBe("0.4.0");
    expect(PLUGIN_API_VERSION).toBe(1);
  });

  it("declares the bridge job/action/data/stream keys", () => {
    expect(JOB_KEYS).toEqual({ reconciliation: "bridge-reconcile" });
    expect(ACTION_KEYS).toEqual({
      companySendMessage: "company.send-message",
      agentReplyToFeedback: "agent.reply-to-feedback",
      setAgentAppearance: "agent.set-pixel-appearance",
    });
    expect(DATA_KEYS).toEqual({
      bridgeSnapshot: "bridge-snapshot",
      companySummary: "company-summary",
      agentBehavior: "agent-behavior",
      outstandingFeedback: "outstanding-feedback",
      visualSettings: "visual-settings",
    });
    expect(STREAM_CHANNELS).toEqual({ bridge: "bridge", behavior: "behavior" });
  });

  it("declares state keys scoped to the bridge namespace", () => {
    expect(STATE_KEYS).toEqual({
      compactBuckets: "compact-buckets",
      lastReconciledAt: "last-reconciled-at",
      schemaVersion: "schema-version",
      leadershipAgentId: "leadership-agent-id",
    });
    expect(STATE_NAMESPACES).toEqual({ bridge: "bridge" });
  });

  it("defaults reconciliation to five minutes", () => {
    expect(RECONCILIATION_DEFAULT_INTERVAL_MS).toBe(5 * 60 * 1000);
  });

  it("subscribes to exactly the core bridge event kinds, in the same order", () => {
    expect([...SUBSCRIBED_EVENT_TYPES]).toEqual([...BRIDGE_EVENT_KINDS]);
  });

  it("declares a least-privilege capability set with no issue-create/update capabilities", () => {
    const readonlyNegative = [
      "issues.create",
      "issues.update",
      "issues.delete",
    ] as const;
    for (const cap of readonlyNegative) {
      expect(MANIFEST_CAPABILITIES).not.toContain(cap);
    }
    // The relay's outbound push is SDK-gated (`ctx.http.fetch`, declared
    // `http.outbound`), and its bearer token is resolved from a secret reference
    // (`ctx.secrets.resolve`, declared `secrets.read-ref`).
    expect(MANIFEST_CAPABILITIES).toContain("http.outbound");
    expect(MANIFEST_CAPABILITIES).toContain("secrets.read-ref");
    expect(MANIFEST_CAPABILITIES).not.toContain("events.emit");
    expect(MANIFEST_CAPABILITIES).toContain("issue.comments.create");
    expect(MANIFEST_CAPABILITIES).toContain("issue.comments.create_human_attributed");
  });

  it("grants the required read/state/session/replay/relay capability surface", () => {
    const required = [
      "companies.read",
      "projects.read",
      "issues.read",
      "issue.subtree.read",
      "issue.comments.read",
      "agents.read",
      "approvals.read",
      "events.subscribe",
      "plugin.state.read",
      "plugin.state.write",
      "agent.sessions.create",
      "agent.sessions.send",
      "secrets.read-ref",
      "http.outbound",
      "ui.page.register",
    ] as const;
    for (const cap of required) {
      expect(MANIFEST_CAPABILITIES).toContain(cap);
    }
  });
});
