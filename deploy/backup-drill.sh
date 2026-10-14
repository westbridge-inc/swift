#!/usr/bin/env bash
# Restore drill of an ENCRYPTED production backup, run on the OWNER'S OWN
# computer. The servers never hold the owner's private key (owner ruling,
# 13 Oct), so they cannot decrypt a backup; this script is the only way one is
# restored:
#
#   ./deploy/backup-drill.sh <user@host> <ssh-key-file> s3://<bucket>/<prefix>/swift-<stamp>.dump.gpg [scratch-db]
#
#   1. asks, at hidden prompts, for the owner's backup PRIVATE key (paste the
#      armored block from the password manager, or type it from the printed
#      copy) and its passphrase. Neither is shown, written to a file, put on
#      a command line, or sent anywhere: the key lives only in a throwaway
#      keyring on this computer for this run, removed at the end;
#   2. the host streams the ENCRYPTED object out of the backup bucket
#      (restore.sh --fetch-encrypted, with the storage keys from its encrypted
#      store, exactly as the runbook's drill does);
#   3. this computer decrypts it, in memory, on the way through;
#   4. the plain dump goes straight back over SSH into
#      `restore.sh --compare-source - <scratch-db>` on the host: a NEW scratch
#      database, never the live one, compared with the live database in
#      every table's rows and checksums, schema, RLS, grants and sequences.
#      Nothing plain is written on this computer.
#
# Pass means the host's last lines: the compare-source line and RESTORE OK,
# then DRILL OK here. Run it on a quiet database right after a backup, as the
# runbook says; the scratch database stays on the host for inspection.
#
# Needs here: bash, ssh, gpg (GnuPG 2.1+). Nothing is installed.
set -euo pipefail
umask 077
export HISTFILE=/dev/null

die() { echo "backup-drill: $*" >&2; exit 1; }
TARGET="${1:-}"
SSH_KEY="${2:-}"
OBJECT="${3:-}"
SCRATCH="${4:-swift_drill_$(date -u +%Y%m%d%H%M%S)}"
REMOTE_DIR="${SWIFT_REMOTE_DIR:-/opt/swift}"

[[ "$TARGET" =~ ^[a-z_][a-z0-9_-]*@[A-Za-z0-9.:-]+$ ]] || die "pass the host as user@host (the deploy user)"
[ -n "$SSH_KEY" ] && [ -r "$SSH_KEY" ] || die "pass the SSH key file for that host"
# Strict shapes: these two travel inside the remote command line.
[[ "$OBJECT" =~ ^s3://[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]/[A-Za-z0-9._/-]+\.dump\.gpg$ ]] ||
  die "pass the encrypted off-site object: s3://<bucket>/<prefix>/swift-<stamp>.dump.gpg"
[[ "$SCRATCH" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "the scratch database name must be a lowercase SQL identifier"
[[ "$REMOTE_DIR" =~ ^/[A-Za-z0-9._/-]+$ ]] || die "SWIFT_REMOTE_DIR must be an absolute path"
for tool in ssh gpg; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required on this computer"; done

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
cleanup() {
  gpgconf --homedir "$GNUPGHOME" --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf -- "$GNUPGHOME"
}
trap cleanup EXIT

# The private key, pasted at a hidden prompt, line by line until its END line.
echo "Paste your Swift backup PRIVATE key (the armored block, from its BEGIN line to its END line). Nothing is shown:" >&2
KEY_TEXT=""
while IFS= read -rs line; do
  KEY_TEXT+="$line"$'\n'
  [[ "$line" == "-----END PGP PRIVATE KEY BLOCK-----"* ]] && break
done
[[ "$KEY_TEXT" == "-----BEGIN PGP PRIVATE KEY BLOCK-----"* ]] && [[ "$KEY_TEXT" == *"-----END PGP PRIVATE KEY BLOCK-----"* ]] ||
  die "that is not an armored PGP private key block (BEGIN … END PGP PRIVATE KEY BLOCK)"
printf '%s' "$KEY_TEXT" | gpg --batch --quiet --import 2>/dev/null || die "the key could not be read"
KEY_TEXT=""
gpg --batch --list-secret-keys --with-colons 2>/dev/null | grep -q '^sec:' || die "no private key was imported"
printf 'Its passphrase (press Enter if it has none). Nothing is shown: ' >&2
IFS= read -rs PASSPHRASE
echo >&2

# [S3-1, Opus review 14 Oct] Only a backup encrypted to THIS key reaches gpg.
# `gpg --decrypt` also "decrypts" a message that carries no encryption at all
# (gpg --store) and exits 0, so the drill could print DRILL OK for an object
# that was never encrypted. The object's first packets must be public-key
# session keys for this key, followed directly by the encrypted data; anything
# else is refused before a byte is decrypted or sent to the host. The head is
# read with gpg's own parser (--list-only never decrypts) and passed on intact.
KEYIDS="$(gpg --batch --list-secret-keys --with-colons 2>/dev/null | awk -F: '/^(sec|ssb):/ { print $5 }')"
only_encrypted_to_this_key() {
  local head="$GNUPGHOME/head" listing keyids keyid
  dd bs=1 count=4096 of="$head" 2>/dev/null
  [ -s "$head" ] || exit 4
  listing="$(gpg --batch --no-autostart --list-only --list-packets "$head" 2>/dev/null || true)"
  printf '%s\n' "$listing" | sed -n 's/^:\([a-z ]*\):.*/\1/p' | awk '
    $0 == "pubkey enc packet" { keys++; next }
    { ok = keys > 0 && ($0 == "encrypted data packet" || $0 == "aead encrypted packet"); exit }
    END { exit ok ? 0 : 1 }' || exit 3
  keyids="$(printf '%s\n' "$listing" | sed -n 's/^:pubkey enc packet:.* keyid \([0-9A-F]\{16\}\).*/\1/p')"
  [ -n "$keyids" ] || exit 3
  for keyid in $keyids; do
    printf '%s\n' "$KEYIDS" | grep -qx "$keyid" || exit 3
  done
  cat -- "$head"
  exec cat
}

REMOTE_FETCH="sudo -n systemd-run --pipe --wait --collect --quiet --uid=swift-deploy --gid=swift-deploy \
-p SupplementaryGroups=docker -p WorkingDirectory=$REMOTE_DIR \
-p 'UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE' \
-p LoadCredentialEncrypted=AWS_ACCESS_KEY_ID:/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred \
-p LoadCredentialEncrypted=AWS_SECRET_ACCESS_KEY:/etc/credstore.encrypted/swift/AWS_SECRET_ACCESS_KEY.cred \
$REMOTE_DIR/deploy/restore.sh --fetch-encrypted '$OBJECT'"
REMOTE_RESTORE="cd $REMOTE_DIR && ./deploy/restore.sh --compare-source - '$SCRATCH'"
SSH=(ssh -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes "$TARGET")
# The fetch never reads this terminal (-n): only the restore reads, from the pipe.
SSH_FETCH=(ssh -n -i "$SSH_KEY" -o BatchMode=yes -o IdentitiesOnly=yes "$TARGET")

echo "drill: $OBJECT → scratch database $SCRATCH on $TARGET (decrypted here, on the way through)" >&2
set +e
"${SSH_FETCH[@]}" "$REMOTE_FETCH" |
  only_encrypted_to_this_key |
  gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 --decrypt 3< <(printf '%s' "$PASSPHRASE") 2>/dev/null |
  "${SSH[@]}" "$REMOTE_RESTORE"
STAGES=("${PIPESTATUS[@]}")
set -e
PASSPHRASE=""
[ "${STAGES[1]}" != 3 ] || die "this computer could not decrypt the backup: the object is not a backup encrypted to this key (an OpenPGP message must start with public-key session keys for this key, followed by the encrypted data); nothing was decrypted and the host received nothing"
[ "${STAGES[0]}" = 0 ] || die "the host could not stream the encrypted backup (exit ${STAGES[0]}); nothing was restored from it"
[ "${STAGES[1]}" = 0 ] || die "nothing arrived from the host; nothing was restored"
[ "${STAGES[2]}" = 0 ] || die "this computer could not decrypt the backup (wrong key or passphrase, or it is not encrypted to this key); the host received nothing usable"
[ "${STAGES[3]}" = 0 ] || die "the host's restore or comparison failed (exit ${STAGES[3]}); see its lines above. The scratch database, if created, is kept for inspection"
echo "DRILL OK: $OBJECT decrypted on this computer and restored on the host into $SCRATCH"
