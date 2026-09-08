#!/usr/bin/env node
/**
 * CI bootstrap helper: install and wire a package so its own pipeline
 * (typecheck / lint / build / test / pack) can run from a clean clone.
 *
 * `paperclip-pixels-common` is intentionally not yet published (the board
 * provides npm/registry auth keys only after this CI work lands), so the
 * plugin packages must resolve it locally during install. This script builds
 * `common` and symlinks it into the target package's node_modules, matching
 * the local resolution the dev workspace already uses. It also points the
 * `@paperclipai/plugin-sdk` / `@paperclipai/shared` imports (used by the
 * Paperclip plugin) at the pinned `paperclip/` submodule, mirroring the root
 * `scripts/link-paperclip-sdk.mjs` linker for a nested package.
 *
 * Usage:
 *   node scripts/ci/prepare-package.mjs <package-dir>
 *
 * <package-dir> is one of: common, plugins/paperclip, plugins/pixel-agents.
 * In a clean clone run this after `git submodule update --init --recursive` and
 * after the paperclip SDK dist is available (see build-paperclip-sdk).
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = process.argv[2];
if (!target) {
  console.error(
    "usage: node scripts/ci/prepare-package.mjs <common|plugins/paperclip|plugins/pixel-agents>",
  );
  process.exit(1);
}

const pkgDir = path.join(root, target);
const pkg = JSON.parse(readFileSync(path.join(pkgDir, "package.json"), "utf8"));
const commonDir = path.join(root, "common");
const commonBuilt = existsSync(path.join(commonDir, "dist", "index.js"));

function run(cmd, args, cwd) {
  console.log(`[prepare-package] ${cmd} ${args.join(" ")} (cwd: ${path.relative(root, cwd)})`);
  execFileSync(cmd, args, { cwd, stdio: "inherit" });
}

function isLink(p) {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function ensureRemoved(p) {
  if (existsSync(p) || isLink(p)) rmSync(p, { recursive: true, force: true });
}

function linkIfNeeded(link, targetPath) {
  if (existsSync(link) && !isLink(link)) return;
  ensureRemoved(link);
  mkdirSync(path.dirname(link), { recursive: true });
  symlinkSync(targetPath, link, "dir");
  console.log(`[prepare-package] linked ${path.relative(root, link)} -> ${path.relative(root, targetPath)}`);
}

function buildCommon() {
  if (!existsSync(path.join(commonDir, "node_modules"))) {
    run("npm", ["ci"], commonDir);
  }
  run("npm", ["run", "build"], commonDir);
}

if (target === "common") {
  if (!existsSync(path.join(commonDir, "node_modules"))) {
    run("npm", ["ci"], commonDir);
  }
  run("npm", ["run", "build"], commonDir);
  process.exit(0);
}

// -- a plugin package -----------------------------------------------------
const dependsOnCommon = Boolean(pkg.dependencies?.["paperclip-pixels-common"]);
const needsSdk = Boolean(pkg.dependencies?.["@paperclipai/plugin-sdk"]);

if (dependsOnCommon) {
  if (!commonBuilt) buildCommon();
  linkIfNeeded(
    path.join(pkgDir, "node_modules", "paperclip-pixels-common"),
    path.join(root, "common"),
  );
}

if (needsSdk && existsSync(path.join(root, "paperclip"))) {
  const sdkDist = path.join(root, "paperclip", "packages", "plugins", "sdk", "dist", "index.js");
  if (!existsSync(sdkDist)) {
    console.error(
      `[prepare-package] @paperclipai/plugin-sdk dist is missing (${sdkDist}). ` +
        "Run the paperclip SDK build before this package pipeline (see build-paperclip-sdk).",
    );
    process.exit(1);
  }
  linkIfNeeded(
    path.join(pkgDir, "node_modules", "@paperclipai", "plugin-sdk"),
    path.join(root, "paperclip", "packages", "plugins", "sdk"),
  );
  linkIfNeeded(
    path.join(pkgDir, "node_modules", "@paperclipai", "shared"),
    path.join(root, "paperclip", "packages", "shared"),
  );
}
