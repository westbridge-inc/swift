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
# skips leading "space" — ASCII whitespace, and also U+00A0 (no-break space,
# a rich-text paste artifact) and U+0085 (next line) — honours an `export `
# prefix and treats a bare `NAME` line as a pass-through from the caller's
# environment. All of those are declarations, while a `# comment`, a
# `NAME_FILE=` wiring line and a different name that merely starts with NAME
# are not.
#
# The space class is written as BYTES (the UTF-8 encodings of U+00A0 and
# U+0085 are C2 A0 and C2 85) and every grep runs under LC_ALL=C, so what
# counts as space never depends on the host's locale: a locale class like
# [[:space:]] covers those two only in some locales, and the server default
# (C.UTF-8) is not one of them.

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

# secret_space_class — a bracket expression of the bytes Compose skips before
# a key: space, tab, VT, FF, CR, and the UTF-8 bytes of U+00A0 and U+0085.
secret_space_class() {
  printf '[ \t\v\f\r\302\240\302\205]'
}

# secret_declaration_re NAME... — an ERE for a line that declares any of NAME.
secret_declaration_re() {
  local ws alternatives
  ws="$(secret_space_class)"
  alternatives="$(printf '%s|' "$@")"
  alternatives="${alternatives%|}"
  printf '^%s*(export%s+)?(%s)(%s*=|%s*$)' "$ws" "$ws" "$alternatives" "$ws" "$ws"
}

# env_file_declares FILE NAME — true when FILE declares NAME.
env_file_declares() {
  [ -f "$1" ] && LC_ALL=C grep -qE "$(secret_declaration_re "$2")" "$1"
}

# strip_secret_declarations FILE NAME... — FILE without those declarations, on stdout.
strip_secret_declarations() {
  local file="$1"
  shift
  if [ $# -eq 0 ]; then cat "$file"; return 0; fi
  LC_ALL=C grep -vE "$(secret_declaration_re "$@")" "$file" || true
}
