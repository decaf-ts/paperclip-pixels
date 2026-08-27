# Integration Host — reproducible live Paperclip + Pixel bridge plugin

Brings up an ephemeral, reproducible live Paperclip instance (embedded
Postgres, `local_trusted` loopback, no login) and loads the Pixel bridge plugin
— this repo's own root package, `@decaf-ts/paperclip-pixels` — via the
**real** Paperclip plugin-loader (`POST /api/plugins/install`, local-path
install).

## Path

Boots the Paperclip server **from the `paperclip/` git-submodule source** with
an ephemeral embedded Postgres (no `DATABASE_URL`), then installs the plugin
from its built `dist/`. This (option B) is used instead of the Docker
quickstart because the plugin's built `dist/worker.js` is fully self-contained
(esbuild inlines `src/core`, `src/pixel-agents-provider`, the plugin SDK, and
zod — see `scripts/build.mjs`), so it resolves on the host filesystem with
nothing to vendor; running the *server* from source (rather than the
published image) keeps the whole stack's dependency graph in one place for
fast iteration.

Key mechanism: the host plugin-loader adds the `tsx` `--import` loader for
**any** local-path install (`activePlugin.packagePath` set + the submodule tsx
loader present — `paperclip/server/src/services/plugin-loader.ts`), so the
plugin worker can resolve the workspace `@paperclipai/shared` TypeScript-source
exports at runtime. That requires the submodule's pnpm workspace to be
installed **with devDependencies** (tsx is a devDep of `cli`/`server`).

Dependency wiring: `@paperclipai/plugin-sdk` and `@paperclipai/shared` can't be
real npm dependencies of this package (`plugin-sdk`'s own `package.json`
depends on `shared` via the pnpm/yarn-only `workspace:*` protocol, which plain
npm can't resolve even via `file:`). `scripts/link-paperclip-sdk.mjs` (this
repo's root `postinstall` hook) symlinks them into `node_modules/@paperclipai/`
instead; `up.sh` re-runs it defensively before boot.

## Exact reproduce commands

From the repo root:

```bash
# 0. One-time prerequisites (submodule deps with devDeps, plugin built).
( cd paperclip && env -u NODE_ENV NODE_ENV=development CI=true pnpm install --frozen-lockfile )
npm run build

# 1. Reproducible one-shot bring-up + plugin load + evidence + teardown:
scripts/integration-host/run.sh

#    To leave the server up for Tester (does NOT tear down on success):
#       KEEP_UP=1 scripts/integration-host/run.sh

# 2. Tear down explicitly (stops server + drops ephemeral embedded Postgres):
scripts/integration-host/down.sh
```

`run.sh` exits `0` only when the plugin registered (the
`"Paperclip Pixel Bridge worker starting"` log line is captured). Evidence is
written to `$INTEGRATION_HOME/evidence.txt` and printed to stdout.

## Current status — fully verified

Verified working end-to-end (reproducible, ~15s cold boot on a fresh ephemeral
home):

- Host boots on an ephemeral port with all migrations applied and a clean
  embedded DB (`GET /api/health` → `{"status":"ok",...}`, `deploymentMode:
  local_trusted`).
- Plugin is installed via the real loader (`POST /api/plugins/install`,
  `isLocalPath:true`); the manifest validates (the `jobs.schedule` capability
  is declared) and the plugin registers in the registry
  (`GET /api/plugins` lists it; health checks `registry`/`manifest`/`status`
  all pass).
- **Registration**: the worker's `ctx.logger.info("Paperclip Pixel Bridge
  worker starting")` line (`src/worker.ts`) is captured from the host log (the
  host re-emits worker logs as `[plugin] ...`).
- **Subscriptions**: the worker's `setup()` registers `ctx.events.on(eventType)`
  for each of the 12 `SUBSCRIBED_EVENT_TYPES` (`src/constants.ts`); the host's
  own activation log reports `registered.eventSubscriptions: 12` directly
  (`plugin-loader: plugin activated successfully`).
- `GET /api/plugins/:id/health` → `{"status":"ready","healthy":true}` with all
  three checks (`registry`/`manifest`/`status`) passing.
- Clean teardown: server SIGTERM does ordered shutdown (stops the embedded
  Postgres it started); the ephemeral `PAPERCLIP_HOME` (DB data dir) is
  removed. The server is launched as a single `node --import <tsx loader>`
  process (no `tsx` CLI wrapper child), so `down.sh` kills it reliably with no
  orphans.

(An earlier revision of this project hit a real blocker here: the plugin
worker — ESM — imported a `@paperclip-pixel/core` package whose `exports` map
declared only a CJS `require` condition, so Node's ESM resolver threw
`ERR_PACKAGE_PATH_NOT_EXPORTED` on worker init. That's now structurally
impossible — `core` is no longer a separate package with its own `exports`
map at all; it's a plain `src/core/` subdirectory of this one package,
consumed via ordinary relative TypeScript imports.)

## Configuration (env overrides)

| Var | Default | Notes |
| --- | --- | --- |
| `PAPERCLIP_PORT` | `13100` | 3100 is the run host; override freely. |
| `INTEGRATION_HOME` | `mktemp -d` | `PAPERCLIP_HOME`; embedded Postgres data dir lives under it and is removed on teardown. |
| `INTEGRATION_INSTANCE` | `integration` | `PAPERCLIP_INSTANCE_ID`. |
| `KEEP_UP` | unset | `1` leaves the server running after success. |
| `SKIP_SERVER_INSTALL` | unset | `1` skips the submodule `pnpm install` prereq check. |
| `PAPERCLIP_LOG_LEVEL` | `debug` | Lower to `info` to reduce noise. |

## Files

- `up.sh` — boot host, install plugin, capture evidence (writes `.run-state`).
- `down.sh` — stop server + drop ephemeral home (reads `.run-state`).
- `run.sh` — one-shot: `down` (clear stale) → `up`.
