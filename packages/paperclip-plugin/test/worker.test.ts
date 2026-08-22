import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_SCHEMA_VERSION } from "@paperclip-pixel/core";
import { DATA_KEYS, JOB_KEYS, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import plugin from "../src/worker.js";
import { pluginDefinition } from "./typing.js";
import {
  AGENT_CEO_ID,
  AGENT_DEV_ID,
  COMPANY_2_ID,
  COMPANY_ID,
  ISSUE_ID,
  PROJECT_ID,
  makeCompany,
  makeIssue,
  makeProject,
  makeHarness,
  seedStandardWorld,
} from "./fixtures.js";

type IntervalHandle = ReturnType<typeof setInterval>;

const intervalHandles: IntervalHandle[] = [];

beforeEach(() => {
  intervalHandles.length = 0;
  const original = setInterval;
  vi.spyOn(globalThis, "setInterval").mockImplementation(((handler: () => void, timeout?: number, ...args: unknown[]) => {
    const handle = original(handler, timeout, ...args) as unknown as IntervalHandle;
    intervalHandles.push(handle);
    return handle;
  }) as unknown as typeof setInterval);
});

afterEach(() => {
  for (const handle of intervalHandles) clearInterval(handle as unknown as ReturnType<typeof setInterval>);
  intervalHandles.length = 0;
  vi.restoreAllMocks();
});

async function setupWorker(harness: ReturnType<typeof makeHarness>): Promise<void> {
  await pluginDefinition(plugin).setup(harness.ctx);
}

function bridgeSnapshot(harness: ReturnType<typeof makeHarness>, companyId = COMPANY_ID): Promise<any> {
  return harness.getData(DATA_KEYS.bridgeSnapshot, { companyId }) as Promise<any>;
}

describe("worker setup (definePlugin + runWorker)", () => {
  it("exposes definePlugin-style setup, onHealth, and a default entrypoint guard", async () => {
    expect(typeof pluginDefinition(plugin).setup).toBe("function");
    expect(await pluginDefinition(plugin).onHealth()).toMatchObject({ status: "ok", message: "Bridge worker running" });
  });

  it("is safe to import in tests (runWorker is a no-op when not the entrypoint)", () => {
    expect(plugin).toBeDefined();
  });
});

describe("worker setup with a seeded world", () => {
  it("bootstraps the authoritative snapshot on boot (criterion 1)", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.schemaVersion).toBe(BRIDGE_SCHEMA_VERSION);
    expect(snapshot.company?.id).toBe(COMPANY_ID);
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "todo", blocked: false })]);
    expect(snapshot.agents).toEqual(
      expect.arrayContaining([expect.objectContaining({ agentId: AGENT_DEV_ID })]),
    );
  });

  it("records the schema version at instance scope", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);
    expect(
      harness.getState({
        scopeKind: "instance",
        namespace: STATE_NAMESPACES.bridge,
        stateKey: STATE_KEYS.schemaVersion,
      }),
    ).toBe(1);
  });
});

describe("worker event pipeline (criterion 2)", () => {
  it("applies a PluginEvent to the bridge store", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("issue.updated", { issueId: ISSUE_ID, projectId: PROJECT_ID, status: "in_progress" }, {
      companyId: COMPANY_ID,
      eventId: "evt-issue-updated",
      occurredAt: "2026-08-22T00:00:00.000Z",
    });

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "in_progress" })]);
  });

  it("bootstraps an unknown company lazily when an event arrives for it", async () => {
    const harness = makeHarness();
    harness.seed({ companies: [makeCompany()], issues: [makeIssue()] });
    await setupWorker(harness);

    harness.seed({
      companies: [makeCompany({ id: COMPANY_2_ID, name: "Late Co" })],
      projects: [makeProject({ id: "project-2", companyId: COMPANY_2_ID })],
      issues: [makeIssue({ id: "issue-2", companyId: COMPANY_2_ID, projectId: "project-2" })],
    });

    await harness.emit("issue.updated", { issueId: "issue-2", projectId: "project-2", status: "in_progress" }, {
      companyId: COMPANY_2_ID,
      eventId: "evt-late-company",
    });

    const snapshot = await bridgeSnapshot(harness, COMPANY_2_ID);
    expect(snapshot.error).toBeUndefined();
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: "issue-2", status: "in_progress" })]);
  });

  it("drops events for companies that cannot be bootstrapped with a warning", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("issue.updated", { issueId: "issue-ghost", projectId: "project-ghost", status: "in_progress" }, {
      companyId: "company-ghost",
      eventId: "evt-ghost",
    });

    expect(
      harness.logs.some(
        (l) => l.level === "warn" && l.message === "Cannot bootstrap company for event" && l.meta?.companyId === "company-ghost",
      ),
    ).toBe(true);
    const snapshot = await bridgeSnapshot(harness, "company-ghost");
    expect(snapshot.company).toBeUndefined();
    expect(snapshot.agents).toEqual([]);
    expect(snapshot.issues).toEqual([]);
    expect(snapshot.projects).toEqual([]);
  });

  it("ignores unsubscribed event types", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("company.updated", { name: "Renamed" }, { companyId: COMPANY_ID });

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.company?.name).toBe("Acme Corp");
  });
});

describe("worker reconciliation job (criterion 3)", () => {
  it("repairs derived drift against the authoritative snapshot", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    await harness.emit("issue.updated", { issueId: ISSUE_ID, projectId: PROJECT_ID, status: "in_progress" }, {
      companyId: COMPANY_ID,
      eventId: "evt-drift",
    });
    expect((await bridgeSnapshot(harness)).issues[0].status).toBe("in_progress");

    await harness.runJob(JOB_KEYS.reconciliation);

    const snapshot = await bridgeSnapshot(harness);
    expect(snapshot.issues).toEqual([expect.objectContaining({ id: ISSUE_ID, status: "todo" })]);
    expect(
      harness.getState({
        scopeKind: "company",
        scopeId: COMPANY_ID,
        namespace: STATE_NAMESPACES.bridge,
        stateKey: STATE_KEYS.lastReconciledAt,
      }),
    ).toEqual(expect.any(String));
  });
});

describe("worker data accessors", () => {
  it("returns company-not-found for unknown companies on every data key", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    for (const params of [
      { companyId: "company-nope" },
      { companyId: "company-nope", agentId: AGENT_DEV_ID },
    ]) {
      const snapshot = (await harness.getData(DATA_KEYS.bridgeSnapshot, params)) as any;
      expect(snapshot.error).toBe("company-not-found");
      expect(snapshot.schemaVersion).toBe(BRIDGE_SCHEMA_VERSION);
    }
    expect(((await harness.getData(DATA_KEYS.companySummary, { companyId: "company-nope" })) as any).error).toBe("company-not-found");
    expect(((await harness.getData(DATA_KEYS.agentBehavior, { companyId: "company-nope", agentId: AGENT_DEV_ID })) as any).error).toBe("company-not-found");
    expect(((await harness.getData(DATA_KEYS.outstandingFeedback, { companyId: "company-nope" })) as any).error).toBe("company-not-found");
  });

  it("serves company summary, behavior vector, and feedback via data handlers", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const summary = (await harness.getData(DATA_KEYS.companySummary, { companyId: COMPANY_ID })) as any;
    expect(summary.companyId).toBe(COMPANY_ID);

    const behavior = (await harness.getData(DATA_KEYS.agentBehavior, { companyId: COMPANY_ID, agentId: AGENT_DEV_ID })) as any;
    expect(behavior.agentId).toBe(AGENT_DEV_ID);
    expect(typeof behavior.load?.value).toBe("number");
    expect(typeof behavior.calculatedAt).toBe("string");

    const feedback = (await harness.getData(DATA_KEYS.outstandingFeedback, { companyId: COMPANY_ID })) as any;
    expect(Array.isArray(feedback)).toBe(true);
  });
});

describe("worker actions wiring", () => {
  it("serves company.send-message through the harness action bridge", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);

    const result = await harness.performAction("company.send-message", {
      companyId: COMPANY_ID,
      text: "Start the next milestone",
    });

    expect(result).toMatchObject({ ok: true });
    expect(typeof (result as { sessionId?: string }).sessionId).toBe("string");
    const openSessions = await harness.ctx.agents.sessions.list(AGENT_CEO_ID, COMPANY_ID);
    expect(openSessions).toHaveLength(1);
  });

  it("routes an out-of-context reply to company intake with no side effects", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);
    const createIssue = vi.spyOn(harness.ctx.issues, "create");

    const eventId = "evt-reply-comment";
    await harness.emit(
      "issue.comment.created",
      { commentId: "comment-1", issueId: "issue-foreign", agentId: AGENT_DEV_ID, body: "hello", isQuestion: false },
      { companyId: COMPANY_ID, eventId, occurredAt: "2026-08-22T00:00:00.000Z" },
    );

    const result = await harness.performAction("agent.reply-to-feedback", {
      companyId: COMPANY_ID,
      feedbackId: `${eventId}:progress`,
      text: "continue as-is",
    });

    expect(result).toMatchObject({ ok: false, error: "ROUTE_TO_COMPANY" });
    expect(createIssue).not.toHaveBeenCalled();
    createIssue.mockRestore();
  });
});

describe("worker trust boundary (criterion 8)", () => {
  it("never obtains outbound HTTP from the harness", async () => {
    const { harness } = seedStandardWorld();
    await setupWorker(harness);
    await expect(
      harness.ctx.http.fetch("https://example.com"),
    ).rejects.toThrow(/missing required capability 'http\.outbound'/);
  });
});
