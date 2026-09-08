import { describe, expect, it, vi } from "vitest";
import {
  PLUGIN_FEED_SCHEMA_VERSION,
  PluginFeedHttpSink,
  validatePluginFeedBatch,
} from "../index.js";
import type { PluginFeedOperation } from "../index.js";

/**
 * Unit tests for the plugin feed wire contract (`src/pixel-agents-plugin/feed.ts`)
 * and its push side (`src/pixel-agents-plugin/feed-sink.ts`) — spec
 * PAPERCLIP_PIXELS-2, WS2-C.
 *
 * The feed replaces the retired Claude-hook impersonation wire: the worker
 * POSTs `{ schemaVersion, companyId, operations }` batches to the embedding
 * surface's `POST /api/plugin-feed`. These tests pin the fail-closed batch
 * validation (every violation named, nothing partial accepted) and the sink's
 * ordered-push discipline (declares in a snapshot must never race ahead of
 * each other), error capture, and dispose semantics.
 */

const COMPANY_ID = "company-acme";
const AGENT_A = "agent-a";

const DECLARE_OP: PluginFeedOperation = {
  op: "declareAgents",
  agents: [{ key: AGENT_A, name: "Agent A", teamName: "paperclip-bridge-1024a250" }],
};

const OPS: PluginFeedOperation[] = [
  DECLARE_OP,
  { op: "updateAgentStatus", key: AGENT_A, status: "waiting", awaitingInput: false },
  { op: "updateAgentActivity", key: AGENT_A, activity: "Task: Paperclip work" },
  { op: "removeAgents", keys: [AGENT_A] },
];

function validBatch(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    companyId: COMPANY_ID,
    operations: OPS,
  };
}

// -- validatePluginFeedBatch ------------------------------------------------

describe("validatePluginFeedBatch", () => {
  it("accepts a well-formed batch and returns it with no errors", () => {
    const input = validBatch();
    const { errors, batch } = validatePluginFeedBatch(input);
    expect(errors).toEqual([]);
    expect(batch).toBeDefined();
    expect(batch?.schemaVersion).toBe(1);
    expect(batch?.companyId).toBe(COMPANY_ID);
    expect(batch?.operations).toHaveLength(4);
    expect(batch?.operations[0]).toEqual(DECLARE_OP);
  });

  it("exposes the current wire schema version as 1", () => {
    expect(PLUGIN_FEED_SCHEMA_VERSION).toBe(1);
  });

  it.each([
    ["null", null],
    ["an array", [validBatch()]],
    ["a string", "not-a-batch"],
    ["a number", 42],
  ])("rejects %s with exactly the top-level shape error", (_label, input) => {
    expect(validatePluginFeedBatch(input)).toEqual({ errors: ["batch must be an object"] });
  });

  it("rejects a wrong schemaVersion", () => {
    const { errors, batch } = validatePluginFeedBatch({ ...validBatch(), schemaVersion: 2 });
    expect(errors).toEqual(["schemaVersion must be 1"]);
    expect(batch).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["non-string", 123],
    ["empty string", ""],
  ])("rejects a %s companyId", (_label, companyId) => {
    const { errors } = validatePluginFeedBatch({ ...validBatch(), companyId });
    expect(errors).toEqual(["companyId must be a non-empty string"]);
  });

  it.each([
    ["missing", undefined],
    ["non-array", { op: "declareAgents" }],
  ])("rejects %s operations", (_label, operations) => {
    const { errors } = validatePluginFeedBatch({ ...validBatch(), operations });
    expect(errors).toEqual(["operations must be an array"]);
  });

  it("rejects a non-object operation", () => {
    const { errors } = validatePluginFeedBatch({
      ...validBatch(),
      operations: ["nope"],
    });
    expect(errors).toEqual(["operations[0] must be an object"]);
  });

  it("rejects declareAgents without an agents array", () => {
    const { errors } = validatePluginFeedBatch({
      ...validBatch(),
      operations: [{ op: "declareAgents", agents: "nope" }],
    });
    expect(errors).toEqual(["operations[0].agents must be an array"]);
  });

  it("rejects removeAgents without a keys array", () => {
    const { errors } = validatePluginFeedBatch({
      ...validBatch(),
      operations: [{ op: "removeAgents", keys: 3 }],
    });
    expect(errors).toEqual(["operations[0].keys must be an array"]);
  });

  it.each(["updateAgentStatus", "updateAgentActivity"])(
    "rejects %s without a string key",
    (op) => {
      const { errors } = validatePluginFeedBatch({
        ...validBatch(),
        operations: [{ op, key: 7 }],
      });
      expect(errors).toEqual([`operations[0].key must be a string`]);
    },
  );

  it("names an unknown op with its JSON-serialized kind", () => {
    const { errors } = validatePluginFeedBatch({
      ...validBatch(),
      operations: [{ op: "summonAgents" }],
    });
    expect(errors).toEqual(['operations[0] has unknown op: "summonAgents"']);
  });

  it("reports every violation at once instead of stopping at the first", () => {
    const { errors, batch } = validatePluginFeedBatch({
      schemaVersion: 99,
      companyId: "",
      operations: [{ op: "bogus" }, "nope", { op: "declareAgents" }],
    });
    expect(errors).toEqual([
      "schemaVersion must be 1",
      "companyId must be a non-empty string",
      'operations[0] has unknown op: "bogus"',
      "operations[1] must be an object",
      "operations[2].agents must be an array",
    ]);
    expect(batch).toBeUndefined();
  });

  it("accepts an empty operations array at the wire level (content rules live on the apply side)", () => {
    const { errors, batch } = validatePluginFeedBatch({ ...validBatch(), operations: [] });
    expect(errors).toEqual([]);
    expect(batch?.operations).toEqual([]);
  });
});

// -- PluginFeedHttpSink -----------------------------------------------------

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

interface DeferredRes {
  promise: Promise<{ ok: boolean; status: number; statusText: string }>;
  resolve: (value: { ok: boolean; status: number; statusText: string }) => void;
}

function deferredRes(ok = true): DeferredRes {
  let resolve!: DeferredRes["resolve"];
  const promise = new Promise<{ ok: boolean; status: number; statusText: string }>((r) => {
    resolve = r;
  });
  return { promise, resolve: (value) => resolve(value ?? { ok, status: 200, statusText: "OK" }) };
}

function okRes(): { ok: boolean; status: number; statusText: string } {
  return { ok: true, status: 200, statusText: "OK" };
}

function makeFetch(calls: FetchCall[]) {
  return vi.fn(async (url: string, init: FetchCall["init"]) => {
    calls.push({ url, init });
    return okRes();
  });
}

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("PluginFeedHttpSink", () => {
  it("POSTs the batch to {baseUrl}/api/plugin-feed with the schema envelope", async () => {
    const calls: FetchCall[] = [];
    const sink = new PluginFeedHttpSink({
      baseUrl: "https://pa.example",
      fetch: makeFetch(calls),
    });

    await sink.push(COMPANY_ID, OPS);

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://pa.example/api/plugin-feed");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(calls[0].init.body)).toEqual(validBatch());
  });

  it("strips a trailing slash from the configured base URL", async () => {
    const calls: FetchCall[] = [];
    const sink = new PluginFeedHttpSink({
      baseUrl: "https://pa.example/",
      fetch: makeFetch(calls),
    });
    await sink.push(COMPANY_ID, OPS);
    expect(calls[0].url).toBe("https://pa.example/api/plugin-feed");
  });

  it("sends an authorization: Bearer header only when a token is configured", async () => {
    const bare: FetchCall[] = [];
    const tokened: FetchCall[] = [];
    const bareSink = new PluginFeedHttpSink({ baseUrl: "https://pa.example", fetch: makeFetch(bare) });
    const tokenSink = new PluginFeedHttpSink({
      baseUrl: "https://pa.example",
      authToken: "tok-1",
      fetch: makeFetch(tokened),
    });

    await bareSink.push(COMPANY_ID, OPS);
    await tokenSink.push(COMPANY_ID, OPS);

    expect("authorization" in bare[0].init.headers).toBe(false);
    expect(tokened[0].init.headers.authorization).toBe("Bearer tok-1");
  });

  it("skips the fetch entirely for an empty operations list", async () => {
    const calls: FetchCall[] = [];
    const sink = new PluginFeedHttpSink({ baseUrl: "https://pa.example", fetch: makeFetch(calls) });
    await sink.push(COMPANY_ID, []);
    expect(calls).toHaveLength(0);
  });

  it("pushes batches strictly in order: the next send starts only after the previous settles", async () => {
    const calls: FetchCall[] = [];
    const first = deferredRes();
    const second = deferredRes();
    const fetch = vi.fn(
      (url: string, init: FetchCall["init"]) => {
        calls.push({ url, init });
        return calls.length === 1 ? first.promise : second.promise;
      },
    );
    const sink = new PluginFeedHttpSink({ baseUrl: "https://pa.example", fetch });

    const p1 = sink.push(COMPANY_ID, [DECLARE_OP]);
    const p2 = sink.push(COMPANY_ID, [{ op: "removeAgents", keys: [AGENT_A] }]);

    // Both pushes are enqueued; after a tick only the first has started.
    await tick();
    expect(fetch).toHaveBeenCalledTimes(1);

    first.resolve(okRes());
    await p1;
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(JSON.parse(calls[1].init.body).operations[0].op).toBe("removeAgents");

    second.resolve(okRes());
    await p2;
  });

  it("captures a non-2xx response in lastPushError and never rejects", async () => {
    const sink = new PluginFeedHttpSink({
      baseUrl: "https://pa.example",
      fetch: async () => ({ ok: false, status: 503, statusText: "Service Unavailable" }),
    });

    await expect(sink.push(COMPANY_ID, OPS)).resolves.toBeUndefined();
    expect(sink.lastPushError).toBe("feed push failed: 503 Service Unavailable");
  });

  it("clears lastPushError on the next successful push", async () => {
    let fail = true;
    const sink = new PluginFeedHttpSink({
      baseUrl: "https://pa.example",
      fetch: async () =>
        fail
          ? { ok: false, status: 500, statusText: "Internal Server Error" }
          : okRes(),
    });

    await sink.push(COMPANY_ID, OPS);
    expect(sink.lastPushError).toBe("feed push failed: 500 Internal Server Error");

    fail = false;
    await sink.push(COMPANY_ID, OPS);
    expect(sink.lastPushError).toBeUndefined();
  });

  it("captures a thrown Error by message (and a non-Error by String) in lastPushError", async () => {
    let thrown: unknown = new Error("connection refused");
    const sink = new PluginFeedHttpSink({
      baseUrl: "https://pa.example",
      fetch: async () => {
        throw thrown;
      },
    });

    await sink.push(COMPANY_ID, OPS);
    expect(sink.lastPushError).toBe("feed push error: connection refused");

    thrown = "plain string failure";
    await sink.push(COMPANY_ID, OPS);
    expect(sink.lastPushError).toBe("feed push error: plain string failure");
  });

  it("dispose() stops queued pushes; a send already past its disposed-check completes normally", async () => {
    const calls: FetchCall[] = [];
    const first = deferredRes();
    const fetch = vi.fn((url: string, init: FetchCall["init"]) => {
      calls.push({ url, init });
      return first.promise;
    });
    const sink = new PluginFeedHttpSink({ baseUrl: "https://pa.example", fetch });

    const p1 = sink.push(COMPANY_ID, [DECLARE_OP]);
    await tick(); // send1 is now past its disposed-check, awaiting fetch
    expect(fetch).toHaveBeenCalledTimes(1);

    const p2 = sink.push(COMPANY_ID, [{ op: "removeAgents", keys: [AGENT_A] }]);
    sink.dispose();

    // The in-flight send completes normally once its fetch settles; the
    // queued send2 then runs its disposed-check and returns without ever
    // touching the wire (its promise still resolves — fire-and-forget).
    first.resolve(okRes());
    await p1;
    await p2;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sink.lastPushError).toBeUndefined();
  });

  it("dispose() blocks even the first push when called before any send starts", async () => {
    const calls: FetchCall[] = [];
    const sink = new PluginFeedHttpSink({ baseUrl: "https://pa.example", fetch: makeFetch(calls) });
    sink.dispose();
    await sink.push(COMPANY_ID, OPS);
    expect(calls).toHaveLength(0);
  });
});
