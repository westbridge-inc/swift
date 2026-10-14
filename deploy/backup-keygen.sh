#!/usr/bin/env bash
# Make the OWNER's backup key pair, once, on the OWNER'S OWN computer.
#
#   ./deploy/backup-keygen.sh <folder-on-this-computer>
#
# Production backups are encrypted to this key (deploy/backup.sh) and only its
# private half can read them (owner ruling, 13 Oct: the owner holds it, in two
# copies, printed and in a password manager; servers never hold it). This
# script asks for a passphrase at a hidden prompt (twice), makes an OpenPGP
# key (ed25519, with a cv25519 encryption subkey, no expiry) in a throwaway
# keyring, and writes two files into the folder:
#
#   swift-backup-public.asc    the PUBLIC key: give it to the operator. It goes
#                              on the production host (BACKUP_GPG_RECIPIENT_FILE)
#                              with its fingerprint pinned (BACKUP_GPG_FINGERPRINT).
#   swift-backup-PRIVATE.asc   the PRIVATE key (protected by the passphrase):
#                              print it, store it in the password manager, then
#                              delete this file. Never send it to anyone or any
#                              server. Keep the passphrase separately.
#
# It prints the fingerprint to pin. Needs: bash and gpg (GnuPG 2.1+).
set -euo pipefail
umask 077
export HISTFILE=/dev/null

die() { echo "backup-keygen: $*" >&2; exit 1; }
OUT="${1:-}"
[ -n "$OUT" ] || die "pass a folder on this computer to write the two key files into"
mkdir -p "$OUT"
[ ! -e "$OUT/swift-backup-PRIVATE.asc" ] && [ ! -e "$OUT/swift-backup-public.asc" ] ||
  die "$OUT already holds swift-backup key files; move them away first (a second key would not open the backups made with the first)"
command -v gpg >/dev/null 2>&1 || die "gpg is required on this computer (macOS: brew install gnupg)"

GNUPGHOME="$(mktemp -d)"
export GNUPGHOME
cleanup() {
  gpgconf --homedir "$GNUPGHOME" --kill gpg-agent >/dev/null 2>&1 || true
  rm -rf -- "$GNUPGHOME"
}
trap cleanup EXIT

printf 'Choose a passphrase for the backup key (at least 12 characters). Nothing is shown: ' >&2
IFS= read -rs PASSPHRASE; echo >&2
printf 'Type it again: ' >&2
IFS= read -rs AGAIN; echo >&2
[ "$PASSPHRASE" = "$AGAIN" ] || die "the two passphrases differ; nothing was made"
AGAIN=""
[ "${#PASSPHRASE}" -ge 12 ] || die "the passphrase is shorter than 12 characters; nothing was made"

gpg --batch --quiet --pinentry-mode loopback --passphrase-fd 3 \
  --quick-generate-key "Swift production backups (owner)" future-default default never 3< <(printf '%s' "$PASSPHRASE") 2>/dev/null ||
  die "gpg could not make the key"
FPR="$(gpg --batch --with-colons --list-keys 2>/dev/null | awk -F: '/^pub:/ { want = 1; next } want && /^fpr:/ { print $10; exit }')"
[[ "$FPR" =~ ^[0-9A-F]{40}$ ]] || die "the new key has no fingerprint"
gpg --batch --armor --export "$FPR" > "$OUT/swift-backup-public.asc"
gpg --batch --pinentry-mode loopback --passphrase-fd 3 --armor --export-secret-keys "$FPR" \
  > "$OUT/swift-backup-PRIVATE.asc" 3< <(printf '%s' "$PASSPHRASE") 2>/dev/null ||
  die "gpg could not export the private key"
PASSPHRASE=""
chmod 600 "$OUT/swift-backup-PRIVATE.asc"
grep -q 'BEGIN PGP PUBLIC KEY BLOCK' "$OUT/swift-backup-public.asc" && ! grep -q 'PRIVATE KEY' "$OUT/swift-backup-public.asc" ||
  die "the public key file is not a public key"

cat >&2 <<MSG

Made the Swift backup key.
  Fingerprint (the operator pins it as BACKUP_GPG_FINGERPRINT):
    $FPR
  Give the operator ONLY:  $OUT/swift-backup-public.asc
  Keep, never send:        $OUT/swift-backup-PRIVATE.asc
    1. print it (keep the paper somewhere safe);
    2. store its whole text in your password manager;
    3. delete the file from this computer.
  Keep the passphrase separately (memory or the password manager's own entry).
  Without this key and passphrase, no production backup can ever be restored.
MSG
printf '%s\n' "$FPR"
