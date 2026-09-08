/**
 * Unit tests for the WS3 per-agent character domain (`src/core/domain/characters.ts`,
 * spec PAPERCLIP_PIXELS-2 FR-13 / CEO decision 4).
 *
 * Coverage:
 * - least-used selection (empty map -> every character exactly once; later
 *   picks stay among least-used; stale assignment ids ignored);
 * - hue-shift-on-reuse (first-round user 0, reusers `45 + ((round-1)*47) % 315`
 *   so every reuse shift stays in [45, 359] — never the identity hue 0 or 360,
 *   and never below the 45° visible-rotation floor; pairwise-distinct per
 *   character for reuse rounds 1..315, deterministic per round);
 * - determinism (same agentId + same map -> identical selection);
 * - `ensureAgentAssignments` (existing assignments preserved byte-for-byte,
 *   only missing agents created, exact `created` list);
 * - `validateAssignmentInput` + `parseCharacterCatalog` shape validation;
 * - real committed `assets/characters/catalog.json` integrity.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import type { CharacterCatalog, CharacterCatalogEntry, AgentCharacterAssignment } from "../../src/core/index.js";
import {
  HUE_SHIFT_MAX_DEG,
  countCharacterUsage,
  ensureAgentAssignments,
  findCatalogEntry,
  hashAgentSeed,
  isAgentCharacterAssignment,
  mulberry32,
  parseCharacterCatalog,
  selectDefaultAssignment,
  validateAssignmentInput,
} from "../../src/core/index.js";

const NOW = "2026-08-22T00:00:00.000Z";

function agentId(index: number): string {
  return `agent-${String(index).padStart(4, "0")}`;
}

function agentIds(count: number, offset = 0): string[] {
  return Array.from({ length: count }, (_, i) => agentId(offset + i));
}

function catalogEntry(id: string, palette: number): CharacterCatalogEntry {
  return {
    id,
    name: `Character ${palette + 1}`,
    palette,
    file: `char_${palette}.png`,
    source: "test fixture",
    license: "CC0-1.0",
  };
}

function makeCatalog(palettes: number[]): CharacterCatalog {
  return {
    schemaVersion: 1,
    characters: palettes.map((palette) => catalogEntry(`char-${palette}`, palette)),
  };
}

/** Independent FNV-1a 32-bit reimplementation of the documented seed hash. */
function expectedFnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function assignment(
  characterId: string,
  palette: number,
  hueShift: number,
  updatedAt = NOW,
): AgentCharacterAssignment {
  return { characterId, palette, hueShift, updatedAt };
}

describe("parseCharacterCatalog", () => {
  it("parses a well-formed catalog and copies each entry verbatim", () => {
    const raw = {
      schemaVersion: 1,
      characters: [
        { id: "pixel-agents:char-0", name: "One", palette: 0, file: "char_0.png", source: "bundled", license: "CC0-1.0" },
        { id: "paperclip-pixels:char-6", name: "Two", palette: 6, file: "char_6.png", source: "generated", license: "CC0-1.0" },
      ],
    };
    const parsed = parseCharacterCatalog(raw);
    expect(parsed).toEqual({ schemaVersion: 1, characters: raw.characters });
  });

  it.each([
    [null, "character catalog must be a JSON object"],
    [[{ id: "x", palette: 0 }], "character catalog must be a JSON object"],
    ["catalog", "character catalog must be a JSON object"],
    [{ schemaVersion: 2, characters: [{ id: "x", name: "X", palette: 0, file: "char_0.png", source: "s", license: "l" }] }, "unsupported character catalog schemaVersion: 2"],
    [{ schemaVersion: 1 }, "character catalog must contain at least one character"],
    [{ schemaVersion: 1, characters: [] }, "character catalog must contain at least one character"],
    [{ schemaVersion: 1, characters: "no" }, "character catalog must contain at least one character"],
  ])("rejects %j with fail-closed error", (raw, message) => {
    expect(() => parseCharacterCatalog(raw)).toThrow(message);
  });

  it.each([
    [{ id: "a", name: "A" }, "missing palette/file"],
    [{ id: 7, name: "A", palette: 0, file: "f", source: "s", license: "l" }, "id is not a string"],
    [{ id: "", name: "A", palette: 0, file: "f", source: "s", license: "l" }, "empty id"],
    [{ id: "x", name: "A", palette: 1.5, file: "f", source: "s", license: "l" }, "fractional palette"],
    [{ id: "x", name: "A", palette: -1, file: "f", source: "s", license: "l" }, "negative palette"],
    [{ id: 7, name: "A", palette: 0, file: "f", source: "s", license: "l" }, "id is not a string"],
    [{ id: "x", palette: 0, file: "f", source: "s", license: "l" }, "missing name"],
    [{ id: "x", name: "A", palette: 0, source: "s", license: "l" }, "missing file"],
  ])("rejects malformed entry (%s)", (entry, _label) => {
    expect(() => parseCharacterCatalog({ schemaVersion: 1, characters: [entry] })).toThrow(
      /malformed character catalog entry/,
    );
  });

  it("rejects duplicate character ids", () => {
    const raw = {
      schemaVersion: 1,
      characters: [
        { id: "dup", name: "A", palette: 0, file: "char_0.png", source: "s", license: "l" },
        { id: "dup", name: "B", palette: 1, file: "char_1.png", source: "s", license: "l" },
      ],
    };
    expect(() => parseCharacterCatalog(raw)).toThrow("duplicate character id: dup");
  });

  it("rejects duplicate palette indices", () => {
    const raw = {
      schemaVersion: 1,
      characters: [
        { id: "one", name: "A", palette: 3, file: "char_3.png", source: "s", license: "l" },
        { id: "two", name: "B", palette: 3, file: "char_3.png", source: "s", license: "l" },
      ],
    };
    expect(() => parseCharacterCatalog(raw)).toThrow("duplicate character palette index: 3");
  });
});

describe("findCatalogEntry", () => {
  const catalog = makeCatalog([0, 1, 2]);
  it("finds an entry by id", () => {
    expect(findCatalogEntry(catalog, "char-1")).toEqual(catalog.characters[1]);
  });
  it("returns undefined for unknown ids", () => {
    expect(findCatalogEntry(catalog, "ghost")).toBeUndefined();
    expect(findCatalogEntry(catalog, "")).toBeUndefined();
  });
});

describe("isAgentCharacterAssignment", () => {
  const valid = assignment("pixel-agents:char-0", 0, 0, "2026-08-22T00:00:00.000Z");

  it.each([
    ["minimal record", valid],
    ["hueShift upper bound 360", assignment("x", 0, HUE_SHIFT_MAX_DEG)],
    ["large palette index", assignment("x", 23, 0)],
  ])("accepts %s", (_label, value) => {
    expect(isAgentCharacterAssignment(value)).toBe(true);
  });

  it.each([
    ["null", null],
    ["bare number", 7],
    ["array", [{ characterId: "x", palette: 0, hueShift: 0, updatedAt: NOW }]],
    ["missing characterId", {}],
    ["empty characterId", assignment("", 0, 0)],
    ["non-integer palette", { characterId: "x", palette: 1.5, hueShift: 0, updatedAt: NOW }],
    ["negative palette", assignment("x", -1, 0)],
    ["non-integer hueShift", { characterId: "x", palette: 0, hueShift: 1.5, updatedAt: NOW }],
    ["hueShift above range", assignment("x", 0, 361)],
    ["negative hueShift", assignment("x", 0, -1)],
    ["empty updatedAt", assignment("x", 0, 0, "")],
    ["numeric updatedAt", { characterId: "x", palette: 0, hueShift: 0, updatedAt: 1724284800000 }],
    ["string hueShift", { characterId: "x", palette: 0, hueShift: "0", updatedAt: NOW }],
  ])("rejects %s", (_label, value) => {
    expect(isAgentCharacterAssignment(value)).toBe(false);
  });
});

describe("mulberry32 / hashAgentSeed determinism", () => {
  it("produces the identical sequence for the same seed", () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    const seq = Array.from({ length: 32 }, () => a());
    for (const value of seq) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
    expect(Array.from({ length: 32 }, () => b())).toEqual(seq);
  });

  it("differs across different seeds", () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    const first = Array.from({ length: 8 }, () => a());
    const second = Array.from({ length: 8 }, () => b());
    expect(first).not.toEqual(second);
  });

  it("hashes an agent id to a stable FNV-1a 32-bit value", () => {
    for (const id of ["agent-0", "agent-1234", "agent-with-Ω", ""]) {
      expect(hashAgentSeed(id)).toBe(expectedFnv1a(id));
    }
    expect(hashAgentSeed("agent-0")).toBe(hashAgentSeed("agent-0"));
    const distinct = new Set(agentIds(64).map((id) => hashAgentSeed(id)));
    expect(distinct.size).toBe(64);
  });

  it("treats agent ids differing only by case as distinct seeds", () => {
    expect(hashAgentSeed("Agent-1")).not.toBe(hashAgentSeed("agent-1"));
  });
});

describe("countCharacterUsage", () => {
  it("counts assignments per catalog index and ignores stale ids", () => {
    const catalog = makeCatalog([0, 1, 2]);
    const counts = countCharacterUsage(catalog, {
      "agent-a": assignment("char-0", 0, 0),
      "agent-b": assignment("char-0", 0, 45),
      "agent-c": assignment("char-2", 2, 0),
      "agent-stale": assignment("char-99", 99, 0),
      "agent-ghost": assignment("pixel-agents:ghost", 0, 0),
    });
    expect(counts).toEqual([2, 0, 1]);
  });

  it("returns zeros for an empty assignment map", () => {
    const catalog = makeCatalog([0, 1, 2]);
    expect(countCharacterUsage(catalog, {})).toEqual([0, 0, 0]);
  });
});

describe("selectDefaultAssignment (least-used selection)", () => {
  /** Build `id -> assignment` by sequentially materializing defaults, per-asserting least-used picks. */
  function buildSequential(catalog: CharacterCatalog, ids: string[]): Record<string, AgentCharacterAssignment> {
    const map: Record<string, AgentCharacterAssignment> = {};
    for (const id of ids) {
      const countsBefore = countCharacterUsage(catalog, map);
      const minCount = Math.min(...countsBefore);
      const pick = selectDefaultAssignment(catalog, map, id, NOW);
      // The chosen entry is one counted least-used at pick time.
      const index = catalog.characters.findIndex((entry) => entry.id === pick.characterId);
      expect(countsBefore[index]).toBe(minCount);
      expect(pick.palette).toBe(catalog.characters[index].palette);
      map[id] = pick;
    }
    return map;
  }

  it("covers every character exactly once with the first N agents over an empty map", () => {
    const catalog = makeCatalog([0, 1, 2, 3, 4]);
    const map = buildSequential(catalog, agentIds(5));
    expect(countCharacterUsage(catalog, map)).toEqual([1, 1, 1, 1, 1]);
    expect(new Set(Object.values(map).map((a) => a.characterId)).size).toBe(5);
    // First-round users: hue shift stays 0.
    for (const value of Object.values(map)) {
      expect(value.hueShift).toBe(0);
    }
  });

  it("beyond N agents keeps picks among least-used (max usage <= ceil(agents/catalog))", () => {
    const catalog = makeCatalog([0, 1, 2, 3, 4]);
    for (let total = 5; total <= 11; total += 1) {
      const map = buildSequential(catalog, agentIds(total));
      const counts = countCharacterUsage(catalog, map);
      const max = Math.max(...counts);
      expect(max).toBeLessThanOrEqual(Math.ceil(total / 5));
      expect(max - Math.min(...counts)).toBeLessThanOrEqual(1);
    }
  });

  it("ignores stale assignment ids pointing outside the catalog when spreading", () => {
    const catalog = makeCatalog([0, 1, 2]);
    const map = buildSequential(catalog, agentIds(3, 100));
    expect(countCharacterUsage(catalog, map)).toEqual([1, 1, 1]);
    // A stale entry occupies a slot in the map but counts no usage, so a
    // stale-only map materializes the exact same all-once spread as an empty
    // one — the stale id cannot skew the least-used computation.
    const reseeded = ensureAgentAssignments(
      catalog,
      { "agent-stale": assignment("ghost-char", 99, 0, NOW) },
      agentIds(3, 200),
      NOW,
    );
    expect(countCharacterUsage(catalog, reseeded.map)).toEqual([1, 1, 1]);
    expect(reseeded.created).toEqual(agentIds(3, 200));
  });

  it("stale entries do not skew the least-used candidates for a new agent", () => {
    // With 2 covered characters and one stale-ghost entry, the remaining agent
    // must pick the single untouched character, never a stale one.
    const catalog = makeCatalog([0, 1, 2]);
    const map: Record<string, AgentCharacterAssignment> = {
      "agent-a": assignment("char-0", 0, 0),
      "agent-b": assignment("char-1", 1, 0),
      "agent-stale": assignment("ghost-char", 77, 0),
    };
    const pick = selectDefaultAssignment(catalog, map, "agent-new", NOW);
    expect(pick.characterId).toBe("char-2");
  });
});

describe("selectDefaultAssignment (hue shift on reuse)", () => {
  it("gives the first-round user hueShift 0 and later rounds per-round deterministic shifts", () => {
    const catalog = makeCatalog([0]);
    const map: Record<string, AgentCharacterAssignment> = {};

    const first = selectDefaultAssignment(catalog, map, agentId(0), NOW);
    expect(first.hueShift).toBe(0);
    map[agentId(0)] = first;

    // Reuse round r (a user joining when the character already has r users)
    // gets 45 + ((r - 1) * 47) % 315, which stays in [45, 359] — never the
    // identity hue 0 (the renderer applies shifts as rotations modulo 360,
    // so 0 and 360 are both identity). Deterministic per round, regardless of
    // the joining agent's id. Asserting against TWO untouched map states with
    // the same usage proves per-round determinism without advancing the map.
    for (let round = 1; round <= 10; round += 1) {
      const state: Record<string, AgentCharacterAssignment> = Object.fromEntries(
        agentIds(round).map((id) => [id, map[id]]),
      );
      const expected = 45 + ((round - 1) * 47) % 315;
      for (const id of [`joiner-A-${round}`, agentId(round + 100)]) {
        const pick = selectDefaultAssignment(catalog, state, id, NOW);
        expect(pick.hueShift).toBe(expected);
      }
      // Re-applying also advances the shared sequential map by one round.
      map[agentId(round)] = selectDefaultAssignment(catalog, map, agentId(round), NOW);
    }
    expect(map[agentId(1)].hueShift).toBe(45);
    // Round 8 keeps the corrected contract's in-range value (the old
    // % 360 formula dropped round 8 to 14, below the 45° visible floor).
    expect(map[agentId(8)].hueShift).toBe(45 + (7 * 47) % 315);
  });

  it("keeps reuse round shifts in [45, 359] and pairwise-distinct through round 315; 0 stays first-round-only and the first repeat is round 316 replaying round 1", () => {
    // Documented behavior acceptance (SAA-474 review finding, fixed on
    // SAA-469): the old formula `(45 + (r - 1) * 47) % 360` wrapped to the
    // identity hue 0 at round 46 — pixel-identical with the first-round user,
    // because the renderer applies hue shifts as rotations modulo 360 — and
    // dropped later rounds below the 45° visible-rotation floor (round 8
    // produced 14). The corrected formula `45 + ((r - 1) * 47) % 315` never
    // yields 0 or 360 for a reuser; 47 is coprime with 315 (= 3^2 * 5 * 7),
    // so reuse rounds 1..315 are pairwise distinct and the first repeat is
    // round 316 replaying round 1's 45.
    const catalog = makeCatalog([0]);
    const map = ensureAgentAssignments(catalog, {}, agentIds(360), NOW).map;
    const roundShifts = new Map<number, number>();
    for (const [id, value] of Object.entries(map)) {
      roundShifts.set(Number(id.split("-")[1]), value.hueShift);
    }
    expect(roundShifts.size).toBe(360);
    // The first-round user keeps the identity hue 0 — exactly once in the
    // whole map. Every reuser lands in [45, 359], never 0 or 360.
    expect(roundShifts.get(0)).toBe(0);
    for (let round = 1; round <= 359; round += 1) {
      const shift = roundShifts.get(round)!;
      expect(shift).toBeGreaterThanOrEqual(45);
      expect(shift).toBeLessThanOrEqual(359);
    }
    // 47 coprime with 315: reuse rounds 1..315 are pairwise distinct, and the
    // fixed regression pin round 46 is 270 (was 0 before the correction).
    const distinct = new Set(Array.from({ length: 315 }, (_, i) => roundShifts.get(i + 1)));
    expect(roundShifts.get(46)).toBe(270);
    expect(distinct.size).toBe(315);
    // The cycle wraps only at round 316, replaying round 1's value 45.
    for (let round = 316; round <= 359; round += 1) {
      expect(roundShifts.get(round)).toBe(roundShifts.get(round - 315));
    }
    expect(roundShifts.get(316)).toBe(45);
    // Per value: 0 exactly once; each rounds-1..44 shift twice (replayed at
    // round r + 315); every other reuse value once — 360 users cover
    // 1 + 315 distinct hue values, no value a third time.
    const counts = new Map<number, number>();
    for (const shift of roundShifts.values()) {
      counts.set(shift, (counts.get(shift) ?? 0) + 1);
    }
    expect(counts.get(0)).toBe(1);
    expect(counts.size).toBe(316);
    expect([...counts.values()].every((n) => n === 1 || n === 2)).toBe(true);
    expect([...counts.entries()].filter(([, n]) => n === 2).map(([value]) => value).sort((a, b) => a - b))
      .toEqual(Array.from({ length: 44 }, (_, i) => 45 + (i * 47) % 315).sort((a, b) => a - b));
  });

  it("keeps reuse-shifts distinct within each shared character of a mixed catalog", () => {
    const catalog = makeCatalog([0, 1, 2, 3]);
    const map = ensureAgentAssignments(catalog, {}, agentIds(12), NOW).map;
    const byCharacter = new Map<string, AgentCharacterAssignment[]>();
    for (const value of Object.values(map)) {
      const group = byCharacter.get(value.characterId) ?? [];
      group.push(value);
      byCharacter.set(value.characterId, group);
    }
    for (const group of byCharacter.values()) {
      const shifts = new Set(group.map((a) => a.hueShift));
      expect(shifts.size).toBe(group.length);
    }
  });

  it("applies the per-round shift only when reusing (zero for first use everywhere)", () => {
    const catalog = makeCatalog([0, 1, 2, 3]);
    const map = ensureAgentAssignments(catalog, {}, agentIds(4), NOW).map;
    for (const value of Object.values(map)) {
      expect(value.hueShift).toBe(0);
    }
  });
});

describe("selectDefaultAssignment (determinism)", () => {
  it("returns identical selections for the same agentId + map state across runs", () => {
    const catalog = makeCatalog([0, 1, 2]);
    // One build step per snapshot point: re-selecting against the SAME map
    // state (the state as it was at pick time) must return the exact same
    // record, so restarts re-derive defaults deterministically.
    const states: Array<Record<string, AgentCharacterAssignment>> = [];
    const map: Record<string, AgentCharacterAssignment> = {};
    for (const id of agentIds(5)) {
      states.push({ ...map });
      map[id] = selectDefaultAssignment(catalog, map, id, NOW);
    }
    for (let i = 0; i < states.length; i += 1) {
      const id = agentId(i);
      const again = selectDefaultAssignment(catalog, states[i], id, NOW);
      expect(again).toStrictEqual(map[id]);
    }
    // Re-materializing from the same starting state yields the same map:
    // the seeded RNG depends on the agent id, never on wall-clock or order.
    const fresh: Record<string, AgentCharacterAssignment> = {};
    for (const id of agentIds(5)) {
      fresh[id] = selectDefaultAssignment(catalog, fresh, id, NOW);
    }
    expect(fresh).toStrictEqual(map);
    // Five agents over three characters leave usage [1, 2, 2] (least-used
    // spread, never a single character above ceil(5/3) = 2).
    expect([...countCharacterUsage(catalog, map)].sort((a, b) => a - b)).toEqual([1, 2, 2]);
  });

  it("may pick differently for different agent ids on the same map (seeded diversity)", () => {
    const catalog = makeCatalog(
      Array.from({ length: 24 }, (_, i) => i),
    );
    const picks = new Set(agentIds(200).map((id) => selectDefaultAssignment(catalog, {}, id, NOW).characterId));
    expect(picks.size).toBeGreaterThanOrEqual(12);
  });
});

describe("ensureAgentAssignments", () => {
  it("preserves existing assignments byte-for-byte and creates only missing agents", () => {
    const catalog = makeCatalog([0, 1, 2]);
    const explicitA = assignment("char-0", 0, 200);
    const explicitB = assignment("char-1", 1, 0, "2026-08-22T00:00:01.000Z");
    const existing: Record<string, AgentCharacterAssignment> = {
      "agent-explicit-a": explicitA,
      "agent-explicit-b": explicitB,
    };
    const { map, created } = ensureAgentAssignments(
      catalog,
      existing,
      ["agent-explicit-a", "agent-new-1", "agent-explicit-b", "agent-new-2"],
      NOW,
    );
    expect(map["agent-explicit-a"]).toBe(explicitA);
    expect(map["agent-explicit-b"]).toBe(explicitB);
    expect(created).toEqual(["agent-new-1", "agent-new-2"]);
    expect(map["agent-new-1"].updatedAt).toBe(NOW);
    expect(map["agent-new-1"].hueShift).toBe(0);
  });

  it("returns the exact created list for a fully-empty map", () => {
    const catalog = makeCatalog([0, 1, 2]);
    const ids = agentIds(3);
    const { map, created } = ensureAgentAssignments(catalog, {}, ids, NOW);
    expect(created).toEqual(ids);
    expect(Object.keys(map).sort()).toEqual([...ids].sort());
  });

  it("is a no-op for an empty agent list", () => {
    const catalog = makeCatalog([0, 1]);
    const existing = { "agent-x": assignment("char-0", 0, 0) };
    const { map, created } = ensureAgentAssignments(catalog, existing, [], NOW);
    expect(created).toEqual([]);
    expect(map).toEqual(existing);
  });

  it("replaces a malformed stored entry and includes it in created (fail-closed)", () => {
    const catalog = makeCatalog([0, 1]);
    const malformed = { characterId: "", palette: -1, hueShift: 999 } as unknown as AgentCharacterAssignment;
    const { map, created } = ensureAgentAssignments(catalog, { "agent-bad": malformed }, ["agent-bad"], NOW);
    expect(created).toEqual(["agent-bad"]);
    expect(isAgentCharacterAssignment(map["agent-bad"])).toBe(true);
    expect(map["agent-bad"].hueShift).toBe(0);
  });

  it("counts materialized defaults toward later least-used computation in the same batch", () => {
    const catalog = makeCatalog([0, 1, 2]);
    const { map } = ensureAgentAssignments(catalog, {}, agentIds(4), NOW);
    expect(Object.values(map).reduce((acc, a) => acc + (a.characterId === "char-0" ? 1 : 0), 0)).toBeLessThanOrEqual(2);
    expect(countCharacterUsage(catalog, map).every((count) => count >= 1 && count <= 2)).toBe(true);
  });

  it("materializes byte-identical maps across two identical builds (restart stability)", () => {
    const catalog = makeCatalog(
      Array.from({ length: 24 }, (_, i) => i),
    );
    const ids = agentIds(24);
    const first = ensureAgentAssignments(catalog, {}, ids, NOW);
    const second = ensureAgentAssignments(catalog, {}, ids, NOW);
    expect(second.map).toStrictEqual(first.map);
    expect(second.created).toEqual(first.created);
  });
});

describe("validateAssignmentInput", () => {
  const catalog = makeCatalog([0, 1, 2]);

  it("accepts a coherent input and returns the catalog entry", () => {
    const result = validateAssignmentInput(catalog, { characterId: "char-1", palette: 1, hueShift: 180 });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.entry).toEqual(catalog.characters[1]);
  });

  it.each([
    [{ characterId: "ghost-char", palette: 0, hueShift: 0 }, "UNKNOWN_CHARACTER"],
    [{ characterId: "", palette: 0, hueShift: 0 }, "UNKNOWN_CHARACTER"],
    [{ characterId: "char-0", palette: 1, hueShift: 0 }, "PALETTE_MISMATCH"],
    [{ characterId: "char-1", palette: Number.NaN, hueShift: 0 }, "PALETTE_MISMATCH"],
    [{ characterId: "char-1", palette: 1.5, hueShift: 0 }, "PALETTE_MISMATCH"],
    [{ characterId: "char-1", palette: 1, hueShift: 361 }, "INVALID_HUE_SHIFT"],
    [{ characterId: "char-1", palette: 1, hueShift: -1 }, "INVALID_HUE_SHIFT"],
    [{ characterId: "char-1", palette: 1, hueShift: 0.5 }, "INVALID_HUE_SHIFT"],
    [{ characterId: "char-1", palette: 1, hueShift: Number.NaN }, "INVALID_HUE_SHIFT"],
  ])("rejects %j with %s", (input, error) => {
    const result = validateAssignmentInput(catalog, input);
    expect(result).toEqual({ ok: false, error });
  });

  it.each([
    [{ characterId: "char-1", palette: 1, hueShift: 0 }],
    [{ characterId: "char-2", palette: 2, hueShift: HUE_SHIFT_MAX_DEG }],
    [{ characterId: "char-0", palette: 0, hueShift: 1 }],
  ])("accepts %j", (input) => {
    expect(validateAssignmentInput(catalog, input).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Real committed catalog integrity (assets/characters/catalog.json, WS3 task 1).
// The invariant: palette == numeric suffix of file == position in Pixel
// Agents' merged sprite array (bundled 0..5 first, shared extras in numeric
// order); every `file` exists on disk next to the catalog.
// ---------------------------------------------------------------------------

const CATALOG_DIR = path.resolve(__dirname, "../../../..", "assets", "characters");

describe("real committed catalog integrity", () => {
  const raw = JSON.parse(readFileSync(path.join(CATALOG_DIR, "catalog.json"), "utf8")) as unknown;

  it("parses into 24 catalog entries", () => {
    const catalog = parseCharacterCatalog(raw);
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.characters).toHaveLength(24);
  });

  it("satisfies palette == file-suffix invariant and ships every sheet on disk", () => {
    const catalog = parseCharacterCatalog(raw);
    for (const entry of catalog.characters) {
      const match = /^char_(\d+)\.png$/.exec(entry.file);
      expect(match).not.toBeNull();
      expect(Number(match![1])).toBe(entry.palette);
      expect(existsSync(path.join(CATALOG_DIR, entry.file))).toBe(true);
    }
  });

  it("orders palettes 0..23: bundled 0..5 first, shared extras appended in numeric order", () => {
    const catalog = parseCharacterCatalog(raw);
    expect(catalog.characters.map((entry) => entry.palette)).toEqual(
      Array.from({ length: 24 }, (_, i) => i),
    );
    for (let i = 0; i < catalog.characters.length; i += 1) {
      if (catalog.characters[i].palette < 6) {
        expect(catalog.characters[i].id).toBe(`pixel-agents:char-${i}`);
        expect(catalog.characters[i].source).toContain("Pixel Agents");
      } else {
        expect(catalog.characters[i].id).toBe(`paperclip-pixels:char-${i}`);
        expect(catalog.characters[i].license).toBe("CC0-1.0");
      }
    }
  });

  it("matches the raw committed JSON entries verbatim", () => {
    const catalog = parseCharacterCatalog(raw);
    expect(catalog.characters).toEqual((raw as { characters: CharacterCatalogEntry[] }).characters);
  });

  it("spreads the first 24 agents over the real catalog exactly once (all first-round hueShift 0)", () => {
    const catalog = parseCharacterCatalog(raw);
    const { map, created } = ensureAgentAssignments(catalog, {}, agentIds(24), NOW);
    expect(created).toHaveLength(24);
    expect(countCharacterUsage(catalog, map)).toEqual(Array.from({ length: 24 }, () => 1));
    expect(new Set(Object.values(map).map((a) => a.characterId)).size).toBe(24);
    for (const value of Object.values(map)) {
      expect(value.hueShift).toBe(0);
    }
    // A 25th agent must not push any character above ceil(25/24) = 2.
    const resumed = ensureAgentAssignments(catalog, map, agentIds(1, 24), NOW);
    expect(Math.max(...countCharacterUsage(catalog, resumed.map))).toBe(2);
  });
});
