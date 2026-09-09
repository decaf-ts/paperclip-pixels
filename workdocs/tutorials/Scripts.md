### Scripts

The repo root is a private npm **workspace root** (not a publishable package): `"workspaces": ["common", "plugins/paperclip", "plugins/pixel-agents"]`. There is no combined root build or test suite — every build/test runs inside the package that owns the code.

Root-level scripts (orchestration only):

- `postinstall` (`scripts/link-paperclip-sdk.mjs`) - symlinks the Paperclip plugin SDK reference packages from the `paperclip/` submodule into `node_modules/@paperclipai/` (run automatically on `npm install`);
- `lint` - ESLint across all workspace packages (`npm run lint --workspaces`);
- `prepare-release` - lint + typecheck + build + tests across all workspace packages, run before tagging;
- `release` - tags a release via `./bin/tag-release.sh`;
- `pixel-agents:sync-legacy` - syncs the fork's legacy branch bookkeeping (`scripts/sync-pixel-agents-legacy.mjs`).

Per-package scripts (run from inside each package directory):

- `common` (`@decaf-ts/paperclip-pixels-common`) - `build`, `typecheck`, `test` (vitest), `test:watch`, `lint`;
- `plugins/pixel-agents` (`@decaf-ts/pixel-agents-paperclip-plugin`) - `build` (tsc output plus the self-contained `dist/pixel-agents-embedding.cjs` the fork's generic `--plugin` loader loads), `typecheck`, `test` (vitest), `test:watch`, `lint`;
- `plugins/paperclip` (`@decaf-ts/paperclip-pixels-plugin`) - `build` / `build:worker` / `build:ui` / `build:types` (esbuild worker + UI bundle + declaration types), `typecheck` / `typecheck:ui`, `lint`, and the test suites: `test:domain` (jest), `test:worker` (vitest), `test` (UI, jest + jsdom + React Testing Library), `test:perf`, and `test:all` (all suites in sequence).

Tip: `npm run build --workspaces` (or `npm run test --workspaces`) runs a script across all three packages from the root; `common` runs first because both plugins depend on it.
