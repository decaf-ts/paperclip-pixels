/**
 * Embedding-side appearance adoption (spec PAPERCLIP_PIXELS-2, WS4-C).
 *
 * Adopts the WS4-A first-class appearance API: the plugin declares its WS3
 * character catalog (the committed `assets/characters` sheets, CC0) through
 * `ctx.appearance.declareCharacterCatalog` and translates per-agent
 * character assignments (the WS3 frozen `characterId` contract) into
 * `ctx.appearance.assignAgentAppearance` integer indices. Pixel Agents then
 * renders each agent exactly as the plugin defined it — sheet sprites with
 * the agent's hueShift applied on top (the webview's sprite store honors
 * the seat hueShift for plugin sheets) — with the built-in palette path as
 * the automatic fallback whenever a declaration or assignment is refused.
 *
 * The interim WS3 asset-sharing arrangement (the operator grants the
 * catalog directory through `addExternalAssetDirectory` and the fork's
 * external loader merges the sheets into its bundled palette array, with
 * the plugin's palette indices pointing into that merged array) is RETIRED
 * as the rendering path: rendering no longer depends on merged-array
 * indices. The operator grant itself is KEPT — WS4-A re-uses exactly those
 * grants as the `PluginAppearanceAssetGate` privilege boundary for
 * `declareCharacterCatalog` (the host never reads a sheet outside a granted
 * directory), so the grant changes role from content channel to
 * authorization boundary. The catalog's `palette` field stays as the
 * sanctioned seat/fallback index (frozen WS3 contract).
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import {
  parseCharacterCatalog,
  type CharacterCatalogEntry,
} from "../core/index.js";
import { resolveCharacterCatalogDir } from "../characters.js";
import type {
  PluginAppearanceSource,
  PluginCharacterSheetDeclaration,
} from "./types.js";

/** The plugin's character sheets in declaration order, plus the
 * characterId → positional-index resolution used for assignments. */
export interface PluginCharacterSheets {
  /** Ordered catalog declaration for `declareCharacterCatalog`. */
  sheets: PluginCharacterSheetDeclaration[];
  /** Positional index of one WS3 character id, or null when unknown. */
  indexOfCharacter(characterId: string): number | null;
}

/** The fork host's sheet-id pattern (appearanceSource.ts
 * SHEET_ID_PATTERN): short stable identifier, no spaces or colons. The WS3
 * catalog ids (`pixel-agents:char-0`) contain colons, so declared ids are
 * sanitized (`pixel-agents-char-0`) — cosmetic only, since sheet indices
 * are positional and assignment resolution uses the catalog array order. */
const SHEET_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

function declaredSheetId(catalogId: string): string {
  const sanitized = catalogId.replace(/[^a-zA-Z0-9._-]/g, "-");
  return SHEET_ID_PATTERN.test(sanitized) ? sanitized : `sheet-${sanitized.replace(/[^a-zA-Z0-9._-]/g, "")}`;
}

/**
 * Load the plugin's WS3 character catalog as WS4-A sheet declarations:
 * absolute file paths (the privilege gate requires absolute paths inside
 * an operator-granted directory), ordered by the catalog's own array
 * order, ids carried from the catalog entries. Throws when the catalog is
 * missing or malformed — callers decide their own fail-open/fail-closed
 * posture (the embedding surface degrades to palette rendering).
 */
export function loadPluginCharacterSheets(): PluginCharacterSheets {
  const dir = resolveCharacterCatalogDir();
  const raw = JSON.parse(readFileSync(path.join(dir, "catalog.json"), "utf8"));
  const catalog = parseCharacterCatalog(raw);
  const entries: CharacterCatalogEntry[] = catalog.characters;
  const indexOf = new Map<string, number>();
  entries.forEach((entry, index) => indexOf.set(entry.id, index));
  return {
    sheets: entries.map((entry) => ({
      id: declaredSheetId(entry.id),
      file: path.join(dir, entry.file),
    })),
    indexOfCharacter: (characterId: string): number | null =>
      indexOf.get(characterId) ?? null,
  };
}

/** Structured-log helper signature the embedding surface uses
 * (ids/counts only, per the host's log rule). */
export type AppearanceLog = (event: string, fields?: Record<string, unknown>) => void;

/**
 * Build the feed-side appearance applier: translates the feed's
 * `assignAgentAppearance { key, characterId }` operations (characterId =
 * the WS3 frozen contract id) into host `assignAgentAppearance(key,
 * sheetIndex)` calls. Fail-closed per call: an unresolvable characterId is
 * logged and skipped (the agent keeps its current appearance) — one bad
 * assignment never breaks the rest of the batch.
 */
export function createFeedAppearanceApplier(options: {
  /** Becomes the host source once the plugin's onStart captured it. */
  getSource(): PluginAppearanceSource | undefined;
  /** The loaded sheets; undefined when the catalog failed to load. */
  getSheets(): PluginCharacterSheets | undefined;
  log?: AppearanceLog;
}): { assign(key: string, characterId: string | null): void } {
  return {
    assign(key: string, characterId: string | null): void {
      const source = options.getSource();
      if (!source) throw new Error("pluginNotStarted");
      if (characterId === null) {
        source.assignAgentAppearance(key, null);
        return;
      }
      const sheets = options.getSheets();
      const index = sheets?.indexOfCharacter(characterId) ?? null;
      if (index === null) {
        // Version skew or an unknown id: skip rather than crash the feed.
        options.log?.("paperclip_appearance_unresolved_character", { key });
        return;
      }
      source.assignAgentAppearance(key, index);
    },
  };
}
