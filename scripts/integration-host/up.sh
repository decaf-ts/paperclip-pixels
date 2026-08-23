#!/usr/bin/env bash
# scripts/integration-host/up.sh
#
# Bring up a reproducible, ephemeral live Paperclip host with the Pixel bridge
# plugin loaded via the real plugin-loader, suitable for integration tests.
#
# Path chosen (option B from the spec): boot the Paperclip server from the
# `paperclip/` git submodule source with an ephemeral embedded Postgres
# (no DATABASE_URL), in `local_trusted` mode (loopback only, no login), then
# install the Pixel bridge plugin from its built `dist/` via the real
# `POST /api/plugins/install` route (local-path install).
#
# Why not Docker quickstart: the plugin lives in the outer `paperclip-pixels`
# workspace and imports `@paperclip-pixel/core` + `@paperclipai/plugin-sdk`,
# whose deps resolve on the host filesystem (outer node_modules) where they are
# already built. Running from source keeps the plugin worker's dependency
# graph intact. The host's plugin-loader adds the tsx loader for any
# local-path install (plugin-loader.ts: `activePlugin.packagePath && tsx
# exists`), so the worker can resolve the workspace `@paperclipai/shared`
# TS-source exports at runtime.
#
# Usage:
#   scripts/integration-host/up.sh                 # defaults: port 13100
#   PAPERCLIP_PORT=13100 scripts/integration-host/up.sh
#
# Env overrides:
#   PAPERCLIP_PORT        host port (default 13100; 3100 is the run host)
#   INTEGRATION_HOME      PAPERCLIP_HOME (default: ephemeral dir under /tmp)
#   INTEGRATION_INSTANCE  PAPERCLIP_INSTANCE_ID (default "integration")
#   SKIP_SERVER_INSTALL   "1" to skip the submodule `pnpm install` prereq check
#   KEEP_UP               "1" to leave the server running after evidence capture
#
# Outputs a state file at $STATE_FILE (default: scripts/integration-host/.run-state)
# consumed by down.sh. Prints connection info + registration evidence to stdout.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PAPERCLIP_SRC="$ROOT/paperclip"
PLUGIN_DIR="$ROOT/packages/paperclip-plugin"
SCRIPT_DIR="$ROOT/scripts/integration-host"
STATE_FILE="${STATE_FILE:-$SCRIPT_DIR/.run-state}"

PORT="${PAPERCLIP_PORT:-13100}"
INSTANCE="${INTEGRATION_INSTANCE:-integration}"
HOME_DIR="${INTEGRATION_HOME:-$(mktemp -d -t paperclip-integration-XXXXXX)}"
LOG_FILE="${LOG_FILE:-$HOME_DIR/server.log}"
EVIDENCE_FILE="${EVIDENCE_FILE:-$HOME_DIR/evidence.txt}"

# pino pretty-prints to stderr by default in dev; force JSON-ish line logs.
export PAPERCLIP_LOG_LEVEL="${PAPERCLIP_LOG_LEVEL:-debug}"
export SERVE_UI="false"
export HOST="127.0.0.1"
export PORT
export PAPERCLIP_HOME="$HOME_DIR"
export PAPERCLIP_INSTANCE_ID="$INSTANCE"
export PAPERCLIP_DEPLOYMENT_MODE="local_trusted"
export PAPERCLIP_DEPLOYMENT_EXPOSURE="private"
export PAPERCLIP_MIGRATION_PROMPT="never"
export PAPERCLIP_MIGRATION_AUTO_APPLY="true"
# dev (tsx) mode must see a non-production NODE_ENV so the server's own
# dev assumptions hold; the run host often exports NODE_ENV=production.
export NODE_ENV="development"
# Test-only event-inject seam (PAPERCLIP_PIXELS-1 / SAA-258): enables
# POST /api/plugins/events/inject so the integration suite can drive
# controlled PluginEvent envelopes (same eventId replay, out-of-order /
# duplicated delivery) through the REAL in-process bus. The route is
# hard-disabled unless this is "1" AND NODE_ENV !== "production"; it
# performs no persistence and no network egress. Off by default upstream.
export PAPERCLIP_EVENT_INJECT="1"
# Verbose embedded-postgres logs help diagnose first-run binary init.
export PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE="${PAPERCLIP_EMBEDDED_POSTGRES_VERBOSE:-true}"

log() { printf '[up] %s\n' "$*" >&2; }
fail() { printf '[up] ERROR: %s\n' "$*" >&2; exit 1; }

# Pick a free port so the server's detectPort() binds exactly what we target.
# The server binds the port it logs via "Server listening on <host>:<port>";
# we re-read that below as a cross-check, but starting from a free port avoids
# racing a stale server bound to the default.
free_port() {
  local start="${1:-13100}"
  node -e "
    const net=require('net');
    const tryP=(p,cb)=>{const s=net.createServer();s.once('error',()=>cb(0));s.once('listening',()=>{s.close(()=>cb(p))});s.listen(p,'127.0.0.1')};
    const find=(p)=>{if(p>65000)process.exit(1);tryP(p,r=>{if(r)process.stdout.write(String(r));else find(p+1)})};
    find($start);
  "
}
PORT="$(free_port "$PORT")"
export PORT

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------
[[ -d "$PAPERCLIP_SRC/server" ]] || fail "Paperclip submodule not found at $PAPERCLIP_SRC"
[[ -f "$PLUGIN_DIR/package.json" ]] || fail "Plugin not found at $PLUGIN_DIR"

# 1. Submodule deps installed? The plugin worker needs cli/node_modules/tsx
#    (the loader adds `--import <tsx loader>` for local-path installs).
TSX_LOADER="$PAPERCLIP_SRC/cli/node_modules/tsx/dist/loader.mjs"
if [[ "${SKIP_SERVER_INSTALL:-0}" != "1" ]]; then
  if [[ ! -f "$TSX_LOADER" ]]; then
    log "Submodule deps not installed (tsx loader missing). Installing pnpm workspace (devDeps required)..."
    ( cd "$PAPERCLIP_SRC" && env -u NODE_ENV NODE_ENV=development CI=true pnpm install --frozen-lockfile ) \
      || fail "pnpm install failed in paperclip submodule. Run: (cd paperclip && NODE_ENV=development CI=true pnpm install --frozen-lockfile)"
  fi
fi
[[ -f "$TSX_LOADER" ]] || fail "tsx loader still missing at $TSX_LOADER after install attempt"

# 2. Plugin built? (dist/worker.js + dist/manifest.js). The loader resolves the
#    manifest via the dist/manifest.js fallback convention (no
#    `paperclipPlugin.manifest` key in package.json is required).
if [[ ! -f "$PLUGIN_DIR/dist/worker.js" || ! -f "$PLUGIN_DIR/dist/manifest.js" ]]; then
  log "Plugin dist missing; building @paperclip-pixel/paperclip-plugin..."
  ( cd "$PLUGIN_DIR" && pnpm run build ) || fail "Plugin build failed. Run: (cd packages/paperclip-plugin && pnpm run build)"
fi
[[ -f "$PLUGIN_DIR/dist/worker.js" ]] || fail "plugin dist/worker.js missing"
[[ -f "$PLUGIN_DIR/dist/manifest.js" ]] || fail "plugin dist/manifest.js missing"

# 3. Wire the plugin's workspace dependencies into its node_modules.
#    The plugin declares `@paperclipai/plugin-sdk: workspace:*` and
#    `@paperclip-pixel/core: ^0.1.0`, but those packages live across a
#    submodule boundary (sdk in paperclip/packages/plugins/sdk) / in the
#    sibling packages/core, and this outer repo has no pnpm-workspace.yaml to
#    resolve `workspace:*`. The pre-existing environment already symlinks
#    `@paperclipai/shared` and `zod` into the plugin's node_modules the same
#    way; we complete the set idempotently so the worker (ESM) can resolve
#    `import "@paperclipai/plugin-sdk"` and `import "@paperclip-pixel/core"`.
ensure_plugin_dep() {
  local scope_dir="$1" name="$2" target="$3"
  mkdir -p "$scope_dir"
  if [[ ! -e "$scope_dir/$name" || "$(readlink -f "$scope_dir/$name" 2>/dev/null || true)" != "$target" ]]; then
    ln -sfn "$target" "$scope_dir/$name"
    log "Linked plugin dep $(basename "$scope_dir")/$name -> $target"
  fi
}
PLUGIN_NM="$PLUGIN_DIR/node_modules"
[[ -d "$PAPERCLIP_SRC/packages/plugins/sdk/dist" ]] || fail "@paperclipai/plugin-sdk dist missing at $PAPERCLIP_SRC/packages/plugins/sdk (build the submodule sdk)"
[[ -d "$ROOT/packages/core/dist" ]] || fail "@paperclip-pixel/core dist missing at $ROOT/packages/core (run: pnpm --filter @paperclip-pixel/core build)"
ensure_plugin_dep "$PLUGIN_NM/@paperclipai" "plugin-sdk" "$PAPERCLIP_SRC/packages/plugins/sdk"
ensure_plugin_dep "$PLUGIN_NM/@paperclip-pixel" "core" "$ROOT/packages/core"

# ---------------------------------------------------------------------------
# Boot the server (background)
# ---------------------------------------------------------------------------
# Verify the tsx loader is installed in the submodule (it is a devDep, so the
# submodule must be installed with devDeps: NODE_ENV=development pnpm install).
TSX_LOADER="$PAPERCLIP_SRC/server/node_modules/tsx/dist/loader.mjs"
[[ -f "$TSX_LOADER" ]] || fail "tsx loader not found at $TSX_LOADER (run the submodule pnpm install with devDeps)"
: > "$LOG_FILE"
log "Booting Paperclip from source on 127.0.0.1:$PORT (home=$HOME_DIR)"
# Launch the server node process directly with the tsx ESM loader registered
# via --import. This avoids the `tsx` CLI wrapper (which spawns its own child
# node process); here $! is the actual server process, so SIGTERM reaches the
# server's own signal handler (ordered shutdown stops embedded Postgres) and
# there is no grandchild that can be reparented to init and leak.
( cd "$PAPERCLIP_SRC/server" && exec node --import "file://$TSX_LOADER" src/index.ts ) > "$LOG_FILE" 2>&1 &
SERVER_PID=$!
PGID="$SERVER_PID"
log "Server PID=$SERVER_PID, log=$LOG_FILE"

# Wait for the health endpoint. The server logs the port it actually bound
# (detectPort may shift it if a race made our chosen port busy); parse it.
ACTUAL_PORT=""
HEALTH=""
for i in $(seq 1 90); do
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    log "Server process exited early. Tail of log:"
    tail -40 "$LOG_FILE" >&2 || true
    fail "Server failed to start"
  fi
  # Prefer the port the server reports it bound.
  if [[ -z "$ACTUAL_PORT" ]]; then
    ACTUAL_PORT="$(grep -m1 -oE "Server listening on 127\.0\.0\.1:[0-9]+" "$LOG_FILE" 2>/dev/null | grep -oE "[0-9]+$" || true)"
  fi
  target_port="${ACTUAL_PORT:-$PORT}"
  HEALTH="$(curl -s -m 3 "http://127.0.0.1:${target_port}/api/health" 2>/dev/null || true)"
  if [[ "$HEALTH" == *'"status":"ok"'* ]]; then
    PORT="$target_port"
    log "Server healthy on 127.0.0.1:$PORT after ${i}s"
    break
  fi
  sleep 1
  HEALTH=""
done
[[ -n "$HEALTH" ]] || fail "Server did not become healthy within 90s. Tail of log:\n$(tail -40 "$LOG_FILE" 2>/dev/null)"

# Persist state for down.sh.
cat > "$STATE_FILE" <<EOF
SERVER_PID=$SERVER_PID
PGID=$PGID
PORT=$PORT
HOME_DIR=$HOME_DIR
LOG_FILE=$LOG_FILE
INSTANCE=$INSTANCE
EOF

# ---------------------------------------------------------------------------
# Install the Pixel bridge plugin via the real plugin-loader API
# ---------------------------------------------------------------------------
log "Installing plugin from local path: $PLUGIN_DIR"
INSTALL_RESP="$(curl -s -m 180 -X POST "http://127.0.0.1:$PORT/api/plugins/install" \
  -H "Content-Type: application/json" \
  -d "{\"packageName\":\"$PLUGIN_DIR\",\"isLocalPath\":true}" 2>/dev/null || true)"

# Give the worker a moment to finish setup() (bootstrap + event subscriptions).
sleep 3

# ---------------------------------------------------------------------------
# Capture registration + subscription evidence
# ---------------------------------------------------------------------------
{
  echo "# Paperclip Pixel bridge — integration host evidence"
  echo "# generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo
  echo "## Host"
  echo "endpoint: http://127.0.0.1:$PORT/api"
  echo "health: $HEALTH"
  echo
  echo "## Plugin install response (POST /api/plugins/install)"
  echo "$INSTALL_RESP"
  echo
  echo "## Plugin registry (GET /api/plugins)"
  curl -s -m 5 "http://127.0.0.1:$PORT/api/plugins" 2>/dev/null || true
  echo
} > "$EVIDENCE_FILE"

# Registration proof: the worker logs "Paperclip Pixel Bridge worker starting"
# (worker.ts setup). The host re-emits worker ctx.logger calls as `[plugin] ...`.
REG_LINE="$(grep -m1 -E "Paperclip Pixel Bridge worker starting" "$LOG_FILE" 2>/dev/null || true)"
HOST_ACTIVATED="$(grep -m1 -E "plugin-loader: worker started" "$LOG_FILE" 2>/dev/null || true)"
# Direct subscription proof: the host's plugin-loader logs
# "plugin activated successfully" with a `registered.eventSubscriptions` count
# measured AFTER the worker's setup() ran its `ctx.events.on()` loop. The count
# must equal SUBSCRIBED_EVENT_TYPES.length (constants.ts) — 12 for this bridge.
ACTIVATED_LINE="$(grep -m1 -E "plugin activated successfully" "$LOG_FILE" 2>/dev/null || true)"
SUB_COUNT="$(printf '%s' "$ACTIVATED_LINE" | grep -oE '"eventSubscriptions":[0-9]+' | grep -oE '[0-9]+' || true)"

{
  echo
  echo "## Registration proof (server log)"
  if [[ -n "$REG_LINE" ]]; then
    echo "FOUND: $REG_LINE"
  else
    echo "NOT FOUND: 'Paperclip Pixel Bridge worker starting' line absent"
  fi
  if [[ -n "$HOST_ACTIVATED" ]]; then
    echo "FOUND: $HOST_ACTIVATED"
  fi
  echo
  echo "## Subscription proof (host plugin-loader activation log)"
  if [[ -n "$ACTIVATED_LINE" ]]; then
    echo "FOUND: $ACTIVATED_LINE"
    echo "eventSubscriptions: ${SUB_COUNT:-?} (must equal SUBSCRIBED_EVENT_TYPES.length = 12)"
  else
    echo "NOT FOUND: 'plugin activated successfully' line absent"
  fi
  echo
  echo "## Plugin worker health (onHealth)"
  # pluginId resolved from the registry listing
  PLUGIN_ID="$(curl -s -m 5 "http://127.0.0.1:$PORT/api/plugins" 2>/dev/null \
    | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const a=JSON.parse(s);const p=Array.isArray(a)?a[0]:null;if(p)console.log(p.id)}catch(e){}})" 2>/dev/null || true)"
  if [[ -n "$PLUGIN_ID" ]]; then
    curl -s -m 5 "http://127.0.0.1:$PORT/api/plugins/$PLUGIN_ID/health" 2>/dev/null || true
    echo
    echo "pluginId: $PLUGIN_ID"
    echo "pluginStatus: $(curl -s -m 5 "http://127.0.0.1:$PORT/api/plugins/$PLUGIN_ID" 2>/dev/null | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{console.log(JSON.parse(s).status)}catch(e){}})" 2>/dev/null || true)"
  fi
  echo
  echo "## Subscription note"
  echo "The worker (worker.ts setup) registers ctx.events.on(eventType) for each"
  echo "of the 12 SUBSCRIBED_EVENT_TYPES (constants.ts). The host event bus stores"
  echo "these silently (no per-subscription log); setup() completing (worker"
  echo "started + onHealth ok) is the signal all 12 subscriptions registered."
} >> "$EVIDENCE_FILE"

# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------
cat "$EVIDENCE_FILE"

if [[ -z "$REG_LINE" ]]; then
  log ""
  log "Registration line NOT found — plugin did not fully register."
  log "Install response was: $INSTALL_RESP"
  log "Tail of server log:"
  tail -30 "$LOG_FILE" >&2 || true
  if [[ "${KEEP_UP:-0}" != "1" ]]; then
    log "Tearing down (set KEEP_UP=1 to keep the server running for inspection)."
    "$SCRIPT_DIR/down.sh" || true
  fi
  exit 1
fi

log ""
log "Bring-up complete. Plugin registered on http://127.0.0.1:$PORT"
log "Evidence: $EVIDENCE_FILE"
log "State:    $STATE_FILE"
if [[ "${KEEP_UP:-0}" != "1" ]]; then
  log "Tearing down (set KEEP_UP=1 to keep the server running for Tester)."
  "$SCRIPT_DIR/down.sh" || true
else
  log "Server left running (KEEP_UP=1). Tear down with: scripts/integration-host/down.sh"
fi
