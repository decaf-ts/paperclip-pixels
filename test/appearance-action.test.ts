/**
 * Unit tests for the WS3 appearance action handler (`handleSetAgentAppearance`
 * in `src/actions.ts`, spec PAPERCLIP_PIXELS-2 FR-13).
 *
 * The handler validates server-side against the worker's package catalog —
 * via `validateAssignmentInput` (the core errors) — resolves the agent, then
 * persists + applies through the worker-provided
 * `applyAgentCharacterAssignment` applier. The catalog loader is mocked (the
 * real catalog semantics live in test/core/characters.test.ts and the real
 * loader in test/characters-loader.test.ts); the mocked loader still serves
 * the real committed catalog so the id/palette pairs stay grounded.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { parseCharacterCatalog, type CharacterCatalog } from "../src/core/index.js";
import { ACTION_KEYS, STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import { handleSetAgentAppearance, type ActionDeps } from "../src/actions.js";
import { AGENT_CEO_ID, AGENT_DEV_ID, COMPANY_ID, seedStandardWorld } from "./fixtures.js";

vi.mock("../src/characters.js", () => ({ loadCharacterCatalog: vi.fn() }));

type Applier = NonNullable<ActionDeps["applyAgentCharacterAssignment"]>;

const REAL_CATALOG: CharacterCatalog = parseCharacterCatalog(
  JSON.parse(readFileSync(new URL("../assets/characters/catalog.json", import.meta.url), "utf8")),
);

interface HandlerResult {
  ok: boolean;
  error?: string;
  assignment?: { characterId: string; palette: number; hueShift: number; updatedAt: string };
  applied?: boolean;
}

function userContext(): PluginPerformActionContext {
  return { actor: { type: "user", userId: null } } as unknown as PluginPerformActionContext;
}

function scopedContext(companyId: string): PluginPerformActionContext {
  return { actor: { type: "user", userId: null, companyId }, companyId } as unknown as PluginPerformActionContext;
}

const BASE_PARAMS = {
  companyId: COMPANY_ID,
  agentId: AGENT_DEV_ID,
  characterId: "pixel-agents:char-0",
  palette: 0,
};

function makeSetDepsWithHarness(): { deps: ActionDeps; harness: ReturnType<typeof seedStandardWorld>["harness"] } {
  const { harness } = seedStandardWorld();
  const deps: ActionDeps = {
    ctx: harness.ctx,
    getFeedback: () => undefined,
    getLeadershipAgentId: () => undefined,
    applyAgentCharacterAssignment: vi.fn(),
  };
  return { deps, harness };
}

function makeSetDeps(appliedResult?: unknown): { deps: ActionDeps; applier: ReturnType<typeof vi.fn> } {
  // The harness must be seeded so ctx.agents.get resolves the fixture agents.
  const { harness }: StandardWorld = seedStandardWorld();
  const applier = vi.fn(async (_companyId: string, input: { assignment: AgentCharacterAssignmentShape }) => ({
    ok: true,
    assignment: structuredClone(input.assignment),
    applied: true,
  }));
  if (appliedResult !== undefined) applier.mockResolvedValue(structuredClone(appliedResult));
  const deps: ActionDeps = {
    ctx: harness.ctx,
    getFeedback: () => undefined,
    getLeadershipAgentId: () => undefined,
    applyAgentCharacterAssignment: applier as unknown as Applier,
  };
  return { deps, applier };
}

describe("handleSetAgentAppearance", () => {
  beforeEach(async () => {
    (await import("../src/characters.js")).loadCharacterCatalog.mockImplementation(() => ({
      catalog: REAL_CATALOG,
      entries: [],
    }));
  });

  it.each([
    [{}, "missing companyId"],
    [{ ...BASE_PARAMS, companyId: "" }, "empty companyId"],
    [{ ...BASE_PARAMS, agentId: "" }, "empty agentId"],
    [{ ...BASE_PARAMS, characterId: "" }, "empty characterId"],
    [{ ...BASE_PARAMS, palette: 0.5 }, "fractional palette"],
    [{ ...BASE_PARAMS, palette: -1 }, "negative palette"],
    [{ ...BASE_PARAMS, hueShift: 361 }, "hueShift above range"],
    [{ ...BASE_PARAMS, hueShift: -1 }, "negative hueShift"],
    [{ ...BASE_PARAMS, hueShift: 0.5 }, "fractional hueShift"],
    [{ ...BASE_PARAMS, unexpected: "key" }, "unexpected extra key"],
  ])("rejects malformed params with INVALID_PARAMS (%s)", async (params, _label) => {
    const { deps, applier } = makeSetDeps();
    const result = (await handleSetAgentAppearance(deps, params, userContext())) as HandlerResult;
    expect(result.ok).toBe(false);
    expect(result.error).toBe("INVALID_PARAMS");
    expect(applier).not.toHaveBeenCalled();
  });

  it("accepts a missing hueShift (schema default 0) and applies it", async () => {
    const { deps, applier } = makeSetDeps();
    const result = (await handleSetAgentAppearance(deps, { ...BASE_PARAMS }, userContext())) as HandlerResult;
    expect(result.ok).toBe(true);
    expect(result.assignment?.hueShift).toBe(0);
    expect(applier).toHaveBeenCalledTimes(1);
  });

  it("fails closed with COMPANY_SCOPE_MISMATCH when the host-authorized company differs", async () => {
    const { deps, applier } = makeSetDeps();
    const result = (await handleSetAgentAppearance(deps, BASE_PARAMS, scopedContext("other-company"))) as HandlerResult;
    expect(result).toEqual({ ok: false, error: "COMPANY_SCOPE_MISMATCH" });
    expect(applier).not.toHaveBeenCalled();
  });

  it("returns CATALOG_UNAVAILABLE when the package catalog cannot load (fail closed)", async () => {
    const { deps } = makeSetDeps();
    (await import("../src/characters.js")).loadCharacterCatalog.mockImplementation(() => {
      throw new Error("catalog.json missing");
    });
    const result = (await handleSetAgentAppearance(deps, BASE_PARAMS, userContext())) as HandlerResult;
    expect(result).toEqual({ ok: false, error: "CATALOG_UNAVAILABLE" });
  });

  it("validates against the catalog before resolving the agent (error precedence + no applier call)", async () => {
    const { deps, applier } = makeSetDeps();
    // Unknown character + valid agent: catalog error first.
    const unknown = (await handleSetAgentAppearance(
      deps,
      { ...BASE_PARAMS, characterId: "ghost-character" },
      userContext(),
    )) as HandlerResult;
    expect(unknown).toEqual({ ok: false, error: "UNKNOWN_CHARACTER" });
    // Known id + mismatched palette.
    const mismatch = (await handleSetAgentAppearance(
      deps,
      { ...BASE_PARAMS, characterId: "pixel-agents:char-0", palette: 3 },
      userContext(),
    )) as HandlerResult;
    expect(mismatch).toEqual({ ok: false, error: "PALETTE_MISMATCH" });
    // Unknown agent + fully valid assignment: agent error surfaces last.
    const unknownAgent = (await handleSetAgentAppearance(
      deps,
      { ...BASE_PARAMS, agentId: "agent-ghost" },
      userContext(),
    )) as HandlerResult;
    expect(unknownAgent).toEqual({ ok: false, error: "AGENT_NOT_FOUND" });
    expect(applier).not.toHaveBeenCalled();
  });

  it("returns ASSIGNMENT_APPLIER_UNAVAILABLE when the worker did not provide an applier (never a silent no-op)", async () => {
    const { harness } = seedStandardWorld();
    const deps: ActionDeps = {
      ctx: harness.ctx,
      getFeedback: () => undefined,
      getLeadershipAgentId: () => undefined,
    };
    const result = (await handleSetAgentAppearance(deps, { ...BASE_PARAMS, hueShift: 47 }, userContext())) as HandlerResult;
    expect(result).toEqual({ ok: false, error: "ASSIGNMENT_APPLIER_UNAVAILABLE" });
  });

  it("persists + applies through the worker-provided applier and returns its result (ok:true path)", async () => {
    const { deps, applier } = makeSetDeps();
    const result = (await handleSetAgentAppearance(
      deps,
      { ...BASE_PARAMS, agentId: AGENT_CEO_ID, characterId: "paperclip-pixels:char-6", palette: 6, hueShift: 360 },
      userContext(),
    )) as HandlerResult;

    expect(result.ok).toBe(true);
    expect(typeof result.assignment?.updatedAt).toBe("string");
    expect(Number.isNaN(Date.parse(result.assignment!.updatedAt))).toBe(false);
    expect(result.assignment?.palette).toBe(6);
    expect(applier).toHaveBeenCalledTimes(1);
    const [argCompanyId, argInput] = applier.mock.calls[0] as unknown as [
      string,
      { agentId: string; agentName: string; assignment: AgentCharacterAssignmentShape },
    ];
    expect(argCompanyId).toBe(COMPANY_ID);
    expect(argInput.agentId).toBe(AGENT_CEO_ID);
    expect(argInput.agentName).toBe("CEO Agent");
    expect(argInput.assignment).toMatchObject({
      characterId: "paperclip-pixels:char-6",
      palette: 6,
      hueShift: 360,
      updatedAt: result.assignment?.updatedAt,
    });
  });

  it("passes the applier's failure outcome through verbatim (write succeeded; relay push re-applied by the next sync)", async () => {
    const { deps } = makeSetDeps({ ok: true, error: undefined, assignment: undefined, applied: false });
    const result = (await handleSetAgentAppearance(deps, { ...BASE_PARAMS }, userContext())) as HandlerResult;
    expect(result).toEqual({ ok: true, error: undefined, assignment: undefined, applied: false });
  });

  it("accepts every committed catalog id/palette pair (spot-checked across both id families)", async () => {
    const { deps, applier } = makeSetDeps();
    for (const [id, palette] of [
      ["pixel-agents:char-0", 0],
      ["paperclip-pixels:char-6", 6],
      ["paperclip-pixels:char-23", 23],
    ] as const) {
      const result = (await handleSetAgentAppearance(deps, {
        companyId: COMPANY_ID,
        agentId: AGENT_DEV_ID,
        characterId: id,
        palette,
        hueShift: 0,
      }, userContext())) as HandlerResult;
      expect(result.ok).toBe(true);
      expect((applier.mock.calls.at(-1) as unknown[])[1]).toMatchObject({ agentId: AGENT_DEV_ID, agentName: "Dev Agent" });
    }
    expect(applier).toHaveBeenCalledTimes(3);
  });

  it("keys the manifest action name for the appearance action", () => {
    expect(ACTION_KEYS.setAgentAppearance).toBe("agent.set-pixel-appearance");
  });

  it("uses the committed catalog unchanged for validation (fixture sanity + raw state untouched)", async () => {
    const { deps, harness } = makeSetDepsWithHarness();
    expect(REAL_CATALOG.characters.length).toBe(24);
    expect(harness.getState({
      scopeKind: "agent",
      scopeId: AGENT_DEV_ID,
      namespace: STATE_NAMESPACES.characters,
      stateKey: STATE_KEYS.agentCharacter,
    })).toBeUndefined();
    await handleSetAgentAppearance(deps, { ...BASE_PARAMS, characterId: "ghost" }, userContext());
    expect(harness.getState({
      scopeKind: "agent",
      scopeId: AGENT_DEV_ID,
      namespace: STATE_NAMESPACES.characters,
      stateKey: STATE_KEYS.agentCharacter,
    })).toBeUndefined();
  });
});

interface AgentCharacterAssignmentShape {
  // Mirrors the frozen core assignment record for handler-input assertions.
  characterId: string;
  palette: number;
  hueShift: number;
  updatedAt: string;
}
