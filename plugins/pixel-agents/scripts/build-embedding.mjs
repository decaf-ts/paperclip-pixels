#!/usr/bin/env node
/**
 * Build script for the Pixel Agents embedding surface
 * (`plugins/pixel-agents/src/embedding.ts`).
 *
 * Produces a self-contained CJS bundle at
 * `plugins/pixel-agents/dist/pixel-agents-embedding.cjs`: the module the
 * deployed Pixel Agents server loads through the fork's generic
 * `--plugin <module>` startup loader. Everything is inlined except Node
 * built-ins (esbuild marks them external automatically for `platform: "node"`),
 * the module format is explicit (CJS) so a dynamic `import()` from the fork's
 * bundled CLI resolves it trivially, and Node 24 is the release target.
 *
 * Run directly with `node scripts/build-embedding.mjs` or via `npm run build`
 * (which runs tsc first, then this bundle).
 */
import { build } from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const pkgRoot = path.resolve(__dirname, "..");
const outfile = path.join(pkgRoot, "dist", "pixel-agents-embedding.cjs");

// esbuild load-plugin that shims `import.meta.url` in CJS output. The
// embedding surface reaches the Pixel Agents plugin's character-catalog
// resolution (src/characters.ts), which uses `import.meta.url` (native ESM).
// When esbuild bundles that ESM source into the CJS embedding artifact it
// would emit `import.meta` as an empty object and warn (`empty-import-meta`),
// leaving a latent wrong-path runtime bug. Rewriting the expression to the CJS
// equivalent at build time makes the artifact's module format explicit and
// warning-free while keeping the `.cjs` filename the deploy manifests COPY in
// from.
const importMetaShim = {
  name: "import-meta-cjs-shim",
  setup(build) {
    build.onLoad({ filter: /\.[cm]?[jt]s$/ }, async (args) => {
      if (args.path.includes("node_modules")) return null;
      const fs = await import("node:fs");
      const src = fs.readFileSync(args.path, "utf8");
      if (!src.includes("import.meta")) return null;
      return {
        contents: src.replace(
          /import\.meta\.url/g,
          "require('url').pathToFileURL(__filename).href",
        ),
        loader: args.path.endsWith("ts") ? "ts" : "js",
      };
    });
  },
};

const result = await build({
  entryPoints: [path.join(pkgRoot, "src/embedding.ts")],
  outfile,
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  sourcemap: true,
  minify: false,
  logLevel: "info",
  plugins: [importMetaShim],
});

const bytes = Object.values(result.metafile?.outputs ?? {}).reduce((s, o) => s + o.bytes, 0);
console.log(`[build-embedding] bundled to ${path.relative(pkgRoot, outfile)}`);
if (bytes) {
  console.log(`[build-embedding] bundle size: ${(bytes / 1024).toFixed(1)} KiB`);
}
console.log(
  "[build-embedding] runtime deps inlined: @decaf-ts/paperclip-pixels-common + zod; externalized: node built-ins",
);
