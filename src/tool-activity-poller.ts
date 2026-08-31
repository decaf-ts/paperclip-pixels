/**
 * Tool-activity poller (spec gap closed 2026-08-31: real tool descriptions in
 * Pixel Agents, not the synthetic "PaperclipWork" placeholder).
 *
 * Paperclip's own plugin event bus has no per-tool-call event at all --
 * confirmed directly against its `PLUGIN_EVENT_TYPES` catalog, the finest
 * granularity it exposes is whole-run boundaries
 * (agent.run.started/finished/failed/cancelled). Native Pixel Agents + Claude
 * Code integration shows "Reading X"/"Writing Y" by tailing Claude Code's own
 * continuously-growing transcript JSONL and parsing `tool_use` content blocks
 * live (confirmed by reading Pixel Agents' own bundle) -- a mechanism this
 * bridge's synthetic, write-once transcript can never feed, since Paperclip
 * never hands the plugin a real tool name or input to write into it.
 *
 * What IS available: each run's raw stdout -- opencode's own `--format json`
 * output -- is stored as NDJSON and readable via
 * `GET /api/heartbeat-runs/:runId/log` with a board-scoped API token
 * (confirmed live: a plain board API key, no narrower scope exists in this
 * host version). It genuinely contains per-tool-call events, in opencode's
 * own shape rather than Claude Code's:
 *   {"type":"tool_use","part":{"type":"tool","tool":"read",
 *     "callID":"...","state":{"status":"completed","input":{"filePath":"..."}}}}
 *
 * This poller tails that log for every currently-tracked active run (fed by
 * BridgeRelay.trackActiveRun/untrackActiveRun, itself driven by
 * agent.run.started/finished/failed/cancelled and by each bootstrapped
 * snapshot's activeRuns) and forwards each newly-seen tool call, translated
 * into the wire shape Pixel Agents' own `formatToolStatus` already knows how
 * to render richly (Reading/Writing/Editing/Running: for a recognized name,
 * "Using <Name>" otherwise -- both exactly what was asked for), through the
 * same sink every other mapped event already goes through. No Pixel Agents
 * change and no new Paperclip plugin capability required.
 */

import type { AgentEventSink } from "./pixel-agents-provider/index.js";
import { syntheticSessionId } from "./pixel-agents-provider/index.js";

/**
 * Minimal fetch-like function for a GET call whose JSON body is actually
 * read (unlike {@link FetchLike} in transport.ts, which only reports
 * ok/status for a fire-and-forget POST push).
 */
export type LogFetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string> },
) => Promise<{ ok: boolean; status: number; statusText: string; json: () => Promise<unknown> }>;

/** One opencode `tool_use` chunk's part, as it appears in the raw run log. */
interface OpencodeToolPart {
  type?: string;
  tool?: string;
  callID?: string;
  state?: { input?: unknown };
}

/**
 * Translate an opencode tool name + its (opencode-shaped) input into the
 * Claude tool name + input `formatToolStatus` (Pixel Agents' own, unchanged)
 * already has a rich case for. Anything unmapped still gets Pixel Agents'
 * own generic fallback ("Using <Name>") by passing a Title-Cased name
 * through -- never worse than today's universal "PaperclipWork", and exactly
 * the "using tool XXX" shape that was asked for.
 *
 * Only translates the input fields a given Claude case actually reads (see
 * `formatToolStatus` in pixel-agents' claude.ts): Read/Edit/Write read
 * `file_path`; Bash reads `command`. Opencode's own field names are
 * confirmed live (2026-08-31) for `read` (`filePath`) and `bash` (`command`,
 * verbatim match); `write`/`edit`/`grep`/`glob` are mapped on the same
 * `filePath`/`pattern` convention as `read` but not yet directly observed --
 * an unrecognized/renamed input shape degrades to that tool's Claude label
 * with no path shown, never an error.
 */
export function translateOpencodeTool(
  tool: string,
  input: unknown,
): { name: string; input: Record<string, unknown> } {
  const inp = (input ?? {}) as Record<string, unknown>;
  const filePath = typeof inp.filePath === "string" ? inp.filePath : undefined;
  switch (tool) {
    case "read":
      return { name: "Read", input: filePath ? { file_path: filePath } : {} };
    case "write":
      return { name: "Write", input: filePath ? { file_path: filePath } : {} };
    case "edit":
    case "multiedit":
      return { name: "Edit", input: filePath ? { file_path: filePath } : {} };
    case "bash":
      return {
        name: "Bash",
        input: typeof inp.command === "string" ? { command: inp.command } : {},
      };
    case "grep":
      return { name: "Grep", input: {} };
    case "glob":
      return { name: "Glob", input: {} };
    case "webfetch":
      return { name: "WebFetch", input: {} };
    case "websearch":
      return { name: "WebSearch", input: {} };
    case "task":
      return { name: "Task", input: {} };
    default: {
      // Title-Case the raw opencode name (e.g. "todowrite" -> "Todowrite") so
      // Pixel Agents' generic fallback reads as "Using Todowrite" rather than
      // "Using todowrite" -- cosmetic only, formatToolStatus's default case
      // never inspects input for an unrecognized name.
      const titled = tool.length > 0 ? tool[0].toUpperCase() + tool.slice(1) : tool;
      return { name: titled, input: {} };
    }
  }
}

/** One run log's incremental read position, so repeated polls only fetch new bytes. */
interface RunLogCursor {
  companyId: string;
  agentId: string;
  offset: number;
  /** Partial line carried over when a poll ends mid-record. */
  pending: string;
  /** Last forwarded tool call's callID, so an unchanged tail is never re-sent. */
  lastCallId: string | null;
}

const LOG_PAGE_BYTES = 8_000;

/** Minimal shape of the heartbeat-run log read endpoint's response. */
interface HeartbeatLogPage {
  content: string;
  nextOffset: number;
}

export interface ToolActivityPollerOptions {
  /** Base URL of the Paperclip API this run belongs to (same-container loopback by default). */
  apiBaseUrl: string;
  /** Bearer token for `GET /api/heartbeat-runs/:runId/log`. */
  apiToken: string;
  /** Injected fetch (kept separate from Node globals for testability, matching HttpPushSink). */
  fetch: LogFetchLike;
  /** Receives each translated tool call as a real (never synthetic) toolStart event. */
  sink: AgentEventSink;
  /** Called on any poll failure; never throws back into the caller. */
  onError?: (runId: string, error: unknown) => void;
}

/**
 * Polls every currently-tracked active run's raw log for new tool calls and
 * forwards them as toolStart events. One instance per company (matching
 * BridgeRelay's per-company CompanyRelay entries); `start`/`stop` own a
 * single interval timer for the whole company regardless of how many runs
 * are tracked at once.
 */
export class ToolActivityPoller {
  private readonly options: ToolActivityPollerOptions;
  private readonly cursors = new Map<string, RunLogCursor>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: ToolActivityPollerOptions) {
    this.options = options;
  }

  /** Begin tracking a run (idempotent -- a repeat call for the same runId is a no-op). */
  trackRun(runId: string, companyId: string, agentId: string): void {
    if (this.cursors.has(runId)) return;
    this.cursors.set(runId, { companyId, agentId, offset: 0, pending: "", lastCallId: null });
  }

  /** Stop tracking a finished/failed/cancelled run. */
  untrackRun(runId: string): void {
    this.cursors.delete(runId);
  }

  /** Number of runs currently tracked (for tests/observability). */
  get trackedRunCount(): number {
    return this.cursors.size;
  }

  /** Poll every tracked run once. Never throws -- failures are reported via `onError`. */
  async pollOnce(): Promise<void> {
    await Promise.all(
      [...this.cursors.entries()].map(([runId, cursor]) => this.pollRun(runId, cursor)),
    );
  }

  private async pollRun(runId: string, cursor: RunLogCursor): Promise<void> {
    try {
      const url = `${this.options.apiBaseUrl.replace(/\/$/, "")}/api/heartbeat-runs/${runId}/log?offset=${cursor.offset}&limitBytes=${LOG_PAGE_BYTES}`;
      const res = await this.options.fetch(url, {
        method: "GET",
        headers: { authorization: `Bearer ${this.options.apiToken}` },
      });
      if (!res.ok) return;
      const page = (await res.json()) as HeartbeatLogPage;
      if (typeof page.nextOffset !== "number" || typeof page.content !== "string") return;
      cursor.offset = page.nextOffset;
      this.processContent(runId, cursor, page.content);
    } catch (err) {
      this.options.onError?.(runId, err);
    }
  }

  private processContent(runId: string, cursor: RunLogCursor, content: string): void {
    const combined = cursor.pending + content;
    const lines = combined.split("\n");
    // The last element is either "" (content ended cleanly on a newline) or
    // an incomplete trailing record -- carry it into the next poll either way.
    cursor.pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      this.processLine(runId, cursor, line);
    }
  }

  private processLine(runId: string, cursor: RunLogCursor, line: string): void {
    let record: { chunk?: unknown };
    try {
      record = JSON.parse(line) as { chunk?: unknown };
    } catch {
      return;
    }
    if (typeof record.chunk !== "string") return;
    let chunk: { type?: string; part?: OpencodeToolPart };
    try {
      chunk = JSON.parse(record.chunk) as { type?: string; part?: OpencodeToolPart };
    } catch {
      return;
    }
    if (chunk.type !== "tool_use" || chunk.part?.type !== "tool") return;
    const tool = chunk.part.tool;
    const callId = chunk.part.callID;
    if (!tool || !callId || callId === cursor.lastCallId) return;
    cursor.lastCallId = callId;

    const { name, input } = translateOpencodeTool(tool, chunk.part.state?.input);
    const result = this.options.sink.emit({
      sessionId: syntheticSessionId(cursor.companyId, cursor.agentId),
      event: { kind: "toolStart", toolId: callId, toolName: name, input },
    });
    if (result && typeof (result as Promise<void>).then === "function") {
      (result as Promise<void>).catch((err) => this.options.onError?.(runId, err));
    }
  }

  /** Start polling on a fixed interval. A repeat call replaces the prior timer. */
  start(intervalMs: number): void {
    this.stop();
    this.timer = setInterval(() => {
      void this.pollOnce();
    }, intervalMs);
    if (typeof this.timer === "object" && this.timer && "unref" in this.timer) {
      (this.timer as { unref: () => void }).unref();
    }
  }

  /** Stop polling. Tracked runs are preserved (call trackRun again after a future start). */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
