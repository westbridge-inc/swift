#!/bin/bash
#
# Swift — give the server's BACKUPS their own storage key, from your Mac.
#
# Double-click this file (it opens in Terminal), or run it with arguments:
#
#   swift-backup-key.command [swift-deploy@host] [path/to/ssh-key]
#
# What it does, in order (each step asks first and can be run again safely):
#
#   1. INSTALL: puts the current secret-store command and backup units from
#      the server's checkout into place (/usr/local/sbin/swift-secrets,
#      swift-backup.service, swift-erasure-ledger.service) and runs
#      `swift-secrets backup init`: the backup store gets its signing key, and
#      until step 2 a COPY of the API's storage key, so backups never stop.
#   2. KEY: asks, at hidden prompts, for the Access Key ID and Secret of the
#      NEW key you created in DigitalOcean for the backup bucket only (owner
#      sheet BACKUP-KEY-SETUP), and sends them over SSH on STDIN ONLY to
#      `sudo -n swift-secrets backup set-keys`, which encrypts them into the
#      backup store the app's containers never see. It refuses the API's own
#      key. The values are never a command-line argument, never written to a
#      file, never echoed.
#   3. VERSIONING: turns on versioning for the backup bucket (an overwritten
#      or deleted dump keeps its previous version), after a lifecycle rule that
#      deletes those old versions after 30 days (each one is a full copy of
#      everyone's data; BACKUP_VERSION_RETAIN_DAYS). DigitalOcean allows this
#      only through its API and only with a FULL-access key, so it runs with the
#      API's current key (deploy/backup-versioning.sh): do it BEFORE that key
#      is narrowed to the uploads bucket. In the same lifecycle configuration
#      it adds the retention you chose (owner ruling 29 Oct): hourly backups
#      deleted 30 days after they are made (never the erasure ledger), only
#      the dump files ("<prefix>/swift-..."; BACKUP_OFFSITE_RETAIN_DAYS). It
#      keeps the bucket's other rules, and changes nothing if one of them
#      would delete the erasure ledger.
#   4. PROVE: starts one backup now and shows its last lines, so you can see
#      "backups use the backup bucket's own storage key" working.
#
# It prints only step names and the server's own status lines. No host name,
# address or key is stored in this file: it lives in a public repository.
set -euo pipefail
umask 077
export HISTFILE=/dev/null

say() { printf '%s\n' "$*" >&2; }
die() { say "error: $*"; exit 1; }
ask() { local a; IFS= read -r -p "$1 [y/N] " a || return 1; [[ "$a" =~ ^[Yy]$ ]]; }

target="${1:-}"
key="${2:-}"
if [ -z "$target" ]; then IFS= read -r -p "Deploy target (swift-deploy@host): " target; fi
[[ "$target" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]*@[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || die "the target must look like user@host"
if [ -z "$key" ]; then IFS= read -r -p "SSH private key path: " key; fi
key="${key/#\~/$HOME}"
[ -r "$key" ] || die "cannot read the SSH key at $key"

SSH=(ssh -i "$key" -o IdentitiesOnly=yes -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o ConnectTimeout=20 "$target")

# Connect once before anything is typed: host-key confirmation and key
# problems surface here, with nothing sensitive in flight.
"${SSH[@]}" -n true </dev/null || die "cannot connect to $target with $key"
# The server's checkout must already carry the backup store (the code is deployed first).
"${SSH[@]}" -n "grep -q 'backup set-keys' /opt/swift/deploy/swift-secrets" </dev/null ||
  die "the server's checkout (/opt/swift) does not have the backup store yet: deploy the code that carries it first"

say ""
say "Step 1 of 4 — install the backup store and the backup units on the server."
if ask "Install now (safe to repeat)?"; then
  "${SSH[@]}" -n "set -e
sudo -n install -m 0755 -o root -g root /opt/swift/deploy/swift-secrets /usr/local/sbin/swift-secrets
sudo -n swift-secrets backup init
sudo -n install -m 0644 -o root -g root /opt/swift/deploy/swift-backup.service /etc/systemd/system/swift-backup.service
sudo -n install -m 0644 -o root -g root /opt/swift/deploy/swift-erasure-ledger.service /etc/systemd/system/swift-erasure-ledger.service
sudo -n systemctl daemon-reload
sudo -n swift-secrets backup list" </dev/null || die "the install did not finish (see the server's lines above); nothing else was changed"
  say "installed."
else
  say "skipped."
fi

say ""
say "Step 2 of 4 — the backup bucket's OWN key (DigitalOcean: Spaces Object Storage > Access Keys,"
say "             Limited access, only the backup bucket, Read/Write/Delete)."
if ask "Enter the new key now?"; then
  while :; do
    IFS= read -r -s -p "Access Key ID (hidden): " id || die "no input"
    say ""
    IFS= read -r -s -p "Secret Key (hidden): " secret || die "no input"
    say ""
    if [ -z "$id" ] || [ -z "$secret" ]; then say "both are needed, asking again"; continue; fi
    IFS= read -r -s -p "Secret Key again (hidden): " again || die "no input"
    say ""
    if [ "$secret" = "$again" ]; then break; fi
    say "the two Secret Key entries differ, asking again"
  done
  again=""
  if printf '%s\n%s\n' "$id" "$secret" | "${SSH[@]}" "sudo -n swift-secrets backup set-keys" >/dev/null; then
    id=""; secret=""
    echo "saved the backup storage key pair"
  else
    id=""; secret=""
    die "FAILED: the server refused the key pair or the connection dropped (nothing was shown). If it said it is the API's own key, create a NEW key for the backup bucket only."
  fi
else
  say "skipped."
fi

say ""
say "Step 3 of 4 — versioning for the backup bucket, old versions deleted after 30 days, and"
say "             hourly backups deleted 30 days after they are made (never the erasure ledger)"
say "             (uses the API's current full-access key, once)."
if ask "Turn versioning on now (safe to repeat)?"; then
  "${SSH[@]}" -n "sudo -n systemd-run --pipe --wait --collect --quiet --uid=swift-deploy --gid=swift-deploy \
-p SupplementaryGroups=docker -p WorkingDirectory=/opt/swift \
-p 'UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE' \
-p LoadCredentialEncrypted=AWS_ACCESS_KEY_ID:/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred \
-p LoadCredentialEncrypted=AWS_SECRET_ACCESS_KEY:/etc/credstore.encrypted/swift/AWS_SECRET_ACCESS_KEY.cred \
/opt/swift/deploy/backup-versioning.sh" </dev/null ||
    say "versioning is NOT on (see the line above). If the API's key is already limited to the uploads bucket, this step needs a Full access key: owner sheet BACKUP-KEY-SETUP, section Versioning."
else
  say "skipped."
fi

say ""
say "Step 4 of 4 — prove it: one backup now (about a minute)."
if ask "Run one backup now?"; then
  "${SSH[@]}" -n "sudo -n systemctl start swift-backup.service; sudo -n journalctl -u swift-backup.service -n 25 --no-pager -o cat" </dev/null ||
    die "the backup did not finish cleanly: read the lines above, then the owner sheet (nothing was lost: the previous backups are untouched)"
  say "Look above for: signed →, verified offsite, and NO line saying BACKUPS STILL SHARE THE API'S STORAGE KEY."
  say "The first signed backup also prints 'signing began: <stamp>': keep that stamp with your copy of the allowed-signers file."
else
  say "skipped."
fi
say "done."
