import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';

function fixture(t, target, failure = '') {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bridge-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(path.join(root, 'scripts'));
  mkdirSync(path.join(root, 'bin'));
  writeFileSync(path.join(root, 'package-lock.json'), JSON.stringify({ packages: {} }));
  copyFileSync(new URL('./release-package.mjs', import.meta.url), path.join(root, 'scripts/release-package.mjs'));
  for (const dir of ['common', 'plugins/paperclip']) {
    mkdirSync(path.join(root, dir, 'src'), { recursive: true });
    writeFileSync(path.join(root, dir, 'package.json'), JSON.stringify({ name: dir === 'common' ? 'paperclip-pixels-common' : '@decaf-ts/paperclip-pixels-plugin', version: '0.1.1' }));
  }
  if (target !== 'common') {
    mkdirSync(path.join(root, target, 'node_modules'));
    mkdirSync(path.join(root, target, 'node_modules/@decaf-ts'), { recursive: true });
    symlinkSync(path.join(root, 'common'), path.join(root, target, 'node_modules/paperclip-pixels-common'), 'dir');
  }
  writeFileSync(path.join(root, target, 'src/constants.ts'), 'export const PLUGIN_VERSION = "0.1.1";\n');
  const stub = `#!/usr/bin/env node
const fs = require('fs'), path = require('path');
const args = process.argv.slice(2), command = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CALLS, JSON.stringify({command,args,cwd:process.cwd()})+'\\n');
if(command==='git') { if(args[0]==='branch') console.log('master'); process.exit(0); }
if(args[0]==='ping' && process.env.FAILURE==='auth') process.exit(1);
if(args[0]==='run' && process.env.FAILURE==='tests') process.exit(1);
if(args[0]==='version') { const p=JSON.parse(fs.readFileSync('package.json')); p.version='0.1.2'; fs.writeFileSync('package.json', JSON.stringify(p)); }
if(args[0]==='install' && args.includes('--save-exact')) { fs.mkdirSync('node_modules/paperclip-pixels-common', {recursive:true}); fs.writeFileSync('node_modules/paperclip-pixels-common/package.json', JSON.stringify({version:'0.1.1'})); }
if(args[0]==='pack') console.log(JSON.stringify([{filename:'test.tgz',integrity:'sha512-test'}]));
if(args[0]==='view') console.log(args.includes('dist.integrity') ? 'sha512-test' : '0.1.1');
`;
  for (const tool of ['npm', 'git']) writeFileSync(path.join(root, 'bin', tool), stub, { mode: 0o700 });
  const calls = path.join(root, 'calls');
  const result = spawnSync(process.execPath, [path.join(root, 'scripts/release-package.mjs'), path.join(root, target), 'patch'], {
    env: { ...process.env, PATH: `${root}/bin:${process.env.PATH}`, CALLS: calls, FAILURE: failure }, encoding: 'utf8',
  });
  return { result, root, calls: readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse) };
}

test('authentication failure stops before version changes or publication', t => {
  const { result, calls } = fixture(t, 'common', 'auth');
  assert.notEqual(result.status, 0);
  assert.equal(calls.some(c => ['version', 'publish', 'commit', 'push'].includes(c.args[0])), false);
});
test('test failure prevents commits and publication', t => {
  const { result, calls } = fixture(t, 'common', 'tests');
  assert.notEqual(result.status, 0);
  assert.equal(calls.some(c => ['publish', 'commit', 'push'].includes(c.args[0])), false);
});
test('common release tests before publish and verifies before pushing its own tag', t => {
  const { result, calls, root } = fixture(t, 'common');
  assert.equal(result.status, 0, result.stderr);
  const index = name => calls.findIndex(c => c.args[0] === name);
  assert.ok(index('run') < index('publish'));
  assert.ok(index('publish') < index('view'));
  assert.ok(index('view') < index('push'));
  assert.ok(calls.find(c => c.args[0] === 'tag').args.includes('paperclip-pixels-common@0.1.2'));
});
test('dependent release installs registry contract before versioning and tests', t => {
  const { result, calls } = fixture(t, 'plugins/paperclip');
  assert.equal(result.status, 0, result.stderr);
  const install = calls.findIndex(c => c.args[0] === 'install' && c.args.includes('--save-exact'));
  assert.ok(install >= 0);
  assert.ok(calls[install].args.includes('paperclip-pixels-common@0.1.1'));
  assert.ok(calls[install].args.includes('--workspaces=false'));
  assert.ok(install < calls.findIndex(c => c.args[0] === 'version'));
});
