#!/usr/bin/env bash
# Sourced by pilot-up.sh and gen-secrets.sh: ONE definition of which names are
# secrets, and ONE definition of "this env file declares NAME".
#
# Which names: the loader allowlist in apps/api/src/utils/secret-files.ts
# (every secret the API accepts from the store), plus the aliases the images
# read for two of them (PGPASSWORD for the database password, MEILI_MASTER_KEY
# for the search key).
#
# What "declares" means: whatever Compose's env-file parser would load. It
# ignores leading whitespace, honours an `export ` prefix and treats a bare
# `NAME` line as a pass-through from the caller's environment — so all of those
# are declarations, while a `# comment`, a `NAME_FILE=` wiring line and a
# different name that merely starts with NAME are not.

SECRET_CONSUMER_ALIASES="PGPASSWORD MEILI_MASTER_KEY"

# secret_allowlist ROOT — the allowlisted names, one per line; fails when the
# source cannot be read, so a caller never guesses.
secret_allowlist() {
  local file="$1/apps/api/src/utils/secret-files.ts" names
  [ -r "$file" ] || return 1
  names="$(sed -n '/SECRET_FILE_NAMES = \[/,/\] as const/p' "$file" | grep -oE "'[A-Z][A-Z0-9_]*'" | tr -d "'")" || true
  [ -n "$names" ] || return 1
  printf '%s\n' "$names"
}

# secret_declaration_re NAME... — an ERE for a line that declares any of NAME.
secret_declaration_re() {
  local alternatives
  alternatives="$(printf '%s|' "$@")"
  alternatives="${alternatives%|}"
  printf '^[[:space:]]*(export[[:space:]]+)?(%s)([[:space:]]*=|[[:space:]]*$)' "$alternatives"
}

# env_file_declares FILE NAME — true when FILE declares NAME.
env_file_declares() {
  [ -f "$1" ] && grep -qE "$(secret_declaration_re "$2")" "$1"
}

# strip_secret_declarations FILE NAME... — FILE without those declarations, on stdout.
strip_secret_declarations() {
  local file="$1"
  shift
  if [ $# -eq 0 ]; then cat "$file"; return 0; fi
  grep -vE "$(secret_declaration_re "$@")" "$file" || true
}
