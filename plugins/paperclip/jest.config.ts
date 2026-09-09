import type { Config } from "jest";
import path from "node:path";

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
    "^paperclip-pixels-common$": path.join(ROOT, "../../common/src/index.ts"),
    "^@paperclipai/plugin-sdk/ui$": `${ROOT}/src/ui/test-utils/sdk-ui.ts`,
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
  setupFilesAfterEnv: [`${ROOT}/src/ui/test-utils/jest-setup.ts`],
  collectCoverage: false,
  collectCoverageFrom: ["src/ui/**/*.{ts,tsx}"],
  roots: [`${ROOT}/src`],
  testPathIgnorePatterns: ["/node_modules/", "/dist/"],
  modulePathIgnorePatterns: [],
  haste: {
    retainAllFiles: false,
  },
} satisfies Config;
