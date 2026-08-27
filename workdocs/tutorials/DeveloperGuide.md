# Developer Guide — Paperclip ↔ Pixel Agents Bridge

For contributors working on the bridge itself. If you just want to install and use it, see the [package README](../README.md) and the [User Guide](UserGuide.md).

## Repo layout

One package, at the repo root — `@decaf-ts/paperclip-pixels` — the only thing that ever gets published. `paperclip/` and `pixel-agents/` are git submodules kept purely for reference (reading their real source to verify wire contracts, and as a base for possible future upstream contributions) — **never modified**, never a build dependency beyond that.

```
src/
  core/                     Pure translation logic, zero I/O, zero dependency on either upstream project
    domain/                 Raw projection, temporal metrics, behavior vectors, feedback contracts
    reducer/                Idempotent event reducer, reconciliation, in-memory store
    temporal/                Rolling-window ring buffers
    behavior/                Workload/friction/momentum/confidence calculators
    policy/                  New-work intake gate, agent-reply fail-closed gate
  pixel-agents-provider/    Maps core events to Pixel Agents' wire format — the only place that knows it
    event-mapper.ts          BridgeInputEvent -> AgentEvent (sessionStart/toolStart/toolEnd/turnEnd/permissionRequest)
    transport.ts             AgentEvent -> real Claude hook JSON body; HttpPushSink
    behavior-sidecar.ts       Richer per-agent state with no AgentEvent home (concurrency, feedback, metrics)
  worker.ts                 Paperclip plugin entrypoint: snapshot bootstrap, event subscriptions, relay wiring
  manifest.ts                Plugin manifest (capabilities, UI slots, config schema)
  actions.ts                  company.send-message / agent.reply-to-feedback action handlers (the fail-closed gate)
  relay.ts                     Per-company BridgeTransport + HttpPushSink lifecycle, config parsing
  ui/                          The embedded "Pixel Office" dashboard (React, runs inside Paperclip's own UI)
bin/paperclip-pixel-relay.js  The relay CLI (published as this package's `bin`)
scripts/build.mjs             esbuild bundle: inlines src/core + src/pixel-agents-provider + plugin-sdk + zod into dist/
test/
  core/                       Domain logic tests (plain Jest — jest.config.domain.ts)
  pixel-agents-provider/      Wire-mapping tests (plain Jest — jest.config.domain.ts)
  *.test.ts                   Worker/relay/actions tests (Vitest — vitest.config.ts)
deploy/
  k8s/                       Reference Kubernetes stack (Postgres + Paperclip host + Pixel Agents + relay sidecar)
  docker/                    Dockerfiles + the (documented, disclosed) Paperclip host build-time patches
workdocs/tutorials/          This guide + the User Guide (repo convention — `docs/` is gitignored, reserved for generated typedoc output)
```

`src/core/` has zero dependency on either upstream project and zero I/O — pure functions over a canonical `BridgeInputEvent` stream, independently testable and reusable regardless of what either Paperclip or Pixel Agents look like (imported by relative path from everywhere else, never a separate package). `src/pixel-agents-provider/` is the only place that knows Pixel Agents' wire format. The rest of `src/` is the only place that knows Paperclip's plugin SDK.

(Earlier revisions of this project split `core`/`pixel-agents-provider`/the plugin into three separate `packages/*` sub-packages with their own `package.json`s. That added real friction — `workspace:*` dependency references that plain npm can't resolve, three sets of near-duplicate build/test config — for no actual benefit, since only one of the three was ever published and the "workspace" was never a real npm/pnpm workspace to begin with. They're now plain subdirectories of the one real package.)

## The zero-source-change constraint, and how the code honors it

This is the project's hardest requirement and the one most worth understanding before touching the mapping code: **the bridge must work against unmodified Paperclip and unmodified Pixel Agents.** Concretely:

- `pixel-agents-provider/src/pixel-agents-types.ts` is a *structural mirror* of Pixel Agents' public `HookProvider`/`AgentEvent` types — copied by hand from `pixel-agents/core/src/provider.ts`, never imported at runtime. If Pixel Agents' public contract changes, this file needs a manual update and a source-verification note, not a build failure.
- `transport.ts`'s `toClaudeHookBody` serializes into the *exact* wire shape `pixel-agents/server/src/providers/hook/claude/claude.ts`'s `normalizeHookEvent` expects (`hook_event_name`, `session_id`, `tool_name`, `tool_input`, etc.) and always omits `transcript_path`, which is what routes synthetic sessions onto Pixel Agents' pre-existing "hooks-only external provider" adoption path (`fileWatcher.ts`'s `adoptExternalSessionFromHook` — built for non-Claude CLIs like OpenCode/Copilot, not something we added).
- `event-mapper.ts` never fabricates evidence it doesn't have: `toolStart` only ever carries the literal name `"PaperclipWork"` (see §21.4 of the design spec), never a real tool name like `"Bash"`; `subagentStart`/`subagentEnd`/`progress` are never emitted at all (no genuine Paperclip subagent correspondence).
- `actions.ts`'s `handleAgentReplyToFeedback` resolves feedback **server-side only** (`deps.getFeedback`) — the action schema uses `.strict()` specifically to reject a caller-supplied `feedback` object, closing a real exploit class (a forged feedback payload claiming `existingWorkContext: true`).

If you're adding a new mapping and find yourself needing a Pixel Agents or Paperclip source change to make it work, that's a signal to either (a) find a different existing extension point (there's usually one — see the hooks-only path above, which wasn't obvious at first either), or (b) put the richer data in the sidecar and surface it in the embedded dashboard instead, or (c) file it as a genuine, small, standalone upstream PR — never silently patch the submodule.

### Why Pixel Agents is read-only

We looked hard for a way to let a user act on Paperclip *from inside* the Pixel Agents sprite canvas (reply to an agent, send company messages) before concluding it isn't possible without a Pixel Agents source change:

- The full `ClientMessage` union (`pixel-agents/core/src/messages.ts`) has zero variants carrying free text intended for an agent/provider — every one is lifecycle/layout/settings/diagnostics.
- The standalone server never constructs a `TerminalAdapter` (`pixel-agents/server/src/cli.ts`) — the "click a character to open its terminal" interaction is VS-Code-adapter-only, not present in the deployed standalone image at all.

So control lives entirely in the plugin's own embedded UI (`src/ui/PixelOfficePage.tsx`), which happens to render inside Paperclip's page, not the sprite canvas. This is a real, working answer to "how do I control Paperclip through the bridge" — it's just not literally inside the pixel-art office.

## The relay: why it exists as a separate process

`paperclip-plugin/src/relay.ts` (running inside Paperclip, as the plugin worker) does all the *mapping*. It doesn't talk to Pixel Agents directly for one reason: Pixel Agents mints a fresh random bearer token (`crypto.randomUUID()`) on every boot with no env/CLI override, so a process running elsewhere (a different pod, a different host) can never know it in advance. `bin/paperclip-pixel-relay.mjs` solves exactly this and nothing else — it's a dumb forwarder that runs next to Pixel Agents, reads `~/.pixel-agents/server.json` off the local filesystem, and re-attaches the correct `Authorization` header before forwarding whatever body it receives. It contains zero mapping logic on purpose (keeping that logic in one tested place, `pixel-agents-provider`).

## Building and testing

One package, three test runners (each suited to what it's testing):

```bash
npm run test:domain    # jest, src/core + src/pixel-agents-provider (no DOM), 149 tests
npm run test:worker    # vitest, worker/relay/actions/manifest/subscriptions/snapshot, 122 tests
npm test                # jest + jsdom + testing-library, src/ui/** components, 88 tests
npm run test:all       # all three, in sequence
```

359 tests total. If you're touching `event-mapper.ts` or `transport.ts`, run both `test:domain` (the mapping logic itself, `test/pixel-agents-provider/`) and `test:worker` (`relay.test.ts`, `worker.test.ts` — they assert on the actual pushed HTTP bodies end-to-end through `BridgeRelay`).

Three runners exist because the code has three genuinely different execution needs: `src/core`/`src/pixel-agents-provider` are plain Node, CommonJS-transpiled by `ts-jest` via `tsconfig.jest.json` (the root `tsconfig.json` targets `NodeNext`/ESM for the plugin worker itself, which plain Jest can't execute directly); the worker/relay/actions side needs Vitest for its ESM-native handling of the real Paperclip plugin SDK test harness; the UI components need `jsdom` + React Testing Library, which only `jest.config.ts` sets up.

**Local dev symlinks:** the two upstream packages this project reads from (`@paperclipai/plugin-sdk`, `@paperclipai/shared`, both inside the `paperclip/` submodule) can't be installed as normal npm dependencies — `plugin-sdk`'s own `package.json` depends on `@paperclipai/shared` via the pnpm/yarn-only `workspace:*` protocol (an internal reference within Paperclip's own real monorepo), which plain npm cannot resolve even via `file:`. `npm install` runs `scripts/link-paperclip-sdk.mjs` automatically (the `postinstall` hook) to symlink them into `node_modules/@paperclipai/` instead. If you ever hit `Cannot find module '@paperclipai/...'`, re-run `node scripts/link-paperclip-sdk.mjs` (or `npm install`, which does it for you) rather than trying to `npm install` those two packages directly.

**Building the publishable bundle:**

```bash
npm run build
```

Runs `scripts/build.mjs` (esbuild, via `@paperclipai/plugin-sdk/bundlers`) producing `dist/worker.js` and `dist/manifest.js` — both fully self-contained (`src/core`, `src/pixel-agents-provider`, the plugin SDK, and zod all inlined; only Node built-ins/react/react-dom stay external) — plus `scripts/build-ui.mjs` for `dist/ui/index.js` (the embedded dashboard bundle, react/react-dom externalized since Paperclip's host provides them). `npm pack --dry-run` shows exactly what would ship.

## Local end-to-end testing (Kubernetes)

`deploy/k8s/` is a complete, working reference stack for exercising the real thing — see [`deploy/README.md`](../deploy/README.md) for the full build/deploy walkthrough. The short version, once you have `docker` and `minikube`:

```bash
npm run build
docker build -t paperclip-pixel-host:local -f deploy/docker/Dockerfile.paperclip-pixel-host .
docker build -t pixel-agents:local -f deploy/docker/Dockerfile.pixel-agents .
minikube start
minikube image load paperclip-pixel-host:local
minikube image load pixel-agents:local
kubectl apply -k deploy/k8s/
```

You can verify the bridge end-to-end without even creating a real Paperclip company, by pushing directly at the relay:

```bash
kubectl -n paperclip-pixels port-forward svc/pixel-agents 8081:8081 &
SID="paperclip-bridge:test-company:test-agent"
curl -X POST http://localhost:8081/api/hooks/claude -H "Content-Type: application/json" \
  -d "{\"hook_event_name\":\"SessionStart\",\"session_id\":\"$SID\",\"cwd\":\"/paperclip/$SID\"}"
curl -X POST http://localhost:8081/api/hooks/claude -H "Content-Type: application/json" \
  -d "{\"hook_event_name\":\"PreToolUse\",\"session_id\":\"$SID\",\"tool_name\":\"PaperclipWork\",\"tool_input\":{}}"
# then: kubectl -n paperclip-pixels logs deploy/pixel-agents -c pixel-agents | grep "Pixel Agents"
# expect: "Hook: Agent N - detected hooks-only external session (...)"
```

## Extending the mapping

Adding a new Paperclip event type or a new `AgentEvent` kind:

1. Add the raw shape to `core/src/domain/events.ts` (`BridgeInputEvent` union) and the subscription in `paperclip-plugin/src/subscriptions.ts`.
2. Decide honestly whether it maps to a *real* `AgentEvent` Pixel Agents already understands (§21.2/§21.4 of the design spec — the safe-mappings table) or belongs in the sidecar only. When genuinely unsure, sidecar-only is the conservative default; a wrong sidecar-only choice loses a visual, a wrong AgentEvent choice fabricates evidence.
3. If it's a real `AgentEvent`: add the case to `event-mapper.ts`'s `mapEvent`, then add the corresponding case to `transport.ts`'s `toClaudeHookBody` (check `pixel-agents/server/src/providers/hook/claude/claude.ts`'s `normalizeHookEvent` for the exact required JSON fields for that `hook_event_name` — don't guess, read it).
4. Write the failing-first test in `pixel-agents-provider/test/event-mapper.test.ts` and `transport.test.ts`, then `paperclip-plugin/test/relay.test.ts` for the end-to-end HTTP body assertion.

## Policy invariants that must never regress

These are the release-blocking tests (`paperclip-plugin/test/actions.test.ts`, `worker.test.ts`, and `core/test/policy.test.ts`):

- `issues.create` is never reachable from the individual-agent reply path — grep the whole tree for it; it should only ever appear in company-intake-adjacent code, never in `handleAgentReplyToFeedback`.
- A reply with no server-resolved `existingWorkContext`/`issueId`/`runId` fails closed (`ROUTE_TO_COMPANY`), never silently drops or silently creates.
- `AgentReplyToFeedbackSchema` stays `.strict()` — the feedback object is never caller-suppliable, only ever resolved server-side by id.
