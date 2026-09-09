/**
 * Build script for the independent Paperclip plugin package
 * (`plugins/paperclip`). Mirrors the outer combined-entry build but targets
 * this package's own `src/` and omits the Pixel Agents embedding bundle
 * (that surface now lives in `plugins/pixel-agents`).
 *
 * Uses esbuild with presets from `@paperclipai/plugin-sdk/bundlers` to create
 * self-contained bundles for the worker and manifest. The resulting files are
 * placed in `dist/` and include all runtime dependencies except Node built-ins
 * and React, which are externalized according to the plugin loader contract.
 * The wire contract (`@decaf-ts/paperclip-pixels-common`) and the local core/domain are
 * bundled in; the host plugin SDK is consumed as TS source.
 *
 * Run: node scripts/build.mjs   (or: npm run build)
 */
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
console.log("[build] runtime deps inlined: @decaf-ts/paperclip-pixels-common, @paperclipai/plugin-sdk, @paperclipai/shared, zod");
console.log("[build] externalized: node built-ins, react, react-dom");
