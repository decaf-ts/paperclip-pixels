/**
 * Unit tests for the WS3 agent-scope persistence helpers
 * (`src/persistence.ts`, spec PAPERCLIP_PIXELS-2 FR-13): round-trip through
 * the plugin SDK testing harness, the exact raw state scope key, fail-closed
 * handling of malformed stored values, and bulk loading.
 */

import { describe, expect, it } from "vitest";
import type { AgentCharacterAssignment } from "../src/core/index.js";
import { STATE_KEYS, STATE_NAMESPACES } from "../src/constants.js";
import {
  loadAgentCharacterAssignment,
  loadAgentCharacterAssignments,
  persistAgentCharacterAssignment,
} from "../src/persistence.js";
import { AGENT_CEO_ID, AGENT_DEV_ID, makeHarness } from "./fixtures.js";

const NOW = "2026-08-22T00:00:00.000Z";

function assignment(
  characterId: string,
  palette: number,
  hueShift: number,
  updatedAt = NOW,
): AgentCharacterAssignment {
  return { characterId, palette, hueShift, updatedAt };
}

/** The exact state scope the persistence helpers must use (frozen contract). */
function agentScope(agentId: string) {
  return {
    scopeKind: "agent" as const,
    scopeId: agentId,
    namespace: STATE_NAMESPACES.characters,
    stateKey: STATE_KEYS.agentCharacter,
  };
}

describe("agent character assignment persistence (WS3, FR-13)", () => {
  it("loads null when no assignment was persisted", async () => {
    const harness = makeHarness();
    expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID)).toBeNull();
    expect(harness.getState(agentScope(AGENT_DEV_ID))).toBeUndefined();
  });

  it("round-trips set -> get through the ctx.state agent scope", async () => {
    const harness = makeHarness();
    const record = assignment("pixel-agents:char-0", 0, 45, "2026-08-22T00:05:00.000Z");
    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, record);
    const loaded = await loadAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID);
    expect(loaded).not.toBeNull();
    expect(loaded!.updatedAt).toBe("2026-08-22T00:05:00.000Z");
    expect(loaded!.palette).toBe(0);
    expect(loaded!.hueShift).toBe(45);
  });

  it("stores the exact record under the frozen agent-scope key", async () => {
    const harness = makeHarness();
    const record = assignment("paperclip-pixels:char-6", 6, 92);
    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, record);
    expect(harness.getState(agentScope(AGENT_DEV_ID))).toEqual(record);
    expect(harness.getState(agentScope(AGENT_CEO_ID))).toBeUndefined();
  });

  it("fails closed to null for malformed stored values (any shape gap)", async () => {
    const harness = makeHarness();
    for (const malformed of [
      "not-an-object",
      42,
      null,
      [],
      {},
      { characterId: "", palette: 0, hueShift: 0, updatedAt: NOW },
      { characterId: "pixel-agents:char-0", palette: 1.5, hueShift: 0, updatedAt: NOW },
      { characterId: "pixel-agents:char-0", palette: -1, hueShift: 0, updatedAt: NOW },
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: 361, updatedAt: NOW },
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: -1, updatedAt: NOW },
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: 0.5, updatedAt: NOW },
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: 0, updatedAt: "" },
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: 0 },
    ]) {
      await persistAgentCharacterAssignment(harness.ctx, AGENT_CEO_ID, malformed as unknown as AgentCharacterAssignment);
      expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_CEO_ID)).toBeNull();
      expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID)).toBeNull();
    }
  });

  it("keeps assignments isolated per agent (overwriting one never touches others)", async () => {
    const harness = makeHarness();
    await persistAgentCharacterAssignment(harness.ctx, AGENT_CEO_ID, assignment("pixel-agents:char-0", 0, 0));
    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, assignment("paperclip-pixels:char-6", 6, 45));
    expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_CEO_ID)).toEqual(assignment("pixel-agents:char-0", 0, 0));
    expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID)).toEqual(assignment("paperclip-pixels:char-6", 6, 45));

    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, assignment("pixel-agents:char-2", 2, 200));
    expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID)).toEqual(assignment("pixel-agents:char-2", 2, 200));
    expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_CEO_ID)).toEqual(assignment("pixel-agents:char-0", 0, 0));
  });

  it("overwrites the stored record with the most recent persist", async () => {
    const harness = makeHarness();
    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, assignment("pixel-agents:char-0", 0, 0));
    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, assignment("pixel-agents:char-1", 1, 47));
    expect(await loadAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID)).toEqual(
      assignment("pixel-agents:char-1", 1, 47),
    );
  });

  it("bulk-loads only the agents that have a valid assignment, skipping absent and malformed ones", async () => {
    const harness = makeHarness();
    await persistAgentCharacterAssignment(harness.ctx, AGENT_CEO_ID, assignment("pixel-agents:char-0", 0, 0));
    await persistAgentCharacterAssignment(harness.ctx, AGENT_DEV_ID, assignment("paperclip-pixels:char-6", 6, 45));
    await harness.ctx.state.set(
      agentScope("agent-broken"),
      { characterId: "pixel-agents:char-0", palette: 0, hueShift: 999, updatedAt: NOW },
    );

    const map = await loadAgentCharacterAssignments(harness.ctx, [
      AGENT_CEO_ID,
      AGENT_DEV_ID,
      "agent-broken",
      "agent-absent",
    ]);
    expect(Object.keys(map).sort()).toEqual([AGENT_CEO_ID, AGENT_DEV_ID].sort());
    expect(map[AGENT_CEO_ID]).toEqual(assignment("pixel-agents:char-0", 0, 0));
    expect(map[AGENT_DEV_ID]).toEqual(assignment("paperclip-pixels:char-6", 6, 45));

    // An all-absent bulk load returns an empty map (fresh materialization).
    expect(await loadAgentCharacterAssignments(harness.ctx, ["agent-ghost-1", "agent-ghost-2"])).toEqual({});
  });
});
