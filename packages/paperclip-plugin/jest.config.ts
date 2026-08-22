/**
 * Jest config for the Paperclip plugin UI component/hook tests
 * (spec PAPERCLIP_PIXELS-1, §31.2 UI snapshot policy tests).
 *
 * Note: this package is ESM (`"type": "module"`); ts-jest emits CommonJS
 * from the transformed sources, which jest executes from memory — the
 * package manifest's module type does not affect it. Sources under
 * `src/ui/` are type-checked with `tsconfig.test.json` (jest et al. types;
 * `paths` mirror the runtime `moduleNameMapper` below).
 */

import type { Config } from "jest";

const ROOT = process.cwd();

export default {
  rootDir: ROOT,
  verbose: true,
  transform: {
    "^.+\\.(ts|tsx)$": ["ts-jest", { tsconfig: `${ROOT}/tsconfig.test.json` }],
  },
  testEnvironment: "jsdom",
  testRegex: "/src/ui/.*\\.(test|spec)\\.tsx?$",
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json", "node"],
  moduleNameMapper: {
    // The real SDK requires the host runtime registry; mock all of its hooks.
    "^@paperclipai/plugin-sdk/ui$": `${ROOT}/src/ui/test-utils/sdk-ui.ts`,
    // Canonical bridge contract: use the built CommonJS bundle (matches the
    // package's runtime resolution) so tests exercise real core behavior.
    "^@paperclip-pixel/core$": `${ROOT}/../core/dist/index.js`,
  },
  setupFilesAfterEnv: [`${ROOT}/src/ui/test-utils/jest-setup.ts`],
  collectCoverage: false,
  collectCoverageFrom: ["src/ui/**/*.{ts,tsx}"],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
} satisfies Config;
