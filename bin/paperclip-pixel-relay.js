#!/usr/bin/env node
import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.RELAY_PORT ?? 8081), host: process.env.RELAY_HOST ?? "127.0.0.1",
    pixelAgentsUrl: process.env.PIXEL_AGENTS_URL ?? "http://127.0.0.1:8080",
    pixelAgentsHome: process.env.PIXEL_AGENTS_HOME ?? path.join(os.homedir(), ".pixel-agents"),
    sharedSecret: process.env.RELAY_SHARED_SECRET ?? "",
    characterCatalog: process.env.PIXEL_CHARACTER_CATALOG ?? "",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--port": opts.port = Number(next()); break; case "--host": opts.host = next(); break;
      case "--pixel-agents-url": opts.pixelAgentsUrl = next(); break; case "--pixel-agents-home": opts.pixelAgentsHome = next(); break;
      case "--shared-secret": opts.sharedSecret = next(); break; case "--character-catalog": opts.characterCatalog = next(); break;
      case "--help": case "-h": console.log("Usage: paperclip-pixel-relay [options] --shared-secret TOKEN"); process.exit(0);
    }
  }
  if (opts.sharedSecret.length < 24) throw new Error("RELAY_SHARED_SECRET (or --shared-secret) must contain at least 24 characters");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const catalogPath = opts.characterCatalog || path.join(packageRoot, "assets", "characters", "catalog.json");
const catalogDir = path.dirname(catalogPath);
const serverJsonPath = path.join(opts.pixelAgentsHome, "server.json");
const assignmentsPath = path.join(opts.pixelAgentsHome, "paperclip-appearance.json");
const sessionsDir = path.join(opts.pixelAgentsHome, "paperclip-sessions");
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; } };
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); const temp = `${file}.${process.pid}.tmp`; fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 }); fs.renameSync(temp, file); }
const readToken = () => { const value = readJson(serverJsonPath, null); return typeof value?.token === "string" ? value.token : null; };
function readBody(req) { return new Promise((resolve, reject) => { let data = ""; req.on("data", (chunk) => { data += chunk; if (data.length > 1_000_000) { reject(new Error("body too large")); req.destroy(); } }); req.on("end", () => resolve(data)); req.on("error", reject); }); }
function authorized(req) { return req.headers.authorization === `Bearer ${opts.sharedSecret}` || req.headers["x-relay-secret"] === opts.sharedSecret; }
function sendJson(res, status, payload) { res.writeHead(status, { "content-type": "application/json", "x-content-type-options": "nosniff" }); res.end(JSON.stringify(payload)); }

// Pixel Agents' blue label is populated from provider team metadata, not the
// hooks-only cwd/folderName label. Its unchanged SessionStart hook already
// supports transcript_path, and its Claude provider reads teamName/agentName
// metadata from JSONL records. Materialize one tiny, stable transcript per
// Paperclip session on the volume shared with Pixel Agents and add that path
// only at this local companion boundary. A unique team name avoids grouping
// unrelated Paperclip agents into a synthetic Claude team or lead hierarchy.
function attachPaperclipTranscript(body) {
  if (
    body?.hook_event_name !== "SessionStart"
    || typeof body.session_id !== "string"
    || body.session_id.length === 0
    || typeof body.cwd !== "string"
    || body.cwd.length === 0
  ) return body;

  const digest = createHash("sha256").update(body.session_id).digest("hex");
  const agentName = path.basename(body.cwd).slice(0, 200);
  // Pixel Agents derives folderName (the areaMappings key) from the
  // transcript's parent directory when transcript_path is present. Keep that
  // directory equal to the Paperclip name as well, so enabling the blue label
  // does not collapse every agent into a generic "sessions" area key.
  const agentDirName = agentName === "." || agentName === ".." ? digest : agentName;
  const transcriptPath = path.join(sessionsDir, agentDirName, `${digest}.jsonl`);
  fs.mkdirSync(path.dirname(transcriptPath), { recursive: true });
  const metadata = JSON.stringify({
    type: "assistant",
    message: { content: [] },
    teamName: `paperclip-${digest.slice(0, 24)}`,
    agentName,
  });
  const temp = `${transcriptPath}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${metadata}\n`, { mode: 0o600 });
  fs.renameSync(temp, transcriptPath);
  return { ...body, transcript_path: transcriptPath };
}

const catalog = readJson(catalogPath, { characters: [] });
const characters = (catalog.characters ?? []).map((item) => ({ ...item, previewDataUrl: `data:image/png;base64,${fs.readFileSync(path.join(catalogDir, item.file)).toString("base64")}` }));
let assignments = readJson(assignmentsPath, {}); let socket = null; let retry = null; let observed = { folderNames: {}, agentMeta: {} };
function socketUrl(token) { const url = new URL(opts.pixelAgentsUrl); url.protocol = url.protocol === "https:" ? "wss:" : "ws:"; url.pathname = "/ws"; url.searchParams.set("token", token); return url; }
function applyAssignments() {
  if (socket?.readyState !== WebSocket.OPEN) return; const seats = { ...observed.agentMeta }; let changed = false;
  for (const assignment of Object.values(assignments)) { const ids = Object.entries(observed.folderNames).filter(([, name]) => name === assignment.agentName).map(([id]) => id); assignment.applied = false; if (ids.length !== 1) continue; seats[ids[0]] = { ...(seats[ids[0]] ?? {}), palette: assignment.palette, hueShift: assignment.hueShift }; assignment.applied = true; changed = true; }
  if (changed) socket.send(JSON.stringify({ type: "saveAgentSeats", seats })); writeJson(assignmentsPath, assignments);
}
function connect() {
  clearTimeout(retry); const token = readToken(); if (!token) { retry = setTimeout(connect, 2000); return; }
  socket = new WebSocket(socketUrl(token)); socket.on("open", () => socket.send(JSON.stringify({ type: "webviewReady" })));
  socket.on("message", (raw) => { try { const msg = JSON.parse(raw.toString()); if (msg.type === "existingAgents") { observed = { folderNames: msg.folderNames ?? {}, agentMeta: msg.agentMeta ?? {} }; applyAssignments(); } else if (msg.type === "agentCreated" || msg.type === "agentClosed") socket.send(JSON.stringify({ type: "webviewReady" })); } catch { /* unrelated message */ } });
  socket.on("close", () => { retry = setTimeout(connect, 2000); }); socket.on("error", () => socket?.close());
}
connect();

const server = http.createServer(async (req, res) => {
  if (!authorized(req)) return sendJson(res, 401, { error: "unauthorized" });
  if (req.method === "GET" && req.url === "/api/visual-settings") return sendJson(res, 200, { schemaVersion: 1, characters, assignments });
  if (req.method === "POST" && req.url === "/api/visual-settings") {
    try { const body = JSON.parse(await readBody(req)); const choice = characters.find((item) => item.id === body.characterId); if (!choice || choice.palette !== body.palette || typeof body.agentId !== "string" || typeof body.agentName !== "string" || !Number.isInteger(body.hueShift) || body.hueShift < 0 || body.hueShift > 360) return sendJson(res, 400, { ok: false, error: "invalid-appearance" }); assignments[body.agentId] = { agentId: body.agentId, agentName: body.agentName, characterId: choice.id, palette: choice.palette, hueShift: body.hueShift, applied: false }; writeJson(assignmentsPath, assignments); if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "webviewReady" })); return sendJson(res, 200, { ok: true, assignment: assignments[body.agentId] }); } catch (err) { return sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) }); }
  }
  if (req.method !== "POST" || !/^\/api\/hooks\/[a-z0-9-]+$/.test(req.url ?? "")) return sendJson(res, 405, { error: "method not allowed" });
  const token = readToken(); if (!token) return sendJson(res, 503, { error: "pixel-agents not ready" });
  try {
    const rawBody = await readBody(req);
    const parsedBody = JSON.parse(rawBody);
    const body = JSON.stringify(attachPaperclipTranscript(parsedBody));
    const upstream = await fetch(`${opts.pixelAgentsUrl}${req.url}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  } catch (err) { sendJson(res, 502, { error: err instanceof Error ? err.message : String(err) }); }
});
server.listen(opts.port, opts.host, () => console.log(`[paperclip-pixel-relay] ${opts.host}:${opts.port}; ${characters.length} complete characters`));
