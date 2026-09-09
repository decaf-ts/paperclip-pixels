/**
 * Worker-side character catalog service (spec PAPERCLIP_PIXELS-2, WS3).
 *
 * Loads and validates the committed character catalog
 * (`assets/characters/catalog.json` plus its `char_<N>.png` sheets) and
 * serves UI-ready entries (base64 preview data URLs for the picker). The
 * catalog file is static package data — read once, cached for the worker's
 * lifetime, and validated fail-closed by the core domain's
 * {@link parseCharacterCatalog}.
 *
 * This module is worker-side only (it touches the filesystem); the pure
 * catalog/assignment contracts live in `core/domain/characters.ts`.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseCharacterCatalog,
  type CharacterCatalog,
  type CharacterCatalogEntry,
} from "./core/index.js";
import {
  validateCompositionCatalog,
  type CompositionPartCatalog,
  type CompositionPartSpec,
} from "paperclip-pixels-common";

/** Catalog entry enriched with a preview image for the UI picker. */
export interface CharacterCatalogViewEntry extends CharacterCatalogEntry {
  previewDataUrl: string;
}

/** Loaded, validated catalog plus its UI-ready entries. */
export interface LoadedCharacterCatalog {
  catalog: CharacterCatalog;
  entries: CharacterCatalogViewEntry[];
}

let cached: LoadedCharacterCatalog | null = null;

/**
 * Resolve the character catalog directory. Candidate order:
 *   1. `PIXEL_CHARACTER_CATALOG` (a catalog.json path — same override the
 *      relay CLI accepts) so operators can substitute a catalog in odd
 *      installs;
 *   2. `<package root>/assets/characters` derived from this module's location
 *      (works both from `dist/worker.js` at runtime and `src/characters.ts`
 *      under ts-node/vitest);
 */
export function resolveCharacterCatalogDir(): string {
  const override = process.env.PIXEL_CHARACTER_CATALOG;
  if (override && override.trim().length > 0) {
    return path.dirname(path.resolve(override.trim()));
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  const fromModule = path.resolve(here, "..", "assets", "characters");
  return fromModule;
}

/**
 * Load and validate the character catalog (cached after the first successful
 * load). Throws on a malformed catalog — callers fail closed (the
 * visual-settings handler surfaces the error; the appearance action rejects
 * writes) rather than serving an unvalidated catalog to the UI.
 */
export function loadCharacterCatalog(): LoadedCharacterCatalog {
  if (cached) return cached;
  const dir = resolveCharacterCatalogDir();
  const catalogPath = path.join(dir, "catalog.json");
  const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  const catalog = parseCharacterCatalog(raw);
  const entries: CharacterCatalogViewEntry[] = catalog.characters.map((entry) => ({
    ...entry,
    previewDataUrl: `data:image/png;base64,${readFileSync(path.join(dir, entry.file)).toString("base64")}`,
  }));
  cached = { catalog, entries };
  return cached;
}

// --- R3-WS5b: composition part catalog --------------------------------------

/** A composition part enriched with a preview image URL for the composer. */
export interface CompositionCatalogViewPart extends CompositionPartSpec {
  previewDataUrl: string;
}

/** Loaded, validated composition part catalog plus its UI-ready parts. */
export interface LoadedCompositionCatalog {
  catalog: CompositionPartCatalog;
  parts: CompositionCatalogViewPart[];
}

let compositionCache: LoadedCompositionCatalog | null = null;

/**
 * Resolve the composition part catalog directory. Candidates:
 *   1. `PIXEL_COMPOSITION_CATALOG` (a catalog.json path) so operators can
 *      substitute a composition catalog;
 *   2. `<package root>/assets/composition` derived from this module's location
 *      (works from `dist/worker.js` and `src/characters.ts`).
 */
export function resolveCompositionCatalogDir(): string {
  const override = process.env.PIXEL_COMPOSITION_CATALOG;
  if (override && override.trim().length > 0) {
    return path.dirname(path.resolve(override.trim()));
  }
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "assets", "composition");
}

/**
 * Load and validate the composition part catalog (cached after the first
 * successful load). Throws on a malformed catalog so callers fail closed
 * (the visual-settings handler surfaces the error) rather than serving an
 * unvalidated catalog to the composer. Each part gets a base64 preview data
 * URL from its `file` (the same technique the whole-sheet picker uses).
 */
export function loadCompositionPartCatalog(): LoadedCompositionCatalog {
  if (compositionCache) return compositionCache;
  const dir = resolveCompositionCatalogDir();
  const catalogPath = path.join(dir, "catalog.json");
  const raw = JSON.parse(readFileSync(catalogPath, "utf8"));
  const violations = validateCompositionCatalog(raw);
  if (violations.length > 0) {
    throw new Error(`Invalid composition part catalog: ${violations.map((v) => v.code).join(", ")}`);
  }
  const catalog = raw as CompositionPartCatalog;
  const parts: CompositionCatalogViewPart[] = catalog.parts.map((part) => {
    const file = path.join(dir, part.file);
    return {
      ...part,
      previewDataUrl: `data:image/svg+xml;base64,${readFileSync(file).toString("base64")}`,
    };
  });
  compositionCache = { catalog, parts };
  return compositionCache;
}
