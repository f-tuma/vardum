#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

staging="${1:-}"
if [[ -z "$staging" ]]; then
  staging="$(mktemp -d)"
  trap 'rm -rf "$staging"' EXIT
  node scripts/release-packages.mjs pack "$staging"
fi
node scripts/release-packages.mjs smoke "$staging"
