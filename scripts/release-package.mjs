#!/usr/bin/env node
// Release a single workspace. No credentials are placed in command arguments.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync, realpathSync, lstatSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [directory, ...args] = process.argv.slice(2);
const access = args[0] === '--private' ? 'restricted' : 'public';
if (['--public', '--private'].includes(args[0])) args.shift();
const [requested = 'patch', ...messageParts] = args;
const cwd = path.resolve(directory ?? '.');
const relative = path.relative(root, cwd);
if (!['common', 'plugins/paperclip', 'plugins/pixel-agents'].includes(relative)) {
  throw new Error('Expected one of the three publishable package directories');
}
const temp = mkdtempSync(path.join(os.tmpdir(), 'bridge-release-'));
const env = { ...process.env };
function run(command, args, location = cwd, capture = false) {
  return execFileSync(command, args, {
    cwd: location, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  })?.trim();
}
function json(file) { return JSON.parse(readFileSync(file, 'utf8')); }
try {
  const githubToken = path.join(cwd, '.token');
  if (existsSync(githubToken)) {
    env.BRIDGE_GITHUB_TOKEN = readFileSync(githubToken, 'utf8').trim();
    env.NPM_CONFIG_USERCONFIG = path.join(temp, 'npmrc');
    writeFileSync(
      env.NPM_CONFIG_USERCONFIG,
      '@decaf-ts:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=${BRIDGE_GITHUB_TOKEN}\n',
      { mode: 0o600 },
    );
  }
  if (existsSync(githubToken)) {
    env.BRIDGE_GIT_TOKEN = readFileSync(githubToken, 'utf8').trim();
    env.GIT_ASKPASS = path.join(temp, 'askpass');
    env.GIT_TERMINAL_PROMPT = '0';
    writeFileSync(env.GIT_ASKPASS, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$BRIDGE_GIT_TOKEN";; esac\n', { mode: 0o700 });
  }
  const branch = run('git', ['branch', '--show-current'], root, true);
  if (!['main', 'master'].includes(branch)) throw new Error('Release from main or master');
  if (run('git', ['diff', '--cached', '--name-only'], root, true)) throw new Error('Commit or unstage existing staged changes before release');
  run('npm', ['whoami', '--registry', 'https://npm.pkg.github.com'], cwd, true);

  // Install the published contract, not npm's local workspace symlink, before
  // starting any dependent package's build/test/version process.
  if (relative !== 'common') {
    const version = json(path.join(root, 'common/package.json')).version;
    run('npm', ['view', `@decaf-ts/paperclip-pixels-common@${version}`, 'version', '--registry', 'https://npm.pkg.github.com']);
    const installed = path.join(cwd, 'node_modules/@decaf-ts/paperclip-pixels-common');
    if (lstatSync(installed, { throwIfNoEntry: false })?.isSymbolicLink()) rmSync(installed);
    run('npm', ['install', '--workspaces=false', '--save-exact', `@decaf-ts/paperclip-pixels-common@${version}`, '--registry', 'https://npm.pkg.github.com']);
    if (realpathSync(installed) === realpathSync(path.join(root, 'common')) || json(path.join(installed, 'package.json')).version !== version) {
      throw new Error('Release requires the freshly published registry dependency, not a workspace link');
    }
    console.log(`Verified registry dependency @decaf-ts/paperclip-pixels-common@${version}`);
  }
  // Version before building so bundles contain the released manifest version.
  run('npm', ['version', requested, '--no-git-tag-version', '--workspaces=false']);
  const pkg = json(path.join(cwd, 'package.json'));
  const constants = path.join(cwd, 'src/constants.ts');
  if (existsSync(constants)) {
    const source = readFileSync(constants, 'utf8');
    if (!/export const PLUGIN_VERSION = "[^"]+";/.test(source)) throw new Error('Missing PLUGIN_VERSION');
    writeFileSync(constants, source.replace(/export const PLUGIN_VERSION = "[^"]+";/, `export const PLUGIN_VERSION = "${pkg.version}";`));
  }
  run('npm', ['install', '--package-lock-only', '--ignore-scripts'], root);
  run('npm', ['run', 'prepare-release', '--workspaces=false']);
  const artifacts = path.join(root, 'release-artifacts');
  run('mkdir', ['-p', artifacts]);
  const packed = JSON.parse(run('npm', ['pack', '--json', '--workspaces=false', '--pack-destination', artifacts], cwd, true))[0];
  const tarball = path.join(artifacts, packed.filename);
  const tag = `${pkg.name}@${pkg.version}`;
  const message = messageParts.join(' ') || `PAPERCLIP_PIXELS-2: release ${tag}`;
  // Explicit paths only. Never stage the whole repository or submodules.
  const files = [relative, 'package-lock.json', 'package.json', '.gitignore', '.dockerignore', 'scripts/release-package.mjs', 'scripts/release-package.test.mjs', 'bin/tag-release.sh'];
  run('git', ['add', '--', ...files], root);
  run('git', ['diff', '--cached', '--check'], root);
  run('git', ['commit', '-m', message], root);
  const distTag = pkg.version.includes('-') ? 'prerelease' : 'latest';
  run('npm', ['publish', tarball, '--access', access, '--tag', distTag, '--workspaces=false', '--registry', 'https://npm.pkg.github.com']);
  const integrity = run('npm', ['view', tag, 'dist.integrity', '--registry', 'https://npm.pkg.github.com'], cwd, true);
  if (integrity !== packed.integrity) throw new Error('Published tarball integrity mismatch');
  run('git', ['tag', '-a', tag, '-m', message], root);
  run('git', ['push', 'origin', `HEAD:refs/heads/${branch}`, `refs/tags/${tag}`], root);
  console.log(`Released and verified ${tag}`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
