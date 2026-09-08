import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pluginRoot, "../..");

/**
 * Dedicated vitest configuration for the production measurement / SLO suite
 * located under test/performance (files with the .perf.ts suffix). Kept
 * separate from the default vitest.config.ts (which runs the fast unit suite
 * over files with the .test.ts suffix) so the sustained-load / soak runs stay
 * out of the regular unit-test gate and are invoked on demand via the
 * `test:perf` script.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/performance/**/*.perf.ts"],
    exclude: ["**/node_modules/**", "**/dist/**"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
    pool: "threads",
  },
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk/testing": `${repoRoot}/paperclip/packages/plugins/sdk/dist/testing.js`,
      "@paperclipai/plugin-sdk": `${repoRoot}/paperclip/packages/plugins/sdk/dist/index.js`,
      "@paperclipai/shared": `${repoRoot}/paperclip/packages/shared/dist/index.js`,
    },
  },
});
