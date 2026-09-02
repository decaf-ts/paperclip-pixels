import { describe, expect, it, vi } from "vitest";
import { ACTION_KEYS } from "../src/constants.js";
import { HttpReplyForwarder, parseReplyPayload } from "../src/pixel-agents-plugin/index.js";
import type { ReplyFetchLike, ReplyForwardRequest } from "../src/pixel-agents-plugin/index.js";

/**
 * Unit tests for `src/pixel-agents-plugin/reply-forwarder.ts` — the
 * transport boundary between the plugin's Pixel-Agents-side reply actions
 * and the plugin's EXISTING Paperclip intake/feedback actions (spec
 * PAPERCLIP_PIXELS-2, WS2-C).
 *
 * The fail-closed invariant under test: the only two routes are the existing
 * action keys (`agent.reply-to-feedback` / `company.send-message`) through
 * the sanctioned performAction proxy — anything else is rejected before any
 * HTTP happens, and there is no issue-creation path anywhere.
 */

const COMPANY_ID = "company-acme";

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function makeFetch(calls: FetchCall[], respond: () => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>) {
  return vi.fn(async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return respond();
  }) as unknown as ReplyFetchLike;
}

function forwarder(calls: FetchCall[], respond: Parameters<typeof makeFetch>[1], pluginId = "paperclip") {
  return new HttpReplyForwarder({
    apiBaseUrl: "https://paperclip.example/",
    apiToken: "board-key-1",
    pluginId,
    fetch: makeFetch(calls, respond),
  });
}

const okJson = (data: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ data }),
});

// -- parseReplyPayload ----------------------------------------------------------

describe("parseReplyPayload", () => {
  it("normalizes a valid reply-to-feedback payload", () => {
    expect(
      parseReplyPayload("reply-to-feedback", {
        companyId: COMPANY_ID,
        feedbackId: "feedback-1",
        text: " Here is the answer ",
      }),
    ).toEqual({
      request: {
        action: "reply-to-feedback",
        companyId: COMPANY_ID,
        feedbackId: "feedback-1",
        text: " Here is the answer ",
      },
    });
  });

  it("normalizes a valid send-message payload (no feedbackId)", () => {
    expect(
      parseReplyPayload("send-message", { companyId: COMPANY_ID, text: "Hello company" }),
    ).toEqual({
      request: { action: "send-message", companyId: COMPANY_ID, text: "Hello company" },
    });
  });

  it.each([
    ["null", null],
    ["an array", [{}]],
    ["a string", "hello"],
    ["missing companyId", { text: "hi" }],
    ["empty companyId", { companyId: "", text: "hi" }],
    ["non-string companyId", { companyId: 7, text: "hi" }],
    ["missing text", { companyId: COMPANY_ID }],
    ["whitespace-only text", { companyId: COMPANY_ID, text: "   " }],
    ["a missing feedbackId", { companyId: COMPANY_ID, text: "hi" }],
    ["an empty feedbackId", { companyId: COMPANY_ID, feedbackId: "", text: "hi" }],
  ])("rejects reply-to-feedback with %s fail-closed", async (_label, payload) => {
    const result = parseReplyPayload("reply-to-feedback", payload);
    expect(result.request).toBeUndefined();
    expect(result.error).toBe("invalidPayload");
  });

  it.each([
    ["null", null],
    ["an array", [{}]],
    ["missing companyId", { text: "hi" }],
    ["empty companyId", { companyId: "", text: "hi" }],
    ["missing text", { companyId: COMPANY_ID }],
    ["whitespace-only text", { companyId: COMPANY_ID, text: "   " }],
    ["a stray feedbackId", { companyId: COMPANY_ID, feedbackId: "feedback-1", text: "hi" }],
  ])("rejects send-message with %s fail-closed", async (_label, payload) => {
    const result = parseReplyPayload("send-message", payload);
    expect(result.request).toBeUndefined();
    expect(result.error).toBe("invalidPayload");
  });
});

// -- HttpReplyForwarder ------------------------------------------------------------

describe("HttpReplyForwarder", () => {
  const replyRequest: ReplyForwardRequest = {
    action: "reply-to-feedback",
    companyId: COMPANY_ID,
    feedbackId: "feedback-1",
    text: "the answer",
  };

  it("forwards reply-to-feedback to the sanctioned agent.reply-to-feedback action route", async () => {
    const calls: FetchCall[] = [];
    const result = await forwarder(calls, () => Promise.resolve(okJson({ ok: true, feedbackId: "feedback-1" }))).forward(replyRequest);

    expect(result).toEqual({ ok: true, result: { ok: true, feedbackId: "feedback-1" } });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(
      `https://paperclip.example/api/plugins/paperclip/actions/${ACTION_KEYS.agentReplyToFeedback}`,
    );
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer board-key-1",
    });
    expect(JSON.parse(calls[0].init.body)).toEqual({
      companyId: COMPANY_ID,
      params: { companyId: COMPANY_ID, text: "the answer", feedbackId: "feedback-1" },
    });
  });

  it("forwards send-message to the sanctioned company.send-message action route without a feedbackId param", async () => {
    const calls: FetchCall[] = [];
    const result = await forwarder(calls, () => Promise.resolve(okJson({ ok: true }))).forward({
      action: "send-message",
      companyId: COMPANY_ID,
      text: "hello",
    });

    expect(result).toEqual({ ok: true, result: { ok: true } });
    expect(calls[0].url).toBe(
      `https://paperclip.example/api/plugins/paperclip/actions/${ACTION_KEYS.companySendMessage}`,
    );
    expect(JSON.parse(calls[0].init.body)).toEqual({
      companyId: COMPANY_ID,
      params: { companyId: COMPANY_ID, text: "hello" },
    });
  });

  it("URL-encodes the plugin id and action key segments", async () => {
    const calls: FetchCall[] = [];
    await forwarder(calls, () => Promise.resolve(okJson({})), "my plugin").forward({
      action: "send-message",
      companyId: COMPANY_ID,
      text: "hi",
    });
    expect(calls[0].url).toBe(
      `https://paperclip.example/api/plugins/my%20plugin/actions/${ACTION_KEYS.companySendMessage}`,
    );
  });

  it("maps a non-2xx proxy response to forwardFailed:<status>, keeping the action's own errors out of `error`", async () => {
    const calls: FetchCall[] = [];
    const result = await forwarder(calls, () =>
      Promise.resolve({ ok: false, status: 403, statusText: "Forbidden", json: async () => ({}) }),
    ).forward(replyRequest);

    expect(result).toEqual({ ok: false, error: "forwardFailed:403" });
  });

  it("rejects a 200 response whose body has no data object (invalidResponse)", async () => {
    for (const body of [{}, { data: null }, { data: "string-not-object" }]) {
      const calls: FetchCall[] = [];
      const result = await forwarder(calls, () =>
        Promise.resolve({ ok: true, status: 200, statusText: "OK", json: async () => body }),
      ).forward(replyRequest);
      expect(result).toEqual({ ok: false, error: "invalidResponse" });
    }
  });

  it("maps a transport failure to forwardFailed without leaking details", async () => {
    const calls: FetchCall[] = [];
    const result = await forwarder(calls, () => Promise.reject(new Error("ECONNREFUSED"))).forward(replyRequest);
    expect(result).toEqual({ ok: false, error: "forwardFailed" });
    expect(calls).toHaveLength(1);
  });

  it("refuses an action outside the two-key allowlist before any HTTP happens", async () => {
    const calls: FetchCall[] = [];
    const result = await forwarder(calls, () => Promise.resolve(okJson({}))).forward({
      action: "create-issue" as never,
      companyId: COMPANY_ID,
      text: "sneaky",
    });
    expect(result).toEqual({ ok: false, error: "unknownAction" });
    expect(calls).toHaveLength(0);
  });
});
