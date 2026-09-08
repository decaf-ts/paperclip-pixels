# Paperclip Pixel — Observability

Health, metrics, structured logging, and alerting for the production stack.

## Health endpoints

| Component | Endpoint | Notes |
|-----------|----------|-------|
| Paperclip host | `GET /api/health` | In `authenticated`/`private` exposure returns 403 for non-loopback callers; k8s probes use a **TCP socket** probe on 3100 (works regardless of auth). |
| Pixel Agents | `GET /api/health` | HTTP probe on 8080. |

The chart wires these probes in the Deployment (`readinessProbe`/`livenessProbe`).
A failed readiness gate prevents traffic; a failed liveness restarts the pod. A
**protocol-compatibility probe** is also in place: if the two plugins negotiate
an unsupported wire `schemaVersion`, the readiness gate fails rather than
silently degrading.

## Metrics

When `metrics.enabled` is true (default in production), the workloads expose a
Prometheus `/metrics` endpoint on port **9299** and the Service objects carry
`prometheus.io/scrape` annotations. The chart ships two **ServiceMonitor**
resources (`monitoring.coreos.com/v1`) for the Prometheus Operator:

- `{{ fullname }}` — scrapes the Paperclip host `metrics` port.
- `{{ fullname }}-pixel-agents` — scrapes the Pixel Agents `metrics` port.

Key metric families (bridge plugin): feed push/ack counts, feed push errors,
reconcile errors, last feed ack timestamp, last reconcile success timestamp.

For a non-Operator Prometheus, scrape via the Service annotations; for
Prometheus **plus** Grafana, enable `metrics.serviceMonitors` and ensure the
`monitoring` namespace is labelled (`kubernetes.io/metadata.name: monitoring`)
so the NetworkPolicy admits the scrape (see [`SECURITY.md`](SECURITY.md)).

## Structured log shipping

Each container emits **structured JSON logs**. Set `logship.enabled: true` to
add a Vector sidecar that ships the app logs to a configured endpoint
(`logship.url`) with a token (`logship.token`); the values are injected from the
`logship` Secret. Without a Vector endpoint, set `LOG_FORMAT=json` so
logs are emitted as JSON to stdout and a DaemonSet/agent can collect them
(pod annotations `logging.paperclip.io/format: json` are set).

```bash
kubectl -n "$NS" logs deploy/paperclip-pixels      # JSON lines
kubectl -n "$NS" logs deploy/paperclip-pixels-pixel-agents
```

## Alert rules

When `metrics.alerting.enabled` is true, the chart creates a
**PrometheusRule** (`monitoring.coreos.com/v1`) with:

| Alert | Condition | Severity | Meaning |
|-------|-----------|----------|---------|
| `PixelAgentsFeedStall` | No feed ack for 5m | warning | The Paperclip bridge is not reaching Pixel Agents |
| `PixelAgentsFeedLoss` | >20 feed push errors in 5m | critical | Operations may be lost |
| `PixelBridgeReconcileFailures` | Reconcile errors in 10m | warning | Periodic reconciliation is failing |
| `PixelBridgeReconcileStale` | No successful reconcile for 1h | warning | Bridge feed may be drifting |

Wire these to a notification route (Slack/PagerDuty) in your Prometheus
Alertmanager. Tune thresholds to your feed rate.

## Related

- [`OPERATIONS.md`](OPERATIONS.md) · [`SECURITY.md`](SECURITY.md) ·
  [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) · [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
