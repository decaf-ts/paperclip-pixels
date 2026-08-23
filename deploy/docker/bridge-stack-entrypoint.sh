#!/bin/sh
# bridge-stack-entrypoint.sh
#
# Entrypoint for the paperclip-pixel-host container. It performs a one-shot
# loopback `local_trusted` bootstrap to install the baked-in bridge plugin
# with NO authentication (local_implicit board admin), then `exec`s the real
# server in authenticated/lan mode. The persisted plugin registry row is
# reactivated automatically by the host's `loadAll()` on every subsequent
# boot, so the bootstrap install is only needed once per fresh database.
#
# Why the loopback dance: in `authenticated` mode, `POST /api/plugins/install`
# requires an instance-admin session (a human must accept the CEO invite and
# sign in). `local_trusted` mode treats every request as a local-implicit
# board admin with no auth, but it is hard-wired to a loopback bind, which is
# unreachable from outside the pod. So we run a throwaway loopback bootstrap
# server purely for the install, stop it, and start the real reachable server.
# This mirrors the upstream `bootstrap-company.sh` company-import pattern.
set -eu

UPSTREAM_ENTRYPOINT=/usr/local/bin/docker-entrypoint.sh
INSTANCE_ID=${PAPERCLIP_INSTANCE_ID:-default}
BOOTSTRAP_PORT=${PAPERCLIP_BOOTSTRAP_PORT:-3101}
BOOTSTRAP_URL="http://127.0.0.1:${BOOTSTRAP_PORT}"
PLUGIN_PATH=${PAPERCLIP_PIXEL_PLUGIN_PATH:-/opt/paperclip-pixel-plugin}
MARKER_DIR="${PAPERCLIP_HOME:-/paperclip}/instances/${INSTANCE_ID}"
MARKER_FILE="${MARKER_DIR}/.pixel-plugin-installed"
SERVER_PID=

stop_bootstrap_server() {
  if [ -n "${SERVER_PID}" ] && kill -0 "${SERVER_PID}" 2>/dev/null; then
    kill -TERM "${SERVER_PID}" 2>/dev/null || true
    wait "${SERVER_PID}" 2>/dev/null || true
  fi
  SERVER_PID=
}
trap 'stop_bootstrap_server; exit 143' TERM INT HUP

# Hand off to the upstream entrypoint (UID/GID remap + gosu drop) for the real
# server. Skip the plugin bootstrap once it has already been recorded.
if [ -f "${MARKER_FILE}" ]; then
  echo "bridge-stack: pixel plugin already installed; starting Paperclip."
  exec "${UPSTREAM_ENTRYPOINT}" "$@"
fi

echo "bridge-stack: starting loopback local_trusted bootstrap server to install the pixel plugin."
# PAPERCLIP_BIND=loopback is required: local_trusted hard-fails otherwise.
# This one-shot subprocess forces local_trusted regardless of the real mode.
env \
  HOST=127.0.0.1 \
  PORT="${BOOTSTRAP_PORT}" \
  PAPERCLIP_API_URL="${BOOTSTRAP_URL}" \
  PAPERCLIP_DEPLOYMENT_MODE=local_trusted \
  PAPERCLIP_DEPLOYMENT_EXPOSURE=private \
  PAPERCLIP_BIND=loopback \
  PAPERCLIP_MIGRATION_AUTO_APPLY=true \
  PAPERCLIP_HOME="${PAPERCLIP_HOME:-/paperclip}" \
  PAPERCLIP_INSTANCE_ID="${INSTANCE_ID}" \
  "${UPSTREAM_ENTRYPOINT}" "$@" &
SERVER_PID=$!

attempt=0
until curl --fail --silent "${BOOTSTRAP_URL}/api/health" >/dev/null 2>&1; do
  attempt=$((attempt + 1))
  if ! kill -0 "${SERVER_PID}" 2>/dev/null; then
    wait "${SERVER_PID}" || true
    echo "bridge-stack: bootstrap server exited before becoming healthy." >&2
    exit 70
  fi
  if [ "${attempt}" -ge "${PAPERCLIP_BOOTSTRAP_ATTEMPTS:-120}" ]; then
    echo "bridge-stack: timed out waiting for the bootstrap server." >&2
    stop_bootstrap_server
    exit 70
  fi
  sleep 1
done

echo "bridge-stack: installing local plugin from ${PLUGIN_PATH}."
install_resp=$(curl -sS -X POST "${BOOTSTRAP_URL}/api/plugins/install" \
  -H "Content-Type: application/json" \
  -d "{\"packageName\":\"${PLUGIN_PATH}\",\"isLocalPath\":true}" || true)
echo "bridge-stack: install response: ${install_resp}"

# Detect a failed install (the host returns 400 with an `error` field). Do NOT
# record the marker in that case, so the next boot retries the install.
if echo "${install_resp}" | grep -q '"error"'; then
  echo "bridge-stack: plugin install FAILED -- not recording marker; will retry next boot." >&2
  stop_bootstrap_server
  exit 71
fi

# Give the worker a moment to start, then list plugins as a best-effort check.
sleep 3
echo "bridge-stack: registered plugins:"
curl -sS "${BOOTSTRAP_URL}/api/plugins" || true
echo

mkdir -p "${MARKER_DIR}"
touch "${MARKER_FILE}"
stop_bootstrap_server

echo "bridge-stack: plugin install recorded; starting Paperclip in ${PAPERCLIP_DEPLOYMENT_MODE:-authenticated} mode."
exec "${UPSTREAM_ENTRYPOINT}" "$@"
