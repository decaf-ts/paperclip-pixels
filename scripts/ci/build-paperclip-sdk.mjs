#!/usr/bin/env node
/**
 * CI helper: build the pinned `paperclip/` submodule's plugin SDK so the
 * Paperclip plugin package can resolve `@paperclipai/plugin-sdk` /
 * `@paperclipai/shared` from a clean clone straddling the reference submodule
 * (its `dist/` is git-ignored, so a fresh `git submodule update` yields only
 * source).
 *
 * The submodule is a pnpm workspace. Use `corepack pnpm` when `pnpm` is not on
 * PATH (CI runners ship corepack). The SDK's own build compiles `@paperclipai/shared`
 * first, so building `packages/plugins/sdk` is sufficient.
 *
 * Usage:
 *   node scripts/ci/build-paperclip-sdk.mjs
 */
import { existsSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const sub = path.join(root, "paperclip");
const sdkDir = path.join(sub, "packages", "plugins", "sdk");
const marker = path.join(sdkDir, "dist", "index.js");

if (!existsSync(path.join(sub, "package.json"))) {
  console.error("[build-paperclip-sdk] paperclip/ submodule missing — run 'git submodule update --init --recursive' first.");
  process.exit(1);
}
if (existsSync(marker)) {
  console.log("[build-paperclip-sdk] SDK dist already present — skipping build.");
  process.exit(0);
}

function pnpm(cmdArgs, cwd) {
  const direct = spawnSync("pnpm", cmdArgs, { stdio: "inherit", cwd });
  if (direct.status === 0) return;
  // fall back to corepack-provided pnpm
  const viaCorepack = spawnSync("corepack", ["pnpm", ...cmdArgs], { stdio: "inherit", cwd });
  if (viaCorepack.status !== 0) process.exit(viaCorepack.status ?? 1);
}

console.log("[build-paperclip-sdk] installing paperclip submodule workspace deps (pnpm).");
pnpm(["install"], sub);
console.log("[build-paperclip-sdk] building @paperclipai/plugin-sdk (+ shared).");
pnpm(["run", "build"], sdkDir);

if (!existsSync(marker)) {
  console.error(`[build-paperclip-sdk] SDK build finished but ${marker} is missing.`);
  process.exit(1);
}
console.log("[build-paperclip-sdk] SDK built.");
