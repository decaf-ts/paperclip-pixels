#!/usr/bin/env bash
# Ad-hoc restore of the Paperclip Pixel stack (Postgres).
# Usage: restore.sh <postgres.dump.gz> [namespace]
set -euo pipefail

DUMP="${1:?usage: restore.sh <postgres.dump.gz> [namespace]}"
NS="${2:-paperclip-pixels}"
[ -f "$DUMP" ] || { echo "dump file not found: $DUMP" >&2; exit 1; }

PG_POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=postgres \
  -o jsonpath='{.items[0].metadata.name}')

echo "==> scaling paperclip host to 0"
kubectl -n "$NS" scale deploy/paperclip-pixels --replicas 0 || true

echo "==> restoring Postgres from $DUMP"
gunzip -c "$DUMP" | kubectl -n "$NS" exec -i "$PG_POD" -- \
  pg_restore -U paperclip -d paperclip --clean --if-exists

echo "==> scaling paperclip host back up"
kubectl -n "$NS" scale deploy/paperclip-pixels --replicas $(kubectl -n "$NS" get deploy/paperclip-pixels -o jsonpath='{.spec.replicas}' || echo 2) || true

echo "==> done. Verify: kubectl -n $NS get pods && curl the /api/health"
