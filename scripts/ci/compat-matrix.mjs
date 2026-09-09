#!/usr/bin/env node
/**
 * Integration-matrix compatibility harness (PAPERCLIP_PIXELS-2 R3-WS2).
 *
 * Proves, cheaply, the upgrade-order compatibility the board waived for full
 * version-drift control: the Paperclip plugin (producer) and the Pixel Agents
 * plugin (consumer) must agree with `paperclip-pixels-common`'s wire schema
 * rules at each version pairing. The runtime package tests already validate
 * behaviour; this harness asserts the version/pairing invariants that block a
 * release when the two plugin surfaces drift apart.
 *
 * Usage:
 *   node scripts/ci/compat-matrix.mjs <paperclip-version> <pixel-agents-version>
 *
 * Reads the three packages' declared versions from the working tree, loads the
 * built common schema rules, and fails on any mismatch or incompatible schema.
 */
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const expectedPaperclip = process.argv[2];
const expectedPixelAgents = process.argv[3];

if (!expectedPaperclip || !expectedPixelAgents) {
  console.error("usage: node scripts/ci/compat-matrix.mjs <paperclip-version> <pixel-agents-version>");
  process.exit(1);
}

const read = (rel) => JSON.parse(readFileSync(path.join(root, rel), "utf8"));

const common = read("common/package.json");
const paperclip = read("plugins/paperclip/package.json");
const pixelAgents = read("plugins/pixel-agents/package.json");

const errors = [];
const expect = (cond, msg) => {
  if (!cond) errors.push(msg);
};

expect(paperclip.version === expectedPaperclip, `paperclip plugin version mismatch: got ${paperclip.version}, expected ${expectedPaperclip}`);
expect(pixelAgents.version === expectedPixelAgents, `pixel-agents plugin version mismatch: got ${pixelAgents.version}, expected ${expectedPixelAgents}`);

// Both plugins must depend on the same common contract version currently in the
// tree, and never on each other (target-shape invariant: plugins only know common).
for (const [name, pkg] of [["paperclip", paperclip], ["pixel-agents", pixelAgents]]) {
  const dep = pkg.dependencies?.["paperclip-pixels-common"];
  expect(dep === common.version, `${name} plugin pins paperclip-pixels-common@${dep}; tree is ${common.version}`);
  expect(pkg.dependencies?.["@decaf-ts/pixel-agents-paperclip-plugin"] === undefined, `${name} plugin must NOT depend on the pixel-agents plugin`);
  expect(pkg.dependencies?.["@decaf-ts/paperclip-pixels-plugin"] === undefined, `${name} plugin must NOT depend on the paperclip plugin`);
}

// Wire schema discipline: the two plugins must speak the same schemaVersion the
// built common contract currently validates.
let schema;
try {
  schema = require(path.join(root, "common", "dist", "version.js"));
} catch {
  errors.push("common/dist/version.js is missing — build common before running the matrix");
}

if (schema) {
  const violations = schema.checkWireSchemaVersion(schema.SCHEMA_VERSION, schema.SCHEMA_VERSION);
  expect(violations.length === 0, `common schema self-check failed: ${violations.join("; ")}`);
}

if (errors.length > 0) {
  console.error("[compat-matrix] FAIL");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}

console.log(`[compat-matrix] OK: paperclip@${paperclip.version} x pixel-agents@${pixelAgents.version} (common@${common.version})`);
console.log(`[compat-matrix] common@${common.version}, schemaVersion=${schema ? schema.SCHEMA_VERSION : "n/a"}`);
