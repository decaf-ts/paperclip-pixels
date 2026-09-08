/**
 * Per-agent character catalog + assignment selection (spec
 * PAPERCLIP_PIXELS-2, FR-13; WS3).
 *
 * Adopts the Agent-Pixels *pattern* only (NFR-3: Agent-Pixels is unlicensed —
 * never its code or sprites): an ordered character catalog with an integer
 * palette index per sheet, plus a per-agent assignment map defaulting to a
 * diverse-random pick. Pure TypeScript, no host SDK dependency, deterministic
 * by construction so the selection is unit-testable.
 */

/** One ordered catalog entry: a complete Pixel Agents character sheet. */
export interface CharacterCatalogEntry {
  /** Stable catalog id (e.g. `pixel-agents:char-0`, `paperclip-pixels:char-6`). */
  id: string;
  /** Human-readable name shown in pickers. */
  name: string;
  /**
   * Integer palette index: the sheet's position in Pixel Agents' merged
   * sprite array (bundled sheets 0..5 first, then the relay-shared extra
   * sheets in numeric order). Invariant: equals the numeric suffix of `file`.
   */
  palette: number;
  /** Sheet file name inside the catalog directory (`char_<palette>.png`). */
  file: string;
  /** Provenance: where the sheet came from (bundled / generated). */
  source: string;
  /** License of the sheet (bundled and generated sheets are CC0-1.0). */
  license: string;
}

/** The ordered character catalog served to the UI and validated on writes. */
export interface CharacterCatalog {
  schemaVersion: 1;
  characters: CharacterCatalogEntry[];
}

/** Upper bound for a sheet's hue rotation, inclusive (degrees). */
export const HUE_SHIFT_MAX_DEG = 360;

/**
 * Minimum hue shift applied when a character must be reused, in degrees.
 * Mirrors the fork's diversity algorithm floor: small shifts are visually
 * indistinguishable, so reuse shifts start at a clearly visible rotation.
 */
const HUE_SHIFT_MIN_DEG = 45;

/**
 * Stride between successive reuse rounds of the same character, in degrees.
 * Coprime with the reuse span (`HUE_SHIFT_MAX_DEG - HUE_SHIFT_MIN_DEG` = 315)
 * so the sequence only collides after a full 315-round wrap.
 */
const HUE_SHIFT_STRIDE_DEG = 47;

/** Parse and validate a raw catalog JSON document. Fail-closed on shape. */
export function parseCharacterCatalog(raw: unknown): CharacterCatalog {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("character catalog must be a JSON object");
  }
  const candidate = raw as { schemaVersion?: unknown; characters?: unknown };
  if (candidate.schemaVersion !== 1) {
    throw new Error(`unsupported character catalog schemaVersion: ${String(candidate.schemaVersion)}`);
  }
  if (!Array.isArray(candidate.characters) || candidate.characters.length === 0) {
    throw new Error("character catalog must contain at least one character");
  }
  const characters: CharacterCatalogEntry[] = [];
  const seenIds = new Set<string>();
  const seenPalettes = new Set<number>();
  for (const entry of candidate.characters) {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("character catalog entry must be an object");
    }
    const e = entry as Record<string, unknown>;
    if (
      typeof e.id !== "string"
      || e.id.length === 0
      || typeof e.name !== "string"
      || typeof e.palette !== "number"
      || !Number.isInteger(e.palette)
      || e.palette < 0
      || typeof e.file !== "string"
      || typeof e.source !== "string"
      || typeof e.license !== "string"
    ) {
      throw new Error(`malformed character catalog entry: ${JSON.stringify(entry)}`);
    }
    if (seenIds.has(e.id)) throw new Error(`duplicate character id: ${e.id}`);
    if (seenPalettes.has(e.palette)) throw new Error(`duplicate character palette index: ${e.palette}`);
    seenIds.add(e.id);
    seenPalettes.add(e.palette);
    characters.push({
      id: e.id,
      name: e.name,
      palette: e.palette,
      file: e.file,
      source: e.source,
      license: e.license,
    });
  }
  return { schemaVersion: 1, characters };
}

/** Find a catalog entry by id. */
export function findCatalogEntry(
  catalog: CharacterCatalog,
  characterId: string,
): CharacterCatalogEntry | undefined {
  return catalog.characters.find((entry) => entry.id === characterId);
}

/**
 * FROZEN per-agent assignment record (the Front-End sibling builds against
 * exactly this shape). Shaped to flow through the WS2 appearance API
 * ([SAA-458](/SAA/issues/SAA-458)) unchanged.
 */
export interface AgentCharacterAssignment {
  /** Catalog id of the assigned character sheet. */
  characterId: string;
  /** Integer palette index of the assigned sheet (catalog invariant). */
  palette: number;
  /** Hue rotation applied on top of the sheet, 0–360 degrees. */
  hueShift: number;
  /** ISO timestamp of the last explicit or defaulted assignment. */
  updatedAt: string;
}

/** Per-agent assignment map keyed by Paperclip agent id (frozen contract). */
export type AgentCharacterAssignmentMap = Record<string, AgentCharacterAssignment>;

/** Validate an assignment value loaded from untrusted persistence. */
export function isAgentCharacterAssignment(value: unknown): value is AgentCharacterAssignment {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.characterId === "string"
    && v.characterId.length > 0
    && typeof v.palette === "number"
    && Number.isInteger(v.palette)
    && v.palette >= 0
    && typeof v.hueShift === "number"
    && Number.isInteger(v.hueShift)
    && v.hueShift >= 0
    && v.hueShift <= HUE_SHIFT_MAX_DEG
    && typeof v.updatedAt === "string"
    && v.updatedAt.length > 0
  );
}

/**
 * Deterministic seedable PRNG (mulberry32). Returns a `next()` function
 * producing floats in [0, 1). Pure: same seed, same sequence.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Stable string hash (FNV-1a, 32-bit) used to seed per-agent randomness so a
 * default assignment is random across agents but deterministic per agent —
 * the property that makes the diverse-random default unit-testable and stable
 * across worker restarts.
 */
export function hashAgentSeed(agentId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < agentId.length; i += 1) {
    hash ^= agentId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Count how many times each catalog character is already assigned.
 * Assignments pointing at unknown catalog ids are ignored (stale entries
 * after a catalog shrink must not skew the least-used computation).
 */
export function countCharacterUsage(
  catalog: CharacterCatalog,
  assignments: AgentCharacterAssignmentMap,
): number[] {
  const counts = new Array<number>(catalog.characters.length).fill(0);
  const indexById = new Map(catalog.characters.map((entry, index) => [entry.id, index]));
  for (const assignment of Object.values(assignments)) {
    const index = indexById.get(assignment.characterId);
    if (index !== undefined) counts[index] += 1;
  }
  return counts;
}

/**
 * Select a character for an agent with no assignment yet (CEO decision 4:
 * diverse-random default, locked).
 *
 * Deterministic-random among the **least-used** characters (seeded by the
 * agent id), so defaults spread across the catalog instead of colliding on
 * one character. When every character is already in use (reuse round), the
 * pick is shifted by a per-round hue rotation so same-character agents stay
 * visually collision-free: round `c` of a character gets
 * `HUE_SHIFT_MIN + ((c - 1) * HUE_SHIFT_STRIDE) % (HUE_SHIFT_MAX - HUE_SHIFT_MIN)`
 * degrees — always in `[HUE_SHIFT_MIN, HUE_SHIFT_MAX - 1]`, so it never wraps
 * to 0 (which would collide with the first-round user, since the renderer
 * applies shifts as rotations modulo 360) and never drops below the visible
 * rotation floor. Distinct per round, stable across restarts, and never
 * colliding within a character until 315 reuse rounds.
 *
 * @returns The assignment record (not yet persisted; `updatedAt` is `now`).
 */
export function selectDefaultAssignment(
  catalog: CharacterCatalog,
  assignments: AgentCharacterAssignmentMap,
  agentId: string,
  now: string,
): AgentCharacterAssignment {
  const counts = countCharacterUsage(catalog, assignments);
  const minCount = Math.min(...counts);
  const candidates: number[] = [];
  for (let i = 0; i < counts.length; i += 1) {
    if (counts[i] === minCount) candidates.push(i);
  }
  const rng = mulberry32(hashAgentSeed(agentId));
  const chosen = candidates[Math.floor(rng() * candidates.length)];
  const entry = catalog.characters[chosen];

  let hueShift = 0;
  if (minCount > 0) {
    // Reuse round `minCount` of this character: deterministic per-round shift,
    // kept inside [HUE_SHIFT_MIN_DEG, HUE_SHIFT_MAX_DEG - 1] so a wrap can
    // never produce 0 (the first-round user's shift) — the renderer applies
    // hue shifts as rotations modulo 360, so 0 and 360 are both identity.
    hueShift
      = HUE_SHIFT_MIN_DEG
        + ((minCount - 1) * HUE_SHIFT_STRIDE_DEG) % (HUE_SHIFT_MAX_DEG - HUE_SHIFT_MIN_DEG);
  }

  return { characterId: entry.id, palette: entry.palette, hueShift, updatedAt: now };
}

/**
 * Materialize defaults for every agent that has no assignment yet, returning
 * the complete map (existing entries preserved byte-for-byte). Pure: the
 * caller persists the returned defaults.
 */
export function ensureAgentAssignments(
  catalog: CharacterCatalog,
  assignments: AgentCharacterAssignmentMap,
  agentIds: string[],
  now: string,
): { map: AgentCharacterAssignmentMap; created: string[] } {
  const map: AgentCharacterAssignmentMap = { ...assignments };
  const created: string[] = [];
  for (const agentId of agentIds) {
    const existing = map[agentId];
    if (existing !== undefined && isAgentCharacterAssignment(existing)) continue;
    map[agentId] = selectDefaultAssignment(catalog, map, agentId, now);
    created.push(agentId);
  }
  return { map, created };
}

/**
 * Validate a caller-supplied assignment against the catalog (used by the
 * `agent.set-pixel-appearance` action). The palette index must match the
 * catalog entry's own palette — a character id plus a foreign palette index
 * would render a different sheet than the one the user picked.
 */
export function validateAssignmentInput(
  catalog: CharacterCatalog,
  input: { characterId: string; palette: number; hueShift: number },
): { ok: true; entry: CharacterCatalogEntry } | { ok: false; error: string } {
  const entry = findCatalogEntry(catalog, input.characterId);
  if (!entry) return { ok: false, error: "UNKNOWN_CHARACTER" };
  if (!Number.isInteger(input.palette) || input.palette !== entry.palette) {
    return { ok: false, error: "PALETTE_MISMATCH" };
  }
  if (
    !Number.isInteger(input.hueShift)
    || input.hueShift < 0
    || input.hueShift > HUE_SHIFT_MAX_DEG
  ) {
    return { ok: false, error: "INVALID_HUE_SHIFT" };
  }
  return { ok: true, entry };
}
