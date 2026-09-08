import { createRequire } from "module";
const require = createRequire("/workspaces/paperclip-pixels/e2e/");
const { chromium } = require("@playwright/test");
const BASE = "http://172.24.0.1:3100";
const EMAIL = "qa-e2e@pixel.local";
const PASS = "QaE2e-Pixel-2026!";
const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();
page.setDefaultTimeout(15000);
await page.goto(BASE + "/auth", { waitUntil: "domcontentloaded", timeout: 15000 });
try {
  await page.locator('input#email[name="email"]').fill(EMAIL);
  await page.locator('input#password[name="password"]').fill(PASS);
  await page.getByRole("button", { name: "Sign In" }).click();
} catch (e) {}
await page.waitForTimeout(2500);
const cookies = await page.context().cookies();
const cookie = cookies.find(c=>c.name.includes("session_token"));
const val = cookie.value;
const res = await page.evaluate(async (token) => {
  const r = await fetch("http://172.24.0.1:3100/api/plugins/ui-contributions", {
    headers: { Accept: "application/json", Cookie: `paperclip-default.session_token=${token}` }
  });
  return await r.text();
}, val);
console.log("UI CONTRIBUTIONS:", res.slice(0, 2000));
await browser.close();
