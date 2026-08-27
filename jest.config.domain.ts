/**
 * Jest config for the domain logic under `src/core/` and
 * `src/pixel-agents-provider/` (pure translation/mapping code, no DOM).
 * Separate from `jest.config.ts` (UI components, jsdom) and `vitest.config.ts`
 * (the worker/relay/actions side, which needs the real Paperclip plugin SDK
 * test harness) — this trio replaces what used to be three separate packages'
 * own configs before the `packages/*` -> root merge.
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
  roots: [`${ROOT}/src/core`, `${ROOT}/src/pixel-agents-provider`, `${ROOT}/test/core`, `${ROOT}/test/pixel-agents-provider`],
  testRegex: "/test/(core|pixel-agents-provider)/.*\\.(test|spec)\\.ts$",
  moduleFileExtensions: ["ts", "js", "json", "node"],
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverage: false,
  collectCoverageFrom: ["src/core/**/*.ts", "src/pixel-agents-provider/**/*.ts"],
} satisfies Config;
