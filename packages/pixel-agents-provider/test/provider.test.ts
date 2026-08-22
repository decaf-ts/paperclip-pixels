import {
  PAPERCLIP_BRIDGE_CONSENT,
  PAPERCLIP_BRIDGE_PROVIDER_ID,
  PaperclipBridgeProvider,
  syntheticSessionId,
} from "../src";
import {
  AGENT_A,
  COMPANY_ID,
  ISSUE_1,
  PROJECT_X,
  runFinished,
  runStarted,
} from "./fixtures";

const provider = (): PaperclipBridgeProvider => new PaperclipBridgeProvider();

function rawRunFinished(): Record<string, unknown> {
  return {
    eventId: "ev-1",
    timestamp: new Date(0).toISOString(),
    companyId: COMPANY_ID,
    kind: "agent.run.finished",
    actor: { id: "system", type: "system" },
    entity: { id: "ev-1", type: "event" },
    payload: {
      runId: "r1",
      agentId: AGENT_A,
      issueId: ISSUE_1,
      projectId: PROJECT_X,
      status: "succeeded",
    },
  };
}

describe("PaperclipBridgeProvider contract (§31.4, §27.3, §39.1)", () => {
  it("exposes the bridge identity and protocol constants", () => {
    const p = provider();
    expect(p.id).toBe(PAPERCLIP_BRIDGE_PROVIDER_ID);
    expect(p.id).toBe("paperclip-bridge");
    expect(p.kind).toBe("hook");
    expect(p.protocolVersion).toBe(1);
    expect(p.displayName).toBe("Paperclip Bridge");
    expect(p.team).toBeUndefined();
  });

  it("keeps all tool-name sets empty (the bridge emits no tool events)", () => {
    const p = provider();
    expect(p.permissionExemptTools.size).toBe(0);
    expect(p.subagentToolNames.size).toBe(0);
    expect(p.readingTools.size).toBe(0);
    expect(p.terminalNamePrefix).toBeUndefined();
  });

  it("normalizeHookEvent returns the primary mapped AgentEvent bound to the synthetic session", () => {
    const p = provider();
    const normalized = p.normalizeHookEvent(rawRunFinished());
    expect(normalized).not.toBeNull();
    expect(normalized!.sessionId).toBe(
      syntheticSessionId(COMPANY_ID, AGENT_A),
    );
    expect(normalized!.event).toEqual({ kind: "turnEnd", awaitingInput: false });
  });

  it("normalizeHookEvent returns the leading sessionStart on first sight (no primary beyond spawn)", () => {
    const p = provider();
    const raw = {
      eventId: "ev-2",
      timestamp: new Date(0).toISOString(),
      companyId: COMPANY_ID,
      kind: "agent.run.started",
      actor: { id: "system", type: "system" },
      entity: { id: "ev-2", type: "event" },
      payload: { runId: "r1", agentId: AGENT_A, issueId: null, projectId: null },
    };
    const normalized = p.normalizeHookEvent(raw);
    expect(normalized!.event.kind).toBe("sessionStart");
    expect(normalized!.event.source).toBe("paperclip-bridge");
  });

  it("normalizeHookEvent returns null for non-mappable events (sidecar-owned)", () => {
    // cost_event.created has no AgentEvent home.
    const p = provider().normalizeHookEvent({
      eventId: "ev-3",
      timestamp: new Date(0).toISOString(),
      companyId: COMPANY_ID,
      kind: "cost_event.created",
      actor: { id: "system", type: "system" },
      entity: { id: "ev-3", type: "event" },
      payload: { costEventId: "ce-1", agentId: AGENT_A, costCents: 1 },
    });
    expect(p).toBeNull();

    // An actively-working run after first sight also normalizes to null.
    const provider2 = provider();
    provider2.normalizeHookEvent({
      eventId: "ev-4",
      timestamp: new Date(0).toISOString(),
      companyId: COMPANY_ID,
      kind: "agent.run.started",
      actor: { id: "system", type: "system" },
      entity: { id: "ev-4", type: "event" },
      payload: { runId: "r1", agentId: AGENT_A, issueId: null, projectId: null },
    });
    expect(
      provider2.normalizeHookEvent({
        eventId: "ev-5",
        timestamp: new Date(0).toISOString(),
        companyId: COMPANY_ID,
        kind: "agent.run.started",
        actor: { id: "system", type: "system" },
        entity: { id: "ev-5", type: "event" },
        payload: { runId: "r2", agentId: AGENT_A, issueId: null, projectId: null },
      }),
    ).toBeNull();
  });

  it("normalizeHookEvent returns null for structurally invalid input", () => {
    const p = provider();
    expect(p.normalizeHookEvent({})).toBeNull();
    expect(
      p.normalizeHookEvent({ kind: "agent.run.finished" } as Record<string, unknown>),
    ).toBeNull();
    expect(
      p.normalizeHookEvent({
        eventId: "ev-1",
        timestamp: new Date(0).toISOString(),
        companyId: COMPANY_ID,
        kind: "not.a.real.kind",
        payload: {},
      } as Record<string, unknown>),
    ).toBeNull();
  });

  it("mapBridgeEvent returns the full mapping result", () => {
    const p = provider();
    const res = p.mapBridgeEvent(runFinished("e1", 0, "r1", AGENT_A));
    expect(res.agentEvents).toHaveLength(2); // sessionStart + turnEnd
    expect(res.agentEvents[0].event.kind).toBe("sessionStart");
    expect(res.agentEvents[1].event).toEqual({
      kind: "turnEnd",
      awaitingInput: false,
    });
    expect(res.sidecar?.kind).toBe("run-activity");
  });

  it("mapRawBridgeEvent maps a valid envelope or returns null for bad input", () => {
    const p = provider();

    const mapped = p.mapRawBridgeEvent(rawRunFinished());
    expect(mapped).not.toBeNull();
    expect(mapped!.agentEvents[mapped!.agentEvents.length - 1].event).toEqual({
      kind: "turnEnd",
      awaitingInput: false,
    });
    expect(mapped!.sidecar).not.toBeNull();

    expect(p.mapRawBridgeEvent({})).toBeNull();
    expect(
      p.mapRawBridgeEvent({
        eventId: "x",
        timestamp: "y",
        companyId: "z",
        kind: "unknown.kind",
        payload: {},
      } as Record<string, unknown>),
    ).toBeNull();
  });

  it("is push-based: install/uninstall resolve no-op and areHooksInstalled is false", async () => {
    const p = provider();
    await p.installHooks();
    await p.installHooks();
    await p.uninstallHooks();
    await p.uninstallHooks();
    await expect(p.areHooksInstalled()).resolves.toBe(false);
  });

  it("consentDisclosure returns the headline + disclosure copy", () => {
    const disclosure = provider().consentDisclosure();
    expect(disclosure.headline).toBe(PAPERCLIP_BRIDGE_CONSENT.headline);
    expect(disclosure.headline.length).toBeGreaterThan(0);
    expect(disclosure.disclosure).toBe(PAPERCLIP_BRIDGE_CONSENT.disclosure);
    expect(disclosure.disclosure.length).toBeGreaterThan(0);
  });

  it("formatToolStatus is a benign passthrough (no tool events to format)", () => {
    const p = provider();
    expect(p.formatToolStatus("read_file")).toBe("read_file");
    expect(p.formatToolStatus("bash", { command: "ls" })).toBe("bash");
  });

  it("exposes its underlying mapper for transport sharing", () => {
    const p = provider();
    expect(p.eventMapper).toBeDefined();
  });

  it("maps a typed run.started only into the sidecar (never a fake tool event)", () => {
    const p = provider();
    const res = p.mapBridgeEvent(runStarted("e1", 0, "r1", AGENT_A));
    expect(res.agentEvents).toHaveLength(1); // leading sessionStart only
    expect(res.agentEvents[0].event.kind).toBe("sessionStart");
    expect(res.sidecar?.kind).toBe("run-activity");
    expect(
      res.agentEvents.some((e) => e.event.kind.startsWith("tool")),
    ).toBe(false);
  });
});
