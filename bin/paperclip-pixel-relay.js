#!/usr/bin/env node
// paperclip-pixel-relay
//
// Standalone companion process for the Pixel Agents side of the Paperclip
// Pixel Bridge. Pixel Agents has no plugin/extension-loading mechanism of any
// kind (confirmed by reading pixel-agents/server/src/cli.ts, server.ts, and
// providers/index.ts — `hookProviders` is a hardcoded array baked in at build
// time), so there is no such thing as "installing a plugin into Pixel
// Agents". The only thing a third party can ever do is talk to it over its
// public HTTP protocol (`/api/hooks/:id`, `/ws`) as an external client — this
// CLI is exactly that: a small companion process you run alongside your
// Pixel Agents instance, never something you install "into" it.
//
// What it solves: Pixel Agents mints a fresh random bearer token on every
// boot (`crypto.randomUUID()`) with no env var / CLI flag to pin it, so the
// Paperclip-side plugin (which runs as a separate, possibly remote process)
// cannot know that token in advance. This relay runs on the SAME machine /
// same pod as Pixel Agents, reads the token straight off
// `~/.pixel-agents/server.json` on the local filesystem, and forwards the
// Paperclip plugin's already-correctly-shaped pushes (real Claude hook JSON
// bodies — see `@paperclip-pixel/pixel-agents-provider`'s `HttpPushSink`) to
// Pixel Agents' real, unmodified `/api/hooks/claude` endpoint with the right
// `Authorization: Bearer` header attached.
//
// Zero external dependencies (Node built-ins only) so `npx <package>
// paperclip-pixel-relay` works with no install step beyond Node itself.
//
// Usage:
//   npx @decaf-ts/paperclip-pixels paperclip-pixel-relay [options]
//
// Options:
//   --port <n>              Port to listen on (default: 8081, or $RELAY_PORT)
//   --host <addr>            Bind address (default: 127.0.0.1, or $RELAY_HOST)
//   --pixel-agents-url <url> Where Pixel Agents itself listens
//                            (default: http://127.0.0.1:8080, or $PIXEL_AGENTS_URL)
//   --pixel-agents-home <p>  Override ~/.pixel-agents (default: real $HOME,
//                            or $PIXEL_AGENTS_HOME) — set this if the relay
//                            runs under a different user/HOME than the Pixel
//                            Agents process it is paired with (e.g. two
//                            containers sharing a mounted volume at a
//                            non-default path).
//   --shared-secret <token>  Require `X-Relay-Secret: <token>` on inbound
//                            requests (default: none, or $RELAY_SHARED_SECRET)
//                            — this is OUR OWN inbound contract (not a Pixel
//                            Agents or Paperclip concept); only useful if the
//                            relay is reachable from more than your own
//                            trusted network.
//   --help                   Show this help and exit

import * as http from "node:http";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

function parseArgs(argv) {
  const opts = {
    port: Number(process.env.RELAY_PORT ?? process.env.SIDECAR_PORT ?? 8081),
    host: process.env.RELAY_HOST ?? process.env.SIDECAR_HOST ?? "127.0.0.1",
    pixelAgentsUrl: process.env.PIXEL_AGENTS_URL ?? "http://127.0.0.1:8080",
    pixelAgentsHome: process.env.PIXEL_AGENTS_HOME ?? path.join(os.homedir(), ".pixel-agents"),
    sharedSecret: process.env.RELAY_SHARED_SECRET ?? process.env.RELAY_SIDECAR_SECRET ?? "",
  };
  for (let i = 0; i < argv.length; i++) {
    const next = () => argv[++i];
    switch (argv[i]) {
      case "--port": opts.port = Number(next()); break;
      case "--host": opts.host = next(); break;
      case "--pixel-agents-url": opts.pixelAgentsUrl = next(); break;
      case "--pixel-agents-home": opts.pixelAgentsHome = next(); break;
      case "--shared-secret": opts.sharedSecret = next(); break;
      case "--help":
      case "-h":
        console.log(`Usage: paperclip-pixel-relay [options]

Options:
  --port <n>               Port to listen on (default: 8081)
  --host <addr>             Bind address (default: 127.0.0.1)
  --pixel-agents-url <url>  Where Pixel Agents itself listens (default: http://127.0.0.1:8080)
  --pixel-agents-home <p>   Override ~/.pixel-agents (default: $HOME/.pixel-agents)
  --shared-secret <token>   Require X-Relay-Secret header on inbound requests
  --help                    Show this help
`);
        process.exit(0);
    }
  }
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
const SERVER_JSON_PATH = path.join(opts.pixelAgentsHome, "server.json");

function readLocalToken() {
  try {
    const raw = fs.readFileSync(SERVER_JSON_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    return typeof parsed.token === "string" ? parsed.token : null;
  } catch {
    // Pixel Agents has not started yet, or server.json is mid-write. The
    // caller surfaces this as a 503 so the plugin's own retry/error-capture
    // (HttpPushSink.lastPushError) handles it gracefully — never a crash.
    return null;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
      if (data.length > 1_000_000) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method !== "POST") {
    res.writeHead(405).end("method not allowed");
    return;
  }

  if (opts.sharedSecret && req.headers["x-relay-secret"] !== opts.sharedSecret) {
    res.writeHead(401).end("unauthorized");
    return;
  }

  const token = readLocalToken();
  if (!token) {
    res.writeHead(503, { "content-type": "text/plain" }).end(
      `pixel-agents not ready (no token at ${SERVER_JSON_PATH})`,
    );
    return;
  }

  let body;
  try {
    body = await readBody(req);
  } catch (err) {
    res.writeHead(400).end(String(err instanceof Error ? err.message : err));
    return;
  }

  // Preserve the caller's chosen providerId path segment (defaults to
  // "claude" upstream) exactly as sent, so behavior stays forward-compatible
  // if Pixel Agents ever restores per-provider dispatch.
  const targetPath = req.url && req.url !== "/" ? req.url : "/api/hooks/claude";

  try {
    const upstream = await fetch(`${opts.pixelAgentsUrl}${targetPath}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body,
    });
    res.writeHead(upstream.status, { "content-type": "application/json" });
    res.end(await upstream.text());
  } catch (err) {
    res.writeHead(502, { "content-type": "text/plain" });
    res.end(`upstream push failed: ${err instanceof Error ? err.message : String(err)}`);
  }
});

server.listen(opts.port, opts.host, () => {
  console.log(
    `[paperclip-pixel-relay] listening on ${opts.host}:${opts.port}, ` +
    `forwarding to ${opts.pixelAgentsUrl}, reading token from ${SERVER_JSON_PATH}`,
  );
});
