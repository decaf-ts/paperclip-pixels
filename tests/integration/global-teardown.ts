/**
 * globalTeardown — tear down the live Paperclip host brought up by
 * globalSetup (stops the server + drops the ephemeral embedded Postgres).
 */
import { execFileSync } from "node:child_process";
import * as path from "node:path";

const ROOT = process.cwd();

export default async function teardown() {
  try {
    execFileSync(path.join(ROOT, "scripts", "integration-host", "down.sh"), [], {
      stdio: "inherit",
      env: process.env,
    });
  } catch (err) {
    // Best-effort: a teardown failure must not mask the suite result.
    console.warn("[integration] down.sh failed during teardown:", String(err));
  }
}
