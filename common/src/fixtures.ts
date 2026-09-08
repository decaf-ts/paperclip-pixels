/**
 * Fixture builders shared by both sides (spec migration plan step 2).
 *
 * These build valid contract objects deterministically so the Paperclip
 * plugin's tests, the Pixel Agents fork guard tests, and the contract tests
 * in this package all exercise the *same* wire shapes. The fork-boundary
 * ticket makes this module the sanctioned import target for the fork guard
 * tests that today illegally import `../../../../src/pixel-agents-plugin/*`.
 */

import { PLUGIN_FEED_SCHEMA_VERSION } from "./version.js";
import { FEED_OP } from "./constants.js";
import type {
  PluginAgentDeclaration,
  PluginCapabilityDeclaration,
  PixelAgentsPluginManifest,
} from "./pluginHost.js";
import type {
  PluginFeedBatch,
  PluginFeedOperation,
  PluginFeedStatusOperation,
  PluginFeedActivityOperation,
  PluginFeedAppearanceAssignmentOperation,
  PluginFeedDialogLinesOperation,
} from "./feed.js";
import type { CharacterCatalog, AgentCharacterAssignment, AgentCharacterAssignmentMap } from "./appearance.js";
import type {
  AgentAppearanceAssignmentV2,
  AppearanceAssignment,
  CharacterComposition,
  CompositionPartCatalog,
  CompositionPartSpec,
} from "./composition.js";
import type { AuthoritativeSnapshotInput, BridgeInputEvent, BridgeEventKind } from "./events.js";
import type { CompanySendMessageRequest, AgentReplyToFeedbackRequest } from "./action.js";
import type { OfficeLayout, OfficeFloor, OfficeSeat, OfficeWall, OfficeFurniture } from "./layout.js";

let counter = 0;

/** Deterministic monotonic id counter (no crypto — fixtures only). */
export function nextFixtureId(): number {
  counter += 1;
  return counter;
}

export function buildAgentDeclaration(
  overrides: Partial<PluginAgentDeclaration> = {},
): PluginAgentDeclaration {
  const n = nextFixtureId();
  return {
    key: `agent-${n}`,
    name: `Agent ${n}`,
    ...overrides,
  };
}

export function buildDeclareAgentsOp(
  agents: PluginAgentDeclaration[] = [buildAgentDeclaration()],
): PluginFeedOperation {
  return { op: FEED_OP.declareAgents, agents };
}

export function buildRemoveAgentsOp(keys: string[] = ["agent-1"]): PluginFeedOperation {
  return { op: FEED_OP.removeAgents, keys };
}

export function buildStatusOp(
  overrides: Partial<PluginFeedStatusOperation> = {},
): PluginFeedOperation {
  return {
    op: FEED_OP.updateAgentStatus,
    key: "agent-1",
    status: "active",
    ...overrides,
  };
}

export function buildActivityOp(
  overrides: Partial<PluginFeedActivityOperation> = {},
): PluginFeedOperation {
  return {
    op: FEED_OP.updateAgentActivity,
    key: "agent-1",
    activity: "Task: Paperclip work",
    ...overrides,
  };
}

export function buildAppearanceAssignOp(
  overrides: Partial<PluginFeedAppearanceAssignmentOperation> = {},
): PluginFeedOperation {
  return {
    op: FEED_OP.assignAgentAppearance,
    key: "agent-1",
    characterId: "pixel-agents:char-0",
    ...overrides,
  };
}

export function buildDialogLinesOp(
  overrides: Partial<PluginFeedDialogLinesOperation> = {},
): PluginFeedOperation {
  return {
    op: FEED_OP.dialogLines,
    lines: [{ text: "Agent 1 started a run: Task: Paperclip work" }],
    ...overrides,
  };
}

export function buildFeedBatch(
  operations: PluginFeedOperation[] = [buildDeclareAgentsOp()],
  companyId = "company-1",
): PluginFeedBatch {
  return {
    schemaVersion: PLUGIN_FEED_SCHEMA_VERSION,
    companyId,
    operations,
  };
}

export function buildCharacterCatalog(
  count = 6,
  _overrides: Partial<CharacterCatalog["characters"][number]> = {},
): CharacterCatalog {
  return {
    schemaVersion: 1,
    characters: Array.from({ length: count }, (_, i) => ({
      id: `pixel-agents:char-${i}`,
      name: `Sheet ${i}`,
      palette: i,
      file: `char_${i}.png`,
      source: "bundled",
      license: "CC0-1.0",
    })),
  };
}

export function buildAgentCharacterAssignment(
  overrides: Partial<AgentCharacterAssignment> = {},
): AgentCharacterAssignment {
  return {
    characterId: "pixel-agents:char-0",
    palette: 0,
    hueShift: 0,
    updatedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

/** Build one compose-able part spec (WS5a composition fixture). */
export function buildCompositionPartSpec(
  overrides: Partial<CompositionPartSpec> = {},
): CompositionPartSpec {
  const n = nextFixtureId();
  return {
    id: `part-${n}`,
    kind: "clothing",
    name: `Part ${n}`,
    layer: 1,
    file: `part_${n}.png`,
    palette: 0,
    source: "bundled",
    license: "CC0-1.0",
    privilege: "granted:assets/characters",
    ...overrides,
  };
}

/** Build a valid composition part catalog (schemaVersion 2). */
export function buildCompositionPartCatalog(
  count = 4,
): CompositionPartCatalog {
  const kinds: Array<CompositionPartSpec["kind"]> = ["skin", "clothing", "hair", "face"];
  return {
    schemaVersion: 2,
    parts: Array.from({ length: count }, (_, i) =>
      buildCompositionPartSpec({
        id: `part-${i}`,
        kind: kinds[i % kinds.length],
        name: `Part ${i}`,
        layer: i,
        file: `part_${i}.png`,
        palette: i,
      }),
    ),
  };
}

/** Build a valid composited appearance (schemaVersion 2). */
export function buildCharacterComposition(
  overrides: Partial<CharacterComposition> = {},
): CharacterComposition {
  return {
    schemaVersion: 2,
    parts: [{ partId: "part-0", hueShift: 0 }],
    palette: 0,
    hueShift: 0,
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

/** Build a composition-mode appearance assignment (v2). */
export function buildCompositionAppearanceAssignment(
  overrides: Partial<AppearanceAssignment & { composition?: CharacterComposition }> = {},
): AppearanceAssignment {
  return {
    mode: "composition",
    composition: overrides.composition ?? buildCharacterComposition(),
  };
}

/** Build a whole-sheet-mode appearance assignment (v2 legacy branch). */
export function buildWholeSheetAppearanceAssignment(
  overrides: Partial<Extract<AppearanceAssignment, { mode: "wholeSheet" }>> = {},
): AppearanceAssignment {
  return {
    mode: "wholeSheet",
    characterId: "pixel-agents:char-0",
    palette: 0,
    hueShift: 0,
    ...overrides,
  };
}

/** Build a v2 per-agent appearance record. */
export function buildAgentAppearanceAssignmentV2(
  overrides: Partial<AgentAppearanceAssignmentV2> = {},
): AgentAppearanceAssignmentV2 {
  return {
    agentId: "agent-1",
    appearance: buildCompositionAppearanceAssignment(),
    updatedAt: "2026-09-07T00:00:00.000Z",
    ...overrides,
  };
}

export function buildAssignmentMap(
  entries: Record<string, AgentCharacterAssignment> = { "agent-1": buildAgentCharacterAssignment() },
): AgentCharacterAssignmentMap {
  return { ...entries };
}

export function buildSnapshot(
  overrides: Partial<AuthoritativeSnapshotInput> = {},
): AuthoritativeSnapshotInput {
  const companyId = "company-1";
  return {
    company: { id: companyId, name: "Paperclip Pixels", status: "active" },
    agents: [
      { id: "agent-1", companyId, name: "Agent 1", status: "idle" },
      { id: "agent-2", companyId, name: "Agent 2", status: "running", activeRuns: [{ id: "run-1", agentId: "agent-2", status: "running", startedAt: "2026-09-06T00:00:00.000Z" }] },
    ],
    projects: [{ id: "project-1", companyId, name: "Project 1" }],
    issues: [{ id: "issue-1", companyId, title: "Do work", status: "in_progress", assigneeAgentId: "agent-2" }],
    approvals: [],
    observedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

export function buildBridgeEvent(
  kind: BridgeEventKind,
  overrides: Partial<BridgeInputEvent> & { payload?: Record<string, unknown> } = {},
): BridgeInputEvent {
  const base = {
    eventId: `event-${nextFixtureId()}`,
    timestamp: "2026-09-06T00:00:00.000Z",
    companyId: "company-1",
  };
  const payload =
    kind === "agent.run.started"
      ? { runId: "run-1", agentId: "agent-1", status: "running" }
      : kind === "issue.comment.created"
        ? { commentId: "c-1", issueId: "issue-1", body: "hello" }
        : { agentId: "agent-1" };
  return { ...base, kind, payload: { ...(payload as Record<string, unknown>), ...(overrides.payload ?? {}) } } as BridgeInputEvent;
}

export function buildCompanySendMessageRequest(
  overrides: Partial<CompanySendMessageRequest> = {},
): CompanySendMessageRequest {
  return { companyId: "company-1", text: "Build the feature", ...overrides };
}

export function buildAgentReplyToFeedbackRequest(
  overrides: Partial<AgentReplyToFeedbackRequest> = {},
): AgentReplyToFeedbackRequest {
  return { companyId: "company-1", feedbackId: "fb-1", text: "On it", ...overrides };
}

export function buildPluginManifest(
  overrides: Partial<PixelAgentsPluginManifest> = {},
): PixelAgentsPluginManifest {
  return {
    id: "paperclip-pixel.paperclip-plugin",
    version: "0.1.0",
    contributes: {
      messages: [],
      actions: [{ id: "company.send-message" }],
      menuItems: [],
      widgets: [],
    },
    sources: { agents: true, appearance: true },
    capabilities: buildCapabilityDeclarations(),
    ...overrides,
  };
}

export function buildCapabilityDeclarations(): PluginCapabilityDeclaration[] {
  return [
    { id: "agents-source", implementation: "override", overrides: "pixel-agents-base", fallback: "base", priority: 10 },
    { id: "appearance-source", implementation: "override", overrides: "pixel-agents-base", fallback: "base", priority: 10 },
    { id: "action-routing", implementation: "override", overrides: "pixel-agents-base", fallback: "base", priority: 10 },
  ];
}

// --- Office-layout fixtures (R3-WS4a) --------------------------------------

export function buildOfficeWall(overrides: Partial<OfficeWall> = {}): OfficeWall {
  return {
    id: `wall-${nextFixtureId()}`,
    from: { x: 0, y: 0 },
    to: { x: 1, y: 0 },
    kind: "solid",
    ...overrides,
  };
}

export function buildOfficeFurniture(overrides: Partial<OfficeFurniture> = {}): OfficeFurniture {
  return {
    id: `furniture-${nextFixtureId()}`,
    kind: "desk",
    position: { x: 0.5, y: 0.5 },
    size: { width: 0.2, height: 0.1 },
    rotation: 0,
    ...overrides,
  };
}

export function buildOfficeSeat(overrides: Partial<OfficeSeat> = {}): OfficeSeat {
  return {
    id: `seat-${nextFixtureId()}`,
    agentId: null,
    position: { x: 0.5, y: 0.5 },
    ...overrides,
  };
}

export function buildOfficeFloor(overrides: Partial<OfficeFloor> = {}): OfficeFloor {
  return {
    id: `floor-${nextFixtureId()}`,
    name: "Main floor",
    walls: [buildOfficeWall()],
    furniture: [buildOfficeFurniture()],
    seats: [buildOfficeSeat()],
    ...overrides,
  };
}

export function buildOfficeLayout(
  overrides: Partial<OfficeLayout> = {},
): OfficeLayout {
  return {
    schemaVersion: 1,
    name: "Pixel Office",
    floors: [buildOfficeFloor()],
    ...overrides,
  };
}
