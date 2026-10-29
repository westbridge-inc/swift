#!/usr/bin/env bash
#
# Take a restorable backup of the Swift database.
#
# ⚠️ READ THIS BEFORE YOU RELY ON IT: A DATABASE DUMP IS NOT A COMPLETE BACKUP.
#
# Verification documents — government IDs and selfies — are envelope-encrypted
# and written through the storage provider, NOT into Postgres. What the
# database holds is the pointer and the wrapped key. So:
#
#   STORAGE_PROVIDER=s3|r2  → the objects live in the bucket. Back the bucket up
#                             too (versioning + lifecycle), or a restore gives
#                             you rows describing documents that no longer exist.
#   STORAGE_PROVIDER=local  → the objects are on THIS machine's disk, outside
#                             this dump entirely. A disk loss loses every KYC
#                             document permanently, and the boot guard only
#                             tolerates that mode behind an explicit
#                             STORAGE_ALLOW_LOCAL=1.
#
# And MASTER_KEK is not in either place. Restore the database, restore the
# bucket, and without the key the documents are ciphertext forever. Keep it
# somewhere a server loss cannot take with it.
#
# Format is pg_dump custom (-Fc): compressed, and restorable selectively with
# pg_restore, which plain SQL is not.
#
# OFFSITE IS THE POINT. The staging timer sets BACKUP_REQUIRED=1 and refuses
# local-only success. An interactive development run may omit the bucket.
#
# [BACKUP-ENC] ENCRYPTED TO THE OWNER (owner ruling, 13 Oct). On production
# (PILOT_ENV=production) every dump is encrypted, ON THIS HOST, to the owner's
# OpenPGP PUBLIC key before it is uploaded or kept: BACKUP_GPG_RECIPIENT_FILE
# (the exported public key, outside the checkout) whose primary key must have
# exactly the fingerprint pinned in BACKUP_GPG_FINGERPRINT. The private key is
# never on any server: a file holding a secret key is refused, and nothing
# here can decrypt. The plain dump exists only between pg_dump and the
# encryption (mode 600, removed right after, and on any failure); the copy
# kept here and the copy uploaded are both the .gpg. Restores are drilled from
# the owner's own computer (deploy/backup-drill.sh), which decrypts there.
# Elsewhere encryption applies when both settings are set; staging without
# them keeps plain dumps as before.
#
# It also records a heartbeat in the database on success. That is what lets
# something else notice when backups have quietly stopped — a silent backup
# failure is indistinguishable from safety until the day you need the file.
#
# Usage:
#   ./deploy/backup.sh                    # → deploy/backups/swift-<utc>.dump
#   ./deploy/backup.sh /path/to/dir       # → that directory
#   BACKUP_RETAIN_DAYS=14 ./deploy/backup.sh
# Local retention defaults to 14 days, and to 2 days on production (hourly
# encrypted dumps; the off-site copies are the history).
#
# Reads the bundled Postgres through its private Compose network. No host
# DATABASE_URL or published database port is needed.
# Offsite SETTINGS come from the environment, then deploy/.env:
#   BACKUP_BUCKET      bucket for dumps (e.g. swift-backups)
#   AWS_S3_ENDPOINT    R2/S3 endpoint
#   BACKUP_PREFIX      key prefix, default "db"
#   AWS_CLI_IMAGE      pinned image@sha256 that provides the AWS CLI (no snap)
# The storage KEYS never come from deploy/.env. [SEC-BACKUP F1] They are the
# backup bucket's OWN pair, BACKUP_AWS_ACCESS_KEY_ID and
# BACKUP_AWS_SECRET_ACCESS_KEY, which systemd hands swift-backup.service from
# the backup store (LoadCredentialEncrypted=, /etc/credstore.encrypted/
# swift-backup: never materialized for the api/worker containers). Only when
# no backup pair is present (a unit installed before the backup store) does it
# fall back to the API's AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, loudly
# (deploy/secret-env.sh load_backup_storage_keys). The database password never
# reaches this host process at all: pg_dump runs inside the postgres container
# and reads POSTGRES_PASSWORD_FILE there.
#
# [SEC-BACKUP F2] SIGNED. Every dump is signed on this host with the backup
# signing key (BACKUP_SIGNING_KEY, from the backup store), and the signature,
# <object>.sig, is kept and uploaded beside it (deploy/backup-signature.py).
# restore.sh and backup-drill.sh refuse a dump that does not verify. A unit
# that has no signing key yet still backs up, unsigned, with a loud warning;
# the heartbeat says so (last_backup_signed) and the API pages.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# [S3-3, Opus review 14 Oct] --check-key runs only the owner-key proof below
# (the same one every encrypted dump runs) and exits: no dump, no upload, no
# storage keys. pilot-up.sh calls it before changing anything on production.
CHECK_KEY=0
if [ "${1:-}" = --check-key ]; then CHECK_KEY=1; shift; fi
OUT_DIR="${1:-$HERE/backups}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")

# Offsite settings, from the environment first, then deploy/.env. Values are
# never echoed — only whether each is present.
env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
# [STG-B] The AWS CLI runs INSIDE a pinned container image — there is no host
# `aws` binary. The snap-packaged CLI starts through setuid snap-confine, which
# the backup unit's NoNewPrivileges=true forbids (observed: "snap-confine is
# packaged without necessary permissions"), and weakening the unit's hardening
# is not on the table. The unit already talks to the docker socket (pg_dump
# above runs through `docker compose exec`), so the pinned image does the S3
# work instead. Credentials pass BY NAME (-e NAME): the values flow to the
# daemon in the container config, never into this process's argv or any log.
aws_cli_image() {
  local image="${AWS_CLI_IMAGE:-}"
  [ -n "$image" ] || { echo "FATAL: AWS_CLI_IMAGE is not set — pin the AWS CLI container image (deploy/.env.deploy.example, OFFSITE BACKUPS)." >&2; return 1; }
  case "$image" in
    *PLACEHOLDER*|*'<'*|*'>'*)
      echo "FATAL: AWS_CLI_IMAGE is still a placeholder — pin a reviewed image@sha256 digest." >&2; return 1; ;;
  esac
  # Anchored digest check: only `<image>@sha256:<64 hex chars>` is a pin. A
  # substring test would let `ubuntu@sha256:` or `aws-cli:2@sha256:zzz`
  # through to fail later at `docker run` with an unhelpful message.
  if ! printf '%s\n' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$'; then
    echo "FATAL: AWS_CLI_IMAGE must pin an image@sha256:<64-hex> digest — a floating tag or malformed digest is not a pin." >&2; return 1
  fi
  printf '%s\n' "$image"
}
# aws_cli MOUNT ARGS... — one pinned-AWS-CLI container run. MOUNT is a docker
# bind mount; the backup mounts its dump directory read-only, restore mounts
# its scratch directory read-write. Runs as the caller's uid so any file the
# container creates is owned by the deploy user.
aws_cli() {
  local mount="$1" image
  shift
  image="$(aws_cli_image)" || return 1
  docker run --rm --user "$(id -u):$(id -g)" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY ${AWS_REGION:+-e AWS_REGION} \
    -v "$mount" \
    "$image" "$@"
}
aws_s3() {
  local mount="$1"
  shift
  if [ -n "${AWS_S3_ENDPOINT:-}" ]; then aws_cli "$mount" --endpoint-url "$AWS_S3_ENDPOINT" "$@"
  else aws_cli "$mount" "$@"; fi
}
for var in BACKUP_BUCKET BACKUP_PREFIX AWS_S3_BUCKET AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE BACKUP_HEARTBEAT_URL PILOT_ENV BACKUP_RETAIN_DAYS BACKUP_GPG_RECIPIENT_FILE BACKUP_GPG_FINGERPRINT BACKUP_SIGNING_ALLOWED_SIGNERS; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
# The storage keys: the backup bucket's own pair (or, until it exists, the
# API's, with a warning), from the environment, *_FILE or systemd's
# credentials directory.
. "$HERE/secret-env.sh"
[ "$CHECK_KEY" = 1 ] || load_backup_storage_keys || exit 1
# [SEC-BACKUP F2] The signing key, as a FILE (ssh-keygen reads it there): the
# unit's credential directory, or BACKUP_SIGNING_KEY_FILE.
SIGNING_KEY="${BACKUP_SIGNING_KEY_FILE:-}"
if [ -z "$SIGNING_KEY" ] && [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -e "$CREDENTIALS_DIRECTORY/BACKUP_SIGNING_KEY" ]; then
  SIGNING_KEY="$CREDENTIALS_DIRECTORY/BACKUP_SIGNING_KEY"
fi
ALLOWED_SIGNERS="${BACKUP_SIGNING_ALLOWED_SIGNERS:-/etc/swift/backup-allowed-signers}"
BACKUP_PREFIX="${BACKUP_PREFIX:-db}"
AWS_REGION="${AWS_REGION:-auto}"
if [ "${PILOT_ENV:-}" = production ]; then RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-2}"; else RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"; fi

# [BACKUP-ENC] Decide, before anything is dumped, whether this run encrypts,
# and prove the recipient is the owner's public key and nothing else.
ENCRYPT=0
GPG_HOME=""
GPG_KEYIDS=""
PLAIN=""
# When encrypting, no plain dump outlives this run, whatever happens: the
# partial, the plain file and the unfinished .gpg are removed on exit, and the
# throwaway keyring with them. The finished .gpg stays.
cleanup() {
  if [ "$ENCRYPT" = 1 ] && [ -n "$PLAIN" ]; then rm -f -- "$PLAIN.partial" "$PLAIN" "$PLAIN.gpg.partial" "$PLAIN.gpg.sig.partial"; fi
  [ -z "$GPG_HOME" ] || rm -rf -- "$GPG_HOME"
}
trap cleanup EXIT
if [ "${PILOT_ENV:-}" = production ] || [ -n "${BACKUP_GPG_RECIPIENT_FILE:-}" ] || [ -n "${BACKUP_GPG_FINGERPRINT:-}" ]; then
  ENCRYPT=1
  [ -n "${BACKUP_GPG_RECIPIENT_FILE:-}" ] && [ -n "${BACKUP_GPG_FINGERPRINT:-}" ] || {
    echo "FATAL: set BACKUP_GPG_RECIPIENT_FILE and BACKUP_GPG_FINGERPRINT: production dumps leave this host only encrypted to the owner's public key (owner ruling, 13 Oct)." >&2; exit 1; }
  [[ "$BACKUP_GPG_FINGERPRINT" =~ ^[0-9A-F]{40}$ ]] ||
    { echo "FATAL: BACKUP_GPG_FINGERPRINT must be the 40-character fingerprint (upper-case hex, no spaces) of the owner's backup key." >&2; exit 1; }
  [[ "$BACKUP_GPG_RECIPIENT_FILE" == /* ]] && [ -f "$BACKUP_GPG_RECIPIENT_FILE" ] && [ -r "$BACKUP_GPG_RECIPIENT_FILE" ] ||
    { echo "FATAL: BACKUP_GPG_RECIPIENT_FILE must be an absolute path to the owner's exported PUBLIC key, readable here." >&2; exit 1; }
  # The private key is never on a server: refuse a file that carries one
  # (named, never printed).
  if grep -q 'PRIVATE KEY BLOCK' "$BACKUP_GPG_RECIPIENT_FILE"; then
    echo "FATAL: BACKUP_GPG_RECIPIENT_FILE holds a PRIVATE key. The owner's private key must never be on a server: remove this file and give only the public key (gpg --armor --export)." >&2; exit 1
  fi
  command -v gpg >/dev/null 2>&1 || { echo "FATAL: gpg is required to encrypt the dump (apt-get install gnupg)." >&2; exit 1; }
  GPG_HOME="$(mktemp -d)"
  chmod 700 "$GPG_HOME"
  KEY_LINES="$(gpg --homedir "$GPG_HOME" --no-autostart --batch --with-colons --show-keys "$BACKUP_GPG_RECIPIENT_FILE" 2>/dev/null || true)"
  if printf '%s\n' "$KEY_LINES" | grep -Eq '^(sec|ssb):'; then
    echo "FATAL: BACKUP_GPG_RECIPIENT_FILE holds a PRIVATE key. The owner's private key must never be on a server." >&2; exit 1
  fi
  [ "$(printf '%s\n' "$KEY_LINES" | grep -c '^pub:')" = 1 ] ||
    { echo "FATAL: BACKUP_GPG_RECIPIENT_FILE must hold exactly one public key (the owner's backup key)." >&2; exit 1; }
  PRIMARY_FPR="$(printf '%s\n' "$KEY_LINES" | awk -F: '/^pub:/ { want = 1; next } want && /^fpr:/ { print $10; exit }')"
  [ "$PRIMARY_FPR" = "$BACKUP_GPG_FINGERPRINT" ] ||
    { echo "FATAL: the key in BACKUP_GPG_RECIPIENT_FILE is not the pinned owner key (its fingerprint differs from BACKUP_GPG_FINGERPRINT). Refusing to encrypt to anyone else." >&2; exit 1; }
  # Every key id of that one key: the encrypted file must name only these.
  GPG_KEYIDS="$(printf '%s\n' "$KEY_LINES" | awk -F: '/^(pub|sub):/ { print $5 }' | sort -u)"
fi
if [ "$CHECK_KEY" = 1 ]; then
  [ "$ENCRYPT" = 1 ] ||
    { echo "FATAL: --check-key: no backup key is configured (BACKUP_GPG_RECIPIENT_FILE and BACKUP_GPG_FINGERPRINT)." >&2; exit 1; }
  echo "backup key OK: BACKUP_GPG_RECIPIENT_FILE holds exactly the pinned public key $BACKUP_GPG_FINGERPRINT, and no private key"
  exit 0
fi

[[ "$RETAIN_DAYS" =~ ^[0-9]+$ ]] || { echo "FATAL: BACKUP_RETAIN_DAYS must be a non-negative integer." >&2; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "FATAL: Docker is required for the private Postgres connection." >&2; exit 1; }
if [ "${BACKUP_REQUIRED:-0}" = "1" ]; then
  for name in BACKUP_BUCKET AWS_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
    [ -n "${!name:-}" ] || { echo "FATAL: $name is required for offsite backups." >&2; exit 1; }
  done
fi
if [ -n "${AWS_S3_BUCKET:-}" ] && [ "${BACKUP_BUCKET:-}" = "$AWS_S3_BUCKET" ]; then
  echo "FATAL: BACKUP_BUCKET must differ from AWS_S3_BUCKET." >&2
  exit 1
fi

command -v pg_restore >/dev/null 2>&1 || { echo "FATAL: pg_restore not found (install the postgresql client)." >&2; exit 1; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUT_DIR/swift-$STAMP.dump"
PLAIN="$TARGET"

echo "dumping → $(basename "$TARGET")"
# Write to a partial name first: a backup job killed mid-write must never leave
# a truncated file that looks like a good backup.
# The container holds the password as a file (POSTGRES_PASSWORD_FILE); it is
# read there, by the exec'd shell, and never crosses to this host.
"${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
  > "$TARGET.partial"
mv "$TARGET.partial" "$TARGET"
chmod 600 "$TARGET"

SIZE=$(wc -c < "$TARGET" | tr -d ' ')
echo "wrote $(basename "$TARGET") ($SIZE bytes, mode 600)"

# A dump that cannot be listed cannot be restored. Cheap, and it catches a
# corrupt or truncated file here rather than during an incident.
if ! pg_restore --list "$TARGET" > /dev/null 2>&1; then
  echo "FATAL: pg_restore --list refused the file just written. It is NOT a usable backup." >&2
  exit 1
fi
echo "verified: pg_restore can read the archive's table of contents"
# [SEC-BACKUP F2] The plain dump's digest, signed with the encrypted copy's, so
# a restore of the decrypted dump (backup-drill.sh) is checked byte for byte.
PLAIN_SHA="$(python3 -I -c 'import hashlib, sys
h = hashlib.sha256()
with open(sys.argv[1], "rb") as f:
    for chunk in iter(lambda: f.read(1 << 20), b""):
        h.update(chunk)
print(h.hexdigest())' "$TARGET")" || { echo "FATAL: could not read the dump just written." >&2; exit 1; }

# [BACKUP-ENC] Encrypt to the owner's key, prove the result names only that
# key, then drop the plain dump: from here on only the .gpg exists.
if [ "$ENCRYPT" = 1 ]; then
  gpg --homedir "$GPG_HOME" --no-autostart --batch --no-tty --yes --quiet --trust-model always \
    --recipient-file "$BACKUP_GPG_RECIPIENT_FILE" --output "$TARGET.gpg.partial" --encrypt "$TARGET" ||
    { echo "FATAL: encrypting the dump to the owner's key failed. Nothing was uploaded; the plain dump is removed." >&2; exit 1; }
  RECIPIENTS="$(gpg --homedir "$GPG_HOME" --no-autostart --batch --list-packets "$TARGET.gpg.partial" 2>/dev/null |
    sed -n 's/^:pubkey enc packet:.* keyid \([0-9A-F]\{16\}\).*/\1/p' | sort -u || true)"
  [ -n "$RECIPIENTS" ] || { echo "FATAL: the encrypted dump names no recipient. Treating this run as FAILED." >&2; exit 1; }
  for keyid in $RECIPIENTS; do
    printf '%s\n' "$GPG_KEYIDS" | grep -qx "$keyid" ||
      { echo "FATAL: the encrypted dump names a recipient that is not the owner's key. Treating this run as FAILED." >&2; exit 1; }
  done
  mv "$TARGET.gpg.partial" "$TARGET.gpg"
  chmod 600 "$TARGET.gpg"
  rm -f -- "$TARGET"
  TARGET="$TARGET.gpg"
  SIZE=$(wc -c < "$TARGET" | tr -d ' ')
  echo "encrypted → $(basename "$TARGET") ($SIZE bytes, to the owner's key $BACKUP_GPG_FINGERPRINT only; the plain dump is removed)"
fi

# ── SIGNATURE [SEC-BACKUP F2] ───────────────────────────────────────────────
# Sign what leaves this host (the .gpg on production), binding the plain
# dump's digest too. Then prove the signature verifies against this host's
# allowed-signers file, exactly as a restore will. No key: unsigned, loudly.
SIGNED=0
SIG=""
# [SEC-BACKUP · REVIEW-M S4-3] A key that is there but does not produce a signature restores accept
# is a FAILED run (after the upload, so the data is still off-site): the unit fails, not only the page.
SIGN_FAILED=0
if [ -n "$SIGNING_KEY" ] && [ -r "$SIGNING_KEY" ]; then
  SIG_ARGS=(--key "$SIGNING_KEY" --object "$TARGET" --out "$TARGET.sig" --created "$STAMP")
  [ "$ENCRYPT" = 1 ] && SIG_ARGS+=(--plain-sha256 "$PLAIN_SHA")
  if python3 -I "$HERE/backup-signature.py" sign "${SIG_ARGS[@]}" >/dev/null; then
    SIG="$TARGET.sig"
    if python3 -I "$HERE/backup-signature.py" verify --allowed-signers "$ALLOWED_SIGNERS" \
         --sig "$SIG" --name "$(basename "$TARGET")" --object "$TARGET" 2>/dev/null; then
      SIGNED=1
      echo "signed → $(basename "$SIG") (verifies against $ALLOWED_SIGNERS)"
    else
      SIGN_FAILED=1
      echo "WARNING: the dump is signed but the signature does NOT verify against $ALLOWED_SIGNERS: restores here would refuse it. Run: sudo swift-secrets backup init" >&2
    fi
  else
    rm -f -- "$TARGET.sig"
    SIGN_FAILED=1
    echo "WARNING: BACKUP NOT SIGNED: signing with the backup signing key failed. A restore will refuse this dump without --allow-unsigned-legacy." >&2
  fi
else
  echo "WARNING: BACKUP NOT SIGNED: this unit has no backup signing key (BACKUP_SIGNING_KEY). Install the backup store (sudo swift-secrets backup init) and the current swift-backup.service (owner sheet BACKUP-KEY-SETUP)." >&2
fi

# ── OFFSITE ─────────────────────────────────────────────────────────────────
# The dump leaves this machine, and we PROVE it arrived before trusting it.
UPLOADED=0
if [ -n "${BACKUP_BUCKET:-}" ]; then
  aws_cli_image >/dev/null || exit 1
  KEY="$BACKUP_PREFIX/$(basename "$TARGET")"
  OUT_ABS="$(cd "$OUT_DIR" && pwd)"
  echo "uploading → s3://$BACKUP_BUCKET/$KEY"
  if ! aws_s3 "$OUT_ABS:/data:ro" s3 cp "/data/$(basename "$TARGET")" "s3://$BACKUP_BUCKET/$KEY" --only-show-errors; then
    echo "FATAL: offsite upload failed. The local dump exists but is NOT safe from this machine dying." >&2
    exit 1
  fi

  # An upload that "succeeded" but landed truncated is the failure that hurts
  # most, because it looks fine. Compare the byte count at the destination.
  REMOTE_SIZE=$(aws_s3 "$OUT_ABS:/data:ro" s3api head-object \
    --bucket "$BACKUP_BUCKET" --key "$KEY" --query 'ContentLength' --output text 2>/dev/null || echo "")
  if [ "$REMOTE_SIZE" != "$SIZE" ]; then
    echo "FATAL: uploaded object is $REMOTE_SIZE bytes, local dump is $SIZE. Treating this run as FAILED." >&2
    exit 1
  fi
  echo "verified offsite: $KEY ($REMOTE_SIZE bytes; restore drill verifies contents)"
  # The signature beside it, proven the same way.
  if [ -n "$SIG" ]; then
    SIG_SIZE=$(wc -c < "$SIG" | tr -d ' ')
    if ! aws_s3 "$OUT_ABS:/data:ro" s3 cp "/data/$(basename "$SIG")" "s3://$BACKUP_BUCKET/$KEY.sig" --only-show-errors; then
      echo "FATAL: the dump is offsite but its signature could not be uploaded; a restore would refuse it. Treating this run as FAILED." >&2
      exit 1
    fi
    REMOTE_SIG_SIZE=$(aws_s3 "$OUT_ABS:/data:ro" s3api head-object \
      --bucket "$BACKUP_BUCKET" --key "$KEY.sig" --query 'ContentLength' --output text 2>/dev/null || echo "")
    if [ "$REMOTE_SIG_SIZE" != "$SIG_SIZE" ]; then
      echo "FATAL: the uploaded signature is $REMOTE_SIG_SIZE bytes, local $SIG_SIZE. Treating this run as FAILED." >&2
      exit 1
    fi
    echo "verified offsite: $KEY.sig"
  fi
  UPLOADED=1
else
  echo "WARNING: BACKUP_BUCKET is not set — this dump lives only on the machine it backs up." >&2
  echo "         One disk failure loses the database AND every backup of it." >&2
fi

# ── HEARTBEAT ───────────────────────────────────────────────────────────────
# Record success in the database itself, so something else can notice when
# backups stop. Recorded ONLY when the dump is genuinely safe: offsite-verified,
# or explicitly local-only. Best-effort — a failed heartbeat must not fail a
# backup that actually worked; the staleness check will catch a real outage.
if command -v docker >/dev/null 2>&1; then
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -q -v ON_ERROR_STOP=1' \
    <<SQL >/dev/null 2>&1 || echo "note: heartbeat write failed (backup itself is fine)" >&2
-- id has no database-side default (Prisma mints the cuid), so supply one.
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_backup_at', to_jsonb(now()::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_backup_offsite', to_jsonb($UPLOADED = 1), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
-- [SEC-BACKUP] Read by the API's backup posture page and by doctor.sh.
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_backup_signed', to_jsonb($SIGNED = 1), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_backup_storage_key', to_jsonb('${BACKUP_STORAGE_KEY:-none}'::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
SQL
fi

# ── EXTERNAL HEARTBEAT ──────────────────────────────────────────────────────
# Everything above pages from INSIDE the box — which is useless the day the box
# itself dies. If BACKUP_HEARTBEAT_URL is set (a healthchecks.io-style check),
# ping it on success; the external service then alarms on SILENCE. Unset = inert.
# Best-effort by design: a failed ping must never fail a backup that worked.
if [ -n "${BACKUP_HEARTBEAT_URL:-}" ]; then
  curl -fsS -m 10 --retry 3 "$BACKUP_HEARTBEAT_URL" >/dev/null 2>&1 \
    && echo "external heartbeat pinged" \
    || echo "note: external heartbeat ping failed (backup itself is fine)" >&2
fi

if [ "$RETAIN_DAYS" -gt 0 ]; then
  DELETED=$(find "$OUT_DIR" \( -name 'swift-*.dump' -o -name 'swift-*.dump.gpg' \) -type f -mtime +"$RETAIN_DAYS" -print -delete | wc -l | tr -d ' ')
  find "$OUT_DIR" \( -name 'swift-*.dump.sig' -o -name 'swift-*.dump.gpg.sig' \) -type f -mtime +"$RETAIN_DAYS" -delete
  [ "$DELETED" != "0" ] && echo "pruned $DELETED backup(s) older than $RETAIN_DAYS days"
fi

# [SEC-BACKUP · REVIEW-G S4-1] When signing began: the first signed backup that is safe (off-site,
# or explicitly local-only) records its stamp, once. restore.sh accepts an UNSIGNED object with
# --allow-unsigned-legacy only when the bucket says it was written before this moment.
FIRST_SIGNED="$OUT_DIR/.first-signed-backup"
if [ "$SIGNED" = 1 ] && { [ "$UPLOADED" = 1 ] || [ -z "${BACKUP_BUCKET:-}" ]; } && [ ! -e "$FIRST_SIGNED" ]; then
  (umask 077; printf '%s\n' "$STAMP" > "$FIRST_SIGNED.partial" && mv -f "$FIRST_SIGNED.partial" "$FIRST_SIGNED") &&
    echo "signing began: $STAMP (recorded in $FIRST_SIGNED; keep a copy of this stamp with the allowed-signers file)" ||
    echo "WARNING: could not record when signing began in $FIRST_SIGNED" >&2
fi

if [ "$SIGN_FAILED" = 1 ]; then
  echo "FATAL: this backup is off-site but its signature cannot be verified here, so every restore refuses it. Treating this run as FAILED: fix the signing key (sudo swift-secrets backup init) before the next run." >&2
  exit 1
fi

cat <<MSG

Reminder, because a dump alone is a false sense of safety:
  - back up the object-storage bucket as well (KYC documents live there)
  - keep MASTER_KEK somewhere the server's loss cannot take with it
  - a backup is only real once ./deploy/restore.sh has actually restored it
MSG
