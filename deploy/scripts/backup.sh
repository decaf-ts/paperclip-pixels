#!/usr/bin/env bash
# Ad-hoc backup of the Paperclip Pixel stack (Postgres + plugin state).
# Usage: backup.sh [namespace] [output-dir]
set -euo pipefail

NS="${1:-paperclip-pixels}"
OUT="${2:-./backups}"
mkdir -p "$OUT"
TS=$(date -u +%Y%m%d-%H%M%S)

PG_POD=$(kubectl -n "$NS" get pod -l app.kubernetes.io/component=postgres \
  -o jsonpath='{.items[0].metadata.name}')

echo "==> postgres dump -> $OUT/postgres-$TS.dump.gz"
kubectl -n "$NS" exec -it "$PG_POD" -- pg_dump -U paperclip -d paperclip -Fc \
  | gzip > "$OUT/postgres-$TS.dump.gz"

echo "==> plugin state archive"
# Requires a pod with the paperclip data PVC mounted (a backup job pod, or
# scale the deployment to a job and tar). Prefer the chart's CronJob PVC path.
echo "   (use the chart's paperclip-pixels-backup CronJob for the plugin-state archive)"

echo "==> done: $OUT/postgres-$TS.dump.gz"
