#!/usr/bin/env node
// scripts/link-paperclip-sdk.mjs
//
// Links @paperclipai/plugin-sdk and @paperclipai/shared into node_modules,
// pointing at the pinned `paperclip/` submodule. Run automatically via the
// `postinstall` npm script.
//
// Why this can't just be a normal dependency: `paperclip/` is Paperclip's own
// internal monorepo, and `packages/plugins/sdk`'s own package.json depends on
// `@paperclipai/shared` via the pnpm/yarn-only `workspace:*` protocol, which
// plain npm cannot resolve (confirmed: `npm install` with a `file:` reference
// to that subdirectory fails with EUNSUPPORTEDPROTOCOL trying to resolve ITS
// internal workspace dependency). A plain symlink sidesteps that entirely —
// we only need the two packages' own source, not their internal dependency
// graph (their runtime deps are covered by our own devDependencies where we
// use them, e.g. `zod`).
import { mkdirSync, existsSync, symlinkSync, rmSync, lstatSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// A downstream consumer (`npm install @decaf-ts/paperclip-pixels`) never has
// the `paperclip/` submodule at all — that's the normal case, not a
// misconfiguration, so stay silent and exit 0. Only warn when `paperclip/`
// exists but a specific nested package is missing (a contributor forgot
// `git submodule update --init`).
if (!existsSync(path.join(root, "paperclip"))) {
  process.exit(0);
}

const nodeModules = path.join(root, "node_modules", "@paperclipai");
mkdirSync(nodeModules, { recursive: true });

const links = [
  ["plugin-sdk", path.join(root, "paperclip", "packages", "plugins", "sdk")],
  ["shared", path.join(root, "paperclip", "packages", "shared")],
];

for (const [name, target] of links) {
  const linkPath = path.join(nodeModules, name);
  if (!existsSync(target)) {
    console.warn(`[link-paperclip-sdk] skip ${name}: submodule target missing (${target}). Did you run 'git submodule update --init'?`);
    continue;
  }
  if (existsSync(linkPath) || lstatSync(linkPath, { throwIfNoEntry: false })) {
    rmSync(linkPath, { recursive: true, force: true });
  }
  symlinkSync(target, linkPath, "dir");
  console.log(`[link-paperclip-sdk] linked @paperclipai/${name} -> ${path.relative(root, target)}`);
}
