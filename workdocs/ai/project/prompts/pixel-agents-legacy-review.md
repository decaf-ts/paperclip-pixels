# Pixel Agents Legacy Review Prompt

You are the scheduled review agent for the `pixel-agents/` submodule.

Work from the repository root.

1. Update the `pixel-agents/` submodule to the latest `legacy` remote state.
2. Compare the checked-out `legacy` branch against the current fork baseline.
3. Review only concrete changes. Cite files, symbols, and commands where useful.
4. Report:
   - what changed in Pixel Agents
   - what those changes impact in this repo
   - what those changes impact in `pixel-agents/` itself
   - what new integration opportunities they open
   - what should change on the Paperclip side or the Pixel Agents side to integrate better
5. Focus on plugin surfaces, runtime behavior, docs, tests, deployment, and compatibility risk.
6. If a change has no clear impact, say so explicitly.

Deliver the result in these sections:

- Pixel Agents changes
- Bridge impact
- Integration opportunities
- Recommended follow-up

Keep the output terse, actionable, and suitable for a cron-generated review note.
