## Testing

The bridge's tests are split by execution need (all commands verified against the `package.json` scripts):

- **`plugins/paperclip/`** — three suites:
  - `npm run test:domain` — pure core/domain logic (jest, `jest.config.domain.ts`);
  - `npm run test:worker` — worker/relay/actions (vitest — ESM-native handling of the real Paperclip plugin SDK test harness);
  - `npm test` — UI components (jest + jsdom + React Testing Library, `jest.config.ts`);
  - `npm run test:all` runs all three in sequence (plus `test:perf`).
- **`common/`** — contract tests (vitest), run standalone from its own directory.
- **`plugins/pixel-agents/`** — feed mapper/server, embedding, forwarder, appearance (vitest), run standalone from its own directory.
- **Fork** (`pixel-agents/`) — its own server/webview unit suites plus standalone Playwright e2e; `npm run check-types` must pass from a clean clone (kept green by the Revision 3 fork-boundary repair).
- **End-to-end** (`e2e/`) — canonical Playwright suites run against the disposable compose stack in `deploy/docker/` (see [`deploy/README.md`](../../deploy/README.md) for the build/deploy/run runbook).
