/**
 * globalSetup — bring up the reproducible live Paperclip host with the Pixel
 * bridge plugin loaded via the REAL plugin-loader (SAA-215 harness).
 *
 * Runs `scripts/integration-host/down.sh` first (clear any stale host), then
 * `up.sh` with `KEEP_UP=1` so the server stays up for the suite. `up.sh`
 * exits 0 only when the plugin registered (the "Paperclip Pixel Bridge worker
 * starting" log line was captured) and writes `scripts/integration-host/.run-state`
 * with the live port + server PID. The suite reads that state file.
 *
 * Prerequisites (one-time, already satisfied in the dev workspace):
 *   - `paperclip/` submodule installed with devDeps (tsx loader present)
 *   - `packages/paperclip-plugin` built (`dist/worker.js` + `dist/manifest.js`)
 *   - `packages/core` built, `@paperclipai/plugin-sdk` dist present
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

const ROOT = process.cwd();
const STATE = path.join(ROOT, "scripts", "integration-host", ".run-state");

function run(script: string, env: NodeJS.ProcessEnv) {
  execFileSync(script, [], { stdio: "inherit", env: { ...process.env, ...env } });
}

export default async function setup() {
  // Clear any stale host first.
  run(path.join(ROOT, "scripts", "integration-host", "down.sh"), {});

  // Bring up a fresh ephemeral host + load the plugin via the real loader.
  // SKIP_SERVER_INSTALL=1: submodule deps already installed in the workspace.
  // PAPERCLIP_LOG_LEVEL=info: reduce log noise.
  run(path.join(ROOT, "scripts", "integration-host", "up.sh"), {
    KEEP_UP: "1",
    SKIP_SERVER_INSTALL: "1",
    PAPERCLIP_LOG_LEVEL: "info",
  });

  if (!existsSync(STATE)) {
    throw new Error("integration host up.sh did not write .run-state");
  }
  // Sanity: the state file must contain a healthy port.
  const port = readPort(STATE);
  if (!port) throw new Error("integration host .run-state has no PORT");

  // Confirm the server stayed up after up.sh returned. up.sh backgrounds the
  // server with `( exec node ) &`; it is reparented to init and must keep
  // serving for the duration of the suite. A connection-refused here means the
  // server died when the up.sh process exited (process-group cleanup).
  const ok = await healthCheck(port, 15000);
  if (!ok) {
    throw new Error(
      `integration host on port ${port} did not respond to /api/health after up.sh returned; ` +
        `the backgrounded server likely died with its process group. ` +
        `See scripts/integration-host/.run-state LOG_FILE for details.`,
    );
  }
}

async function healthCheck(port: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`);
      if (r.ok) {
        const j = (await r.json()) as { status?: string };
        if (j.status === "ok") return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

function readPort(stateFile: string): string | undefined {
  const txt = readFileSync(stateFile, "utf8");
  const m = txt.match(/^PORT=(\d+)/m);
  return m ? m[1] : undefined;
}
