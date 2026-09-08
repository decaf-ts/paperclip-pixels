import { describe, expect, it, vi } from "vitest";
import { PLUGIN_VERSION } from "../constants.js";
import {
  createPaperclipPluginHandlers,
  createPaperclipPluginManifest,
  createPaperclipPluginRegistration,
  PAPERCLIP_PIXEL_PLUGIN_ID,
  PAPERCLIP_PLUGIN_ACTIONS,
  PAPERCLIP_PLUGIN_STARTED_MESSAGE,
  PAPERCLIP_DIALOG_LINES_MESSAGE,
  PAPERCLIP_REPLY_MENU_ITEM,
  registerPaperclipPixelPlugin,
} from "../index.js";
import type {
  PaperclipPluginDeps,
  PixelAgentsPluginContext,
  PixelAgentsPluginHost,
  PluginAgentDeclaration,
  ReplyForwardRequest,
  ReplyForwardResult,
} from "../index.js";

/**
 * Unit tests for the plugin registration surface of
 * `src/pixel-agents-plugin/` — `manifest.ts` (the A1 host-schema manifest)
 * and `plugin.ts` (handlers + `registerPaperclipPixelPlugin`), spec
 * PAPERCLIP_PIXELS-2, WS2-C.
 *
 * Pinned contracts: the manifest declares exactly what the bridge uses on
 * the WS2-A1 host (agent source, two reply actions, one started message),
 * every action id conforms to the A1 host validator pattern
 * `^[a-z0-9][a-z0-9-]{0,63}$`, onStart re-declares the cached roster, and
 * the reply actions route through the injected forwarder fail-closed.
 */

const ROSTER: PluginAgentDeclaration[] = [
  { key: "agent-a", name: "Agent A", teamName: "paperclip-bridge-1024a250" },
  { key: "agent-b", name: "Agent B", teamName: "paperclip-bridge-1024a253" },
];

interface LogCall {
  event: string;
  fields?: Record<string, unknown>;
}

function makeDeps(overrides: Partial<PaperclipPluginDeps> = {}, logs?: LogCall[]): PaperclipPluginDeps {
  return {
    getDeclaredAgents: () => ROSTER,
    forwardReply: vi.fn(async () => ({ ok: true, result: { recorded: true } }) as ReplyForwardResult),
    ...(logs
      ? {
          log: (event: string, fields?: Record<string, unknown>) => {
            logs.push({ event, fields });
          },
        }
      : {}),
    ...overrides,
  };
}

function makeCtx() {
  return {
    pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
    manifest: createPaperclipPluginManifest(),
    emit: vi.fn(() => true),
    agents: {
      declareAgents: vi.fn(),
      removeAgents: vi.fn(),
      updateAgentStatus: vi.fn(),
      updateAgentActivity: vi.fn(),
    },
  } as unknown as PixelAgentsPluginContext;
}

// -- manifest --------------------------------------------------------------------

describe("createPaperclipPluginManifest", () => {
  it("declares the paperclip plugin id, current version, and both sources", () => {
    const manifest = createPaperclipPluginManifest();
    expect(manifest.id).toBe("paperclip");
    expect(PAPERCLIP_PIXEL_PLUGIN_ID).toBe("paperclip");
    expect(manifest.version).toBe(PLUGIN_VERSION);
    expect(manifest.sources).toEqual({ agents: true, appearance: true });
    expect(typeof manifest.description).toBe("string");
  });

  it("contributes the started + dialog-lines messages, the two reply actions, and the dialog-pane widget", () => {
    const manifest = createPaperclipPluginManifest();
    expect(manifest.contributes.messages).toHaveLength(2);
    expect(manifest.contributes.messages?.[0].type).toBe(PAPERCLIP_PLUGIN_STARTED_MESSAGE);
    expect(PAPERCLIP_PLUGIN_STARTED_MESSAGE).toBe("paperclip.bridge.started");
    expect(manifest.contributes.messages?.[1].type).toBe(PAPERCLIP_DIALOG_LINES_MESSAGE);
    expect(PAPERCLIP_DIALOG_LINES_MESSAGE).toBe("paperclip.dialog.lines");

    expect(manifest.contributes.actions).toEqual([
      expect.objectContaining({ id: PAPERCLIP_PLUGIN_ACTIONS.replyToFeedback }),
      expect.objectContaining({ id: PAPERCLIP_PLUGIN_ACTIONS.sendMessage }),
    ]);
    expect(PAPERCLIP_PLUGIN_ACTIONS).toEqual({
      replyToFeedback: "reply-to-feedback",
      sendMessage: "send-message",
    });

    // WS4-C: the dialog-pane shell-panel widget, fed by the declared
    // conversation-extract message type.
    expect(manifest.contributes.widgets).toEqual([
      expect.objectContaining({
        id: "dialog-pane",
        kind: "shell-panel",
        binding: "global",
        messageTypes: [PAPERCLIP_DIALOG_LINES_MESSAGE],
      }),
    ]);
  });

  it("every action id conforms to the A1 host validator pattern", () => {
    const pattern = /^[a-z0-9][a-z0-9-]{0,63}$/;
    const manifest = createPaperclipPluginManifest();
    for (const action of manifest.contributes.actions ?? []) {
      expect(action.id).toMatch(pattern);
    }
    expect(PAPERCLIP_REPLY_MENU_ITEM.id).toMatch(pattern);
  });

  it("omits labelPolicy — the as-implemented shape the real host validator accepts", () => {
    const manifest = createPaperclipPluginManifest();
    expect(manifest.contributes.menuItems).toEqual([{ ...PAPERCLIP_REPLY_MENU_ITEM }]);
    // The WS2-C-era `labelPolicy: {}` placeholder is gone by design: the
    // REAL fork host validator (pixel-agents/server/src/plugins/manifest.ts
    // validatePluginManifest) rejects a present `labelPolicy` without a
    // valid `mode` fail-closed, so the manifest omits the key entirely
    // (default label behavior). Pin it as absent — not `{}` — and pin the
    // exact key set so a stray placeholder can never sneak back in.
    // (`widgets` is no longer absent since WS4-C: the dialog-pane
    // shell-panel widget ships, with its message type declared above.)
    expect(manifest.contributes.labelPolicy).toBeUndefined();
    expect(Object.keys(manifest.contributes).sort()).toEqual([
      "actions",
      "menuItems",
      "messages",
      "widgets",
    ]);
  });
});

// -- createPaperclipPluginHandlers --------------------------------------------------

describe("createPaperclipPluginHandlers", () => {
  it("onStart re-declares the cached roster through the sanctioned agent source", () => {
    const deps = makeDeps();
    const ctx = makeCtx();
    const handlers = createPaperclipPluginHandlers(deps);

    handlers.onStart?.(ctx);

    expect(ctx.agents.declareAgents).toHaveBeenCalledTimes(1);
    expect(ctx.agents.declareAgents).toHaveBeenCalledWith(ROSTER);
  });

  it("onStart skips declareAgents entirely for an empty roster but still announces the start", () => {
    const ctx = makeCtx();
    const logs: LogCall[] = [];
    const handlers = createPaperclipPluginHandlers(makeDeps({ getDeclaredAgents: () => [] }, logs));

    handlers.onStart?.(ctx);

    expect(ctx.agents.declareAgents).not.toHaveBeenCalled();
    expect(ctx.emit).toHaveBeenCalledWith(PAPERCLIP_PLUGIN_STARTED_MESSAGE, {
      plugin: PAPERCLIP_PIXEL_PLUGIN_ID,
      agents: 0,
    });
    expect(logs).toEqual([{ event: "paperclip_plugin_started", fields: { agents: 0 } }]);
  });

  it("onStart emits the started message with the roster size and logs it", () => {
    const logs: LogCall[] = [];
    const ctx = makeCtx();
    createPaperclipPluginHandlers(makeDeps({}, logs)).onStart?.(ctx);

    expect(ctx.emit).toHaveBeenCalledWith(PAPERCLIP_PLUGIN_STARTED_MESSAGE, {
      plugin: PAPERCLIP_PIXEL_PLUGIN_ID,
      agents: ROSTER.length,
    });
    expect(logs).toEqual([{ event: "paperclip_plugin_started", fields: { agents: ROSTER.length } }]);
  });

  it("reply-to-feedback routes a well-formed payload through the forwarder and returns its result", async () => {
    const forwardReply = vi.fn(
      async (request: ReplyForwardRequest): Promise<ReplyForwardResult> => ({
        ok: true,
        result: { recorded: true, request },
      }),
    );
    const handlers = createPaperclipPluginHandlers(makeDeps({ forwardReply }));
    const payload = { companyId: "company-acme", feedbackId: "feedback-1", text: "the answer" };

    const result = (await handlers.actions?.["reply-to-feedback"](payload)) as ReplyForwardResult;

    expect(forwardReply).toHaveBeenCalledTimes(1);
    expect(forwardReply.mock.calls[0][0]).toEqual({
      action: "reply-to-feedback",
      companyId: "company-acme",
      feedbackId: "feedback-1",
      text: "the answer",
    });
    expect(result).toEqual({
      ok: true,
      result: { recorded: true, request: forwardReply.mock.calls[0][0] },
    });
  });

  it("reply-to-feedback rejects a malformed payload fail-closed: forwarder never called", async () => {
    const forwardReply = vi.fn(async () => ({ ok: true }) as ReplyForwardResult);
    const logs: LogCall[] = [];
    const handlers = createPaperclipPluginHandlers(makeDeps({ forwardReply }, logs));

    const result = (await handlers.actions?.["reply-to-feedback"]({
      companyId: "company-acme",
      text: "missing feedbackId",
    })) as ReplyForwardResult;

    expect(result).toEqual({ ok: false, error: "invalidPayload" });
    expect(forwardReply).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { event: "paperclip_reply_rejected", fields: { action: "reply-to-feedback", reason: "invalidPayload" } },
    ]);
  });

  it("reply-to-feedback surfaces a forwarding failure as-is and logs it", async () => {
    const forwardReply = vi.fn(
      async (): Promise<ReplyForwardResult> => ({ ok: false, error: "forwardFailed:500" }),
    );
    const logs: LogCall[] = [];
    const handlers = createPaperclipPluginHandlers(makeDeps({ forwardReply }, logs));

    const result = (await handlers.actions?.["reply-to-feedback"]({
      companyId: "company-acme",
      feedbackId: "feedback-1",
      text: "hi",
    })) as ReplyForwardResult;

    expect(result).toEqual({ ok: false, error: "forwardFailed:500" });
    expect(logs).toEqual([
      { event: "paperclip_reply_forward_failed", fields: { action: "reply-to-feedback", reason: "forwardFailed:500" } },
    ]);
  });

  it("send-message routes a well-formed payload (text only) through the forwarder", async () => {
    const forwardReply = vi.fn(
      async (): Promise<ReplyForwardResult> => ({ ok: true, result: { sent: true } }),
    );
    const handlers = createPaperclipPluginHandlers(makeDeps({ forwardReply }));

    const result = (await handlers.actions?.["send-message"]({
      companyId: "company-acme",
      text: "hello",
    })) as ReplyForwardResult;

    expect(forwardReply).toHaveBeenCalledWith({
      action: "send-message",
      companyId: "company-acme",
      text: "hello",
    });
    expect(result).toEqual({ ok: true, result: { sent: true } });
  });

  it("send-message rejects a payload carrying a stray feedbackId fail-closed", async () => {
    const forwardReply = vi.fn(async () => ({ ok: true }) as ReplyForwardResult);
    const handlers = createPaperclipPluginHandlers(makeDeps({ forwardReply }));

    const result = (await handlers.actions?.["send-message"]({
      companyId: "company-acme",
      feedbackId: "feedback-1",
      text: "hello",
    })) as ReplyForwardResult;

    expect(result).toEqual({ ok: false, error: "invalidPayload" });
    expect(forwardReply).not.toHaveBeenCalled();
  });
});

// -- registration ---------------------------------------------------------------------

describe("createPaperclipPluginRegistration / registerPaperclipPixelPlugin", () => {
  it("builds a complete registration: id, version, manifest, handlers", () => {
    const registration = createPaperclipPluginRegistration(makeDeps());

    expect(registration.id).toBe("paperclip");
    expect(registration.version).toBe(PLUGIN_VERSION);
    expect(registration.manifest).toEqual(createPaperclipPluginManifest());
    expect(registration.handlers.onStart).toBeTypeOf("function");
    expect(Object.keys(registration.handlers.actions ?? {}).sort()).toEqual([
      "reply-to-feedback",
      "send-message",
    ]);
  });

  it("registers and starts the plugin through the host in one call", () => {
    const host: PixelAgentsPluginHost = {
      registerPlugin: vi.fn(),
      startPlugin: vi.fn(),
    };

    const result = registerPaperclipPixelPlugin(host, makeDeps());

    expect(result).toEqual({ ok: true });
    expect(host.registerPlugin).toHaveBeenCalledTimes(1);
    const registration = (host.registerPlugin as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(registration.id).toBe("paperclip");
    expect(registration.handlers.onStart).toBeTypeOf("function");
    expect(host.startPlugin).toHaveBeenCalledWith("paperclip");
  });

  it("returns the registration error fail-closed and never starts a failed registration", () => {
    const startPlugin = vi.fn();
    const host = {
      registerPlugin: vi.fn(() => {
        throw new Error("duplicate plugin id");
      }),
      startPlugin,
    } as unknown as PixelAgentsPluginHost;
    const logs: LogCall[] = [];

    const result = registerPaperclipPixelPlugin(host, makeDeps({}, logs));

    expect(result).toEqual({ ok: false, error: "duplicate plugin id" });
    expect(startPlugin).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { event: "paperclip_plugin_register_failed", fields: { error: "duplicate plugin id" } },
    ]);
  });
});
