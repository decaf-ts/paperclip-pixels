#!/usr/bin/env bash
# Assembles a self-contained copy of the Paperclip-Pixel bridge plugin at the
# target directory.
#
# The plugin worker + manifest are bundled by esbuild into self-contained
# single files (scripts/build.mjs) that inline the core/pixel-agents-provider
# source (plain src/ subdirectories of this one package, not separate
# packages), @paperclipai/plugin-sdk, @paperclipai/shared, and zod,
# externalizing only node built-ins (and, for the UI bundle, react/react-dom).
# So the install location only needs the package.json (with the
# paperclipPlugin manifest/worker pointers), the built dist/worker.js +
# dist/manifest.js, and the UI bundle under dist/ui/.
#
# Usage: build-plugin-bundle.sh <target-dir>
#
# Layout produced:
#   <target>/
#     package.json   (the @decaf-ts/paperclip-pixels root package.json)
#     dist/          (worker.js, manifest.js, ui/index.js -- all self-contained)
set -euo pipefail

TARGET="${1:?target dir required}"
SRC_PLUGIN="${SRC_PLUGIN:-/tmp/src/paperclip-pixels}"

echo "[build-plugin-bundle] assembling plugin at ${TARGET}"
mkdir -p "${TARGET}"

cp "${SRC_PLUGIN}/package.json" "${TARGET}/package.json"
cp -R "${SRC_PLUGIN}/dist" "${TARGET}/dist"

echo "[build-plugin-bundle] done."
ls -R "${TARGET}/dist" > /tmp/bundle-listing.txt 2>/dev/null || true
echo "[build-plugin-bundle] self-contained dist present."
