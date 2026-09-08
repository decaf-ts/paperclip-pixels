import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";
import path from "node:path";

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot = path.resolve(pluginRoot, "../..");

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "test/core/**"],
  },
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk/testing": `${repoRoot}/paperclip/packages/plugins/sdk/dist/testing.js`,
      "@paperclipai/plugin-sdk": `${repoRoot}/paperclip/packages/plugins/sdk/dist/index.js`,
      "@paperclipai/shared": `${repoRoot}/paperclip/packages/shared/dist/index.js`,
    },
  },
});
