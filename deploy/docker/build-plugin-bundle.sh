#!/usr/bin/env bash
# Assembles a self-contained copy of the Paperclip-Pixel bridge plugin at the
# target directory, with its runtime dependencies vendored as real files.
#
# Usage: build-plugin-bundle.sh <target-dir>
#
# Layout produced:
#   <target>/
#     package.json            (from packages/paperclip-plugin)
#     dist/                   (compiled worker.js, manifest.js, ...)
#     node_modules/
#       @paperclip-pixel/core/    (real copy of packages/core + dist)
#       @paperclipai/plugin-sdk/ (real copy of paperclip/.../sdk + dist)
#       @paperclipai/shared/     (real copy of paperclip/.../shared + dist,
#                                 with package.json exports rewritten to the
#                                 built dist JS so plain Node can load it --
#                                 upstream exports point at TS source which
#                                 only the tsx loader can run)
#       zod/                      (zod v4, installed from npm)
set -euo pipefail

TARGET="${1:?target dir required}"
SRC_PLUGIN="${SRC_PLUGIN:-/tmp/src/paperclip-plugin}"
SRC_CORE="${SRC_CORE:-/tmp/src/core}"
SRC_SDK="${SRC_SDK:-/tmp/src/plugin-sdk}"
SRC_SHARED="${SRC_SHARED:-/tmp/src/shared}"

echo "[build-plugin-bundle] assembling plugin at ${TARGET}"
mkdir -p "${TARGET}/node_modules/@paperclip-pixel" \
         "${TARGET}/node_modules/@paperclipai"

# Plugin package + built dist.
cp -R "${SRC_PLUGIN}/package.json" "${TARGET}/package.json"
cp -R "${SRC_PLUGIN}/dist" "${TARGET}/dist"

# core (CJS, already built -- main -> dist/index.js). Its package.json exports
# only define a `require` condition, so an ESM worker (`import { ... }`) cannot
# resolve it. Add an `import` condition pointing at the same CJS dist; Node's
# cjs-module-lexer then exposes the named exports to ESM consumers.
cp -R "${SRC_CORE}" "${TARGET}/node_modules/@paperclip-pixel/core"
rm -rf "${TARGET}/node_modules/@paperclip-pixel/core/node_modules"
node -e "
const fs=require('fs');
const p='${TARGET}/node_modules/@paperclip-pixel/core/package.json';
const pkg=JSON.parse(fs.readFileSync(p,'utf8'));
if(pkg.exports&&pkg.exports['.']&&!pkg.exports['.'].import){
  pkg.exports['.'].import=pkg.exports['.'].require||'./dist/index.js';
  fs.writeFileSync(p,JSON.stringify(pkg,null,2));
}
"

# plugin-sdk (ESM, already built -- exports -> dist).
cp -R "${SRC_SDK}" "${TARGET}/node_modules/@paperclipai/plugin-sdk"
rm -rf "${TARGET}/node_modules/@paperclipai/plugin-sdk/node_modules"

# shared: copy, ensure dist is built, and rewrite its package.json exports to
# point at the compiled dist JS instead of the TS source.
cp -R "${SRC_SHARED}" "${TARGET}/node_modules/@paperclipai/shared"
rm -rf "${TARGET}/node_modules/@paperclipai/shared/node_modules"
if [ ! -f "${TARGET}/node_modules/@paperclipai/shared/dist/index.js" ]; then
  echo "[build-plugin-bundle] building @paperclipai/shared dist..."
  npm --prefix "${TARGET}/node_modules/@paperclipai/shared" install --no-save --ignore-scripts
  npm --prefix "${TARGET}/node_modules/@paperclipai/shared" run build >/dev/null 2>&1 || true
fi
node -e "
const fs=require('fs');
const p='${TARGET}/node_modules/@paperclipai/shared/package.json';
const pkg=JSON.parse(fs.readFileSync(p,'utf8'));
const rewrite=(cond)=>cond && cond.startsWith('./src/') ? cond.replace(/^\.\/src\//,'./dist/').replace(/\.ts$/,'.js') : cond;
if(pkg.exports){
  for(const k of Object.keys(pkg.exports)){
    const e=pkg.exports[k];
    if(typeof e==='string') pkg.exports[k]=rewrite(e);
    else if(e&&typeof e==='object'){ for(const c of Object.keys(e)) e[c]=rewrite(e[c]); }
  }
}
if(pkg.main&&pkg.main.startsWith('./src/')) pkg.main=pkg.main.replace(/^\.\/src\//,'./dist/').replace(/\.ts$/,'.js');
fs.writeFileSync(p, JSON.stringify(pkg,null,2));
"

# zod v4 (runtime dep of the plugin + sdk + shared). Install in an isolated
# dir (the plugin's package.json uses `workspace:*` which npm cannot resolve,
# so `--prefix` against the plugin dir itself is rejected).
echo "[build-plugin-bundle] installing zod@^4..."
ZOD_TMP="$(mktemp -d)"
npm install --prefix "${ZOD_TMP}" --no-save --ignore-scripts zod@^4.4.3 >/dev/null
cp -R "${ZOD_TMP}/node_modules/zod" "${TARGET}/node_modules/zod"
rm -rf "${ZOD_TMP}"

echo "[build-plugin-bundle] done."
ls -R "${TARGET}/node_modules/@paperclipai" "${TARGET}/node_modules/@paperclip-pixel" > /tmp/bundle-listing.txt 2>/dev/null || true
echo "[build-plugin-bundle] vendored packages present."
