import { defineConfig } from "vitest/config";

const root = "/workspaces/paperclip-pixels";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@paperclipai/plugin-sdk/testing": `${root}/paperclip/packages/plugins/sdk/dist/testing.js`,
      "@paperclipai/plugin-sdk": `${root}/paperclip/packages/plugins/sdk/dist/index.js`,
      "@paperclipai/shared": `${root}/paperclip/packages/shared/dist/index.js`,
      "@paperclip-pixel/core": `${root}/packages/core/dist/index.js`,
    },
  },
});
