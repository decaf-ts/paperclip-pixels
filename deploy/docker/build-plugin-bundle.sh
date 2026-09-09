#!/usr/bin/env bash
# Assembles a self-contained copy of the Paperclip-Pixel bridge plugin at the
# target directory. The source is the independent Paperclip plugin package
# `plugins/paperclip` (never the combined root build, removed in R3-M4).
#
# The plugin worker + manifest are bundled by esbuild into self-contained
# single files (plugins/paperclip/scripts/build.mjs) that inline the plugin's
# own src/ source, paperclip-pixels-common, @paperclipai/plugin-sdk,
# @paperclipai/shared, and zod, externalizing only node built-ins (and, for
# the UI bundle, react/react-dom). So the install location only needs the
# plugin package.json (with the paperclipPlugin manifest/worker pointers), the
# built dist/worker.js + dist/manifest.js, the UI bundle under dist/ui/, and
# the WS3 character + composition assets under assets/ (read off disk at
# runtime by the worker — plugins/paperclip/src/characters.ts resolves
# <package root>/assets/characters).
#
# Usage: build-plugin-bundle.sh <target-dir>
#
# Layout produced:
#   <target>/
#     package.json   (the plugins/paperclip package.json)
#     dist/          (worker.js, manifest.js, ui/index.js -- all self-contained)
#     assets/        (characters/catalog.json + sprite pngs — WS3 catalog, composition)
set -euo pipefail

TARGET="${1:?target dir required}"
SRC_PLUGIN="${SRC_PLUGIN:-/tmp/src/paperclip-pixels-plugin}"

echo "[build-plugin-bundle] assembling plugin at ${TARGET}"
mkdir -p "${TARGET}"

cp "${SRC_PLUGIN}/package.json" "${TARGET}/package.json"
cp -R "${SRC_PLUGIN}/dist" "${TARGET}/dist"
cp -R "${SRC_PLUGIN}/assets" "${TARGET}/assets"

echo "[build-plugin-bundle] done."
ls -R "${TARGET}/dist" > /tmp/bundle-listing.txt 2>/dev/null || true
echo "[build-plugin-bundle] self-contained dist present."
