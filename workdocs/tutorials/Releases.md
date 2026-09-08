### Releases

This repository automates releases in the following manner:

- run `npm run release -- <major|minor|patch|version> <message>`:
  - if arguments are missing you will be prompted for them;
- it will run `npm run prepare-release` (lint + typecheck + build + all tests) first;
- it will commit all changes and push the new tag (via `./bin/tag-release.sh`).

Per the board Revision 3 remediation, the release CI itself is being replaced with a single provenance-aware gate (submodules, typecheck, lint, build, all tests, fork checks, package smoke, image build, integration contract tests, SBOM/audit, publishing via decaf-ts reusable actions) — treat `.github/workflows/` as the source of truth for what currently runs, and note that some legacy workflow files still reference scripts that no longer exist until that replacement lands.

If publishing to a private repo's npm registry, make sure you add to your `package.json`:

```json
{
  "publishConfig": {
    "<SCOPE>:registry": " https://<REGISTRY>/api/v4/projects/<PROJECT_ID>/packages/npm/"
  }
}
```

Where:

- `<SCOPE>` - Is the scope of your package;
- `<REGISTRY>` - your registry host;
- `<PROJECT_ID>` - you project's id number.
