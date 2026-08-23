#!/usr/bin/env bash
# scripts/integration-host/run.sh
#
# One-shot reproducible bring-up: start the ephemeral Paperclip host, load the
# Pixel bridge plugin via the real plugin-loader, capture registration evidence,
# then tear down. Exit 0 only if the plugin registered (the
# "Paperclip Pixel Bridge worker starting" log line was captured).
#
# This is the exact command to reproduce the bring-up for CI / Tester handoff.
#
# Usage:
#   scripts/integration-host/run.sh
#   PAPERCLIP_PORT=13100 KEEP_UP=1 scripts/integration-host/run.sh
#
# Env passthrough: PAPERCLIP_PORT, INTEGRATION_HOME, INTEGRATION_INSTANCE,
# KEEP_UP (1 = leave server up after success; down.sh still tears down on
# failure), SKIP_SERVER_INSTALL.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
export STATE_FILE="${STATE_FILE:-$ROOT/scripts/integration-host/.run-state}"

# Clean any prior state first so a stale server is not left dangling.
"$ROOT/scripts/integration-host/down.sh" >/dev/null 2>&1 || true

exec "$ROOT/scripts/integration-host/up.sh"
