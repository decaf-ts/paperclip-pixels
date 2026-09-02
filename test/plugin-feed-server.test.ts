import { describe, expect, it, vi } from "vitest";
import {
  createPluginFeedHandler,
  DeclaredAgentCache,
} from "../src/pixel-agents-plugin/index.js";
import type { PluginAgentDeclaration, PluginAgentSource } from "../src/pixel-agents-plugin/index.js";

/**
 * Unit tests for `src/pixel-agents-plugin/feed-server.ts` — the framework-
 * agnostic apply side of the plugin feed (`POST /api/plugin-feed`), plus its
 * `DeclaredAgentCache` (spec PAPERCLIP_PIXELS-2, WS2-C).
 *
 * The handler validates each pushed batch fail-closed (shape, then operation
 * content — all-or-nothing, mirroring the host's declareAgents) and applies
 * the surviving operations through the registered plugin's sanctioned
 * `PluginAgentSource`. Cheap structural gates keep junk off the wire log;
 * the host re-validates everything behind it.
 */

const COMPANY_ID = "company-acme";

interface LogCall {
  event: string;
  fields?: Record<string, unknown>;
}

function makeSource() {
  return {
    declareAgents: vi.fn(),
    removeAgents: vi.fn(),
    updateAgentStatus: vi.fn(),
    updateAgentActivity: vi.fn(),
  } satisfies PluginAgentSource;
}

function makeHandler(source: PluginAgentSource = makeSource(), logs?: LogCall[]) {
  return createPluginFeedHandler({
    source,
    log: logs
      ? (event, fields) => {
          logs.push({ event, fields });
        }
      : undefined,
  });
}

function batch(operations: unknown[]): unknown {
  return { schemaVersion: 1, companyId: COMPANY_ID, operations };
}

function declareOp(agents: unknown[]): unknown {
  return { op: "declareAgents", agents };
}

// -- DeclaredAgentCache -------------------------------------------------------

describe("DeclaredAgentCache", () => {
  it("upserts declarations by key (latest wins) and lists them", () => {
    const cache = new DeclaredAgentCache();
    const first: PluginAgentDeclaration = { key: "agent-a", name: "First" };
    const second: PluginAgentDeclaration = { key: "agent-a", name: "Second", palette: 2 };
    const other: PluginAgentDeclaration = { key: "agent-b", name: "B" };

    cache.recordDeclare([first, other]);
    cache.recordDeclare([second]);

    const declared = cache.getDeclaredAgents();
    expect(declared).toHaveLength(2);
    expect(declared.find((a) => a.key === "agent-a")).toEqual({
      key: "agent-a",
      name: "Second",
      palette: 2,
    });
    expect(declared.find((a) => a.key === "agent-b")).toEqual({ key: "agent-b", name: "B" });
  });

  it("recordRemove prunes by key", () => {
    const cache = new DeclaredAgentCache();
    cache.recordDeclare([{ key: "agent-a", name: "A" }, { key: "agent-b", name: "B" }]);
    cache.recordRemove(["agent-a"]);
    expect(cache.getDeclaredAgents().map((a) => a.key)).toEqual(["agent-b"]);
  });
});

// -- createPluginFeedHandler: happy path ---------------------------------------

describe("createPluginFeedHandler — application", () => {
  it("applies a well-formed batch in order and reports the applied count", async () => {
    const source = makeSource();
    const { handle } = makeHandler(source);

    const result = await handle(
      batch([
        declareOp([{ key: "agent-a", name: "Agent A" }]),
        { op: "updateAgentStatus", key: "agent-a", status: "active" },
        { op: "updateAgentActivity", key: "agent-a", activity: "Task: Work" },
        { op: "removeAgents", keys: ["agent-b"] },
      ]),
    );

    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true, applied: 4 });
    expect(source.declareAgents).toHaveBeenCalledWith([
      { key: "agent-a", name: "Agent A" },
    ]);
    expect(source.updateAgentStatus).toHaveBeenCalledWith("agent-a", { status: "active" });
    expect(source.updateAgentActivity).toHaveBeenCalledWith("agent-a", "Task: Work");
    expect(source.removeAgents).toHaveBeenCalledWith(["agent-b"]);
  });

  it("records declares into the write-through cache (trimmed names) and prunes on remove", async () => {
    const source = makeSource();
    const { handle, cache } = makeHandler(source);

    await handle(batch([declareOp([{ key: "agent-a", name: "  Agent A  " }])]));
    expect(cache.getDeclaredAgents()).toEqual([{ key: "agent-a", name: "Agent A" }]);

    await handle(batch([{ op: "removeAgents", keys: ["agent-a"] }]));
    expect(cache.getDeclaredAgents()).toEqual([]);
  });

  it("trims and caps declaration names at 100 characters before they reach the source", async () => {
    const source = makeSource();
    const { handle } = makeHandler(source);
    const longName = `${"x".repeat(120)}trimmed-away-tail`;

    await handle(batch([declareOp([{ key: "agent-a", name: `  ${longName}  ` }])]));

    const passed = source.declareAgents.mock.calls[0][0] as PluginAgentDeclaration[];
    expect(passed[0].name).toBe("x".repeat(100));
  });

  it("maps status operations exactly: active carries no awaitingInput; waiting reflects it", async () => {
    const source = makeSource();
    const { handle } = makeHandler(source);

    await handle(
      batch([
        { op: "updateAgentStatus", key: "agent-a", status: "active", awaitingInput: true },
        { op: "updateAgentStatus", key: "agent-b", status: "waiting", awaitingInput: true },
        { op: "updateAgentStatus", key: "agent-c", status: "waiting" },
      ]),
    );

    expect(source.updateAgentStatus).toHaveBeenNthCalledWith(1, "agent-a", { status: "active" });
    expect(source.updateAgentStatus).toHaveBeenNthCalledWith(2, "agent-b", {
      status: "waiting",
      awaitingInput: true,
    });
    expect(source.updateAgentStatus).toHaveBeenNthCalledWith(3, "agent-c", {
      status: "waiting",
      awaitingInput: false,
    });
  });

  it("trims and caps activity captions at 300 characters; null passes through as null", async () => {
    const source = makeSource();
    const { handle } = makeHandler(source);
    const longActivity = `${"y".repeat(350)}tail`;

    await handle(
      batch([
        { op: "updateAgentActivity", key: "agent-a", activity: `  ${longActivity}  ` },
        { op: "updateAgentActivity", key: "agent-a", activity: null },
      ]),
    );

    expect(source.updateAgentActivity).toHaveBeenNthCalledWith(1, "agent-a", "y".repeat(300));
    expect(source.updateAgentActivity).toHaveBeenNthCalledWith(2, "agent-a", null);
  });

  it("logs declare/remove events with counts (ids/counts only, per the host's log rule)", async () => {
    const logs: LogCall[] = [];
    const { handle } = makeHandler(makeSource(), logs);

    await handle(
      batch([
        declareOp([
          { key: "agent-a", name: "A" },
          { key: "agent-b", name: "B" },
        ]),
        { op: "removeAgents", keys: ["agent-c"] },
      ]),
    );

    expect(logs).toEqual([
      { event: "paperclip_feed_declare", fields: { count: 2 } },
      { event: "paperclip_feed_remove", fields: { count: 1 } },
    ]);
  });
});

// -- createPluginFeedHandler: fail-closed validation -----------------------------

describe("createPluginFeedHandler — validation", () => {
  it("rejects a malformed batch shape with 400 invalidFeedBatch and applies nothing", async () => {
    const source = makeSource();
    const logs: LogCall[] = [];
    const { handle } = makeHandler(source, logs);

    const result = await handle({ schemaVersion: 2, companyId: "", operations: "nope" });

    expect(result.status).toBe(400);
    expect(result.body).toMatchObject({ ok: false, error: "invalidFeedBatch" });
    expect((result.body.errors as string[]).length).toBeGreaterThan(0);
    expect(source.declareAgents).not.toHaveBeenCalled();
    expect(logs).toEqual([{ event: "paperclip_feed_rejected", fields: { errorCount: 3 } }]);
  });

  it.each([
    ["an empty agents array", declareOp([]), "operations[0].agents must be a non-empty array"],
    [
      "a declaration with a malformed key",
      declareOp([{ key: "bad key", name: "A" }]),
      "operations[0] has an invalid declaration",
    ],
    [
      "a declaration with an empty name",
      declareOp([{ key: "agent-a", name: "   " }]),
      "operations[0] has an invalid declaration",
    ],
    [
      "a declaration with a negative palette",
      declareOp([{ key: "agent-a", name: "A", palette: -1 }]),
      "operations[0] has an invalid declaration",
    ],
    [
      "a declaration with a fractional palette",
      declareOp([{ key: "agent-a", name: "A", palette: 1.5 }]),
      "operations[0] has an invalid declaration",
    ],
    [
      "a declaration with an out-of-range hueShift",
      declareOp([{ key: "agent-a", name: "A", hueShift: 361 }]),
      "operations[0] has an invalid declaration",
    ],
    ["removeAgents with non-string keys", { op: "removeAgents", keys: [1] }, "operations[0].keys must be an array of strings"],
    ["a status op with a malformed key", { op: "updateAgentStatus", key: "bad key", status: "active" }, "operations[0].key is invalid"],
    ["a status op with an unknown status", { op: "updateAgentStatus", key: "agent-a", status: "paused" }, "operations[0].status must be 'active' or 'waiting'"],
    ["an activity op with an empty caption", { op: "updateAgentActivity", key: "agent-a", activity: "   " }, "operations[0].activity must be a non-empty string or null"],
    ["an activity op with a non-string caption", { op: "updateAgentActivity", key: "agent-a", activity: 42 }, "operations[0].activity must be a non-empty string or null"],
  ])("rejects %s with 400 invalidFeedOperations", async (_label, op, expectedError) => {
    const source = makeSource();
    const { handle } = makeHandler(source);

    const result = await handle(batch([op]));

    expect(result.status).toBe(400);
    expect(result.body).toEqual({ ok: false, error: "invalidFeedOperations", errors: [expectedError] });
    expect(source.declareAgents).not.toHaveBeenCalled();
  });

  it("is all-or-nothing: one invalid operation voids the whole batch, valid ops never apply", async () => {
    const source = makeSource();
    const { handle } = makeHandler(source);

    const result = await handle(
      batch([
        declareOp([{ key: "agent-a", name: "A" }]),
        { op: "updateAgentStatus", key: "agent-a", status: "paused" },
      ]),
    );

    expect(result.status).toBe(400);
    expect(source.declareAgents).not.toHaveBeenCalled();
    expect(source.updateAgentStatus).not.toHaveBeenCalled();
  });

  it("accepts every field the mapper legitimately emits (palette 0, hueShift 0/360, key with dots/dashes)", async () => {
    const source = makeSource();
    const { handle } = makeHandler(source);

    const result = await handle(
      batch([
        declareOp([{ key: "agent.ceo-1", name: "CEO", palette: 0, hueShift: 360 }]),
        { op: "updateAgentActivity", key: "agent.ceo-1", activity: "Task: x" },
      ]),
    );

    expect(result.status).toBe(200);
    expect(source.declareAgents).toHaveBeenCalledWith([
      { key: "agent.ceo-1", name: "CEO", palette: 0, hueShift: 360 },
    ]);
  });
});
