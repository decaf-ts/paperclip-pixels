import { describe, expect, it, vi } from "vitest";

import {
  DIALOG_EXTRACT_MAX_CHARS_OPT_IN,
  DIALOG_EXTRACT_MAX_CHARS_REDACTED,
  DIALOG_LINE_MAX_CHARS,
  clampDialogLine,
  dialogExtract,
  redactSensitiveText,
} from "../dialog.js";
import { createPluginFeedHandler } from "../index.js";
import type { PluginAgentSource } from "../index.js";

/**
 * Acceptance tests for the WS4-C dialog-pane privacy guardrails (spec
 * PAPERCLIP_PIXELS-2, WS4-C; PAPERCLIP_PIXELS-1 NFR-7; CEO decision 2).
 *
 * Two layers, both plugin-side:
 * - `src/core/domain/dialog.ts`: secret redaction (always on) + mode-
 *   dependent extract truncation (OFF ≤ 120 chars, ON ≤ 480) + the shared
 *   600-char wire clamp.
 * - `src/pixel-agents-plugin/feed-server.ts`: the `dialogLines` apply-side
 *   defense in depth — batch/line validation, the 8-lines-per-batch cap,
 *   the 600-char re-clamp, and fail-closed 400s for malformed pushes and
 *   missing sinks.
 *
 * Fail-on-old-code intent: a pre-guardrail implementation that ships the
 * full comment body unredacted fails every truncation and every
 * secret-absence assertion below.
 */

const COMPANY_ID = "company-acme";

const BEARER_TOKEN = "AbCdEf1234567890";
const API_KEY_VALUE = "sk-live-9876543210fedcba";
const DB_PASSWORD_VALUE = "hunter2-super-secret";
const MY_TOKEN_VALUE = "ghp_AbCdEf123456789012345";

const SENSITIVE_BODY = [
  `Please deploy the service. Authorization: Bearer ${BEARER_TOKEN}`,
  `config: api_key=${API_KEY_VALUE}`,
  `db_password=${DB_PASSWORD_VALUE}`,
  `MY_API_TOKEN=${MY_TOKEN_VALUE}`,
  "and then " + "lorem ipsum dolor sit amet ".repeat(60),
].join(". ");

function makeSource(): PluginAgentSource {
  return {
    declareAgents: vi.fn(),
    removeAgents: vi.fn(),
    updateAgentStatus: vi.fn(),
    updateAgentActivity: vi.fn(),
    updateAgentLabelPolicy: vi.fn(),
  } satisfies PluginAgentSource;
}

function batch(operations: unknown[]): unknown {
  return { schemaVersion: 1, companyId: COMPANY_ID, operations };
}

// -- dialogExtract: truncation ----------------------------------------------------

describe("dialogExtract — mode-dependent truncation", () => {
  it("privacy toggle OFF: a long sensitive body ships as ≤121 chars (120 + ellipsis)", () => {
    expect(SENSITIVE_BODY.length).toBeGreaterThan(DIALOG_EXTRACT_MAX_CHARS_REDACTED);
    const extract = dialogExtract(SENSITIVE_BODY, false);
    expect(extract.length).toBeLessThanOrEqual(DIALOG_EXTRACT_MAX_CHARS_REDACTED + 1);
    expect(extract.endsWith("…")).toBe(true);
  });

  it("privacy toggle ON: a fuller but still bounded extract (≤481 chars)", () => {
    const extract = dialogExtract(SENSITIVE_BODY, true);
    expect(extract.length).toBeLessThanOrEqual(DIALOG_EXTRACT_MAX_CHARS_OPT_IN + 1);
    expect(extract.length).toBeGreaterThan(DIALOG_EXTRACT_MAX_CHARS_REDACTED + 1);
    expect(extract.endsWith("…")).toBe(true);
  });

  it("a short body ships whole in both modes (no needless cut)", () => {
    expect(dialogExtract("Which database?", false)).toBe("Which database?");
    expect(dialogExtract("Which database?", true)).toBe("Which database?");
  });

  it("whitespace is collapsed and empty input yields the empty string", () => {
    expect(dialogExtract("  a \n\t b  ", false)).toBe("a b");
    expect(dialogExtract("", false)).toBe("");
    expect(dialogExtract("   ", true)).toBe("");
  });
});

// -- dialogExtract / redactSensitiveText: secrets never ride the pane ---------------

describe("dialogExtract — secret redaction (both modes)", () => {
  it("OFF mode: no Bearer token, api key, db_password, or compound token value survives", () => {
    const extract = dialogExtract(SENSITIVE_BODY, false);
    expect(extract).not.toContain(BEARER_TOKEN);
    expect(extract).not.toContain(API_KEY_VALUE);
    expect(extract).not.toContain(DB_PASSWORD_VALUE);
    expect(extract).not.toContain(MY_TOKEN_VALUE);
  });

  it("ON mode: secrets are redacted even when the company opted in", () => {
    const extract = dialogExtract(SENSITIVE_BODY, true);
    expect(extract).not.toContain(BEARER_TOKEN);
    expect(extract).not.toContain(API_KEY_VALUE);
    expect(extract).not.toContain(DB_PASSWORD_VALUE);
    expect(extract).not.toContain(MY_TOKEN_VALUE);
  });

  it("redactSensitiveText keeps the key name but drops the value for assignment-style credentials", () => {
    expect(redactSensitiveText(`api_key=${API_KEY_VALUE}`)).toBe("api_key=[redacted]");
    expect(redactSensitiveText(`"db_password": "${DB_PASSWORD_VALUE}"`)).toContain("db_password");
    expect(redactSensitiveText(`"db_password": "${DB_PASSWORD_VALUE}"`)).not.toContain(DB_PASSWORD_VALUE);
    // Compound keys (leading identifier characters shielded from a \b anchor).
    expect(redactSensitiveText(`MY_API_TOKEN=${MY_TOKEN_VALUE}`)).not.toContain(MY_TOKEN_VALUE);
    expect(redactSensitiveText(`refresh_token=${MY_TOKEN_VALUE}`)).not.toContain(MY_TOKEN_VALUE);
  });

  it("redactSensitiveText masks Bearer authorization credentials", () => {
    expect(redactSensitiveText(`Bearer ${BEARER_TOKEN}`)).not.toContain(BEARER_TOKEN);
    expect(redactSensitiveText(`Authorization: Bearer ${BEARER_TOKEN}`)).not.toContain(BEARER_TOKEN);
  });

  // FIXED (SAA-620 follow-up): dialog.ts gained a Basic-auth pattern applied
  // right after the bearer pass.
  it("redactSensitiveText masks short Basic authorization credentials", () => {
    const basic = "dXNlcjpwYXNzd29yZA=="; // base64("user:password")
    const redacted = redactSensitiveText(`Authorization: Basic ${basic}`);
    expect(redacted).not.toContain(basic);
    expect(redacted).toContain("Basic [redacted]");
  });

  it("redactSensitiveText masks long credential-shaped runs (JWTs, hex/base64 keys)", () => {
    const run = "a".repeat(40);
    expect(redactSensitiveText(`token ${run}`)).not.toContain(run);
  });
});

// -- clampDialogLine: the shared wire cap -------------------------------------------

describe("clampDialogLine — 600-char wire cap", () => {
  it("caps an over-long composed line at 600 chars + ellipsis", () => {
    const line = "x".repeat(DIALOG_LINE_MAX_CHARS + 100);
    const clamped = clampDialogLine(line);
    expect(clamped.length).toBe(DIALOG_LINE_MAX_CHARS + 1);
    expect(clamped.endsWith("…")).toBe(true);
  });

  it("leaves short lines untouched and collapses whitespace", () => {
    expect(clampDialogLine("Human: hi")).toBe("Human: hi");
    expect(clampDialogLine("  a \n b ")).toBe("a b");
    expect(clampDialogLine("   ")).toBe("");
  });
});

// -- feed-server dialogLines: apply-side defense in depth ---------------------------

describe("feed-server — dialogLines apply-side guardrails", () => {
  it("emits well-formed lines through the dialog sink and logs the count", async () => {
    const source = makeSource();
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const emitLines = vi.fn();
    const { handle } = createPluginFeedHandler({
      source,
      dialog: { emitLines },
      log: (event, fields) => logs.push({ event, fields }),
    });

    const result = await handle(
      batch([{ op: "dialogLines", lines: [{ text: "line one" }, { text: "line two" }] }]),
    );
    expect(result.status).toBe(200);
    expect(emitLines).toHaveBeenCalledWith([{ text: "line one" }, { text: "line two" }]);
    expect(logs).toContainEqual({
      event: "paperclip_feed_dialog_lines",
      fields: { count: 2 },
    });
  });

  it("re-clamps each line to 600 chars at the apply boundary (defense in depth)", async () => {
    const source = makeSource();
    const emitLines = vi.fn();
    const { handle } = createPluginFeedHandler({ source, dialog: { emitLines } });

    const long = "y".repeat(700);
    await handle(batch([{ op: "dialogLines", lines: [{ text: long }] }]));
    expect(emitLines).toHaveBeenCalledTimes(1);
    const [emitted] = emitLines.mock.calls[0][0] as Array<{ text: string }>;
    expect(emitted.text.length).toBeLessThanOrEqual(600);
    expect(emitted.text).not.toContain(long);
  });

  it("rejects more than 8 lines per batch with 400 (all-or-nothing)", async () => {
    const source = makeSource();
    const emitLines = vi.fn();
    const { handle } = createPluginFeedHandler({ source, dialog: { emitLines } });

    const lines = Array.from({ length: 9 }, (_, i) => ({ text: `line ${i}` }));
    const result = await handle(batch([{ op: "dialogLines", lines }]));
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("at most 8");
    expect(emitLines).not.toHaveBeenCalled();
  });

  it("accepts exactly 8 lines", async () => {
    const source = makeSource();
    const emitLines = vi.fn();
    const { handle } = createPluginFeedHandler({ source, dialog: { emitLines } });
    const lines = Array.from({ length: 8 }, (_, i) => ({ text: `line ${i}` }));
    expect((await handle(batch([{ op: "dialogLines", lines }]))).status).toBe(200);
  });

  it.each([
    ["a non-array lines field", { op: "dialogLines", lines: "nope" }],
    ["an empty lines array", { op: "dialogLines", lines: [] }],
    ["a line without string text", { op: "dialogLines", lines: [{ text: 42 }] }],
    ["a whitespace-only line", { op: "dialogLines", lines: [{ text: "   " }] }],
    ["a null line", { op: "dialogLines", lines: [null] }],
  ])("rejects %s with 400", async (_label, operation) => {
    const source = makeSource();
    const emitLines = vi.fn();
    const { handle } = createPluginFeedHandler({ source, dialog: { emitLines } });
    const result = await handle(batch([operation]));
    expect(result.status).toBe(400);
    expect(emitLines).not.toHaveBeenCalled();
  });

  it("rejects any dialogLines push with 400 when no dialog sink is wired (fail-closed, not silent)", async () => {
    const source = makeSource();
    const { handle } = createPluginFeedHandler({ source });
    const result = await handle(batch([{ op: "dialogLines", lines: [{ text: "hi" }] }]));
    expect(result.status).toBe(400);
    expect(JSON.stringify(result.body)).toContain("dialog sink unavailable");
  });

  it("one invalid dialog operation rejects the whole batch: nothing else applies", async () => {
    const source = makeSource();
    const emitLines = vi.fn();
    const { handle } = createPluginFeedHandler({ source, dialog: { emitLines } });

    const result = await handle(
      batch([
        { op: "declareAgents", agents: [{ key: "agent-a", name: "Agent A" }] },
        { op: "dialogLines", lines: [] },
      ]),
    );
    expect(result.status).toBe(400);
    expect(source.declareAgents).not.toHaveBeenCalled();
    expect(emitLines).not.toHaveBeenCalled();
  });

  it("assignAgentAppearance applies through the appearance sink; a missing sink is a 400", async () => {
    const source = makeSource();
    const assign = vi.fn();
    const withSink = createPluginFeedHandler({ source, appearance: { assign } });
    const applied = await withSink.handle(
      batch([{ op: "assignAgentAppearance", key: "agent-a", characterId: "pixel-agents:char-3" }]),
    );
    expect(applied.status).toBe(200);
    expect(assign).toHaveBeenCalledWith("agent-a", "pixel-agents:char-3");

    const noSink = createPluginFeedHandler({ source });
    const refused = await noSink.handle(
      batch([{ op: "assignAgentAppearance", key: "agent-a", characterId: "pixel-agents:char-3" }]),
    );
    expect(refused.status).toBe(400);
    expect(JSON.stringify(refused.body)).toContain("appearance sink unavailable");
  });
});
