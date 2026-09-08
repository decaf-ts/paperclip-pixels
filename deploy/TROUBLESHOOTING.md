# Paperclip Pixel — Troubleshooting

Operator runbook for common production issues.

## Feed not reaching Pixel Agents

Symptoms: `PixelAgentsFeedStall` / `PixelAgentsFeedLoss` alerts, no agents
declared in the UI.

Checks:

```bash
kubectl -n "$NS" exec -it deploy/paperclip-pixels -- curl -s \
  "https://<svc>-pixel-agents:8081/api/plugin-feed" -k
# expect 401 (auth) not connection-refused
kubectl -n "$NS" logs deploy/paperclip-pixels | grep -i feed
kubectl -n "$NS" logs deploy/paperclip-pixels-pixel-agents | grep -i feed
```

Common causes:
- The plugin's company-scoped config `pixelAgentsUrl` still points at the wrong
  host (default `http://127.0.0.1:8081` is wrong for the containerized
  topology), or the company has **no `plugin_config` row** so the relay push
  never fires. Run the one-time bootstrap (`deploy/scripts/init-company.sh`)
  after the first company exists — see `deploy/OPERATIONS.md`.
- The feed **shared secret** differs between the Paperclip plugin config
  (`pixelAgentsTokenRef`) and `PAPERCLIP_PIXEL_FEED_TOKEN`. The feed endpoint
  returns `401` on mismatch; the plugin module refuses to start without a token.
- **TLS/mTLS mismatch:** if `transport.feed.scheme=https`, the paperclip client
  cert / CA and the pixel-agents server cert must match. A handshake failure
  looks like a feed stall. Drop to `http` + `allowedHttpHosts` only for an
  explicitly trusted internal host (dev).
- `paperclip_appearance_catalog_unavailable` (ENOENT
  `/opt/assets/characters/catalog.json`) in the pixel-agents logs means the
  character catalog is not beside the embedding module. With an up-to-date
  pixel-agents image the catalog is vendored at
  `/opt/paperclip-pixel-embedding/assets/characters` and the
  `externalAssetDirectories` grant is baked into `~/.pixel-agents/config.json`;
  a stale image (built before SAA-961) degrades to built-in palettes.

## Paperclip host not ready

- `/api/health` returns 403 for non-loopback callers in `authenticated`/`private`
  mode — that is expected. Use the TCP socket probe; if the port accepts a
  connection the server is up.
- First-boot OOM: bump `resources.paperclip.limits.memory` (needs ~2Gi+ at
  startup; chart defaults to 4Gi).
- `PAPERCLIP_ALLOWED_HOSTNAMES` must include the in-cluster Service DNS name
  and the ingress host, or requests answer `403 Hostname '…' is not allowed`.

## Pod stuck ImagePullBackOff

- The image is digest-pinned from `ghcr.io/decaf-ts`; ensure the
  `imagePullSecrets` secret exists and the registry credentials are valid.
- Dev path uses `:local` + `imagePullPolicy: Never` — the image must be loaded
  into the cluster first (`minikube image load`).

## Probes failing after NetworkPolicies

- With a default-deny Ingress, the CNI must allow node→pod kubelet probes. If
  liveness/readiness fail after applying the policies, reconcile the CNI's
  host-endpoint handling (Calico/Cilium do this by default) or add an explicit
  egress/ingress allowance for kubelet traffic.

## Reconciliation failing / stale

- `PixelBridgeReconcileFailures` / `PixelBridgeReconcileStale`: check the bridge
  worker logs and that the feed is reachable (above). Confirm the periodic
  `bridge-reconcile` job runs.

## Restart / rollback

```bash
kubectl -n "$NS" rollout restart deploy/paperclip-pixels
kubectl -n "$NS" rollout restart deploy/paperclip-pixels-pixel-agents
helm rollback paperclip-pixels <revision>
```

## Where to find logs / metrics

- Logs: `kubectl -n "$NS" logs deploy/paperclip-pixels` (JSON when
  `LOG_FORMAT=json`).
- Metrics: scrape the `metrics` (9299) port; ServiceMonitors ship with the chart
  (see [`OBSERVABILITY.md`](OBSERVABILITY.md)).

## Related

- [`OPERATIONS.md`](OPERATIONS.md) · [`SECURITY.md`](SECURITY.md) ·
  [`OBSERVABILITY.md`](OBSERVABILITY.md) · [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md)
