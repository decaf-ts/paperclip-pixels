// Bundles the Pixel Office plugin UI (`src/ui/index.tsx`) into `dist/ui/index.js`
// using esbuild, mirroring the SDK reference pattern in
// `paperclip/packages/plugins/examples/plugin-kitchen-sink-example/scripts/build-ui.mjs`.
//
// The host loads this bundle from the manifest's `entrypoints.ui` ("./dist/ui")
// and mounts the named export matching each slot's `exportName`
// (PLUGIN_SPEC §19): `PixelOfficePage` (page slot) and `PixelOfficeSidebar`
// (sidebar slot).
//
// Trust boundary (FR-9, §28.2): React and the SDK UI hooks are externalized —
// the host injects them at runtime — so this bundle never ships its own copy
// of React and talks to Paperclip only through the worker bridge
// (`ctx.data` / `ctx.actions` / `ctx.streams`).
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  // Automatic JSX runtime -> imports from `react/jsx-runtime` (externalized).
  // Set explicitly because the worker tsconfig.json (which esbuild would
  // otherwise auto-discover) excludes `src/ui` and declares no `jsx` mode.
  jsx: "automatic",
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
    "@paperclipai/plugin-sdk/ui",
  ],
  logLevel: "info",
});
