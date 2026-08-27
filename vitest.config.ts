import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

// Repo root, derived from this file's location instead of a hardcoded
// devcontainer path (`/workspaces/paperclip-pixels`), so the aliases below
// resolve on any checkout. This config now lives at the repo root itself.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // core/pixel-agents-provider/worker code now all live under src/ as plain
    // relative TS source (no longer separate packages), so no exclusions are
    // needed beyond vitest's own defaults — but be explicit about not
    // reaching into the submodules' own test suites.
    // test/core/** and test/pixel-agents-provider/** are plain Jest (global
    // describe/it, no vitest import) — see jest.config.domain.ts.
    exclude: ["**/node_modules/**", "**/dist/**", "paperclip/**", "pixel-agents/**", "test/core/**", "test/pixel-agents-provider/**"],
  },
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk/testing": `${root}/paperclip/packages/plugins/sdk/dist/testing.js`,
      "@paperclipai/plugin-sdk": `${root}/paperclip/packages/plugins/sdk/dist/index.js`,
      "@paperclipai/shared": `${root}/paperclip/packages/shared/dist/index.js`,
    },
  },
});
