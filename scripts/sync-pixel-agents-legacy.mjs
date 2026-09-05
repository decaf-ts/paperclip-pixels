#!/usr/bin/env node
// Sync the local pixel-agents fork branch named `legacy` to the remote
// branch tracked by the `legacy` remote, keeping the repo on the new fork
// origin while preserving the upstream remote as a pristine reference.

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repo = path.join(root, "pixel-agents");

if (!existsSync(repo)) {
  console.error(`[sync-pixel-agents-legacy] missing submodule: ${path.relative(root, repo)}`);
  process.exit(1);
}

const git = (args, options = {}) =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  }).trim();

const run = (args) =>
  execFileSync("git", ["-C", repo, ...args], {
    stdio: "inherit",
  });

const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
if (status) {
  console.error("[sync-pixel-agents-legacy] aborting: pixel-agents has local changes");
  console.error(status);
  process.exit(1);
}

try {
  run(["fetch", "legacy", "--prune"]);
} catch (error) {
  console.error("[sync-pixel-agents-legacy] fetch failed for remote `legacy`");
  process.exit(error?.status ?? 1);
}

const candidates = [];
try {
  const head = git(["symbolic-ref", "--quiet", "--short", "refs/remotes/legacy/HEAD"]);
  if (head) {
    candidates.push(head);
  }
} catch {
  // Fall through to the explicit branch probes below.
}

for (const ref of ["legacy/main", "legacy/master"]) {
  if (!candidates.includes(ref)) {
    candidates.push(ref);
  }
}

let target = null;
for (const ref of candidates) {
  try {
    git(["show-ref", "--verify", "--quiet", `refs/remotes/${ref}`]);
    target = ref;
    break;
  } catch {
    // Try the next candidate.
  }
}

if (!target) {
  console.error("[sync-pixel-agents-legacy] could not find legacy/main or legacy/master after fetch");
  process.exit(1);
}

let currentBranch = null;
try {
  currentBranch = git(["symbolic-ref", "--quiet", "--short", "HEAD"]);
} catch {
  currentBranch = null;
}

run(["checkout", "-B", "legacy", target]);
run(["branch", "--set-upstream-to", target, "legacy"]);

if (currentBranch && currentBranch !== "legacy") {
  run(["checkout", currentBranch]);
}

console.log(`[sync-pixel-agents-legacy] synced branch legacy to ${target}`);
