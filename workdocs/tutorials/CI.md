## Continuous Integration/Deployment

The legacy CI ships workflows for both gitlab and github. **Note (board Revision 3):** the release CI is being replaced by a single provenance-aware gate (R3-WS2, in flight) — some legacy workflow files still invoke scripts that no longer exist in `package.json` (e.g. `build:prod`, `coverage`, `docs`) until that replacement lands. Treat `.github/workflows/` as the source of truth for what currently runs.

The template comes with ci/cd for:

- gitlab (with caching for performance):
  - stages:
    - dependencies: installs dependencies (on `package-lock.json` changes, caches node modules);
    - build: builds the code (on `src/*` changes, caches `lib` and `dist`);
    - test: tests the code (on `src/*`, `test/*` changes);
    - deploy:
      - deploys to package registry on a tag (public|private);
      - deploys docker image to docker registry (private);
- github:
  - jest-test: standard `install -> build -> test` loop;
  - jest-coverage: extracts coverage from the tests;
  - codeql-analysis: code quality analysis;
  - release-on-tag / release-alpha-on-tag: issues a release when the tag does not contain the `-no-ci` string;
  - publish-on-release: publishes to package registry when the tag does not contain the `-no-ci` string;
  - snyk-analysis: dependency vulnerability analysis;
  - requires variables:
    - CONSECUTIVE_ACTION_TRIGGER: secret to enable actions to trigger other actions;
    - NPM_TOKEN: npm/docker registry token.
