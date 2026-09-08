#!/usr/bin/env bash
# Production install helper for the paperclip-pixels Helm chart.
#
# Creates the target namespace + Secrets from environment variables (never
# committed), then installs/upgrades the chart with digest-pinned images.
#
# Required env:
#   NAMESPACE            target namespace (default paperclip-pixels)
#   CHART_DIR            chart dir (default ../helm/paperclip-pixels)
#   IMAGE_PAPERCLIP_DIGEST / IMAGE_PIXEL_AGENTS_DIGEST   (sha256:... from CI publish)
#   IMAGE_TAG            version tag
#   BETTER_AUTH_SECRET   Better Auth secret
#   FEED_TOKEN           plugin feed shared secret
#   POSTGRES_PASSWORD    postgres password
#   DATABASE_URL         full postgres URL (or leave blank to auto-build)
# Optional:
#   PAPERCLIP_PIXEL_API_TOKEN   board API key
#   HAS_CA, FEED_CA, FEED_SERVER_CERT, FEED_SERVER_KEY,
#   FEED_CLIENT_CERT, FEED_CLIENT_KEY  (mtls; base64 or file paths with --from-file)
set -euo pipefail

NS="${NAMESPACE:-paperclip-pixels}"
CHART_DIR="${CHART_DIR:-$(cd "$(dirname "$0")/../helm/paperclip-pixels" && pwd)}"
IMAGE_TAG="${IMAGE_TAG:-0.1.0}"

: "${BETTER_AUTH_SECRET:?set BETTER_AUTH_SECRET}"
: "${FEED_TOKEN:?set FEED_TOKEN}"
: "${POSTGRES_PASSWORD:?set POSTGRES_PASSWORD}"
DATABASE_URL="${DATABASE_URL:-postgres://paperclip:${POSTGRES_PASSWORD}@paperclip-pixels-postgres:5432/paperclip}"

echo "==> namespace $NS"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f - >/dev/null

echo "==> application secret (no values committed)"
kubectl -n "$NS" create secret generic paperclip-pixels-prod-secrets \
  --dry-run=client -o yaml \
  --from-literal=BETTER_AUTH_SECRET="$BETTER_AUTH_SECRET" \
  --from-literal=PAPERCLIP_PIXEL_FEED_TOKEN="$FEED_TOKEN" \
  --from-literal=PAPERCLIP_PIXEL_API_TOKEN="${PAPERCLIP_PIXEL_API_TOKEN:-}" \
  --from-literal=POSTGRES_USER="${POSTGRES_USER:-paperclip}" \
  --from-literal=POSTGRES_PASSWORD="$POSTGRES_PASSWORD" \
  --from-literal=POSTGRES_DB="${POSTGRES_DB:-paperclip}" \
  --from-literal=DATABASE_URL="$DATABASE_URL" \
  | kubectl apply -f - >/dev/null

[ -z "$IMAGE_PAPERCLIP_DIGEST" ] && { echo "set IMAGE_PAPERCLIP_DIGEST (sha256:...)" >&2; exit 1; }
[ -z "$IMAGE_PIXEL_AGENTS_DIGEST" ] && { echo "set IMAGE_PIXEL_AGENTS_DIGEST (sha256:...)" >&2; exit 1; }

echo "==> helm upgrade (digest-pinned)"
helm upgrade --install paperclip-pixels "$CHART_DIR" -n "$NS" \
  --set image.paperclipHost.tag="$IMAGE_TAG" \
  --set image.paperclipHost.digest="$IMAGE_PAPERCLIP_DIGEST" \
  --set image.pixelAgents.tag="$IMAGE_TAG" \
  --set image.pixelAgents.digest="$IMAGE_PIXEL_AGENTS_DIGEST" \
  --set secrets.existingSecret=paperclip-pixels-prod-secrets \
  "$@"

echo "==> done. Watch:"
echo "  kubectl -n $NS rollout status deploy/paperclip-pixels"
