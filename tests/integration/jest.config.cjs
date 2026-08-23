/* eslint-env node */
/* eslint-disable no-undef */
/**
 * Jest config for the live-Paperclip Pixel bridge integration suite
 * (PAPERCLIP_PIXELS-1, SAA-216).
 *
 * Self-contained: `globalSetup` brings up the reproducible live Paperclip
 * host + loaded bridge plugin via the SAA-215 harness
 * (`scripts/integration-host/up.sh`), the suite drives the REAL host event
 * bus + REAL worker + REAL getData RPC, and `globalTeardown` tears it down.
 *
 * No coverage thresholds (this suite asserts live behaviour, not source
 * coverage), run in band (one live host at a time), generous per-test
 * timeout (real host boots + real async event delivery).
 */
module.exports = {
  rootDir: ".",
  testEnvironment: "node",
  testMatch: ["**/*.test.ts"],
  transform: { "^.+\\.ts$": "ts-jest" },
  moduleFileExtensions: ["ts", "js", "json"],
  globalSetup: "<rootDir>/global-setup.ts",
  globalTeardown: "<rootDir>/global-teardown.ts",
  testTimeout: 90000,
  collectCoverage: false,
  reporters: ["default"],
};
