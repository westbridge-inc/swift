#!/usr/bin/env bash
# Source from a deploy script. Secret settings for HOST-side tools (the backup
# and restore scripts) come from, in order:
#   1. the environment, if already set;
#   2. NAME_FILE, a file the caller points at;
#   3. $CREDENTIALS_DIRECTORY/NAME — what systemd provides to a unit that
#      declares LoadCredentialEncrypted=NAME:/etc/credstore.encrypted/swift/NAME.cred
#      (see swift-backup.service): decrypted by the service manager, visible to
#      the unit's user only, gone when the unit exits.
# Never deploy/.env: that file holds settings, not secrets. Values are read
# into the process environment and never echoed.

load_secret_env() {
  local name file_var path value
  for name in "$@"; do
    if [ -n "${!name:-}" ]; then continue; fi
    file_var="${name}_FILE"
    path=""
    if [ -n "${!file_var:-}" ]; then
      path="${!file_var}"
    elif [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -e "$CREDENTIALS_DIRECTORY/$name" ]; then
      path="$CREDENTIALS_DIRECTORY/$name"
    fi
    [ -n "$path" ] || continue
    [ -r "$path" ] || { echo "FATAL: $name is expected in $path, which cannot be read." >&2; return 1; }
    value="$(cat "$path"; printf x)"
    value="${value%x}"
    # One trailing "\r\n" or "\n", exactly as the app's loader and `set` do.
    if [[ "$value" == *$'\n' ]]; then
      value="${value%$'\n'}"
      value="${value%$'\r'}"
    fi
    [ -n "$value" ] || { echo "FATAL: $path is empty." >&2; return 1; }
    export "$name=$value"
  done
}
