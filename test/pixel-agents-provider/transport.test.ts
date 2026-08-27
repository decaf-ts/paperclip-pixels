import {
  BridgeTransport,
  HttpPushSink,
  syntheticSessionId,
  type AgentEventSink,
  type FetchLike,
  type SessionAgentEvent,
} from "../../src/pixel-agents-provider/index.js";
import {
  AGENT_A,
  AGENT_B,
  AGENT_C,
  AGENT_NEW,
  COMPANY_ID,
  PROJECT_X,
  runStarted,
  runFinished,
  snapshot,
} from "./fixtures";
import type { AgentInput } from "../../src/core/index.js";

class RecordingSink implements AgentEventSink {
  readonly events: SessionAgentEvent[] = [];
  emit(event: SessionAgentEvent): void {
    this.events.push(event);
  }
}

function agentInput(id: string): AgentInput {
  return { id, companyId: COMPANY_ID, name: id, status: "idle" };
}

const sessionId = (agentId: string): string =>
  syntheticSessionId(COMPANY_ID, agentId);

describe("BridgeTransport (§31.4, §30)", () => {
  it("ingests a snapshot while connected and spawns every agent exactly once", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });

    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A), agentInput(AGENT_B)] }));
    expect(t.connectionState).toBe("connected");
    expect(t.isStale()).toBe(false);

    expect(sink.events).toHaveLength(2);
    expect(sink.events).toEqual([
      { sessionId: sessionId(AGENT_A), event: { kind: "sessionStart", source: "paperclip-bridge" } },
      { sessionId: sessionId(AGENT_B), event: { kind: "sessionStart", source: "paperclip-bridge" } },
    ]);

    // Re-ingesting the same snapshot is idempotent (no re-spawn).
    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A), agentInput(AGENT_B)] }));
    expect(sink.events).toHaveLength(2);
  });

  it("marks state stale on disconnect and stops event flow while still updating the sidecar", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A)] }));
    const before = sink.events.length;

    t.disconnect("bridge down");
    expect(t.isStale()).toBe(true);
    expect(t.connectionState).toBe("disconnected");
    let snap = t.sidecarSnapshot();
    expect(snap.stale).toBe(true);
    expect(snap.staleReason).toBe("bridge down");

    // Events ingested while disconnected do NOT reach the sink...
    t.ingestEvent(runStarted("e1", 10, "r1", AGENT_A, null, PROJECT_X));
    expect(sink.events).toHaveLength(before);

    // ...but they still update the (stale) sidecar.
    snap = t.sidecarSnapshot();
    const agent = snap.agents.find((a) => a.agentId === AGENT_A);
    expect(agent!.concurrency.activeRunCount).toBe(1);
    expect(agent!.concurrency.runs.map((r) => r.runId)).toEqual(["r1"]);
    expect(sink.events).toHaveLength(before);
  });

  it("reconnects with a fresh snapshot: clears staleness and flows sessionStart again", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A), agentInput(AGENT_B)] }));
    t.disconnect("bridge down");

    // The company rescans and now has a third agent.
    t.reconnect(
      snapshot({
        agents: [agentInput(AGENT_A), agentInput(AGENT_B), agentInput(AGENT_C)],
      }),
    );

    expect(t.isStale()).toBe(false);
    expect(t.connectionState).toBe("connected");
    const snaps = t.sidecarSnapshot();
    expect(snaps.stale).toBe(false);

    // Sink received a fresh sessionStart for the new agent and none for existing.
    const cStarts = sink.events.filter(
      (e) => e.event.kind === "sessionStart" && e.sessionId === sessionId(AGENT_C),
    );
    expect(cStarts).toHaveLength(1);
    const aStarts = sink.events.filter(
      (e) => e.event.kind === "sessionStart" && e.sessionId === sessionId(AGENT_A),
    );
    expect(aStarts).toHaveLength(1);
  });

  it("reconnect() without a snapshot resumes flow but leaves the sidecar stale", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A)] }));
    t.disconnect("bridge down");
    const before = sink.events.length;

    t.reconnect();
    expect(t.connectionState).toBe("connected");
    expect(t.isStale()).toBe(true);

    // Connected again: a fresh agent's sessionStart flows to the sink.
    t.ingestEvent(runStarted("e1", 10, "r1", AGENT_NEW, null, PROJECT_X));
    const newStarts = sink.events
      .slice(before)
      .filter((e) => e.sessionId === sessionId(AGENT_NEW) && e.event.kind === "sessionStart");
    expect(newStarts).toHaveLength(1);
  });

  it("connect()/disconnect() toggle emission", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    t.disconnect("off");
    expect(t.connectionState).toBe("disconnected");
    expect(sink.events).toHaveLength(0);

    // While disconnected the mapper still learns the agent, so no re-spawn later.
    t.ingestEvent(runFinished("e1", 0, "r1", AGENT_NEW));
    expect(sink.events).toHaveLength(0);

    t.connect();
    expect(t.connectionState).toBe("connected");
    // A fresh character's first event flows again while connected.
    t.ingestEvent(runFinished("e2", 5, "r2", AGENT_B));
    expect(sink.events.map((e) => e.event.kind)).toEqual([
      "sessionStart",
      "turnEnd",
    ]);
    expect(sink.events[1].sessionId).toBe(sessionId(AGENT_B));
  });

  it("ingestRaw accepts valid envelopes and rejects invalid or unknown kinds", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });

    const rawRun = {
      eventId: "ev-1",
      timestamp: new Date().toISOString(),
      companyId: COMPANY_ID,
      kind: "agent.run.started",
      payload: { runId: "r1", agentId: AGENT_A, issueId: null, projectId: null },
    };
    expect(t.ingestRaw(rawRun)).toBe(true);

    expect(t.ingestRaw({ kind: "unknown.kind" } as Record<string, unknown>)).toBe(false);
    expect(t.ingestRaw({ kind: "cost_event.created" } as Record<string, unknown>)).toBe(false);
    const rawCost = {
      eventId: "ev-2",
      timestamp: new Date().toISOString(),
      companyId: COMPANY_ID,
      kind: "cost_event.created",
      payload: { costEventId: "ce-1", agentId: AGENT_A, costCents: 1 },
    };
    expect(t.ingestRaw(rawCost)).toBe(true);
  });

  it("reset() clears mapper + sidecar state (characters respawn on next snapshot)", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A)] }));
    expect(sink.events).toHaveLength(1);

    t.reset();
    expect(t.sidecarSnapshot().agents).toHaveLength(0);
    expect(t.isStale()).toBe(false);

    t.ingestSnapshot(snapshot({ agents: [agentInput(AGENT_A)] }));
    expect(sink.events).toHaveLength(2);
    const starts = sink.events.filter(
      (e) => e.event.kind === "sessionStart" && e.sessionId === sessionId(AGENT_A),
    );
    expect(starts).toHaveLength(2);
  });

  it("dispose() leaves the transport disconnected", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    t.dispose();
    expect(t.connectionState).toBe("disconnected");
  });

  it("exposes the shared mapper and sidecar channels", () => {
    const sink = new RecordingSink();
    const t = new BridgeTransport({ agentEventSink: sink });
    expect(t.behaviorSidecar).toBeDefined();
    expect(t.eventMapper).toBeDefined();
    expect(t.behaviorSidecar.snapshot().schemaVersion).toBe(1);
  });
});

describe("HttpPushSink (§31.4, §7.3, §21)", () => {
  const sessionEvent: SessionAgentEvent = {
    sessionId: syntheticSessionId(COMPANY_ID, AGENT_A),
    event: { kind: "turnEnd", awaitingInput: false },
  };

  function fetchLike(): jest.MockedFunction<FetchLike> {
    return jest.fn() as jest.MockedFunction<FetchLike>;
  }

  it("POSTs the real Claude hook body to the unmodified /api/hooks/claude endpoint with a bearer token", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    const sink = new HttpPushSink({
      baseUrl: "https://bridge.example/",
      authToken: "sec-1",
      fetch: fetchMock,
    });

    await sink.emit(sessionEvent);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example/api/hooks/claude");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({
      "content-type": "application/json",
      authorization: "Bearer sec-1",
    });
    // Real Claude hook wire shape (claude.ts normalizeHookEvent), not the
    // old { providerId, sessionId, event } custom envelope.
    expect(JSON.parse(init.body)).toEqual({
      hook_event_name: "Stop",
      session_id: sessionEvent.sessionId,
    });
    expect(sink.lastPushError).toBeUndefined();
  });

  it("serializes every mapped AgentEvent kind into its real Claude hook body", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    const sink = new HttpPushSink({ baseUrl: "https://bridge.example", fetch: fetchMock });
    const sid = syntheticSessionId(COMPANY_ID, AGENT_A);

    const cases: Array<[SessionAgentEvent, Record<string, unknown>]> = [
      [
        { sessionId: sid, event: { kind: "sessionStart", source: "paperclip-bridge" } },
        { hook_event_name: "SessionStart", session_id: sid, source: "paperclip-bridge", cwd: `/paperclip/${sid}` },
      ],
      [
        { sessionId: sid, event: { kind: "sessionEnd", reason: "offline" } },
        { hook_event_name: "SessionEnd", session_id: sid, reason: "offline" },
      ],
      [
        { sessionId: sid, event: { kind: "toolStart", toolId: "t1", toolName: "PaperclipWork" } },
        { hook_event_name: "PreToolUse", session_id: sid, tool_name: "PaperclipWork", tool_input: {} },
      ],
      [
        { sessionId: sid, event: { kind: "toolEnd", toolId: "t1" } },
        { hook_event_name: "PostToolUse", session_id: sid },
      ],
      [
        { sessionId: sid, event: { kind: "turnEnd", awaitingInput: true } },
        { hook_event_name: "Notification", session_id: sid, notification_type: "idle_prompt" },
      ],
      [
        { sessionId: sid, event: { kind: "permissionRequest" } },
        { hook_event_name: "PermissionRequest", session_id: sid },
      ],
    ];

    for (const [event, expected] of cases) {
      fetchMock.mockClear();
      await sink.emit(event);
      expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual(expected);
    }
  });

  it("never sends a transcript_path (stays on the hooks-only adoption path)", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    const sink = new HttpPushSink({ baseUrl: "https://bridge.example", fetch: fetchMock });
    await sink.emit({
      sessionId: syntheticSessionId(COMPANY_ID, AGENT_A),
      event: { kind: "sessionStart" },
    });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).not.toHaveProperty("transcript_path");
  });

  it("skips (does not POST) subagent/progress kinds with no Claude hook correspondence", async () => {
    const fetchMock = fetchLike();
    const sink = new HttpPushSink({ baseUrl: "https://bridge.example", fetch: fetchMock });
    await sink.emit({
      sessionId: syntheticSessionId(COMPANY_ID, AGENT_A),
      event: { kind: "subagentStart", parentToolId: "p", toolId: "t", toolName: "x" },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("omits the authorization header when no authToken is set", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    const sink = new HttpPushSink({
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });
    await sink.emit(sessionEvent);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.authorization).toBeUndefined();
    expect(init.headers["content-type"]).toBe("application/json");
  });

  it("defaults to the real 'claude' provider id, and honors a custom one in the URL only", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    const defaultSink = new HttpPushSink({ baseUrl: "https://bridge.example", fetch: fetchMock });
    await defaultSink.emit(sessionEvent);
    expect(fetchMock.mock.calls[0][0]).toBe("https://bridge.example/api/hooks/claude");

    fetchMock.mockClear();
    const customSink = new HttpPushSink({
      baseUrl: "https://bridge.example",
      providerId: "custom-provider",
      fetch: fetchMock,
    });
    await customSink.emit(sessionEvent);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://bridge.example/api/hooks/custom-provider");
    // The body is always the real Claude hook shape regardless of providerId
    // (only the URL path segment is configurable).
    expect(JSON.parse(init.body)).toEqual({ hook_event_name: "Stop", session_id: sessionEvent.sessionId });
  });

  it("records lastPushError on a non-ok response and clears it on the next success", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "Server Error" });
    const sink = new HttpPushSink({
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });

    await sink.emit(sessionEvent);
    expect(sink.lastPushError).toBe("push failed: 500 Server Error");

    fetchMock.mockResolvedValue({ ok: true, status: 200, statusText: "OK" });
    await sink.emit(sessionEvent);
    expect(sink.lastPushError).toBeUndefined();
  });

  it("records lastPushError when the fetch rejects", async () => {
    const fetchMock = fetchLike();
    fetchMock.mockRejectedValue(new Error("network down"));
    const sink = new HttpPushSink({
      baseUrl: "https://bridge.example",
      fetch: fetchMock,
    });

    await sink.emit(sessionEvent);
    expect(sink.lastPushError).toBe("push error: network down");
  });
});
