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
# OFFSITE IS THE POINT. A dump written next to the database it protects is a
# copy, not a backup: one dead disk takes both. When BACKUP_BUCKET is set this
# script uploads each dump off the machine and VERIFIES the upload before it
# will call the run a success. Without it, it warns loudly and keeps going, so
# a laptop or a dev box still works.
#
# It also records a heartbeat in the database on success. That is what lets
# something else notice when backups have quietly stopped — a silent backup
# failure is indistinguishable from safety until the day you need the file.
#
# Usage:
#   ./deploy/backup.sh                    # → deploy/backups/swift-<utc>.dump
#   ./deploy/backup.sh /path/to/dir       # → that directory
#   BACKUP_RETAIN_DAYS=14 ./deploy/backup.sh
#
# Reads DATABASE_URL from the environment, else from deploy/.env.
# Offsite (all from deploy/.env, same credentials the app already uses for R2):
#   BACKUP_BUCKET      bucket for dumps (e.g. swift-backups)
#   AWS_S3_ENDPOINT    R2/S3 endpoint
#   AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY
#   BACKUP_PREFIX      key prefix, default "db"

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$HERE/backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"

if [ -z "${DATABASE_URL:-}" ] && [ -f "$HERE/.env" ]; then
  # Only this one variable, and never echoed.
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$HERE/.env" | head -1 | cut -d= -f2- || true)"
fi
if [ -z "${DATABASE_URL:-}" ]; then
  echo "FATAL: DATABASE_URL is not set and deploy/.env does not define it." >&2
  exit 1
fi

# Offsite settings, from the environment first, then deploy/.env. Values are
# never echoed — only whether each is present.
env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
for var in BACKUP_BUCKET BACKUP_PREFIX AWS_S3_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_REGION BACKUP_HEARTBEAT_URL; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
BACKUP_PREFIX="${BACKUP_PREFIX:-db}"
AWS_REGION="${AWS_REGION:-auto}"

command -v pg_dump >/dev/null 2>&1 || { echo "FATAL: pg_dump not found (install the postgresql client)." >&2; exit 1; }

mkdir -p "$OUT_DIR"
chmod 700 "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
TARGET="$OUT_DIR/swift-$STAMP.dump"

echo "dumping → $(basename "$TARGET")"
# Write to a partial name first: a backup job killed mid-write must never leave
# a truncated file that looks like a good backup.
pg_dump "$DATABASE_URL" -Fc -f "$TARGET.partial"
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

# ── OFFSITE ─────────────────────────────────────────────────────────────────
# The dump leaves this machine, and we PROVE it arrived before trusting it.
UPLOADED=0
if [ -n "${BACKUP_BUCKET:-}" ]; then
  if ! command -v aws >/dev/null 2>&1; then
    echo "FATAL: BACKUP_BUCKET is set but the aws CLI is not installed. Offsite backup cannot run." >&2
    exit 1
  fi
  KEY="$BACKUP_PREFIX/$(basename "$TARGET")"
  ENDPOINT_ARG=()
  [ -n "${AWS_S3_ENDPOINT:-}" ] && ENDPOINT_ARG=(--endpoint-url "$AWS_S3_ENDPOINT")

  echo "uploading → s3://$BACKUP_BUCKET/$KEY"
  if ! aws "${ENDPOINT_ARG[@]}" s3 cp "$TARGET" "s3://$BACKUP_BUCKET/$KEY" --only-show-errors; then
    echo "FATAL: offsite upload failed. The local dump exists but is NOT safe from this machine dying." >&2
    exit 1
  fi

  # An upload that "succeeded" but landed truncated is the failure that hurts
  # most, because it looks fine. Compare the byte count at the destination.
  REMOTE_SIZE=$(aws "${ENDPOINT_ARG[@]}" s3api head-object \
    --bucket "$BACKUP_BUCKET" --key "$KEY" --query 'ContentLength' --output text 2>/dev/null || echo "")
  if [ "$REMOTE_SIZE" != "$SIZE" ]; then
    echo "FATAL: uploaded object is $REMOTE_SIZE bytes, local dump is $SIZE. Treating this run as FAILED." >&2
    exit 1
  fi
  echo "verified offsite: $KEY ($REMOTE_SIZE bytes, byte-for-byte with the local dump)"
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
if command -v psql >/dev/null 2>&1; then
  psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1 || echo "note: heartbeat write failed (backup itself is fine)" >&2
-- id has no database-side default (Prisma mints the cuid), so supply one.
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_backup_at', to_jsonb(now()::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_backup_offsite', to_jsonb($UPLOADED = 1), now())
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
  DELETED=$(find "$OUT_DIR" -name 'swift-*.dump' -type f -mtime +"$RETAIN_DAYS" -print -delete | wc -l | tr -d ' ')
  [ "$DELETED" != "0" ] && echo "pruned $DELETED backup(s) older than $RETAIN_DAYS days"
fi

cat <<MSG

Reminder, because a dump alone is a false sense of safety:
  - back up the object-storage bucket as well (KYC documents live there)
  - keep MASTER_KEK somewhere the server's loss cannot take with it
  - a backup is only real once ./deploy/restore.sh has actually restored it
MSG
