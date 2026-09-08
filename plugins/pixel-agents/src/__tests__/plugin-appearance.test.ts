import * as http from "node:http";
import * as net from "node:net";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFeedAppearanceApplier,
  loadPluginCharacterSheets,
  PAPERCLIP_DIALOG_LINES_MESSAGE,
  PAPERCLIP_PIXEL_PLUGIN_ID,
  PLUGIN_FEED_PATH,
  registerPaperclipPixelEmbedding,
} from "../index.js";
import type {
  PixelAgentsPluginContext,
  PixelAgentsPluginHost,
  PixelAgentsPluginRegistration,
  PluginAgentSource,
} from "../index.js";

/**
 * Acceptance tests for the WS4-C first-class appearance adoption (spec
 * PAPERCLIP_PIXELS-2, WS4-C): the plugin's WS3 character catalog declared
 * through the WS4-A appearance source (`appearance.ts`), the feed-side
 * characterId → sheet-index applier, and the embedding surface's onStart
 * wiring (`embedding.ts`).
 *
 * Pinned contracts:
 * - `loadPluginCharacterSheets`: the committed catalog (24 sheets) loads as
 *   declarations with ABSOLUTE file paths and host-pattern-conforming
 *   sanitized ids (`pixel-agents:char-0` → `pixel-agents-char-0`), while
 *   `indexOfCharacter` resolves the ORIGINAL WS3 catalog ids positionally.
 * - `createFeedAppearanceApplier`: a known characterId resolves to its
 *   positional sheet index; an UNKNOWN id is skipped fail-closed (logged,
 *   never thrown, never assigned); `null` reverts to palette rendering.
 * - `register()`'s onStart: captures `ctx.appearance`, declares the catalog
 *   (24 sheets), and routes feed `assignAgentAppearance` / `dialogLines`
 *   operations through the captured sinks end-to-end.
 *
 * The onStart declaration is best-effort: a host `declareCharacterCatalog`
 * refusal (e.g. the asset gate rejecting an ungranted catalog directory)
 * degrades to built-in palette rendering, never aborts onStart.
 */

const FEED_TOKEN = "feed-shared-secret";

/** The fork host's sheet-id pattern (appearanceSource.ts SHEET_ID_PATTERN). */
const SHEET_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

// -- loadPluginCharacterSheets ---------------------------------------------------

describe("loadPluginCharacterSheets — catalog → WS4-A sheet declarations", () => {
  it("loads all 24 catalog entries as declarations in catalog order", () => {
    const sheets = loadPluginCharacterSheets();
    expect(sheets.sheets).toHaveLength(24);
  });

  it("declares ABSOLUTE file paths (the asset privilege gate requires them)", () => {
    const { sheets } = loadPluginCharacterSheets();
    for (const sheet of sheets) {
      expect(path.isAbsolute(sheet.file), `${sheet.id} must be absolute`).toBe(true);
    }
    expect(sheets[0].file.endsWith(path.join("assets", "characters", "char_0.png"))).toBe(true);
    expect(sheets[23].file.endsWith(path.join("assets", "characters", "char_23.png"))).toBe(true);
  });

  it("sanitizes ids to the host sheet-id pattern: colon ids become dash ids", () => {
    const { sheets } = loadPluginCharacterSheets();
    for (const sheet of sheets) {
      expect(sheet.id).toMatch(SHEET_ID_PATTERN);
      expect(sheet.id).not.toContain(":");
    }
    // The catalog mixes id prefixes (entries 0-5 ship `pixel-agents:*`,
    // 6-23 ship `paperclip-pixels:*`); every colon is sanitized to a dash.
    expect(sheets[0].id).toBe("pixel-agents-char-0");
    expect(sheets[7].id).toBe("paperclip-pixels-char-7");
    expect(sheets[23].id).toBe("paperclip-pixels-char-23");
    // Unique per sheet.
    expect(new Set(sheets.map((s) => s.id)).size).toBe(24);
  });

  it("indexOfCharacter resolves ORIGINAL catalog ids to positional indices", () => {
    const sheets = loadPluginCharacterSheets();
    expect(sheets.indexOfCharacter("pixel-agents:char-0")).toBe(0);
    expect(sheets.indexOfCharacter("pixel-agents:char-5")).toBe(5);
    expect(sheets.indexOfCharacter("paperclip-pixels:char-6")).toBe(6);
    expect(sheets.indexOfCharacter("paperclip-pixels:char-23")).toBe(23);
    // Unknown ids resolve to null — never a guess. (The catalog ships no
    // `pixel-agents:char-23`: 6-23 use the paperclip-pixels prefix.)
    expect(sheets.indexOfCharacter("pixel-agents:char-23")).toBeNull();
    expect(sheets.indexOfCharacter("pixel-agents:char-99")).toBeNull();
    expect(sheets.indexOfCharacter("somebody-else:char-0")).toBeNull();
    // Resolution is by the ORIGINAL id only: the sanitized id is cosmetic.
    expect(sheets.indexOfCharacter("pixel-agents-char-0")).toBeNull();
  });
});

// -- createFeedAppearanceApplier ---------------------------------------------------

function makeAppearanceSource() {
  return {
    declareCharacterCatalog: vi.fn(),
    assignAgentAppearance: vi.fn(),
  };
}

describe("createFeedAppearanceApplier — feed assignments", () => {
  it("resolves a known characterId to its positional sheet index", () => {
    const source = makeAppearanceSource();
    const applier = createFeedAppearanceApplier({
      getSource: () => source,
      getSheets: () => loadPluginCharacterSheets(),
    });
    applier.assign("agent-a", "pixel-agents:char-3");
    expect(source.assignAgentAppearance).toHaveBeenCalledWith("agent-a", 3);
    applier.assign("agent-b", "pixel-agents:char-0");
    expect(source.assignAgentAppearance).toHaveBeenCalledWith("agent-b", 0);
  });

  it("UNKNOWN characterId is skipped fail-closed: logged, no throw, no assignment", () => {
    const source = makeAppearanceSource();
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const applier = createFeedAppearanceApplier({
      getSource: () => source,
      getSheets: () => loadPluginCharacterSheets(),
      log: (event, fields) => logs.push({ event, fields }),
    });

    expect(() => applier.assign("agent-a", "pixel-agents:char-99")).not.toThrow();
    expect(source.assignAgentAppearance).not.toHaveBeenCalled();
    expect(logs).toEqual([
      { event: "paperclip_appearance_unresolved_character", fields: { key: "agent-a" } },
    ]);

    // One bad assignment never breaks the rest of the batch.
    applier.assign("agent-b", "pixel-agents:char-1");
    expect(source.assignAgentAppearance).toHaveBeenCalledWith("agent-b", 1);
  });

  it("skips fail-closed when the catalog failed to load (no sheets)", () => {
    const source = makeAppearanceSource();
    const logs: Array<{ event: string; fields?: Record<string, unknown> }> = [];
    const applier = createFeedAppearanceApplier({
      getSource: () => source,
      getSheets: () => undefined,
      log: (event, fields) => logs.push({ event, fields }),
    });
    expect(() => applier.assign("agent-a", "pixel-agents:char-0")).not.toThrow();
    expect(source.assignAgentAppearance).not.toHaveBeenCalled();
    expect(logs.map((l) => l.event)).toEqual(["paperclip_appearance_unresolved_character"]);
  });

  it("null characterId clears the assignment (revert to palette rendering)", () => {
    const source = makeAppearanceSource();
    const applier = createFeedAppearanceApplier({
      getSource: () => source,
      getSheets: () => loadPluginCharacterSheets(),
    });
    applier.assign("agent-a", null);
    expect(source.assignAgentAppearance).toHaveBeenCalledWith("agent-a", null);
  });

  it("refuses fail-closed before onStart captured the appearance source", () => {
    const applier = createFeedAppearanceApplier({
      getSource: () => undefined,
      getSheets: () => loadPluginCharacterSheets(),
    });
    expect(() => applier.assign("agent-a", "pixel-agents:char-0")).toThrow(/pluginNotStarted/);
  });
});

// -- embedding-level onStart wiring ------------------------------------------------

type MockHost = PixelAgentsPluginHost & {
  registerPlugin: ReturnType<typeof vi.fn>;
  startPlugin: ReturnType<typeof vi.fn>;
};

function makeHost(): MockHost {
  return {
    registerPlugin: vi.fn(),
    startPlugin: vi.fn(),
  } as unknown as MockHost;
}

async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate a test port"));
        return;
      }
      server.close((error) => {
        if (error) reject(error);
        else resolve(address.port);
      });
    });
  });
}

function postFeed(
  port: number,
  body: string,
  token: string = FEED_TOKEN,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: "127.0.0.1",
        port,
        path: PLUGIN_FEED_PATH,
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          "content-length": String(Buffer.byteLength(body)),
        },
        agent: false,
      },
      (res) => {
        let data = "";
        res.on("data", (chunk: Buffer) => (data += chunk.toString("utf8")));
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: data ? (JSON.parse(data) as Record<string, unknown>) : {},
          });
        });
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

function registrationOf(host: MockHost): PixelAgentsPluginRegistration {
  expect(host.registerPlugin).toHaveBeenCalledTimes(1);
  return host.registerPlugin.mock.calls[0][0] as PixelAgentsPluginRegistration;
}

function makeAgentSource(): PluginAgentSource {
  return {
    declareAgents: vi.fn(),
    removeAgents: vi.fn(),
    updateAgentStatus: vi.fn(),
    updateAgentActivity: vi.fn(),
    updateAgentLabelPolicy: vi.fn(),
  } satisfies PluginAgentSource;
}

function feedBody(operations: unknown[]): string {
  return JSON.stringify({ schemaVersion: 1, companyId: "company-acme", operations });
}

describe("register — WS4-A appearance adoption at onStart", () => {
  const ORIGINAL_ENV = process.env;
  const ENV_KEYS = [
    "PAPERCLIP_PIXEL_FEED_TOKEN",
    "PAPERCLIP_PIXEL_FEED_HOST",
    "PAPERCLIP_PIXEL_FEED_PORT",
    "PAPERCLIP_PIXEL_API_BASE_URL",
    "PAPERCLIP_PIXEL_API_TOKEN",
  ] as const;

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  function stubEnv(vars: Record<string, string>): void {
    const env: Record<string, string | undefined> = { ...ORIGINAL_ENV, ...vars };
    for (const key of ENV_KEYS) {
      if (!(key in vars)) delete env[key];
    }
    process.env = env;
  }

  it("onStart declares the 24-sheet character catalog through ctx.appearance", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    const appearance = makeAppearanceSource();
    registration.handlers.onStart?.({
      pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
      manifest: registration.manifest,
      emit: vi.fn(),
      agents: makeAgentSource(),
      appearance,
    } as unknown as PixelAgentsPluginContext);

    expect(appearance.declareCharacterCatalog).toHaveBeenCalledTimes(1);
    const sheets = appearance.declareCharacterCatalog.mock.calls[0][0];
    expect(sheets).toHaveLength(24);
    expect(sheets[0].id).toBe("pixel-agents-char-0");
    expect(path.isAbsolute(sheets[0].file)).toBe(true);

    registration.handlers.onStop?.();
  });

  it("feed assignAgentAppearance resolves end-to-end through the captured appearance source", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    const appearance = makeAppearanceSource();
    registration.handlers.onStart?.({
      pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
      manifest: registration.manifest,
      emit: vi.fn(),
      agents: makeAgentSource(),
      appearance,
    } as unknown as PixelAgentsPluginContext);

    const applied = await postFeed(
      port,
      feedBody([
        { op: "assignAgentAppearance", key: "agent-a", characterId: "pixel-agents:char-2" },
      ]),
    );
    expect(applied.status).toBe(200);
    expect(appearance.assignAgentAppearance).toHaveBeenCalledWith("agent-a", 2);

    // Null clears end-to-end too.
    const cleared = await postFeed(
      port,
      feedBody([{ op: "assignAgentAppearance", key: "agent-a", characterId: null }]),
    );
    expect(cleared.status).toBe(200);
    expect(appearance.assignAgentAppearance).toHaveBeenCalledWith("agent-a", null);

    registration.handlers.onStop?.();
  });

  it("feed dialogLines re-emits through the declared paperclip.dialog.lines message", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    const emit = vi.fn(() => true);
    registration.handlers.onStart?.({
      pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
      manifest: registration.manifest,
      emit,
      agents: makeAgentSource(),
      appearance: makeAppearanceSource(),
    } as unknown as PixelAgentsPluginContext);

    const applied = await postFeed(
      port,
      feedBody([{ op: "dialogLines", lines: [{ text: "Human (question): which DB?" }] }]),
    );
    expect(applied.status).toBe(200);
    expect(emit).toHaveBeenCalledWith(PAPERCLIP_DIALOG_LINES_MESSAGE, {
      text: "Human (question): which DB?",
    });

    registration.handlers.onStop?.();
  });

  // FIXED (SAA-620 follow-up): the onStart wrapper now wraps the declare in
  // try/catch and degrades to palette rendering on a host refusal.
  it("degrades to palette rendering when declareCharacterCatalog throws (best-effort)", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });

    const appearance = makeAppearanceSource();
    appearance.declareCharacterCatalog.mockImplementation(() => {
      throw new Error("assetGateRefused");
    });
    const agents = makeAgentSource();
    // The contract: onStart completes, the refusal is logged, the agent
    // source stays captured, and the bridge keeps working (palette
    // rendering fallback) — never a throw out of onStart.
    expect(() =>
      registration.handlers.onStart?.({
        pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
        manifest: registration.manifest,
        emit: vi.fn(),
        agents,
        appearance,
      } as unknown as PixelAgentsPluginContext),
    ).not.toThrow();
    expect(logs.some((line) => line.includes("paperclip_appearance_catalog_refused"))).toBe(true);
    expect(logs.some((line) => line.includes("assetGateRefused"))).toBe(true);
    // The error message is logged, but never any token material.
    expect(logs.some((line) => line.includes(FEED_TOKEN))).toBe(false);

    // The feed still applies operations after the degraded start.
    const applied = await postFeed(
      port,
      feedBody([{ op: "declareAgents", agents: [{ key: "agent-a", name: "Agent A" }] }]),
    );
    expect(applied.status).toBe(200);
    expect(agents.declareAgents).toHaveBeenCalledWith([{ key: "agent-a", name: "Agent A" }]);

    registration.handlers.onStop?.();
  });
});
