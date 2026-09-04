import { describe, expect, it } from "vitest";

import type { BridgeInputEvent } from "../src/core/index.js";
import plugin from "../src/worker.js";
import { parseRelayConfig, RELAY_CONFIG_FIELDS } from "../src/relay.js";
import {
  createPaperclipPluginManifest,
  PAPERCLIP_DIALOG_LINES_MESSAGE,
  PluginFeedMapper,
} from "../src/pixel-agents-plugin/index.js";
import { pluginDefinition } from "./typing.js";

/**
 * Acceptance tests for the WS4-C dialog-pane wiring ABOVE the pure guardrail
 * (test/dialog-guardrail.test.ts owns the core + feed-server layer):
 *
 * - the feed mapper's dialog lines under both `dialogPrivacyOptIn` toggle
 *   states (comment extracts, run edges, approval waits) and the agentLabel
 *   fallback order (appearance name → declared name → agent id, "Human" for
 *   user comments);
 * - the manifest registration: the dialog-pane shell-panel widget declared
 *   with the `paperclip.dialog.lines` message type and
 *   `sources.appearance === true` (the WS4-A gate);
 * - the relay/worker config plumbing: `dialogPanePrivacyOptIn` parses
 *   strict-true (anything but `=== true` means OFF) and the worker's
 *   `onValidateConfig` rejects non-boolean values.
 */

const COMPANY_ID = "company-acme";
const AGENT_A = "agent-a";
const ISO = "2026-09-01T00:00:00.000Z";

let eventCounter = 0;

function ev(kind: string, payload: Record<string, unknown>): BridgeInputEvent {
  eventCounter += 1;
  return {
    eventId: `evt-${eventCounter}`,
    timestamp: ISO,
    companyId: COMPANY_ID,
    kind,
    payload,
  } as unknown as BridgeInputEvent;
}

function comment(body: string, extra: Record<string, unknown> = {}): BridgeInputEvent {
  return ev("issue.comment.created", {
    commentId: `c-${eventCounter}`,
    issueId: "issue-1",
    body,
    ...extra,
  });
}

function runStarted(agentId: string): BridgeInputEvent {
  return ev("agent.run.started", { runId: "run-1", agentId, issueId: null });
}

/** The single dialogLines op of one mapper batch, as composed text. */
function dialogTexts(ops: ReturnType<PluginFeedMapper["mapEvent"]>): string[] {
  return ops
    .filter((op) => op.op === "dialogLines")
    .map((op) => (op as { lines: Array<{ text: string }> }).lines.map((l) => l.text))
    .flat();
}

// -- mapper: comment extracts under both toggle states ------------------------------

describe("PluginFeedMapper — dialog comment extracts vs dialogPrivacyOptIn", () => {
  const LONG_BODY = "We should migrate the invoices service to the new queue. ".repeat(20);

  it("default (OFF): a long comment ships as a short bounded extract", () => {
    const mapper = new PluginFeedMapper();
    const [line] = dialogTexts(mapper.mapEvent(comment(LONG_BODY, { agentId: null, userId: "u1" })));
    expect(line.startsWith("Human: ")).toBe(true);
    const extract = line.slice("Human: ".length);
    expect(extract.length).toBeLessThanOrEqual(121); // 120 + ellipsis
  });

  it("opt-in (ON): the same comment ships a fuller, still-bounded extract", () => {
    const mapper = new PluginFeedMapper({ dialogPrivacyOptIn: true });
    const [line] = dialogTexts(mapper.mapEvent(comment(LONG_BODY, { agentId: null, userId: "u1" })));
    const extract = line.slice("Human: ".length);
    expect(extract.length).toBeGreaterThan(121);
    expect(extract.length).toBeLessThanOrEqual(481); // 480 + ellipsis
  });

  it("only an explicit true opts in: undefined/false/\"true\"/1 all mean OFF", () => {
    for (const options of [undefined, {}, { dialogPrivacyOptIn: false }, { dialogPrivacyOptIn: "true" as never }, { dialogPrivacyOptIn: 1 as never }]) {
      const mapper = new PluginFeedMapper(options);
      const [line] = dialogTexts(mapper.mapEvent(comment(LONG_BODY, { agentId: null, userId: "u1" })));
      expect(line.slice("Human: ".length).length).toBeLessThanOrEqual(121);
    }
  });

  it("a sensitive comment is redacted in BOTH toggle states", () => {
    const secret = "sk-live-9876543210fedcba";
    const body = `Use api_key=${secret} for the deploy, thanks`;
    for (const optIn of [false, true]) {
      const mapper = new PluginFeedMapper({ dialogPrivacyOptIn: optIn });
      const [line] = dialogTexts(mapper.mapEvent(comment(body, { agentId: null, userId: "u1" })));
      expect(line).not.toContain(secret);
    }
  });

  it("a question comment carries the (question) author tag", () => {
    const mapper = new PluginFeedMapper();
    const [line] = dialogTexts(
      mapper.mapEvent(comment("Which database?", { agentId: null, userId: "u1", isQuestion: true })),
    );
    expect(line).toBe("Human (question): Which database?");
  });
});

// -- mapper: activity lines are toggle-independent -----------------------------------

describe("PluginFeedMapper — run/approval dialog lines (toggle-independent)", () => {
  it("run started/finished and approval-wait lines are identical under both toggles", () => {
    for (const optIn of [false, true]) {
      const mapper = new PluginFeedMapper({ dialogPrivacyOptIn: optIn });
      expect(dialogTexts(mapper.mapEvent(runStarted(AGENT_A)))).toEqual([`${AGENT_A} started a run`]);
      expect(dialogTexts(mapper.mapEvent(ev("agent.run.finished", { runId: "run-1", agentId: AGENT_A, issueId: null }))))
        .toEqual([`${AGENT_A} finished a run`]);
      expect(
        dialogTexts(
          mapper.mapEvent(ev("approval.created", { approvalId: "ap-1", issueId: null, agentId: AGENT_A, status: "pending" })),
        ),
      ).toEqual([`${AGENT_A} is waiting for an approval`]);
    }
  });
});

// -- mapper: agentLabel fallback order -------------------------------------------------

describe("PluginFeedMapper — dialog agentLabel fallback order", () => {
  it("appearance name wins when the agent is in the appearance map", () => {
    const mapper = new PluginFeedMapper();
    mapper.setAppearances([{
      agentId: AGENT_A,
      agentName: "Display A",
      characterId: "pixel-agents:char-3",
      palette: 3,
      hueShift: 45,
    }]);
    const [line] = dialogTexts(mapper.mapEvent(comment("hi", { agentId: AGENT_A, userId: null })));
    expect(line).toBe("Display A: hi");
  });

  it("falls back to the last declared name, then the raw agent id", () => {
    const mapper = new PluginFeedMapper();
    mapper.mapEvent(ev("agent.created", { agentId: AGENT_A, name: "Dev Agent" }));
    const [line] = dialogTexts(mapper.mapEvent(comment("hi", { agentId: AGENT_A, userId: null })));
    expect(line).toBe("Dev Agent: hi");

    const bare = new PluginFeedMapper();
    const [bareLine] = dialogTexts(bare.mapEvent(comment("hi", { agentId: "agent-x", userId: null })));
    expect(bareLine).toBe("agent-x: hi");
  });

  it("user comments are always authored by \"Human\"", () => {
    const mapper = new PluginFeedMapper();
    const [line] = dialogTexts(mapper.mapEvent(comment("hello", { agentId: null, userId: "user-1" })));
    expect(line).toBe("Human: hello");
  });
});

// -- registration: manifest surface -----------------------------------------------------

describe("registration — dialog-pane widget + appearance source", () => {
  it("declares the dialog-pane shell-panel widget fed by the dialog-lines message type", () => {
    const manifest = createPaperclipPluginManifest();
    const widget = manifest.contributes.widgets?.find((w) => w.id === "dialog-pane");
    expect(widget).toBeDefined();
    expect(widget).toMatchObject({
      id: "dialog-pane",
      kind: "shell-panel",
      binding: "global",
      label: "Paperclip conversation",
      messageTypes: [PAPERCLIP_DIALOG_LINES_MESSAGE],
    });
  });

  it("declares the paperclip.dialog.lines message type (const value pinned)", () => {
    const manifest = createPaperclipPluginManifest();
    expect(PAPERCLIP_DIALOG_LINES_MESSAGE).toBe("paperclip.dialog.lines");
    expect(
      manifest.contributes.messages?.some((m) => m.type === PAPERCLIP_DIALOG_LINES_MESSAGE),
    ).toBe(true);
  });

  it("declares sources.appearance === true (the WS4-A gate for the appearance path)", () => {
    const manifest = createPaperclipPluginManifest();
    expect(manifest.sources?.agents).toBe(true);
    expect(manifest.sources?.appearance).toBe(true);
  });
});

// -- config plumbing: relay strict-true parse + worker boolean validation ---------------

describe("config plumbing — dialogPanePrivacyOptIn", () => {
  it("parseRelayConfig: only an explicit boolean true opts in", () => {
    expect(parseRelayConfig({}).dialogPanePrivacyOptIn).toBe(false);
    expect(parseRelayConfig({ dialogPanePrivacyOptIn: true }).dialogPanePrivacyOptIn).toBe(true);
    expect(parseRelayConfig({ dialogPanePrivacyOptIn: false }).dialogPanePrivacyOptIn).toBe(false);
    expect(parseRelayConfig({ dialogPanePrivacyOptIn: "true" }).dialogPanePrivacyOptIn).toBe(false);
    expect(parseRelayConfig({ dialogPanePrivacyOptIn: 1 }).dialogPanePrivacyOptIn).toBe(false);
  });

  it("dialogPanePrivacyOptIn is part of the relay config field list", () => {
    expect(RELAY_CONFIG_FIELDS).toContain("dialogPanePrivacyOptIn");
  });

  it("worker onValidateConfig: a boolean or absent value is valid, anything else is rejected", async () => {
    const def = pluginDefinition(plugin);

    const okAbsent = await def.onValidateConfig!({});
    expect(okAbsent.ok).toBe(true);

    const okTrue = await def.onValidateConfig!({ dialogPanePrivacyOptIn: true });
    expect(okTrue.ok).toBe(true);

    const okFalse = await def.onValidateConfig!({ dialogPanePrivacyOptIn: false });
    expect(okFalse.ok).toBe(true);

    const bad = await def.onValidateConfig!({ dialogPanePrivacyOptIn: "yes" });
    expect(bad.ok).toBe(false);
    expect(bad.errors).toContain("dialogPanePrivacyOptIn must be a boolean when present");
  });
});
