# User Guide — Paperclip ↔ Pixel Agents Bridge

This guide is for someone who already has the bridge installed (see the [package README](../README.md) for installation) and wants to use it day to day. If you're setting up a full reference stack to try it out first, see [`deploy/README.md`](../deploy/README.md) instead — it walks through a complete, working Kubernetes deployment you can copy from.

## What you'll see

Once the plugin is installed in Paperclip and `paperclip-pixel-relay` is running next to Pixel Agents, every agent that does anything in Paperclip appears as an animated character in your Pixel Agents office:

- **A character spawns** the first time an agent becomes active (a run starts, or any tracked event fires for it).
- **It animates while working** — a synthetic "PaperclipWork" status shows while the agent has at least one active run, and clears when the last one finishes.
- **A permission bubble appears** when a Paperclip approval is created and awaiting a decision (`pending`/`open`/`requested`/`awaiting`/`undecided` status).
- **A "waiting for input" state** appears when a human asks the agent a question via an issue comment.
- **The character despawns** when the agent goes offline (removed, deleted, archived, or offboarded).

Characters are keyed by `paperclip-bridge:<companyId>:<agentId>` — one character per Paperclip agent, regardless of how many concurrent runs it has. Concurrency itself (how many runs are active, which issues/projects they touch) is preserved losslessly — it just isn't rendered as multiple clones. You can see the full picture (every active run, per-window behavioral signals, cost/budget context) in the plugin's own dashboard, described below.

## Where to actually interact: the Paperclip-embedded dashboard

The Pixel Agents sprite canvas is **read-only** — it's a pure activity visualizer with no chat or text-input mechanism anywhere in its interface (this is intentional; see the [Developer Guide](DeveloperGuide.md#why-pixel-agents-is-read-only) for why). All interaction happens through the plugin's own page, embedded directly inside Paperclip's UI:

**Paperclip → your company → Pixel Office** (the sidebar/page the plugin registers).

From there you can:

### Send new work to the company

Use the **company intake** box at the top. This is the *only* path for new work to enter — by design, matching Paperclip's own model where all new tickets go through the CEO/leadership agent, never through an incidental conversation with an individual agent. Type your request and send; it opens (or reuses) a session with your company's leadership agent.

### Reply to an agent

Click any agent card to open its detail view. If it has outstanding feedback (a question, a blocker, a completion note), you can reply directly — your reply is posted as a comment on the specific issue that feedback came from.

**Fail-closed by design:** if what you type looks like it's introducing genuinely new work rather than continuing the existing conversation, the reply is rejected with a **"Send to company"** option instead of silently creating a new issue. This isn't just a UI nicety — the server-side action handler has no code path capable of creating an issue from this surface at all; it's structurally impossible, not just discouraged.

### Read the operational signals

Each agent's detail view shows:
- Every active run, with its issue/project, never collapsed into a single count.
- Windowed metrics (5m/30m/2h/8h/24h): busy ratio, run starts/finishes/failures, issue/project switches.
- Behavioral proxies — **load**, **friction**, **momentum**, **collaboration**, and so on — each labeled with a confidence score and its evidence basis. These are explicitly operational estimates, never presented as claims about how an agent "feels." You'll never see a made-up "satisfaction" score presented as fact.

## Configuring who leads intake

The company intake box needs a leadership agent to route to. The plugin picks one automatically — the first agent whose role is `ceo` or who has no manager (`reportsTo: null`) and is actually invokable (not paused, pending, or terminated) — and remembers that choice. If your org structure changes (a new CEO, the old one archived), the plugin re-resolves automatically the next time the stored choice turns out to be uninvokable.

## Troubleshooting

**No characters are appearing at all.**
Check `paperclip-pixel-relay`'s own log output for `pixel-agents not ready` (503) — it means it can't find Pixel Agents' `server.json` yet, usually because Pixel Agents hasn't finished starting. Check the plugin's config has `pixelAgentsRelayEnabled` on (it's the default) and `pixelAgentsUrl` pointing at your running relay, not at Pixel Agents directly.

**Characters appear but never animate (no typing/waiting/permission states).**
Confirm Pixel Agents has "Watch All Sessions" enabled — a synthetic Paperclip session is never inside a real tracked project directory, so without this setting it's silently ignored rather than adopted. (The reference deployment seeds this automatically; see `deploy/k8s/pixel-agents.yaml`'s `seed-config` init container if you're setting this up yourself.)

**A reply I sent isn't showing up as a comment.**
The reply only posts if it's bound to existing work — a feedback item with a resolvable `issueId`. If the underlying feedback couldn't be resolved server-side (e.g. it expired, or belongs to a different company), the action fails closed rather than guessing; you'll see an error, not a silent no-op.

**The context/token gauge above a character is always empty.**
Expected — see the "Known gap" note in the [package README](../README.md#known-gap).
