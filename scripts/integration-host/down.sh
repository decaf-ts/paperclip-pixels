#!/usr/bin/env bash
# scripts/integration-host/down.sh
#
# Tear down the integration Paperclip host brought up by up.sh:
#   - stop the server process (its ordered shutdown stops the embedded Postgres
#     cluster it started), and
#   - remove the ephemeral PAPERCLIP_HOME (embedded Postgres data dir + state).
#
# Usage:
#   scripts/integration-host/down.sh
#   STATE_FILE=/path/to/.run-state scripts/integration-host/down.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCRIPT_DIR="$ROOT/scripts/integration-host"
STATE_FILE="${STATE_FILE:-$SCRIPT_DIR/.run-state}"

log() { printf '[down] %s\n' "$*" >&2; }

if [[ ! -f "$STATE_FILE" ]]; then
  log "No state file at $STATE_FILE — nothing to tear down."
  exit 0
fi

# shellcheck disable=SC1090
source "$STATE_FILE"

log "Stopping Paperclip server (pid=${SERVER_PID:-?}, pgid=${PGID:-${SERVER_PID:-?}})"
PGID="${PGID:-${SERVER_PID:-}}"
# Kill the whole process group first (covers the tsx cli.mjs wrapper + its
# spawned node server child + embedded Postgres the server started). The
# server's SIGTERM handler does ordered shutdown (stops embedded Postgres).
if [[ -n "${PGID:-}" ]]; then
  kill -TERM "-$PGID" 2>/dev/null || kill -TERM "${SERVER_PID:-}" 2>/dev/null || true
fi
for i in $(seq 1 30); do
  if [[ -n "${SERVER_PID:-}" ]] && ! kill -0 "$SERVER_PID" 2>/dev/null; then
    break
  fi
  sleep 0.5
done
if [[ -n "${SERVER_PID:-}" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
  log "Server did not exit on SIGTERM; sending SIGKILL to process group"
  kill -KILL "-$PGID" 2>/dev/null || kill -KILL "${SERVER_PID:-}" 2>/dev/null || true
  sleep 1
fi
# Belt-and-suspenders: reap any leaked descendants still in the group.
if [[ -n "${PGID:-}" ]]; then
  pkill -KILL -g "$PGID" 2>/dev/null || true
fi

# Best-effort: kill any stray embedded-postgres backend bound to the data dir.
if [[ -n "${HOME_DIR:-}" && -d "${HOME_DIR:-}" ]]; then
  log "Removing ephemeral home: $HOME_DIR"
  # Ensure no postgres process still holds the data dir.
  if [[ -f "$HOME_DIR/instances/${INSTANCE:-integration}/db/postmaster.pid" ]]; then
    PID_LINE="$(head -1 "$HOME_DIR/instances/${INSTANCE:-integration}/db/postmaster.pid" 2>/dev/null || true)"
    if [[ -n "$PID_LINE" && "$PID_LINE" =~ ^[0-9]+$ ]]; then
      kill -TERM "$PID_LINE" 2>/dev/null || true
      sleep 1
    fi
  fi
  rm -rf "$HOME_DIR" 2>/dev/null || log "warning: could not fully remove $HOME_DIR (postgres may still hold files)"
fi

rm -f "$STATE_FILE"
log "Teardown complete."
