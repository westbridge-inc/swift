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

# [SEC-BACKUP F1] The storage keys a HOST backup tool (backup.sh,
# erasure-ledger-ship.sh, restore.sh) uses for the backup bucket: the bucket's
# OWN pair, BACKUP_AWS_ACCESS_KEY_ID + BACKUP_AWS_SECRET_ACCESS_KEY, from the
# backup store (/etc/credstore.encrypted/swift-backup, which swift-secrets
# never materializes for the containers). Once that pair is here the API's
# AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY are never read. FALLBACK, so
# backups never stop: with no backup pair (a unit installed before the backup
# store existed) the API's pair is used, with a loud warning. Exports the pair
# under the AWS CLI's names for the pinned CLI container, and
# BACKUP_STORAGE_KEY=dedicated|shared for the heartbeat.
backup_key_warning() {
  echo "WARNING: BACKUPS STILL SHARE THE API'S STORAGE KEY ($1): whoever holds the API's key can read, overwrite or delete every off-site backup. Create a key limited to the backup bucket and store it with deploy/owner/swift-backup-key.command (owner sheet BACKUP-KEY-SETUP)." >&2
}
load_backup_storage_keys() {
  load_secret_env BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY BACKUP_KEY_SOURCE || return 1
  if [ -n "${BACKUP_AWS_ACCESS_KEY_ID:-}" ] && [ -n "${BACKUP_AWS_SECRET_ACCESS_KEY:-}" ]; then
    export AWS_ACCESS_KEY_ID="$BACKUP_AWS_ACCESS_KEY_ID"
    export AWS_SECRET_ACCESS_KEY="$BACKUP_AWS_SECRET_ACCESS_KEY"
    unset BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY
    if [ "${BACKUP_KEY_SOURCE:-dedicated}" = shared-api-key ]; then
      BACKUP_STORAGE_KEY=shared
      backup_key_warning "the backup store holds a copy of it"
    else
      BACKUP_STORAGE_KEY=dedicated
    fi
  else
    if [ -n "${BACKUP_AWS_ACCESS_KEY_ID:-}${BACKUP_AWS_SECRET_ACCESS_KEY:-}" ]; then
      echo "WARNING: only one half of the backup storage key pair is present; using the API's pair instead." >&2
    fi
    unset BACKUP_AWS_ACCESS_KEY_ID BACKUP_AWS_SECRET_ACCESS_KEY
    load_secret_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || return 1
    BACKUP_STORAGE_KEY=shared
    if [ -n "${AWS_ACCESS_KEY_ID:-}" ]; then
      backup_key_warning "no backup key pair is installed for this run"
    fi
  fi
  unset BACKUP_KEY_SOURCE
  export BACKUP_STORAGE_KEY
}
