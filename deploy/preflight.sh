#!/usr/bin/env bash
#
# Thin wrapper so the deploy story is three shell commands, not two shell
# commands and a tsx invocation you have to remember.
#
# The logic lives in preflight.ts because it IMPORTS the real boot guard
# (apps/api/src/utils/boot-config.ts) rather than reimplementing it in bash.
# A bash reimplementation would drift the moment either side changed, and a
# preflight that reports PASS where the server would refuse to start is worse
# than having no preflight at all.
#
# Usage:
#   ./deploy/preflight.sh                 # checks deploy/.env
#   ./deploy/preflight.sh path/to/.env    # checks another file
#
# Exit 0 = the boot guard is satisfied. Exit 1 = it would refuse, and the
# message printed is the one the server would print.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"

# tsx ships with the API workspace; a bare checkout may not have run install.
TSX="$ROOT/apps/api/node_modules/.bin/tsx"
if [ ! -x "$TSX" ]; then
  if command -v tsx >/dev/null 2>&1; then
    TSX="$(command -v tsx)"
  else
    cat >&2 <<'MSG'
FATAL: tsx not found.

The preflight runs the REAL boot guard rather than a copy of it, so it needs to
execute TypeScript. Install workspace dependencies first:

    pnpm install --frozen-lockfile

MSG
    exit 1
  fi
fi

exec "$TSX" "$HERE/preflight.ts" "$@"
