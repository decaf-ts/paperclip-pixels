# @decaf-ts/paperclip-pixels-plugin

Independent Paperclip plugin for the Paperclip <-> Pixel Agents bridge
(PAPERCLIP_PIXELS-2, board Revision 3 "two-plugin" architecture).

This package is the Paperclip side of the bridge: the Paperclip SDK worker,
the Pixel Office UI (`page` + `sidebar` slots), persistence, metrics, policy,
snapshot/event normalization, reconciliation, and the outbound feed mapper +
HTTP sink / retry client that pushes feed operations to the Pixel Agents
plugin's `POST /api/plugin-feed` endpoint.

It depends only on `@decaf-ts/paperclip-pixels-common` (the neutral wire-contract
package at `./common`) plus its own runtime deps (the host plugin SDK,
`@paperclipai/shared`, `zod`, `ws`). It never imports the
`pixel-agents-paperclip-plugin` package or the `pixel-agents/` fork internals.

## Relationship to the former combined entry

The former combined root npm entry (the pre-split single package that bundled
both plugins and the Paperclip plugin source) was the **temporary combined
entry** that the board's migration plan preserved during the transition. It has
since been removed (Revision 3, migration-plan step 4) once a documented,
tested migration path existed for Compose, Kubernetes, and current users.

This package is the canonical home for the Paperclip-plugin worker + UI +
core. The former outer `src/` mirror and its push-side re-export shims were
retired with the combined entry.

## Build + typecheck (standalone)

From this package dir:

```bash
npm run build         # esbuild worker + manifest + UI, then tsc types
npm run typecheck     # worker/domain TS
npm run typecheck:ui  # UI TS (jsdom test tsconfig)
```

## Test (standalone)

```bash
npm run test:all      # domain (jest) + worker (vitest) + UI (jest) suites
```

The three suites mirror the outer combined entry: `test:domain` (core
translation/metrics under `test/core`), `test:worker` (worker/relay/actions
via vitest), and `test` (UI components under `src/ui` via jest + jsdom).
The character catalog used by the UI picker and the appearance action ships
in the published package under `assets/characters/`.
