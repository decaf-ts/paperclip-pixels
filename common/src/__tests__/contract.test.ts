import { describe, expect, it } from "vitest";

import {
  buildAgentCharacterAssignment,
  buildAgentReplyToFeedbackRequest,
  buildCharacterCatalog,
  buildCompanySendMessageRequest,
  buildFeedBatch,
  buildPluginManifest,
  buildSnapshot,
} from "../fixtures.js";
import {
  PluginFeedBatchSchema,
  validatePluginFeedBatch,
  PluginFeedOperationSchema,
} from "../feed.js";
import { AgentCharacterAssignmentSchema, CharacterCatalogSchema, FeedAppearanceEntrySchema } from "../appearance.js";
import { AuthoritativeSnapshotInputSchema, BRIDGE_EVENT_KINDS } from "../events.js";
import {
  CompanySendMessageRequestSchema,
  AgentReplyToFeedbackRequestSchema,
  SetAgentAppearanceRequestSchema,
} from "../action.js";
import { checkWireSchemaVersion, SCHEMA_VERSION, PLUGIN_FEED_SCHEMA_VERSION } from "../version.js";
import { PluginAgentDeclarationSchema } from "../pluginHost.js";

describe("feed contract", () => {
  it("accepts a valid fixture batch", () => {
    const batch = buildFeedBatch();
    const parsed = PluginFeedBatchSchema.safeParse(batch);
    expect(parsed.success).toBe(true);
    expect(validatePluginFeedBatch(batch)).toEqual({ ok: true, batch });
  });

  it("rejects an invalid schemaVersion", () => {
    const batch = buildFeedBatch();
    const result = validatePluginFeedBatch({ ...batch, schemaVersion: 999 });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join(" ")).toContain("schemaVersion");
  });

  it("rejects an unknown operation op", () => {
    const bad = { ...buildFeedBatch(), operations: [{ op: "nope" }] };
    const result = validatePluginFeedBatch(bad);
    expect(result.ok).toBe(false);
  });

  it("validates a single operation through the discriminated union", () => {
    expect(PluginFeedOperationSchema.safeParse({ op: "updateAgentStatus", key: "a", status: "waiting" }).success).toBe(true);
    expect(PluginFeedOperationSchema.safeParse({ op: "updateAgentStatus", key: "a", status: "stopped" }).success).toBe(false);
  });

  it("validates an agent declaration", () => {
    expect(PluginAgentDeclarationSchema.safeParse({ key: "a", name: "Agent" }).success).toBe(true);
    expect(PluginAgentDeclarationSchema.safeParse({ key: "a", name: "Agent", hueShift: 999 }).success).toBe(false);
  });
});

describe("appearance contract", () => {
  it("validates the catalog and assignment", () => {
    const catalog = buildCharacterCatalog();
    expect(CharacterCatalogSchema.safeParse(catalog).success).toBe(true);
    const assignment = buildAgentCharacterAssignment();
    expect(AgentCharacterAssignmentSchema.safeParse(assignment).success).toBe(true);
  });

  it("rejects an out-of-range hueShift", () => {
    const assignment = buildAgentCharacterAssignment({ hueShift: 361 });
    expect(AgentCharacterAssignmentSchema.safeParse(assignment).success).toBe(false);
  });

  it("validates a feed appearance entry", () => {
    expect(
      FeedAppearanceEntrySchema.safeParse({ agentId: "a", agentName: "A", characterId: "c", palette: 0, hueShift: 0 }).success,
    ).toBe(true);
  });
});

describe("snapshot / event contract", () => {
  it("validates an authoritative snapshot fixture", () => {
    const snapshot = buildSnapshot();
    expect(AuthoritativeSnapshotInputSchema.safeParse(snapshot).success).toBe(true);
  });

  it("covers every bridge event kind", () => {
    expect(BRIDGE_EVENT_KINDS).toContain("agent.run.started");
    expect(BRIDGE_EVENT_KINDS).toContain("issue.comment.created");
    expect(BRIDGE_EVENT_KINDS.length).toBeGreaterThanOrEqual(18);
  });
});

describe("action contract", () => {
  it("accepts valid action requests", () => {
    expect(CompanySendMessageRequestSchema.safeParse(buildCompanySendMessageRequest()).success).toBe(true);
    expect(AgentReplyToFeedbackRequestSchema.safeParse(buildAgentReplyToFeedbackRequest()).success).toBe(true);
    expect(
      SetAgentAppearanceRequestSchema.safeParse({
        companyId: "c",
        agentId: "a",
        characterId: "char-0",
        palette: 0,
        hueShift: 0,
      }).success,
    ).toBe(true);
  });

  it("strict-rejects a forged feedback object (C1 guard)", () => {
    const req = buildAgentReplyToFeedbackRequest();
    const forged = {
      ...req,
      feedback: { existingWorkContext: true, issueId: "foreign-issue" },
    } as Record<string, unknown>;
    expect(AgentReplyToFeedbackRequestSchema.safeParse(forged).success).toBe(false);
  });
});

describe("versioning / compatibility rules", () => {
  it("accepts the current schema version", () => {
    expect(checkWireSchemaVersion(SCHEMA_VERSION)).toEqual([]);
    expect(checkWireSchemaVersion(PLUGIN_FEED_SCHEMA_VERSION, PLUGIN_FEED_SCHEMA_VERSION)).toEqual([]);
  });

  it("rejects an unsupported version with a diagnostic", () => {
    const errors = checkWireSchemaVersion(2);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors[0]).toContain("unsupported");
  });

  it("rejects a non-numeric version", () => {
    expect(checkWireSchemaVersion("1")[0]).toContain("must be a number");
  });
});

describe("plugin manifest fixture", () => {
  it("builds a valid manifest with capability declarations", () => {
    const manifest = buildPluginManifest();
    expect(manifest.contributes.actions).toBeDefined();
    expect(manifest.capabilities?.length).toBeGreaterThan(0);
    expect((manifest.capabilities ?? [])[0].implementation).toBe("override");
  });
});
