/**
 * Jest config for the domain logic under `src/core/` (pure translation/
 * mapping code, no DOM). Separate from `jest.config.ts` (UI components,
 * jsdom) and `vitest.config.ts` (the worker/relay/actions side, which needs
 * the real Paperclip plugin SDK test harness) — this trio replaces what used
 * to be three separate packages' own configs before the `packages/*` -> root
 * merge. The retired `src/pixel-agents-provider/` hook-vocabulary package
 * (WS2-C) had its own roots here; its coverage moves to the worker-side
 * vitest suite against the plugin feed.
 */
import type { Config } from "jest";

const ROOT = process.cwd();

export default {
  rootDir: ROOT,
  verbose: true,
  // ts-jest must emit CommonJS regardless of the root tsconfig's NodeNext
  // setting (needed for the plugin worker code) — jest's default runtime
  // can't execute raw ESM `import` output.
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: `${ROOT}/tsconfig.jest.json` }] },
  testEnvironment: "node",
  roots: [`${ROOT}/src/core`, `${ROOT}/test/core`],
  testRegex: "/test/core/.*\\.(test|spec)\\.ts$",
  moduleFileExtensions: ["ts", "js", "json", "node"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverage: false,
  collectCoverageFrom: ["src/core/**/*.ts"],
} satisfies Config;
