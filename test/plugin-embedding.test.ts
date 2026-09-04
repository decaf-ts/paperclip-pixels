import { EventEmitter } from "node:events";
import * as http from "node:http";
import * as net from "node:net";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  PAPERCLIP_PIXEL_PLUGIN_ID,
  PLUGIN_FEED_PATH,
  bearerTokenMatches,
  createEmbeddingRequestHandler,
  parseEmbeddingEnv,
  registerPaperclipPixelEmbedding,
} from "../src/pixel-agents-plugin/index.js";
import type {
  EmbeddingConfig,
  PixelAgentsPluginContext,
  PixelAgentsPluginRegistration,
  PluginAgentSource,
  PluginFeedHandlerResult,
} from "../src/pixel-agents-plugin/index.js";
import type { PixelAgentsPluginHost } from "../src/pixel-agents-plugin/index.js";

/**
 * Unit tests for `src/pixel-agents-plugin/embedding.ts` — the WS2-D embedding
 * surface the Pixel Agents fork loads through its generic `--plugin` loader
 * (spec PAPERCLIP_PIXELS-2, WS2-D).
 *
 * Pinned contracts:
 * - `parseEmbeddingEnv`: fail-closed gates (missing/blank feed token throws,
 *   unusable port throws) plus the documented defaults (loopback bind,
 *   companion port 8081, relay API base, no API token unless configured).
 * - `bearerTokenMatches`: constant-time digest compare — wrong tokens are
 *   false, and a length mismatch never throws.
 * - `createEmbeddingRequestHandler`: the wire contract of the sidecar feed
 *   endpoint — opaque 404 for unknown paths (regardless of credentials),
 *   405 for non-POST, 401 for missing/wrong bearer and for a token riding
 *   the URL, 400 for invalid JSON, 413 for an oversized body, and
 *   proxy-through of everything else to the feed handler (including the
 *   last-resort opaque 500). The token is never logged.
 * - `register()`: composition — refuses to start without a feed token,
 *   registers + starts the plugin through the host API, serves the feed on
 *   the configured port, refuses feed operations until onStart captures the
 *   plugin's agent source, fails reply actions closed with
 *   `forwarderNotConfigured` without `PAPERCLIP_PIXEL_API_TOKEN`, and closes
 *   the listener on onStop.
 */

const FEED_TOKEN = "feed-shared-secret";
const AUTH = `Bearer ${FEED_TOKEN}`;

// -- parseEmbeddingEnv ----------------------------------------------------------

describe("parseEmbeddingEnv", () => {
  const TOKEN = "feed-shared-secret";

  it("throws when PAPERCLIP_PIXEL_FEED_TOKEN is missing (fail-closed startup)", () => {
    expect(() => parseEmbeddingEnv({})).toThrow(/PAPERCLIP_PIXEL_FEED_TOKEN is required/);
    expect(() => parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: undefined })).toThrow(
      /PAPERCLIP_PIXEL_FEED_TOKEN is required/,
    );
  });

  it("throws on a whitespace-only token (trimmed to empty)", () => {
    expect(() => parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: "   \t " })).toThrow(
      /PAPERCLIP_PIXEL_FEED_TOKEN is required/,
    );
  });

  it("applies the documented defaults: loopback bind, companion port, relay API base, no API token", () => {
    const config = parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN });
    expect(config).toEqual({
      feedHost: "127.0.0.1",
      feedPort: 8081,
      feedToken: TOKEN,
      apiBaseUrl: "http://127.0.0.1:3100",
    });
    expect("apiToken" in config).toBe(false);
  });

  it("trims the token and accepts a valid explicit port", () => {
    const config = parseEmbeddingEnv({
      PAPERCLIP_PIXEL_FEED_TOKEN: `  ${TOKEN}  `,
      PAPERCLIP_PIXEL_FEED_PORT: " 9100 ",
    });
    expect(config.feedToken).toBe(TOKEN);
    expect(config.feedPort).toBe(9100);
  });

  it("falls back to the default port for an empty or whitespace-only value", () => {
    expect(
      parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN, PAPERCLIP_PIXEL_FEED_PORT: "" })
        .feedPort,
    ).toBe(8081);
    expect(
      parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN, PAPERCLIP_PIXEL_FEED_PORT: "   " })
        .feedPort,
    ).toBe(8081);
  });

  it.each([
    ["zero", "0"],
    ["above the TCP range", "65536"],
    ["negative", "-1"],
    ["decimal", "8081.5"],
    ["non-numeric", "http"],
  ])("throws on an invalid PAPERCLIP_PIXEL_FEED_PORT (%s)", (_label, rawPort) => {
    expect(() =>
      parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN, PAPERCLIP_PIXEL_FEED_PORT: rawPort }),
    ).toThrow(/Invalid PAPERCLIP_PIXEL_FEED_PORT/);
  });

  it("honors feed host and API base URL overrides, stripping a trailing slash", () => {
    const config = parseEmbeddingEnv({
      PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN,
      PAPERCLIP_PIXEL_FEED_HOST: "0.0.0.0",
      PAPERCLIP_PIXEL_API_BASE_URL: "http://paperclip.internal:3100/",
    });
    expect(config.feedHost).toBe("0.0.0.0");
    expect(config.apiBaseUrl).toBe("http://paperclip.internal:3100");
  });

  it("includes the API token only when PAPERCLIP_PIXEL_API_TOKEN is set (trimmed)", () => {
    expect(
      parseEmbeddingEnv({
        PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN,
        PAPERCLIP_PIXEL_API_TOKEN: "  board-key  ",
      }).apiToken,
    ).toBe("board-key");
    expect(
      parseEmbeddingEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: TOKEN, PAPERCLIP_PIXEL_API_TOKEN: "   " })
        .apiToken,
    ).toBeUndefined();
  });
});

// -- bearerTokenMatches ---------------------------------------------------------

describe("bearerTokenMatches", () => {
  it("accepts the shared secret and rejects anything else", () => {
    expect(bearerTokenMatches("secret", "secret")).toBe(true);
    expect(bearerTokenMatches("secret", "wrong")).toBe(false);
    expect(bearerTokenMatches("secret", "")).toBe(false);
    expect(bearerTokenMatches("", "secret")).toBe(false);
  });

  it("never throws on a length mismatch (compares digests, not raw secrets)", () => {
    const long = "a-much-longer-attacker-supplied-value";
    expect(() => bearerTokenMatches("short", long)).not.toThrow();
    expect(bearerTokenMatches("short", long)).toBe(false);
  });
});

// -- createEmbeddingRequestHandler: fakes ---------------------------------------

interface CapturedResponse {
  status: number;
  headers: Record<string, string | number>;
  body: Record<string, unknown> | undefined;
}

/** A ServerResponse stand-in that captures writeHead/end and resolves `done`
 *  on the first end() — the wire contract is testable without a listener. */
function makeRes() {
  const captured: CapturedResponse = { status: 0, headers: {}, body: undefined };
  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });
  const res = {
    writeHead(status: number, headers: Record<string, string | number>) {
      captured.status = status;
      captured.headers = headers;
    },
    end(payload?: string) {
      if (payload !== undefined) captured.body = JSON.parse(payload) as Record<string, unknown>;
      resolveDone();
    },
  };
  return { res: res as unknown as ServerResponse, captured, done };
}

/** An IncomingMessage stand-in: fields the handler reads plus a destroy spy
 *  (readBody destroys the request on body overflow). */
function makeReq(options: { url?: string; method?: string; authorization?: string } = {}) {
  const req = new EventEmitter() as EventEmitter & {
    url?: string;
    method?: string;
    headers: Record<string, string>;
    destroy: ReturnType<typeof vi.fn>;
  };
  req.url = options.url ?? PLUGIN_FEED_PATH;
  req.method = options.method ?? "POST";
  req.headers = options.authorization === undefined ? {} : { authorization: options.authorization };
  const destroy = vi.fn();
  req.destroy = destroy;
  return { req: req as unknown as IncomingMessage, destroy };
}

/** Emit a request body: data chunks then end (listeners are attached
 *  synchronously inside the handler, so this is safe right after invoke). */
function emitBody(req: IncomingMessage, chunks: string[], end = true): void {
  for (const chunk of chunks) req.emit("data", Buffer.from(chunk, "utf8"));
  if (end) req.emit("end");
}

function handlerConfig(): EmbeddingConfig {
  return {
    feedHost: "127.0.0.1",
    feedPort: 0,
    feedToken: FEED_TOKEN,
    apiBaseUrl: "http://127.0.0.1:3100",
  };
}

function okFeed(): Promise<PluginFeedHandlerResult> {
  return Promise.resolve({ status: 200, body: { ok: true, applied: 1 } });
}

// -- createEmbeddingRequestHandler: wire contract -------------------------------

describe("createEmbeddingRequestHandler — wire contract", () => {
  it("answers an opaque 404 for any unknown path, even with valid credentials", () => {
    const { res, captured } = makeRes();
    const handler = createEmbeddingRequestHandler(handlerConfig(), okFeed);

    handler(makeReq({ url: "/api/elsewhere", authorization: AUTH }).req, res);

    expect(captured.status).toBe(404);
    expect(captured.body).toEqual({ ok: false, error: "notFound" });
  });

  it("answers 405 for a non-POST method, even with valid credentials (method gates before auth)", () => {
    for (const method of ["GET", "PUT", "DELETE"]) {
      const { res, captured } = makeRes();
      createEmbeddingRequestHandler(handlerConfig(), okFeed)(
        makeReq({ method, authorization: AUTH }).req,
        res,
      );
      expect(captured.status).toBe(405);
      expect(captured.body).toEqual({ ok: false, error: "methodNotAllowed" });
    }
  });

  it("answers 401 when the Authorization header is missing", () => {
    const { res, captured } = makeRes();
    createEmbeddingRequestHandler(handlerConfig(), okFeed)(makeReq({}).req, res);

    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ ok: false, error: "unauthorized" });
  });

  it("answers 401 for a wrong bearer token and for a non-Bearer scheme", () => {
    for (const authorization of ["Bearer wrong-token", "Basic dXNlcjpwYXNz", "bearer secret-ish"]) {
      const { res, captured } = makeRes();
      createEmbeddingRequestHandler(handlerConfig(), okFeed)(
        makeReq({ authorization }).req,
        res,
      );
      expect(captured.status).toBe(401);
      expect(captured.body).toEqual({ ok: false, error: "unauthorized" });
    }
  });

  it("logs the 401 as a structured event and never logs the token", () => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    try {
      const { res, captured } = makeRes();
      createEmbeddingRequestHandler(handlerConfig(), okFeed)(
        makeReq({ authorization: `Bearer ${"x".repeat(FEED_TOKEN.length)}` }).req,
        res,
      );

      expect(captured.status).toBe(401);
      expect(logs.some((line) => line.includes("paperclip_feed_unauthorized"))).toBe(true);
      expect(logs.some((line) => line.includes(FEED_TOKEN))).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  it("answers 401 when the token rides the URL query (never accepted from the URL)", () => {
    const { res, captured } = makeRes();
    createEmbeddingRequestHandler(handlerConfig(), okFeed)(
      makeReq({ url: `${PLUGIN_FEED_PATH}?token=${encodeURIComponent(FEED_TOKEN)}` }).req,
      res,
    );

    expect(captured.status).toBe(401);
    expect(captured.body).toEqual({ ok: false, error: "unauthorized" });
  });

  it("ignores the query string when the path matches (auth still rides the header)", async () => {
    const { req } = makeReq({ url: `${PLUGIN_FEED_PATH}?junk=1`, authorization: AUTH });
    const { res, captured, done } = makeRes();
    const feed = vi.fn(okFeed);
    createEmbeddingRequestHandler(handlerConfig(), feed)(req, res);
    emitBody(req, ["{}"]);
    await done;

    expect(captured.status).toBe(200);
    expect(feed).toHaveBeenCalledTimes(1);
  });

  it("answers 400 for an invalid JSON body without calling the feed handler", async () => {
    const { req } = makeReq({ authorization: AUTH });
    const { res, captured, done } = makeRes();
    const feed = vi.fn(okFeed);
    createEmbeddingRequestHandler(handlerConfig(), feed)(req, res);
    emitBody(req, ["not json {"]);
    await done;

    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({ ok: false, error: "invalidJson" });
    expect(feed).not.toHaveBeenCalled();
  });

  it("answers 413 and destroys the request when the body exceeds the 1 MiB cap", async () => {
    const { req, destroy } = makeReq({ authorization: AUTH });
    const { res, captured, done } = makeRes();
    const feed = vi.fn(okFeed);
    createEmbeddingRequestHandler(handlerConfig(), feed)(req, res);
    emitBody(req, ["x".repeat(1024 * 1024), "one byte over"]);
    await done;

    expect(captured.status).toBe(413);
    expect(captured.body).toEqual({ ok: false, error: "bodyTooLarge" });
    expect(destroy).toHaveBeenCalled();
    expect(feed).not.toHaveBeenCalled();
  });

  it("proxies a valid authenticated JSON body to the feed handler and passes its status/body through", async () => {
    const { req } = makeReq({ authorization: AUTH });
    const { res, captured, done } = makeRes();
    const feed = vi.fn(async (): Promise<PluginFeedHandlerResult> => ({
      status: 200,
      body: { ok: true, applied: 2 },
    }));
    createEmbeddingRequestHandler(handlerConfig(), feed)(req, res);
    emitBody(req, [JSON.stringify({ schemaVersion: 1, companyId: "company-acme", operations: [] })]);
    await done;

    expect(feed).toHaveBeenCalledTimes(1);
    expect(feed.mock.calls[0][0]).toEqual({
      schemaVersion: 1,
      companyId: "company-acme",
      operations: [],
    });
    expect(captured.status).toBe(200);
    expect(captured.body).toEqual({ ok: true, applied: 2 });
    // Machine-endpoint response headers, exactly as sendJson writes them.
    expect(captured.headers["content-type"]).toBe("application/json");
    expect(captured.headers["cache-control"]).toBe("no-store");
    expect(captured.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("passes a non-200 feed result through verbatim (e.g. a 400 invalid batch)", async () => {
    const { req } = makeReq({ authorization: AUTH });
    const { res, captured, done } = makeRes();
    const feed = vi.fn(async (): Promise<PluginFeedHandlerResult> => ({
      status: 400,
      body: { ok: false, error: "invalidFeedBatch", errors: ["schemaVersion must be 1"] },
    }));
    createEmbeddingRequestHandler(handlerConfig(), feed)(req, res);
    emitBody(req, ["{}"]);
    await done;

    expect(captured.status).toBe(400);
    expect(captured.body).toEqual({
      ok: false,
      error: "invalidFeedBatch",
      errors: ["schemaVersion must be 1"],
    });
  });

  it("answers an opaque 500 when the feed handler throws (no detail leaks to the pusher)", async () => {
    const { req } = makeReq({ authorization: AUTH });
    const { res, captured, done } = makeRes();
    const feed = vi.fn(async (): Promise<PluginFeedHandlerResult> => {
      throw new Error("pluginNotStarted");
    });
    createEmbeddingRequestHandler(handlerConfig(), feed)(req, res);
    emitBody(req, ["{}"]);
    await done;

    expect(captured.status).toBe(500);
    expect(captured.body).toEqual({ ok: false, error: "internalError" });
    expect(JSON.stringify(captured.body)).not.toContain("pluginNotStarted");
  });
});

// -- register(): fork plugin-module composition ---------------------------------

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

const VALID_BATCH = JSON.stringify({
  schemaVersion: 1,
  companyId: "company-acme",
  operations: [
    { op: "declareAgents", agents: [{ key: "agent-a", name: "Agent A" }] },
    { op: "updateAgentStatus", key: "agent-a", status: "active" },
  ],
});

describe("register — fork plugin-module composition", () => {
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

  /** Replace process.env with a copy in which every embedding variable is
   *  cleared unless the test sets it (register reads process.env directly). */
  function stubEnv(vars: Record<string, string>): void {
    const env: Record<string, string | undefined> = { ...ORIGINAL_ENV, ...vars };
    for (const key of ENV_KEYS) {
      if (!(key in vars)) delete env[key];
    }
    process.env = env;
  }

  it("refuses to register at all without PAPERCLIP_PIXEL_FEED_TOKEN (fail-closed startup)", async () => {
    stubEnv({});
    const host = makeHost();

    await expect(registerPaperclipPixelEmbedding(host, { store: {} })).rejects.toThrow(
      /PAPERCLIP_PIXEL_FEED_TOKEN is required/,
    );

    expect(host.registerPlugin).not.toHaveBeenCalled();
    expect(host.startPlugin).not.toHaveBeenCalled();
  });

  it("refuses to register on an invalid PAPERCLIP_PIXEL_FEED_PORT (fail-closed startup)", async () => {
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: "not-a-port" });
    const host = makeHost();

    await expect(registerPaperclipPixelEmbedding(host, { store: {} })).rejects.toThrow(
      /Invalid PAPERCLIP_PIXEL_FEED_PORT/,
    );
    expect(host.registerPlugin).not.toHaveBeenCalled();
  });

  it("registers the plugin through the host API and serves the feed endpoint on the configured port", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();

    await registerPaperclipPixelEmbedding(host, { store: {} });

    const registration = registrationOf(host);
    expect(registration.id).toBe(PAPERCLIP_PIXEL_PLUGIN_ID);
    expect(registration.handlers.onStart).toBeTypeOf("function");
    expect(Object.keys(registration.handlers.actions ?? {}).sort()).toEqual([
      "reply-to-feedback",
      "send-message",
    ]);
    expect(host.startPlugin).toHaveBeenCalledWith(PAPERCLIP_PIXEL_PLUGIN_ID);

    // The sidecar listener is up and answers with the wire contract.
    const response = await postFeed(port, "not-json");
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: "invalidJson" });

    registration.handlers.onStop?.();
  });

  it("refuses feed operations with an opaque 500 until onStart captures the agent source", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    // Before onStart the source proxy refuses (pluginNotStarted); the pusher
    // only ever sees the opaque last-resort 500.
    const refused = await postFeed(port, VALID_BATCH);
    expect(refused.status).toBe(500);
    expect(refused.body).toEqual({ ok: false, error: "internalError" });
    expect(JSON.stringify(refused.body)).not.toContain("pluginNotStarted");

    // onStart (run by the real host's startPlugin) captures the plugin's
    // sanctioned agent source — from here the same push applies.
    const source = {
      declareAgents: vi.fn(),
      removeAgents: vi.fn(),
      updateAgentStatus: vi.fn(),
      updateAgentActivity: vi.fn(),
      updateAgentLabelPolicy: vi.fn(),
    } satisfies PluginAgentSource;
    registration.handlers.onStart?.({
      pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
      manifest: registration.manifest,
      emit: vi.fn(),
      agents: source,
      appearance: {
        declareCharacterCatalog: vi.fn(),
        assignAgentAppearance: vi.fn(),
      },
    } as unknown as PixelAgentsPluginContext);

    const applied = await postFeed(port, VALID_BATCH);
    expect(applied.status).toBe(200);
    expect(applied.body).toEqual({ ok: true, applied: 2 });
    expect(source.declareAgents).toHaveBeenCalledWith([{ key: "agent-a", name: "Agent A" }]);
    expect(source.updateAgentStatus).toHaveBeenCalledWith("agent-a", { status: "active" });

    registration.handlers.onStop?.();
  });

  it("fails every reply action closed with forwarderNotConfigured without PAPERCLIP_PIXEL_API_TOKEN", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    const reply = await registration.handlers.actions?.["reply-to-feedback"]({
      companyId: "company-acme",
      feedbackId: "feedback-1",
      text: "the answer",
    });
    expect(reply).toEqual({ ok: false, error: "forwarderNotConfigured" });

    const sent = await registration.handlers.actions?.["send-message"]({
      companyId: "company-acme",
      text: "hello",
    });
    expect(sent).toEqual({ ok: false, error: "forwarderNotConfigured" });

    registration.handlers.onStop?.();
  });

  it("never logs the feed token across the full composition", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    });
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    await postFeed(port, "not-json"); // 400 path
    await postFeed(port, VALID_BATCH, "wrong-token"); // 401 path
    registration.handlers.onStart?.({
      pluginId: PAPERCLIP_PIXEL_PLUGIN_ID,
      manifest: registration.manifest,
      emit: vi.fn(),
      agents: {
        declareAgents: vi.fn(),
        removeAgents: vi.fn(),
        updateAgentStatus: vi.fn(),
        updateAgentActivity: vi.fn(),
        updateAgentLabelPolicy: vi.fn(),
      } satisfies PluginAgentSource,
      appearance: {
        declareCharacterCatalog: vi.fn(),
        assignAgentAppearance: vi.fn(),
      },
    } as unknown as PixelAgentsPluginContext);
    await postFeed(port, VALID_BATCH); // 200 path

    expect(logs.some((line) => line.includes(FEED_TOKEN))).toBe(false);

    registration.handlers.onStop?.();
  });

  it("onStop closes the sidecar listener (new connections are refused)", async () => {
    const port = await getFreePort();
    stubEnv({ PAPERCLIP_PIXEL_FEED_TOKEN: FEED_TOKEN, PAPERCLIP_PIXEL_FEED_PORT: String(port) });
    const host = makeHost();
    await registerPaperclipPixelEmbedding(host, { store: {} });
    const registration = registrationOf(host);

    // Still up before the stop.
    expect((await postFeed(port, "{}")).status).toBe(400);

    registration.handlers.onStop?.();

    const deadline = Date.now() + 2_000;
    for (;;) {
      try {
        await postFeed(port, "{}");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).toBe("ECONNREFUSED");
        break;
      }
      if (Date.now() > deadline) {
        throw new Error("listener still accepts connections after onStop()");
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  });
});
