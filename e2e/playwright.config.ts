/**
 * Playwright config for the Pixel Office e2e suite (spec PAPERCLIP_PIXELS-1,
 * SAA-231).
 *
 * Drives the deployed SAA-212 minikube bridge stack through port-forwards (set
 * up by global-setup). The webServer directive is intentionally absent: the
 * suite does NOT bootstrap a throwaway server — it points at the real deployed
 * host (PAPERCLIP_PIXEL_E2E_HOST_URL, default http://localhost:13100).
 */

import path from "node:path";

import { defineConfig } from "@playwright/test";

const here = import.meta.dirname;
const testDir = path.join(here, "paperclip");
const outputDir = path.join(here, "test-results");
const reportDir = path.join(here, "playwright-report");

export default defineConfig({
  testDir,
  testMatch: "**/*.spec.ts",
  // Live remote deployment: login fixture (retried UI sign-in) + up to
  // RECONCILE_WAIT_MS reconciles need headroom beyond the per-step budgets.
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalSetup: path.join(here, "global-setup.ts"),
  globalTeardown: path.join(here, "global-teardown.ts"),
  use: {
    baseURL: process.env.PAPERCLIP_PIXEL_E2E_HOST_URL ?? "http://localhost:13100",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
    actionTimeout: 30_000,
    navigationTimeout: 30_000,
  },
  projects: [
    { name: "chromium", use: { browserName: "chromium" } },
  ],
  outputDir,
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: reportDir }],
  ],
});
