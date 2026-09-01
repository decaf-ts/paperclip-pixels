/**
 * Black-box unit tests for the relay CLI's WS3 HTTP surface
 * (`bin/paperclip-pixel-relay.js`, spec PAPERCLIP_PIXELS-2 WS3): a spawned
 * relay process against a scratch `PIXEL_AGENTS_HOME` validates
 * `POST /api/appearance-sync`, the retired visual-settings POST (410), the
 * debug GET view, the write-through appearance cache, and the share-directory
 * copy of the palette >= 6 sheets.
 *
 * Kept lean deliberately (the relay has no other test harness): one spawned
 * process, requests via plain fetch, no WS connection needed for these
 * assertions (the relay connects/retries to Pixel Agents on its own).
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const RELAY_BIN = path.join(REPO_ROOT, "bin", "paperclip-pixel-relay.js");
const CATALOG_DIR = path.join(REPO_ROOT, "assets", "characters");
const SHARED_SECRET = `test-shared-secret-${"a".repeat(24)}`;

interface SpawnedRelay {
  child: ChildProcess;
  stdout: string;
  stderr: string;
  baseUrl: string;
  home: string;
  exitCode: number | null;
}

let spawned: SpawnedRelay;

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function appearanceEntry(
  overrides: Partial<Record<string, unknown>> = {},
): Record<string, unknown> {
  return {
    agentId: "agent-sync-1",
    agentName: "Sync Agent",
    characterId: "pixel-agents:char-0",
    palette: 0,
    hueShift: 0,
    updatedAt: "2026-08-22T00:00:00.000Z",
    ...overrides,
  };
}

async function post(
  url: string,
  body: unknown,
  secret = SHARED_SECRET,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(secret ? { authorization: `Bearer ${secret}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(url: string, secret = SHARED_SECRET): Promise<Response> {
  return fetch(url, { method: "GET", headers: secret ? { authorization: `Bearer ${secret}` } : {} });
}

vi.hoisted(() => vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 }));

beforeAll(async () => {
  // Pick a free-ish port (random + retry attempts); spawn and wait for the
  // relay's listen banner before making assertions.
  for (let attempt = 0; attempt < 5 && !spawned; attempt += 1) {
    const port = 21_000 + Math.floor(Math.random() * 20_000);
    const home = mkdtempSync(path.join(os.tmpdir(), "pixel-relay-home-"));
    const child = spawn(
      process.execPath,
      [
        RELAY_BIN,
        "--port", String(port),
        "--host", "127.0.0.1",
        "--pixel-agents-home", home,
        "--shared-secret", SHARED_SECRET,
      ],
      { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, RELAY_PORT: String(port), PIXEL_AGENTS_HOME: home } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });

    const exitCode = await new Promise<number | null>((resolve) => {
      child.once("exit", (code) => resolve(code));
      setTimeout(() => resolve(null), 15_000).unref();
    });
    if (exitCode !== null) {
      // EADDRINUSE or a startup crash: try the next port.
      rmSync(home, { recursive: true, force: true });
      continue;
    }
    const startedAt = Date.now();
    while (Date.now() - startedAt < 15_000 && !stdout.includes("[paperclip-pixel-relay]")) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    spawned = { child, stdout, stderr, baseUrl: `http://127.0.0.1:${port}`, home, exitCode };
  }
  if (!spawned) throw new Error("relay test fixture: could not spawn the relay binary");
});

afterAll(async () => {
  spawned?.child.kill("SIGTERM");
  // The relay retries WS connections every 2s; a nuke leaves no stragglers.
  await new Promise((resolve) => setTimeout(resolve, 100));
  if (spawned) rmSync(spawned.home, { recursive: true, force: true });
});

describe("relay CLI: GET view + valid sync + write-through cache", () => {
  it("GET /api/visual-settings returns the relay's debug catalog + cache view + shareDirectory", async () => {
    const res = await get(`${spawned.baseUrl}/api/visual-settings`);
    expect(res.status).toBe(200);
    const body = await responseJson(res);
    expect(body.schemaVersion).toBe(1);
    expect(Array.isArray(body.characters)).toBe(true);
    expect((body.characters as unknown[]).length).toBe(24);
    // No appearance-sync yet: the write-through cache view is empty.
    expect(body.assignments).toEqual({});
    expect(typeof body.shareDirectory).toBe("string");
    expect(existsSync(String(body.shareDirectory))).toBe(true);
  });

  it("POST /api/appearance-sync accepts a valid sync and writes the appearance cache", async () => {
    const res = await post(`${spawned.baseUrl}/api/appearance-sync`, {
      companyId: "company-acme",
      assignments: [
        appearanceEntry(),
        appearanceEntry({ agentId: "agent-sync-2", agentName: "Second Agent", characterId: "paperclip-pixels:char-6", palette: 6, hueShift: 45 }),
      ],
    });
    expect(res.status).toBe(200);
    expect(await responseJson(res)).toEqual({ ok: true, count: 2 });

    const cache = JSON.parse(
      readFileSync(path.join(spawned.home, "appearance-cache.json"), "utf8"),
    ) as Record<string, Record<string, unknown>>;
    expect(Object.keys(cache).sort()).toEqual(["agent-sync-1", "agent-sync-2"]);
    expect(cache["agent-sync-1"]).toEqual(appearanceEntry());
    expect(cache["agent-sync-2"].characterId).toBe("paperclip-pixels:char-6");
    expect(cache["agent-sync-2"].hueShift).toBe(45);
  });

  it("copies only the palette >= 6 sheets into the share directory (bundled sheets never duplicated)", async () => {
    const shareChars = path.join(spawned.home, "paperclip-characters", "assets", "characters");
    const numeric = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    const files = readdirSync(shareChars).sort(numeric);
    const expected = Array.from({ length: 18 }, (_, i) => `char_${i + 6}.png`);
    expect(files).toEqual(expected);
    for (const file of files) {
      expect(readFileSync(path.join(CATALOG_DIR, file))).toEqual(readFileSync(path.join(shareChars, file)));
    }
  });
});

describe("relay CLI: appearance-sync validation failures", () => {
  it.each([
    ["palette mismatch", appearanceEntry({ palette: 3 })],
    ["hueShift above range", appearanceEntry({ hueShift: 361 })],
    ["non-integer hueShift", appearanceEntry({ hueShift: 47.5 })],
    ["negative hueShift", appearanceEntry({ hueShift: -1 })],
    ["unknown character id", appearanceEntry({ characterId: "ghost-character" })],
    ["empty agentId", appearanceEntry({ agentId: "" })],
    ["non-string agentId", appearanceEntry({ agentId: 7 })],
    ["empty agentName", appearanceEntry({ agentName: "" })],
    ["payload without assignments list", { companyId: "company-acme" }],
  ])("rejects %s with 400 invalid-appearance", async (_label, payload) => {
    const res = await post(`${spawned.baseUrl}/api/appearance-sync`, {
      companyId: "company-acme",
      assignments: [payload],
    });
    expect(res.status).toBe(400);
    expect(await responseJson(res)).toEqual({ ok: false, error: "invalid-appearance" });
  });

  it("(legacy shape error) rejects a non-array assignments payload with 400 invalid-appearance-sync", async () => {
    const res = await post(`${spawned.baseUrl}/api/appearance-sync`, { companyId: "company-acme", assignments: "no" });
    expect(res.status).toBe(400);
    expect(await responseJson(res)).toEqual({ ok: false, error: "invalid-appearance-sync" });
  });

  it("annotates each 400 with a fresh body (rejects never persist to the cache)", async () => {
    const before = readFileSync(path.join(spawned.home, "appearance-cache.json"), "utf8");
    await post(`${spawned.baseUrl}/api/appearance-sync`, {
      companyId: "company-acme",
      assignments: [appearanceEntry({ palette: 999 })],
    });
    expect(readFileSync(path.join(spawned.home, "appearance-cache.json"), "utf8")).toBe(before);
  });

  it("still accepts a valid sync after interleaved failures (the applier stays live)", async () => {
    const res = await post(`${spawned.baseUrl}/api/appearance-sync`, {
      companyId: "company-acme",
      assignments: [appearanceEntry({ hueShift: 47 })],
    });
    expect(res.status).toBe(200);
    expect(await responseJson(res)).toEqual({ ok: true, count: 1 });
  });
});

describe("relay CLI: auth + retired endpoints", () => {
  it("rejects unauthenticated requests with 401 (shared secret is the safeguard)", async () => {
    const view = await get(`${spawned.baseUrl}/api/visual-settings`, "");
    expect(view.status).toBe(401);
    expect(await responseJson(view)).toEqual({ error: "unauthorized" });
    const sync = await post(`${spawned.baseUrl}/api/appearance-sync`, { companyId: "company-acme", assignments: [] }, "");
    expect(sync.status).toBe(401);
  });

  it("retires per-agent appearance writes: POST /api/visual-settings returns 410", async () => {
    const res = await post(`${spawned.baseUrl}/api/visual-settings`, {
      companyId: "company-acme",
      assignments: [],
    });
    expect(res.status).toBe(410);
    const body = await responseJson(res);
    expect(body.ok).toBe(false);
    expect(String(body.error)).toMatch(/retired/);
  });

  it("rejects unknown routes with 405", async () => {
    const res = await post(`${spawned.baseUrl}/api/unknown-route`, {});
    expect(res.status).toBe(405);
  });
});
