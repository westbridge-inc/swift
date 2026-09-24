#!/usr/bin/env bash
# Sourced by pilot-up.sh and gen-secrets.sh: ONE definition of which names are
# secrets, and ONE reader of the env file that decides which lines declare one.
#
# Which names: the loader allowlist in apps/api/src/utils/secret-files.ts
# (every secret the API accepts from the store), plus the aliases the images
# read for two of them (PGPASSWORD for the database password, MEILI_MASTER_KEY
# for the search key).
#
# What "declares" means: whatever Compose's env-file parser (compose-go dotenv,
# godotenv lineage) would load under NAME. The reader below is a model of that
# parser; every rule in it was probed against the pinned Docker Compose binary
# (v2.40.3, 2026-09-23) with one spelling per file, and the python test matrix
# carries the same spellings:
#   - a UTF-8 BOM at the very start of the file is dropped; a BOM on a later
#     line makes Compose refuse the whole file (fail closed: not a declaration);
#   - every Unicode White_Space character before the key is skipped — NBSP, NEL,
#     EM SPACE, THIN SPACE, ideographic space, U+2028, in any mix, all load;
#   - `export` followed by at least one ASCII space, tab, FF or CR (Go's \s) is
#     stripped, and NBSP/NEL after that are skipped too. `export` glued to the
#     name (`exportJWT_SECRET=`) or followed only by Unicode whitespace is NOT
#     an export to Compose: it loads the value under the garbage key
#     `exportJWT_SECRET`. That still puts the value into the container config,
#     so such a line is refused as a MANGLED declaration of the allowlisted
#     name — only when the remainder is an allowlisted name; `exportFOO=` stays
#     the harmless key exportFOO;
#   - the key runs to `=` or `:` (both separate) or the end of the line (a
#     bare name is passed through from the caller's environment); space, tab,
#     VT, FF, CR, NBSP and NEL inside the run are trimmed before the separator;
#     any other character — EM SPACE before `=`, an interior ASCII space, an
#     uppercase EXPORT — makes Compose refuse the file: fail closed;
#   - a line that is empty after the skip, or starts with `#`, declares
#     nothing; `:` alone declares the empty name.
# The reader works on bytes in python3 (present on the host, installed by
# provision-ubuntu.sh) and never consults the host locale.

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

# _secret_env_reader MODE FILE NAME... — MODE `declared` prints each NAME the
# file declares, in file order; MODE `strip` prints FILE without those lines,
# byte for byte (a kept first line keeps its BOM).
_secret_env_reader() {
  python3 - "$@" <<'PY'
import sys

mode, path, names = sys.argv[1], sys.argv[2], set(sys.argv[3:])

# Go's unicode.IsSpace: the Unicode White_Space property.
WHITE_SPACE = set('\t\n\v\f\r \x85\xa0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000')
# compose-go dotenv isSpace(): the seven characters skipped around a key.
IS_SPACE7 = set('\t\v\f\r \x85\xa0')
# Go regexp `^export\s+`: RE2's \s is ASCII only.
GO_S = set('\t\n\f\r ')


def key_of(line, first):
    """The name Compose would load this line under (or the allowlisted name a
    mangled export prefix hides), or None when the line loads nothing or makes
    Compose refuse the file."""
    if first and line.startswith('\ufeff'):
        line = line[1:]
    i = 0
    while i < len(line) and line[i] in WHITE_SPACE:
        i += 1
    s = line[i:]
    if not s or s[0] == '#':
        return None
    if s.startswith('export'):
        rest = s[6:]
        if rest and rest[0] in GO_S:
            s = rest.lstrip(''.join(IS_SPACE7 | {'\n'}))
        else:
            # Mangled: Compose keeps `export` in the key; the value still lands.
            s = rest.lstrip(''.join(WHITE_SPACE))
    chars = []
    for ch in s:
        if ch in IS_SPACE7:
            chars.append(ch)
        elif ch in '=:\n':
            break
        elif ch in '_.-[]' or ch.isalnum():
            chars.append(ch)
        else:
            return None
    key = ''.join(chars).rstrip(''.join(WHITE_SPACE))
    if not key or ' ' in key:
        return None
    return key


with open(path, 'rb') as handle:
    data = handle.read()
pieces = data.split(b'\n')
out = sys.stdout.buffer
seen = []
for index, raw in enumerate(pieces):
    last = index == len(pieces) - 1
    if last and raw == b'':
        break
    key = key_of(raw.decode('utf-8', 'surrogateescape'), index == 0)
    declared = key is not None and key in names
    if mode == 'declared':
        if declared and key not in seen:
            seen.append(key)
    elif not declared:
        out.write(raw + (b'' if last else b'\n'))
if mode == 'declared':
    for key in seen:
        out.write(key.encode('utf-8') + b'\n')
out.flush()
PY
}

# env_file_declared_names FILE NAME... — the names FILE declares, one per line.
env_file_declared_names() {
  local file="$1"
  shift
  [ -f "$file" ] || return 0
  [ $# -gt 0 ] || return 0
  _secret_env_reader declared "$file" "$@"
}

# env_file_declares FILE NAME — true when FILE declares NAME.
env_file_declares() {
  [ -n "$(env_file_declared_names "$1" "$2")" ]
}

# strip_secret_declarations FILE NAME... — FILE without those declarations, on stdout.
strip_secret_declarations() {
  local file="$1"
  shift
  if [ $# -eq 0 ]; then cat "$file"; return 0; fi
  _secret_env_reader strip "$file" "$@"
}
