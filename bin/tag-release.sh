#!/usr/bin/env bash
set -euo pipefail
repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
for package in common plugins/paperclip plugins/pixel-agents; do
  bash "$repo_root/$package/bin/tag-release.sh" "$@"
done
