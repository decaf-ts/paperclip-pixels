# Paperclip Pixel — Deployment Operations

Operator documentation for the Paperclip Pixel Agents bridge stack
([PAPERCLIP_PIXELS-2](/SAA/issues/SAA-447) Revision 3, workstream 6). This
covers **deployment** (Docker + Kubernetes/Helm), **configuration**, **HA
sizing**, and **initial company configuration**. Security,
observability, backup/restore, and troubleshooting have their own documents:

- [`SECURITY.md`](SECURITY.md) — secrets, TLS/mTLS, NetworkPolicies, threat
  model.
- [`OBSERVABILITY.md`](OBSERVABILITY.md) — health, metrics, logging, alert
  rules.
- [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) — backup/restore runbook + drill.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — common problems and fixes.

The recommended production path is a **single Helm chart**
(`deploy/helm/paperclip-pixels`) that deploys the two plugins (Paperclip host +
Pixel Agents host) and Postgres together, with independent health checks and a
protocol-compatibility check. The existing `deploy/k8s` kustomize manifests and
`deploy/docker/docker-compose.bridge-stack.yml` remain as the **development
reference** path.

## Stack architecture

| Component | Image | Port(s) | Role |
|-----------|-------|---------|------|
| Postgres | `postgres:17-alpine` | 5432 | Paperclip metadata DB |
| Paperclip host | `ghcr.io/decaf-ts/paperclip-pixel-host:<tag>@sha256:<digest>` | 3100 (API/UI), 9299 (metrics) | Paperclip host with the bridge plugin baked in |
| Pixel Agents | `ghcr.io/decaf-ts/pixel-agents:<tag>@sha256:<digest>` | 8080 (UI, cluster-internal), 8081 (plugin feed), 9299 (metrics) | Standalone Pixel Agents host with the embedding module loaded in-process |

The Paperclip host runs the bridge plugin as a forked worker child process
(installed at first boot via a loopback `local_trusted` bootstrap, then in
`authenticated`/lan mode). The Pixel Agents container loads the bridge
embedding module through the fork CLI's generic `--plugin` loader. The
Paperclip-plugin relay pushes authenticated feed operations to the Pixel
Agents plugin feed endpoint over **https (mTLS) by default**.

## Deploy with Helm (production)

### 1. Pre-requisites

- A Kubernetes cluster ≥ 1.27 with a NetworkPolicy-capable CNI
  (Calico/Cilium/Weave).
- `helm`, `kubectl`.
- A registry credential secret to pull the digest-pinned images from
  `ghcr.io/decaf-ts` (imagePullSecrets).
- A secret-manager-backed `Secret` in the target namespace.
- AWS/GCP/other storage for backups (optional, see
  [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md)).

### 2. Populate images / secrets

Copy `deploy/helm/paperclip-pixels/values.production.yaml` to a local values
file, set the real digests recorded by the CI publish step, and create the
secret out-of-band:

```bash
NAMESPACE=paperclip-pixels
kubectl create ns "$NAMESPACE"

# Create the imagePullSecret for ghcr.io.
kubectl -n "$NAMESPACE" create secret docker-registry image-pull \
  --docker-server=ghcr.io \
  --docker-username="$GH_USER" \
  --docker-password="$GH_PAT"

# Create the application Secret from your secret manager / env.
kubectl -n "$NAMESPACE" create secret generic paperclip-pixels-prod-secrets \
  --from-literal=BETTER_AUTH_SECRET="$(openssl rand -hex 32)" \
  --from-literal=PAPERCLIP_PIXEL_FEED_TOKEN="$(openssl rand -hex 32)" \
  --from-literal=PAPERCLIP_PIXEL_API_TOKEN="$(board api key)" \
  --from-literal=POSTGRES_USER="paperclip" \
  --from-literal=POSTGRES_PASSWORD="$(openssl rand -hex 24)" \
  --from-literal=POSTGRES_DB="paperclip" \
  --from-literal=DATABASE_URL="postgres://paperclip:$(openssl rand -hex 24)@<svc>-postgres:5432/paperclip" \
  --from-file=FEED_CA=./certs/ca.pem \
  --from-file=FEED_SERVER_CERT=./certs/server.pem \
  --from-file=FEED_SERVER_KEY=./certs/server-key.pem \
  --from-file=FEED_CLIENT_CERT=./certs/client.pem \
  --from-file=FEED_CLIENT_KEY=./certs/client-key.pem
```

> **Tip:** `deploy/scripts/init-secrets.sh` performs this and writes the
> digest-pinned values file. It never writes values into the repo.

### 3. Install

```bash
helm upgrade --install paperclip-pixels deploy/helm/paperclip-pixels \
  -n "$NAMESPACE" \
  -f values.production.yaml \
  --set imagePullSecrets[0].name=image-pull
```

Wait for rollout and confirm the protocol-compatibility check:

```bash
kubectl -n "$NAMESPACE" rollout status deploy/paperclip-pixels
kubectl -n "$NAMESPACE" rollout status deploy/paperclip-pixels-pixel-agents
kubectl -n "$NAMESPACE" get pods
```

### 4. Reach the UI

The public Paperclip UI/API is exposed via the Ingress
(`https://<ingress.host>`). To reach it locally:

```bash
kubectl -n "$NAMESPACE" port-forward svc/paperclip-pixels 3100:3100
kubectl -n "$NAMESPACE" port-forward svc/paperclip-pixels-pixel-agents 8080:8080
```

## Deploy with Docker (compose dev fallback)

For a single machine without k8s:

```bash
npm install && npm run build
docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
docker build -t pixel-agents:local        -f deploy/docker/Dockerfile.pixel-agents .

PAPERCLIP_AUTH_SECRET=$(openssl rand -hex 32) \
PAPERCLIP_PIXEL_FEED_TOKEN=$(openssl rand -hex 32) \
  docker compose -f deploy/docker/docker-compose.bridge-stack.yml up
```

The compose profile is the **dev** path (local images). For production use the
Helm chart with digest-pinned registry images.

## Configuration

Key configuration is exposed as chart values (`deploy/helm/paperclip-pixels/values.yaml`):

| Value | Purpose | Default |
|-------|---------|---------|
| `image.paperclipHost.digest` / `image.pixelAgents.digest` | Immutable image pin | empty (use tag) |
| `secrets.existingSecret` | Reference an operator-managed Secret (recommended) | empty |
| `transport.feed.scheme` | `https` (mTLS) or `http` (cleartext) for the feed | `https` |
| `transport.feed.allowedHttpHosts` | Trusted internal cleartext hosts | `[]` |
| `global.tls.*` | Ingress + feed mTLS certs | empty |
| `ingress.*` | Public ingress + cert-manager | disabled |
| `replicaCount.*` | Per-component replicas | 2/2/1 |
| `metrics.*` | ServiceMonitors + alert rules | enabled |
| `backup.*` | Periodic Postgres + plugin-state backup | enabled |
| `initialCompany.config` | Declarative first-company seed | empty |

The Paperclip host's own env (from the deployment template): `PAPERCLIP_BIND`
(must be `lan` in k8s), `PAPERCLIP_DEPLOYMENT_MODE=authenticated`,
`PAPERCLIP_DEPLOYMENT_EXPOSURE=private`, `PAPERCLIP_MIGRATION_AUTO_APPLY=true`,
`PAPERCLIP_ALLOWED_HOSTNAMES` (service DNS name + ingress host), and the feed
scheme/TLS env. The Pixel Agents side reads `PAPERCLIP_PIXEL_FEED_HOST/PORT`,
`PAPERCLIP_PIXEL_FEED_TOKEN`, and the mTLS cert paths.

## HA sizing

The table below is the recommended starting point for a single-tenant
production install (single node). Scale the replicas with the workload; the
PodDisruptionBudget (`pdb.*`) keeps the bridge up during node drains.

| Component | Replicas | Requests | Limits |
|-----------|----------|----------|--------|
| Postgres | 1 (StatefulSet) | 50m / 128Mi | 500m / 512Mi |
| Paperclip host | 2-3 | 200m / 512Mi | 2 / 4Gi |
| Pixel Agents | 2 | 100m / 256Mi | 1 / 1Gi |

- **Postgres** is stateful; keep `replicaCount.postgres = 1` (HA for Postgres
  requires a managed/replicated Postgres, out of scope for the single-node
  reference; see [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) for availability via
  backup).
- **Paperclip host**: bump memory on first-boot if the pod OOMs (the plugin
  worker forks; a fresh-start spike needs ~2Gi+). The chart defaults to 4Gi
  limit. Pair with `pdb.paperclip.minAvailable=1`.
- **Pixel Agents**: CPU-light; the feed + webview fit in 1Gi.
- Enable **node affinity / topology spread** in production to spread the two
  plugin replicas across nodes.

## Initial company configuration (declarative)

Set `initialCompany.config` so the first company and the plugin's
company-scoped feed configuration are applied on first boot, without manual
per-company UI steps:

```yaml
initialCompany:
  config: |
    name: Example Co
    slug: example-co
    logo: ""
    channel: direct
    # pixelAgentsUrl: https://<svc>-pixel-agents:8081
    # pixelAgentsTokenRef: <secret-ref-for-the-feed-token>
    # pixelAgentsAllowedHttpHosts: []
```

The chart writes this to a ConfigMap mounted at
`/paperclip/instances/default/company-init.yaml` and names it in env
`PAPERCLIP_COMPANY_INIT_FILE`. The host image vendors
`deploy/scripts/init-company.sh` (at `/usr/local/bin/init-company.sh`); the
bootstrap entrypoint calls it **best-effort on first boot**, consuming the
same file plus `PAPERCLIP_PIXEL_FEED_TOKEN` / `PAPERCLIP_PIXEL_FEED_URL` /
`PAPERCLIP_PIXEL_ALLOWED_HTTP_HOSTS` from the Deployment env. It registers
the feed token as a company secret and applies the plugin config
(`pixelAgentsUrl` / `pixelAgentsTokenRef` / `pixelAgentsAllowedHttpHosts`) so
the worker→feed relay push is active.

### Relay-feed wiring note (SAA-961 Finding 2)

Plugin config is **company-scoped** and a fresh deployment has zero
`plugin_config` rows, so on a truly fresh first boot there is no company yet
and the entrypoint init is a no-op (it exits non-zero, which the entrypoint
treats as "left for later"). After the first company exists (board claim /
sign-up, or your own company import), run the one-time bootstrap:

```bash
kubectl -n "$NAMESPACE" exec deploy/paperclip-pixels -- \
  /usr/local/bin/init-company.sh http://127.0.0.1:3100
```

It auto-discovers the company (slug from `initialCompany.config`, or the
single company) and applies the config. The feed token must be in the
Paperclip container's env (`PAPERCLIP_PIXEL_FEED_TOKEN`); the chart renders it
from the `Secret`. `pixelAgentsUrl` / `pixelAgentsAllowedHttpHosts` are
rendered from `transport.feed.*` via the paperclip Deployment env, so you
typically only need the `slug`/`name` in `initialCompany.config`.

### Appearance catalog (SAA-961 Finding 1)

The WS3 character/appearance catalog is now vendored into the **pixel-agents**
image at `/opt/paperclip-pixel-embedding/assets/characters` (beside the
embedding module, so its ancestor walk finds it) and the WS1
`externalAssetDirectories` grant for that `assets/characters` directory is
baked into the image's `~/.pixel-agents/config.json`. Granting the
`assets/characters` subdirectory (not the embedding root) keeps the WS4-C
`declareCharacterCatalog` privilege gate satisfied while avoiding the retired
WS3 merged-array path that would duplicate the characters in the picker. This
gives a fresh two-plugin deployment full appearance support — no manual
`addExternalAssetDirectory` needed. No per-surface change is required;
compose, k8s, and helm all consume the same image.

> **Protocol-compatibility check:** the two plugins must agree on the wire
> `schemaVersion`. The chart ships independent health checks for each plugin
> and a compatibility probe that asserts the negotiated version is supported.
> A version-mismatch fails the readiness gate rather than degrading silently
> (see [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)).

## Upgrades / rollback

Upgrades are immutable-image driven: change `image.*.tag`/`digest`, bump the
chart, and `helm upgrade`. Because each plugin is an independent Deployment with
its own health gate, a rolling upgrade of the paperclip host and pixel-agents
can proceed independently. `schemaVersion` discipline is enforced at the wire
by the compatibility check.

Rollback:

```bash
helm rollback paperclip-pixels <revision>
```

## Related

- [`SECURITY.md`](SECURITY.md) — TLS/mTLS, secrets, NetworkPolicies.
- [`OBSERVABILITY.md`](OBSERVABILITY.md) — metrics, logs, alerts.
- [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) — plugin state + Postgres.
- [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md) — runbook.
