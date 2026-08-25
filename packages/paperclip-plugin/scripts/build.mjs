/**
 * Build script for the Paperclip-Pixel bridge plugin.
 *
 * Uses esbuild with presets from `@paperclipai/plugin-sdk/bundlers` to create
 * self‑contained bundles for the worker and manifest. The resulting files are
 * placed in `dist/` and include all runtime dependencies except Node built‑ins
 * and React, which are externalized according to the plugin loader contract.
 *
 * Run with `node scripts/build.mjs` or via `npm run build`.
 */
// Self-contained esbuild bundle for the Paperclip-Pixel bridge plugin worker
// and manifest, using the SDK-blessed presets (@paperclipai/plugin-sdk/bundlers
// -> createPluginBundlerPresets). Bundling inlines @paperclip-pixel/core,
// @paperclipai/plugin-sdk, @paperclipai/shared (consumed as TS source), and
// zod into the worker so the forked worker process never has to resolve them
// from an install location at runtime. Node built-ins and react/react-dom are
// externalized per the plugin loader contract.
//
// Run: node scripts/build.mjs   (or: npm run build)
import { build } from "esbuild";
import { createPluginBundlerPresets } from "@paperclipai/plugin-sdk/bundlers";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm } from "node:fs/promises";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, "..");
const outdir = path.join(pkgRoot, "dist");

await rm(outdir, { recursive: true, force: true });

const presets = createPluginBundlerPresets({
  pluginRoot: pkgRoot,
  workerEntry: path.join(pkgRoot, "src/worker.ts"),
  manifestEntry: path.join(pkgRoot, "src/manifest.ts"),
  outdir,
  sourcemap: true,
  minify: false,
});

const workerOptions = {
  ...presets.esbuild.worker,
  entryPoints: [path.join(pkgRoot, "src/worker.ts")],
  outdir,
  metafile: true,
  logLevel: "info",
};

const manifestOptions = {
  ...presets.esbuild.manifest,
  entryPoints: [path.join(pkgRoot, "src/manifest.ts")],
  outdir,
  metafile: true,
  logLevel: "info",
};

const [workerResult, manifestResult] = await Promise.all([
  build(workerOptions),
  build(manifestOptions),
]);

const workerBytes = workerResult.metafile
  ? Object.values(workerResult.metafile.outputs).reduce((s, o) => s + o.bytes, 0)
  : undefined;

console.log("[build] worker + manifest bundled to dist/");
if (workerBytes) {
  console.log(`[build] worker bundle size: ${(workerBytes / 1024).toFixed(1)} KiB`);
}
console.log("[build] runtime deps inlined: @paperclip-pixel/core, @paperclipai/plugin-sdk, @paperclipai/shared, zod");
console.log("[build] externalized: node built-ins, react, react-dom");
