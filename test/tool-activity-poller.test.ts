import { afterEach, describe, expect, it, vi } from "vitest";
import { ToolActivityPoller, translateOpencodeTool, type LogFetchLike } from "../src/tool-activity-poller.js";
import type { SessionAgentEvent } from "../src/pixel-agents-provider/index.js";

describe("translateOpencodeTool", () => {
  it("maps read/write/edit to their Claude names with file_path from opencode's filePath", () => {
    expect(translateOpencodeTool("read", { filePath: "/a/b/report.md" })).toEqual({
      name: "Read",
      input: { file_path: "/a/b/report.md" },
    });
    expect(translateOpencodeTool("write", { filePath: "/a/out.ts" })).toEqual({
      name: "Write",
      input: { file_path: "/a/out.ts" },
    });
    expect(translateOpencodeTool("edit", { filePath: "/a/out.ts" })).toEqual({
      name: "Edit",
      input: { file_path: "/a/out.ts" },
    });
    expect(translateOpencodeTool("multiedit", { filePath: "/a/out.ts" })).toEqual({
      name: "Edit",
      input: { file_path: "/a/out.ts" },
    });
  });

  it("maps bash's command through verbatim (confirmed identical field name live)", () => {
    expect(translateOpencodeTool("bash", { command: "npm test" })).toEqual({
      name: "Bash",
      input: { command: "npm test" },
    });
  });

  it("degrades to the Claude name with empty input when the expected field is missing", () => {
    expect(translateOpencodeTool("read", {})).toEqual({ name: "Read", input: {} });
    expect(translateOpencodeTool("bash", {})).toEqual({ name: "Bash", input: {} });
    expect(translateOpencodeTool("read", undefined)).toEqual({ name: "Read", input: {} });
  });

  it("Title-Cases an unrecognized tool name for Pixel Agents' own generic 'Using <Name>' fallback", () => {
    expect(translateOpencodeTool("todowrite", {})).toEqual({ name: "Todowrite", input: {} });
    expect(translateOpencodeTool("skill", { name: "git-ops" })).toEqual({ name: "Skill", input: {} });
  });
});

/** Build one heartbeat-run-log NDJSON line wrapping an opencode tool_use chunk. */
function toolUseLine(tool: string, callID: string, input: unknown): string {
  const chunk = JSON.stringify({
    type: "tool_use",
    part: { type: "tool", tool, callID, state: { status: "completed", input } },
  });
  return JSON.stringify({ ts: "2026-08-31T21:00:00.000Z", stream: "stdout", chunk, seq: 1 });
}

/** A non-tool-use line (e.g. opencode's step_start), which must never be forwarded. */
function stepStartLine(): string {
  const chunk = JSON.stringify({ type: "step_start", sessionID: "ses_x" });
  return JSON.stringify({ ts: "2026-08-31T21:00:00.000Z", stream: "stdout", chunk, seq: 2 });
}

function makeFetch(
  pages: Array<{ content: string; nextOffset: number } | Error>,
): { fetch: LogFetchLike; calls: Array<{ url: string; headers: Record<string, string> }> } {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetch: LogFetchLike = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const page = pages[Math.min(i, pages.length - 1)];
    i += 1;
    if (page instanceof Error) throw page;
    return { ok: true, status: 200, statusText: "OK", json: async () => page };
  };
  return { fetch, calls };
}

describe("ToolActivityPoller", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a real tool call as a toolStart event carrying the translated name/input", async () => {
    const emitted: SessionAgentEvent[] = [];
    const { fetch, calls } = makeFetch([
      { content: toolUseLine("read", "call-1", { filePath: "/x/y.ts" }) + "\n", nextOffset: 500 },
    ]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: (event) => { emitted.push(event); } },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");

    await poller.pollOnce();

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:3100/api/heartbeat-runs/run-1/log?offset=0&limitBytes=8000");
    expect(calls[0].headers.authorization).toBe("Bearer tok-1");
    expect(emitted).toEqual([
      {
        sessionId: "paperclip-bridge:company-acme:agent-dev",
        event: { kind: "toolStart", toolId: "call-1", toolName: "Read", input: { file_path: "/x/y.ts" } },
      },
    ]);
  });

  it("advances the offset so the next poll only requests new bytes", async () => {
    const { fetch, calls } = makeFetch([
      { content: toolUseLine("bash", "call-1", { command: "ls" }) + "\n", nextOffset: 300 },
      { content: "", nextOffset: 300 },
    ]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: () => {} },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");

    await poller.pollOnce();
    await poller.pollOnce();

    expect(calls[0].url).toContain("offset=0");
    expect(calls[1].url).toContain("offset=300");
  });

  it("never re-forwards the same tool call across repeated polls (dedup by callID)", async () => {
    const emitted: SessionAgentEvent[] = [];
    const line = toolUseLine("bash", "call-1", { command: "ls" }) + "\n";
    const { fetch } = makeFetch([
      { content: line, nextOffset: 300 },
      { content: line, nextOffset: 300 }, // same content re-served (e.g. offset didn't move)
    ]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: (event) => { emitted.push(event); } },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");

    await poller.pollOnce();
    await poller.pollOnce();

    expect(emitted).toHaveLength(1);
  });

  it("ignores non-tool_use chunks (e.g. opencode's step_start) without forwarding anything", async () => {
    const emitted: SessionAgentEvent[] = [];
    const { fetch } = makeFetch([{ content: stepStartLine() + "\n", nextOffset: 100 }]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: (event) => { emitted.push(event); } },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");

    await poller.pollOnce();

    expect(emitted).toEqual([]);
  });

  it("buffers a record split across two polls instead of dropping or misparsing it", async () => {
    const fullLine = toolUseLine("read", "call-1", { filePath: "/a.ts" });
    const splitPoint = Math.floor(fullLine.length / 2);
    const emitted: SessionAgentEvent[] = [];
    const { fetch } = makeFetch([
      { content: fullLine.slice(0, splitPoint), nextOffset: splitPoint },
      { content: fullLine.slice(splitPoint) + "\n", nextOffset: fullLine.length + 1 },
    ]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: (event) => { emitted.push(event); } },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");

    await poller.pollOnce();
    expect(emitted).toEqual([]); // nothing yet -- the record isn't complete
    await poller.pollOnce();
    expect(emitted).toHaveLength(1);
    expect((emitted[0].event as { toolName: string }).toolName).toBe("Read");
  });

  it("reports a fetch failure via onError and never throws out of pollOnce", async () => {
    const onError = vi.fn();
    const { fetch } = makeFetch([new Error("network down")]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: () => {} },
      onError,
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");

    await expect(poller.pollOnce()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith("run-1", expect.any(Error));
  });

  it("stops polling a run once untracked", async () => {
    const { fetch, calls } = makeFetch([{ content: "", nextOffset: 0 }]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: () => {} },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");
    poller.untrackRun("run-1");

    await poller.pollOnce();

    expect(calls).toHaveLength(0);
    expect(poller.trackedRunCount).toBe(0);
  });

  it("tracking the same runId twice is a no-op (does not reset an in-progress cursor)", async () => {
    const { fetch, calls } = makeFetch([
      { content: toolUseLine("bash", "call-1", { command: "ls" }) + "\n", nextOffset: 300 },
    ]);
    const poller = new ToolActivityPoller({
      apiBaseUrl: "http://127.0.0.1:3100",
      apiToken: "tok-1",
      fetch,
      sink: { emit: () => {} },
    });
    poller.trackRun("run-1", "company-acme", "agent-dev");
    await poller.pollOnce();
    poller.trackRun("run-1", "company-acme", "agent-dev"); // repeat

    await poller.pollOnce();

    expect(calls[1].url).toContain("offset=300"); // not reset back to 0
  });
});
