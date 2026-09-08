#!/usr/bin/env bash
set -euo pipefail
package_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
exec node "$package_dir/../../scripts/release-package.mjs" "$package_dir" "$@"
