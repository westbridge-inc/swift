#!/usr/bin/env bash
# audit/install.sh — prerequisite inventory only. This script never installs.
set -euo pipefail

PATH="/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"
export PATH

have() { command -v "$1" >/dev/null 2>&1; }
version() {
  if have "$1"; then
    printf '  %-14s %s\n' "$1" "$("$1" --version 2>&1 | head -n 1)"
  else
    printf '  %-14s MISSING\n' "$1"
  fi
}

printf '%s\n' 'Swift audit prerequisite inventory (no changes are made)'
printf '%s\n' 'Required:'
missing=0
for tool in semgrep gitleaks trivy jq node pnpm; do
  version "$tool"
  have "$tool" || missing=1
done

printf '%s\n' 'Optional:'
for tool in osv-scanner trufflehog psql; do
  version "$tool"
done

if [ "$missing" -ne 0 ]; then
  printf '%s\n' 'One or more required tools are missing. Install them through the machine owner\047s reviewed toolchain before running the full audit.' >&2
  exit 1
fi

printf '%s\n' 'Prerequisite inventory complete. No packages were downloaded or changed.'
