## Documentation

This repository's documentation lives in two places:

- **Hand-written docs**, kept current as the system changes (never versioned snapshots):
  - [`README.md`](../../README.md) — what the bridge is, the two-plugin architecture, install/configure/run, the full configuration reference;
  - [`workdocs/tutorials/`](./) — user and developer guides;
  - [`workdocs/ai/architecture-handbook.md`](../ai/architecture-handbook.md) — components, contracts, trust boundaries, security, decisions and risks;
  - [`deploy/README.md`](../../deploy/README.md) — the reference deployment and its runbook;
  - the `pixel-agents/` fork's own `FORK.md`/`DIVERGENCE.md` governance and divergence log.
- **Per-ticket domain records** under `workdocs/ai/project/` (specifications, plan) — owned by the Delivery Documentation Specialist; read and link them, do not edit them.

Source-level API documentation uses the JSDoc configuration in `jsdocs.json` (better-docs). The repository template's generated-docs pipeline (`npm run docs`/`drawings`/`uml` gulp stages, publishing a compiled site under `./docs`) is **not wired up in this repository** — no such scripts exist here; do not reference them. Diagrams in the hand-written docs are inline Mermaid where possible.
