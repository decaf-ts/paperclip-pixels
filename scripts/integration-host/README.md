# Integration Host — reproducible live Paperclip + Pixel bridge plugin

Brings up an ephemeral, reproducible live Paperclip instance (embedded
Postgres, `local_trusted` loopback, no login) and loads the Pixel bridge plugin
from `packages/paperclip-plugin` via the **real** Paperclip plugin-loader
(`POST /api/plugins/install`, local-path install).

Tester's integration-test sibling blocks on this bring-up.

## Path

Boots the Paperclip server **from the `paperclip/` git-submodule source** with an
ephemeral embedded Postgres (no `DATABASE_URL`), then installs the plugin from
its built `dist/`. This (option B) is used instead of the Docker quickstart
because the plugin imports `@paperclip-pixel/core` and `@paperclipai/plugin-sdk`,
whose dependency graph already resolves on the host filesystem; running from
source keeps that graph intact.

Key mechanism: the host plugin-loader adds the `tsx` `--import` loader for **any**
local-path install (`activePlugin.packagePath` set + the submodule tsx loader
present — `paperclip/server/src/services/plugin-loader.ts`), so the plugin worker
can resolve the workspace `@paperclipai/shared` TypeScript-source exports at
runtime. That requires the submodule's pnpm workspace to be installed **with
devDependencies** (tsx is a devDep of `cli`/`server`).

Dependency wiring: the plugin declares `@paperclipai/plugin-sdk: workspace:*`
and `@paperclip-pixel/core: ^0.1.0`, but those packages live across a submodule
boundary (`plugin-sdk` in `paperclip/packages/plugins/sdk`) / in the sibling
`packages/core`, and this outer repo has no `pnpm-workspace.yaml` to resolve
`workspace:*`. The pre-existing environment already symlinks `@paperclipai/shared`
and `zod` into the plugin's `node_modules`; `up.sh` completes that set
idempotently (`@paperclipai/plugin-sdk` → submodule sdk, `@paperclip-pixel/core`
→ `packages/core`) so the worker can resolve its imports.

## Exact reproduce commands

From the repo root (`/workspaces/paperclip-pixels`):

```bash
# 0. One-time prerequisites (submodule deps with devDeps, plugin built).
( cd paperclip && env -u NODE_ENV NODE_ENV=development CI=true pnpm install --frozen-lockfile )
( cd packages/paperclip-plugin && pnpm run build )

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

## Current status — what works and what is blocked

Verified working (reproducible, ~22s cold boot on a fresh ephemeral home):

- Host boots on an ephemeral port with all 225 migrations applied and a clean
  embedded DB (`GET /api/health` → `{"status":"ok",...}`, `deploymentMode:
  local_trusted`).
- Plugin is installed via the real loader (`POST /api/plugins/install`,
  `isLocalPath:true`); the manifest **validates** (the `jobs.schedule` capability
  is declared) and the plugin registers in the registry
  (`GET /api/plugins` lists it; health checks `registry` + `manifest` pass).
- Clean teardown: server SIGTERM does ordered shutdown (stops the embedded
  Postgres it started); the ephemeral `PAPERCLIP_HOME` (DB data dir) is removed.
  The server is launched as a single `node --import <tsx loader>` process (no
  `tsx` CLI wrapper child), so `down.sh` kills it reliably with no orphans.

**BLOCKED — bridge-side defect** (cannot register/subscribe until fixed):

The worker (`packages/paperclip-plugin/dist/worker.js`, ESM) does
`import { BridgeStore, ... } from "@paperclip-pixel/core"`, but
`packages/core/package.json` `exports` declares **only** a CJS `require`
condition:

```json
"exports": { ".": { "require": "./dist/index.js", "types": "./dist/index.d.ts" } },
"type": "commonjs"
```

Node's ESM resolver (and the tsx loader) throws
`ERR_PACKAGE_PATH_NOT_EXPORTED: No "exports" main defined in
.../@paperclip-pixel/core/package.json` because there is no `import`/`default`
condition to match an `import`. The worker process exits (code 1) during
initialize; plugin status goes `ready → error`. A global `--conditions=require`
workaround is NOT viable: it makes the **server itself** crash
(`@cursor/sdk` and other server adapter ESM deps lose their named exports via
CJS interop). The fix belongs to the bridge owner in `packages/core`:

  - Minimal: add `"default": "./dist/index.js"` (or `"import": "./dist/index.js"`)
    to `exports["."]` — `dist/index.js` uses `exports.X = ...` style, so
    `cjs-module-lexer` will expose the named exports to ESM importers.
  - Proper: rebuild `core` as ESM (`module: node16`/`es2022`, `"type":"module"`,
    `import`/`export`).

Until that lands, `run.sh` exits `1` and the registration/subscription evidence
below is **not** captured.


## Configuration (env overrides)

| Var | Default | Notes |
| --- | --- | --- |
| `PAPERCLIP_PORT` | `13100` | 3100 is the run host; override freely. |
| `INTEGRATION_HOME` | `mktemp -d` | `PAPERCLIP_HOME`; embedded Postgres data dir lives under it and is removed on teardown. |
| `INTEGRATION_INSTANCE` | `integration` | `PAPERCLIP_INSTANCE_ID`. |
| `KEEP_UP` | unset | `1` leaves the server running after success. |
| `SKIP_SERVER_INSTALL` | unset | `1` skips the submodule `pnpm install` prereq check. |
| `PAPERCLIP_LOG_LEVEL` | `debug` | Lower to `info` to reduce noise. |

## What the script proves (once the bridge `core` exports defect is fixed)

- Host boots on an ephemeral port with migrations applied and a clean embedded DB
  (`GET /api/health` → `status:ok`). *(verified)*
- Plugin is installed via the real loader (`POST /api/plugins/install`,
  `isLocalPath:true`) and the manifest validates. *(verified)*
- **Registration** *(pending)*: the worker's
  `ctx.logger.info("Paperclip Pixel Bridge worker starting")` line
  (`packages/paperclip-plugin/src/worker.ts`) is captured from the host log (the
  host re-emits worker logs as `[plugin] ...`).
- **Subscriptions** *(pending)*: the worker's `setup()` registers
  `ctx.events.on(eventType)` for each of the 12 `SUBSCRIBED_EVENT_TYPES`
  (`packages/paperclip-plugin/src/constants.ts`); the host event bus stores these
  silently, so setup() completing — worker started + `GET
  /api/plugins/:id/health` → `onHealth` `{status:"ok",message:"Bridge worker
  running"}` — is the signal all 12 subscriptions registered.
- Clean teardown: server SIGTERM stops the embedded Postgres it started; the
  ephemeral `PAPERCLIP_HOME` (DB data dir) is removed. *(verified)*

## Files

- `up.sh` — boot host, install plugin, capture evidence (writes `.run-state`).
- `down.sh` — stop server + drop ephemeral home (reads `.run-state`).
- `run.sh` — one-shot: `down` (clear stale) → `up`.
