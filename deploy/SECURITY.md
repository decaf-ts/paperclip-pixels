# Paperclip Pixel — Security

Security posture for the production deployment. The core principles: **no
secret material in the repo**, **TLS/mTLS on by default** (cleartext only for
explicitly configured internal hosts), **implicit-deny networking**, and
**immutable images**.

## No secret material in the repo

- The k8s manifests (`deploy/k8s/*.yaml`) reference Secrets by name; the
  values are generated at apply time from the git-ignored
  `deploy/k8s/secrets.env` (`kustomize secretGenerator`). The previous
  committed dev auth secret
  (`paperclip-pixels-dev-auth-secret-change-me`) was removed.
- The Helm chart (`deploy/helm/paperclip-pixels`) renders a Secret only from
  install-time values (`--set`/`--set-file`) **or** references a
  `secrets.existingSecret`. Defaults carry no secret value; `helm install`
  fails closed if required secrets are missing.

Verify with grep (must return nothing):

```bash
# No literal-looking secret values in tracked deploy manifests / chart.
grep -RniE "secret-change-me|BEGIN (RSA |EC |)PRIVATE KEY|PAPERCLIP_PIXEL_FEED_TOKEN=[A-Za-z0-9]{8,}|BETTER_AUTH_SECRET=[A-Za-z0-9]{8,}" deploy/ \
  || echo "no secret material"
```

## Secrets set

| Secret | Key(s) | Purpose |
|--------|--------|---------|
| App Secret | `BETTER_AUTH_SECRET` | Paperclip host (Better Auth) signing secret |
| Feed secret | `PAPERCLIP_PIXEL_FEED_TOKEN` | Shared bearer secret for `POST /api/plugin-feed` |
| Reply key | `PAPERCLIP_PIXEL_API_TOKEN` | Board API key for the click-menu reply forwarder (optional) |
| Postgres | `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB`, `DATABASE_URL` | Paperclip metadata DB credentials |
| mTLS feed | `FEED_CA`, `FEED_SERVER_CERT`, `FEED_SERVER_KEY`, `FEED_CLIENT_CERT`, `FEED_CLIENT_KEY` | Mutual TLS for the in-cluster feed channel |
| Registry | docker-registry `imagePullSecrets` | Pull the digest-pinned `ghcr.io` images |

Use a secret manager (Vault, AWS Secrets Manager, SOPS) to inject these into a
`Secret` out-of-band; never commit or inline the values.

## Transport: TLS/mTLS default

TLS/mTLS is the production **default** (board amendment — configurable, not
mandatory). Cleartext HTTP remains available only for explicitly declared
internal hosts.

- **Public ingress:** the Ingress serves the Paperclip UI/API over HTTPS via
  cert-manager (default) or a supplied leaf cert / existing secret.
- **Feed channel (Paperclip → Pixel Agents):** `transport.feed.scheme` defaults
  to `https` and the chart mounts a CA + client cert (Paperclip side) and CA +
  server cert (Pixel Agents side) so the feed is **mutually authenticated**. The
  plugin config must match (`pixelAgentsUrl` `https://…`, the
  `pixelAgentsTokenRef` secret, and no `pixelAgentsAllowedHttpHosts`).
- **Cleartext escape hatch:** set `transport.feed.scheme: http` and
  `transport.feed.allowedHttpHosts: ["<host>"]` only for an explicitly trusted
  internal peer (or the dev path). This is the identical contract the runtime
  enforces for a token-bearing feed on a non-loopback host.

## NetworkPolicies (implicit deny)

The chart ships a default-deny model (`deploy/helm/paperclip-pixels/templates/networkpolicy.yaml`):

- `default-deny` — no ingress to any pod unless admitted.
- `feed-from-paperclip` — the plugin feed port is reachable **only** from the
  Paperclip host pod(s); without this policy the feed is unreachable.
- `postgres-from-paperclip` — Postgres reachable only from the Paperclip pod.
- `ingress-to-paperclip` — the public ingress controller may reach the Paperclip
  host on 3100 (`ingress-nginx` namespace must exist).
- `metrics-scrape` — the monitoring namespace may scrape the metrics ports.

These require a NetworkPolicy-capable CNI (Calico/Cilium/Weave). **Kubelet
probe note:** with a default-deny Ingress, the CNI must allow node→pod health
probes (Calico/Cilium do by default). If probes fail after applying, reconcile
the CNI's host-endpoint handling or add an explicit nodeSelector for the
kubelet traffic.

## Image immutability

Production images are **digest-pinned** (`image.*.digest`), pushed by the CI
pipeline with OIDC provenance + SBOM attestations (`publish.yml`). `pullPolicy`
is `IfNotPresent`, so a running deployment never silently picks up a mutable
`:latest` tag. `:local` images (`imagePullPolicy: Never`) are the **dev** path
only.

## Threat model (summary)

| Threat | Control |
|--------|---------|
| Compromised feed endpoint | Shared-secret bearer auth, fail-closed (module refuses to start without token) |
| Feed eavesdropping / tampering | mTLS on the feed channel (default) |
| New-work smuggling | Fail-closed invariant: Pixel Agents may request actions, never create work; Paperclip authorizes |
| Unauthorized DB access | NetworkPolicy + secrets, Postgres reachable only from the Paperclip pod |
| Mutable / unverified images | Digest pinning + OIDC provenance + SBOM |
| Secret leakage in repo | No committed secrets; git-ignored env; fail-closed chart |

## Related

- [`OPERATIONS.md`](OPERATIONS.md) · [`OBSERVABILITY.md`](OBSERVABILITY.md) ·
  [`BACKUP_RESTORE.md`](BACKUP_RESTORE.md) · [`TROUBLESHOOTING.md`](TROUBLESHOOTING.md)
