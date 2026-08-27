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
    // NodeNext-style relative imports carry an explicit ".js" extension even
    // though the file on disk is ".ts" (core/pixel-agents-provider now live
    // as plain source under src/, not a separate built package) — strip it so
    // ts-jest resolves the real .ts file.
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFilesAfterEnv: [`${ROOT}/src/ui/test-utils/jest-setup.ts`],
  collectCoverage: false,
  collectCoverageFrom: ["src/ui/**/*.{ts,tsx}"],
  // This config now lives at the repo root (not a package subdirectory), so
  // an unscoped scan sweeps up the paperclip/pixel-agents submodules' own
  // tests and any stale leftover directories — restrict discovery to our
  // own src/ tree.
  roots: [`${ROOT}/src`],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  modulePathIgnorePatterns: ["<rootDir>/paperclip/", "<rootDir>/pixel-agents/"],
  haste: {
    retainAllFiles: false,
  },
} satisfies Config;
