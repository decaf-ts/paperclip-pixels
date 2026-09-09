import type { Config } from "jest";
import path from "node:path";

const ROOT = process.cwd();

export default {
  rootDir: ROOT,
  verbose: true,
  transform: { "^.+\\.ts$": ["ts-jest", { tsconfig: `${ROOT}/tsconfig.jest.json` }] },
  testEnvironment: "node",
  roots: [`${ROOT}/src/core`, `${ROOT}/test/core`],
  testRegex: "/test/core/.*\\.(test|spec)\\.ts$",
  moduleFileExtensions: ["ts", "js", "json", "node"],
  moduleNameMapper: {
    "^paperclip-pixels-common$": path.join(ROOT, "../../common/src/index.ts"),
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  collectCoverage: false,
  collectCoverageFrom: ["src/core/**/*.ts"],
} satisfies Config;
