/**
 * Unit tests for the worker-side character catalog loader
 * (`src/characters.ts`, spec PAPERCLIP_PIXELS-2 FR-13 / WS3): the package
 * catalog resolves and loads (cached), UI entries carry preview data URLs,
 * `PIXEL_CHARACTER_CATALOG` is honored, and malformed catalogs throw
 * (fail-closed, cached stays unset).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const OVERRIDE_ENV = "PIXEL_CHARACTER_CATALOG";
const CATALOG_DIR = path.resolve(import.meta.dirname, "..", "assets", "characters");

describe("resolveCharacterCatalogDir", () => {
  it("resolves the package assets directory by default", async () => {
    const saved = process.env[OVERRIDE_ENV];
    delete process.env[OVERRIDE_ENV];
    try {
      const { resolveCharacterCatalogDir } = await import("../src/characters.js");
      const dir = resolveCharacterCatalogDir();
      expect(dir.endsWith(path.join("assets", "characters"))).toBe(true);
      expect(existsSync(path.join(dir, "catalog.json"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[OVERRIDE_ENV];
      else process.env[OVERRIDE_ENV] = saved;
    }
  });

  it("honors PIXEL_CHARACTER_CATALOG (dir of the configured catalog.json)", async () => {
    const saved = process.env[OVERRIDE_ENV];
    const fixture = mkdtempSync(path.join(os.tmpdir(), "pixel-catalog-"));
    mkdirSync(path.join(fixture, "sub"), { recursive: true });
    writeFileSync(path.join(fixture, "catalog.json"), JSON.stringify({ schemaVersion: 1, characters: [] }), "utf8");
    writeFileSync(path.join(fixture, "sub", "catalog.json"), JSON.stringify({ schemaVersion: 1, characters: [] }), "utf8");
    process.env[OVERRIDE_ENV] = path.join(fixture, "sub", "catalog.json");
    try {
      vi.resetModules();
      const { resolveCharacterCatalogDir } = await import("../src/characters.js");
      const dir = resolveCharacterCatalogDir();
      expect(dir.endsWith(path.join("sub"))).toBe(true);
      expect(existsSync(path.join(dir, "catalog.json"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env[OVERRIDE_ENV];
      else process.env[OVERRIDE_ENV] = saved;
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

describe("loadCharacterCatalog (real package catalog)", () => {
  const savedOverride = process.env[OVERRIDE_ENV];
  delete process.env[OVERRIDE_ENV];

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the committed catalog with UI preview entries", async () => {
    vi.resetModules();
    const { loadCharacterCatalog } = await import("../src/characters.js");
    const loaded = loadCharacterCatalog();
    expect(loaded.catalog.schemaVersion).toBe(1);
    expect(loaded.catalog.characters).toHaveLength(24);
    for (const entry of loaded.entries) {
      expect(entry.previewDataUrl.startsWith("data:image/png;base64,")).toBe(true);
      // base64 length of the file bytes (no newlines): ceil(bytes / 3) * 4.
      const bytes = statSync(path.join(CATALOG_DIR, entry.file)).size;
      expect(entry.previewDataUrl.length).toBeGreaterThanOrEqual(Math.ceil((bytes / 3) * 4) - 4);
      expect(entry.file).toBe(`char_${entry.palette}.png`);
    }
    expect(loaded.entries[0].id).toBe("pixel-agents:char-0");
    expect(loaded.entries[23].id).toBe("paperclip-pixels:char-23");
  });

  it("caches the loaded catalog for the worker's lifetime", async () => {
    vi.resetModules();
    const { loadCharacterCatalog } = await import("../src/characters.js");
    expect(loadCharacterCatalog()).toBe(loadCharacterCatalog());
  });

  it("throws on a malformed catalog (fail-closed, not a silent empty catalog)", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "pixel-catalog-bad-"));
    writeFileSync(
      path.join(fixture, "catalog.json"),
      JSON.stringify({
        schemaVersion: 2,
        characters: [{ id: "x", name: "X", palette: 0, file: "char_0.png", source: "s", license: "l" }],
      }),
      "utf8",
    );
    writeFileSync(path.join(fixture, "char_0.png"), "png");
    process.env[OVERRIDE_ENV] = path.join(fixture, "catalog.json");
    try {
      vi.resetModules();
      const { loadCharacterCatalog } = await import("../src/characters.js");
      expect(() => loadCharacterCatalog()).toThrow(/unsupported character catalog schemaVersion/);
      // A duplicate palette index is equally rejected.
      writeFileSync(
        path.join(fixture, "catalog.json"),
        JSON.stringify({
          schemaVersion: 1,
          characters: [
            { id: "a", name: "A", palette: 2, file: "char_2.png", source: "s", license: "l" },
            { id: "b", name: "B", palette: 2, file: "char_2.png", source: "s", license: "l" },
          ],
        }),
        "utf8",
      );
      vi.resetModules();
      const { loadCharacterCatalog: reload } = await import("../src/characters.js");
      expect(() => reload()).toThrow(/duplicate character palette index/);
    } finally {
      if (savedOverride === undefined) delete process.env[OVERRIDE_ENV];
      else process.env[OVERRIDE_ENV] = savedOverride;
      rmSync(fixture, { recursive: true, force: true });
    }
  });

  it("accepts an operator-catalog override end-to-end (PIXEL_CHARACTER_CATALOG)", async () => {
    const fixture = mkdtempSync(path.join(os.tmpdir(), "pixel-catalog-override-"));
    const charDir = path.join(fixture, "assets", "characters");
    mkdirSync(charDir, { recursive: true });
    const raw = readFileSync(path.join(CATALOG_DIR, "char_0.png"));
    writeFileSync(
      path.join(charDir, "catalog.json"),
      JSON.stringify({
        schemaVersion: 1,
        characters: [{ id: "custom:char-7", name: "Custom", palette: 7, file: "char_7.png", source: "custom", license: "custom" }],
      }),
      "utf8",
    );
    writeFileSync(path.join(charDir, "char_7.png"), raw);
    process.env[OVERRIDE_ENV] = path.join(charDir, "catalog.json");
    try {
      vi.resetModules();
      const { loadCharacterCatalog } = await import("../src/characters.js");
      const loaded = loadCharacterCatalog();
      expect(loaded.catalog.characters).toHaveLength(1);
      expect(loaded.entries[0].previewDataUrl.startsWith("data:image/png;base64,")).toBe(true);
    } finally {
      if (savedOverride === undefined) delete process.env[OVERRIDE_ENV];
      else process.env[OVERRIDE_ENV] = savedOverride;
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
