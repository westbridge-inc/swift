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
# Usage:
#   ./deploy/backup.sh                    # → deploy/backups/swift-<utc>.dump
#   ./deploy/backup.sh /path/to/dir       # → that directory
#   BACKUP_RETAIN_DAYS=14 ./deploy/backup.sh
#
# Reads DATABASE_URL from the environment, else from deploy/.env.

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
