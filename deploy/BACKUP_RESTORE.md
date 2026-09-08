# Paperclip Pixel — Backup & Restore

Backs up **plugin state** (the Paperclip host home PVC, which holds the bridge
plugin's worker/registry state) and **Postgres** (the Paperclip metadata DB
where companies, agents, and bridge state live). Restore returns both.

## What is backed up

| Data | Where | Backup mechanism |
|------|-------|------------------|
| Postgres | `{{ <fullname> }}-postgres` StatefulSet | `pg_dump -Fc` (logical dump, compressed) |
| Plugin state | `{{ <fullname> }}-data` PVC (Paperclip home `/paperclip`) | `tar czf` archive |

Both are written to the `{{ <fullname> }}-backup` PVC by a scheduled
**CronJob** (`backup.*`). Artifact naming: `postgres-<ts>.dump.gz` and
`paperclip-home-<ts>.tar.gz`, pruned to `backup.retention`.

## Enable

```bash
helm upgrade --install paperclip-pixels deploy/helm/paperclip-pixels \
  -f values.production.yaml \
  --set backup.enabled=true --set backup.schedule="0 2 * * *" --set backup.retention=7
```

## Manual backup (ad-hoc)

```bash
# Run the backup CronJob manually.
kubectl -n "$NS" create job --from=cronjob/paperclip-pixels-backup manual-backup
kubectl -n "$NS" wait --for=condition=complete job/manual-backup --timeout=300s
# List artifacts on the backup volume.
kubectl -n "$NS" exec -it $POD -- ls -lh /backup
```

Or from the operator host against the live DB:

```bash
kubectl -n "$NS" exec -it $(kubectl -n "$NS" get pod -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}') -- \
  pg_dump -U paperclip -d paperclip -Fc | gzip > postgres-backup.dump.gz
```

## Restore

### 1. Postgres

```bash
kubectl -n "$NS" exec -it $(kubectl -n "$NS" get pod -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}') -- \
  pg_restore -U paperclip -d paperclip --clean --if-exists < postgres-backup.dump.gz
```

(Or `gunzip -c postgres-backup.dump.gz | kubectl exec -i … -- pg_restore …`.)

### 2. Plugin state

Scale the Paperclip host down before restoring the home PVC so nothing writes
concurrently, then restore the archive:

```bash
kubectl -n "$NS" scale deploy/paperclip-pixels --replicas 0
kubectl -n "$NS" exec -it $(kubectl -n "$NS" get pod -l job-name=manual-backup -o jsonpath='{.items[0].metadata.name}') -- \
  tar xzf /backup/paperclip-home-<ts>.tar.gz -C /paperclip
kubectl -n "$NS" scale deploy/paperclip-pixels --replicas <n>
```

## Restore runbook (full)

1. Stop the application (`scale deploy … --replicas 0`).
2. Restore Postgres (above).
3. Restore plugin state (above).
4. Start the application.
5. Verify (`GET /api/health` returns ok; the plugin worker is up; the feed
   reconciles; the Paperclip UI lists the restored company/agents).

## Drill (backup/restore executed once)

The acceptance criterion requires the backup/restore drill to be executed **once**
with evidence recorded here. Run it in a reachable cluster:

```bash
NS=paperclip-pixels
# 1. Create a marker row / know the current state.
kubectl -n "$NS" exec -it $(kubectl -n "$NS" get pod -l app.kubernetes.io/component=postgres -o jsonpath='{.items[0].metadata.name}') -- \
  psql -U paperclip -d paperclip -c "select count(*) from company;"
# 2. Snapshot.
kubectl -n "$NS" create job --from=cronjob/paperclip-pixels-backup drill-backup
kubectl -n "$NS" wait --for=condition=complete job/drill-backup --timeout=300s
# 3. (optional) mutate to prove restore, e.g. drop a company, then restore the DB dump.
# 4. Restore (above) and confirm the marker/company is back.

# 5. Record evidence (timestamp, job names, before/after counts) here and in the
#    issue comment.
```

### Drill evidence

| Field | Value |
|-------|-------|
| Date/drill run | _pending — see note below_ |
| Env | _cluster_ |
| Backup job | `manual-backup` / `drill-backup` |
| DB count before / after | _/_ |
| Plugin-state archive | `paperclip-home-<ts>.tar.gz` |
| Restore result | _ok_ |

> **Note (this delivery):** the chart, CronJob, and restore procedures are in
> place, but the live drill could not be executed in the authoring environment —
> the sandbox minikube API server was unreachable (`kubectl` → `connection
> refused`, see the issue comment). The command sequence above is the runnable
> drill; run it in a reachable cluster to close out the acceptance criterion.

## Related

- [`OPERATIONS.md`](OPERATIONS.md) · [`SECURITY.md`](SECURITY.md) ·
  [`OBSERVABILITY.md`](OBSERVABILITY.md) · [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
