/**
 * Character catalog loading + validation (spec PAPERCLIP_PIXELS-2, WS3).
 *
 * The runtime half common cannot hold: `parseCharacterCatalog` (the pure,
 * fail-closed catalog validator) and `resolveCharacterCatalogDir` (the
 * filesystem lookup used by the WS4-A appearance adoption). The shared
 * serializable shapes (`CharacterCatalog`, `CharacterCatalogEntry`) come
 * from `@decaf-ts/paperclip-pixels-common`.
 */

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CharacterCatalog, CharacterCatalogEntry } from "@decaf-ts/paperclip-pixels-common";

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

/**
 * Resolve the character catalog directory. Candidate order:
 *   1. `PIXEL_CHARACTER_CATALOG` (a catalog.json path — the same override the
 *      relay CLI accepts) so operators can substitute a catalog in odd
 *      installs (e.g. a deployment that keeps the catalog elsewhere);
 *   2. the nearest ancestor (from this module's location, walking up to the
 *      repo root) that ships an `assets/characters/catalog.json`. The catalog
 *      is committed beside the plugin package (this package's own assets, or
 *      the outer plugin's when consumed in-repo), so the lookup is a pure
 *      filesystem probe — it never imports another package's source.
 *
 * The embedding surface calls this best-effort: a missing/malformed catalog
 * degrades to built-in palette rendering rather than aborting the bridge.
 */
export function resolveCharacterCatalogDir(): string {
  const override = process.env.PIXEL_CHARACTER_CATALOG;
  if (override && override.trim().length > 0) {
    return path.dirname(path.resolve(override.trim()));
  }
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.resolve(dir, "assets", "characters");
    if (existsSync(path.join(candidate, "catalog.json"))) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Conventional fallback beside this module (matches the pre-extraction
  // `resolveCharacterCatalogDir` single-`..` lookup).
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets", "characters");
}

/** Load the raw catalog.json from a resolved catalog directory (no caching). */
export function readCharacterCatalog(dir: string): CharacterCatalog {
  const catalogPath = path.join(dir, "catalog.json");
  return parseCharacterCatalog(JSON.parse(readFileSync(catalogPath, "utf8")));
}
