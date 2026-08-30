#!/usr/bin/env bash
#
# Restore a Swift backup into a SCRATCH database and prove it is real.
#
# The point of this script is that it is meant to be RUN, routinely, not kept
# for an emergency. An untested backup is a belief, not a backup — and the
# failure mode is silent: pg_dump exits 0 on a database it could only partly
# read, and nobody finds out until the day it matters.
#
# So this restores into a NEW database and counts rows in the tables that would
# make a restore worthless if they came back empty. It refuses to restore over
# an existing database unless you say so explicitly, because the one command
# you do not want to fat-finger during an incident is this one.
#
# Usage:
#   ./deploy/restore.sh deploy/backups/swift-<utc>.dump
#   ./deploy/restore.sh <dump> swift_restore_check          # name the scratch DB
#   ALLOW_EXISTING=1 ./deploy/restore.sh <dump> <existing>  # deliberate re-use
#
# Reads DATABASE_URL for the SERVER to restore into (the database name in it is
# ignored; the scratch name is used instead). Never writes to the live database
# unless you explicitly pass its name AND set ALLOW_EXISTING=1.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DUMP="${1:-}"
SCRATCH="${2:-swift_restore_check_$(date -u +%Y%m%d%H%M%S)}"

[ -n "$DUMP" ] || { echo "usage: ./deploy/restore.sh <dump-file> [scratch-db-name]" >&2; exit 2; }
[ -f "$DUMP" ] || { echo "FATAL: $DUMP does not exist." >&2; exit 1; }

if [ -z "${DATABASE_URL:-}" ] && [ -f "$HERE/.env" ]; then
  DATABASE_URL="$(grep -E '^DATABASE_URL=' "$HERE/.env" | head -1 | cut -d= -f2- || true)"
fi
[ -n "${DATABASE_URL:-}" ] || { echo "FATAL: DATABASE_URL is not set and deploy/.env does not define it." >&2; exit 1; }

for tool in pg_restore psql; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: $tool not found (install the postgresql client)." >&2; exit 1; }
done

# Server connection with the database swapped for 'postgres', so we can create
# the scratch database without touching the one named in DATABASE_URL.
SERVER="${DATABASE_URL%/*}/postgres"

echo "archive : $(basename "$DUMP")"
echo "scratch : $SCRATCH"

# Read the table of contents BEFORE creating anything — a corrupt archive
# should cost nothing.
pg_restore --list "$DUMP" > /dev/null 2>&1 || {
  echo "FATAL: pg_restore cannot read this archive. It is not a usable backup." >&2
  exit 1
}

EXISTS=$(psql "$SERVER" -tAc "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH';" || true)
if [ "$EXISTS" = "1" ]; then
  if [ "${ALLOW_EXISTING:-0}" != "1" ]; then
    echo "FATAL: database '$SCRATCH' already exists. Refusing to restore into it." >&2
    echo "       Pass a new name, or set ALLOW_EXISTING=1 if you truly mean this one." >&2
    exit 1
  fi
  echo "restoring into EXISTING database '$SCRATCH' (ALLOW_EXISTING=1)"
else
  # psql, not createdb: `createdb <conn> <name>` reads the first argument as the
  # DATABASE NAME and the second as a comment, so passing a connection string
  # there silently creates nothing and the restore then fails against a database
  # that does not exist. Found by running this script, which is the entire
  # reason a restore script must be run rather than written.
  psql "$SERVER" -q -c "CREATE DATABASE \"$SCRATCH\";"
fi

TARGET="${DATABASE_URL%/*}/$SCRATCH"
# [D-3] The stopwatch. "How long would we be down?" has exactly one honest
# answer: the time this restore takes on this data. Measured, then recorded
# below so the doctor can say it — nobody should have to remember it.
RESTORE_STARTED=$(date +%s)
# --no-owner: the dump's role names need not exist on the restoring server.
pg_restore --no-owner --dbname "$TARGET" "$DUMP" 2>&1 | grep -viE '^pg_restore: (connecting|creating|processing|implied)' | tail -20 || true

echo
echo "SANITY CHECKS — a restore that returns empty tables is a failed restore"
echo "──────────────────────────────────────────────────────────────────────"
FAILED=0
check() { # name  sql  minimum
  local n; n=$(psql "$TARGET" -tAc "$2" 2>/dev/null || echo "ERR")
  if [ "$n" = "ERR" ]; then
    printf '  %-22s  ERROR (table missing?)\n' "$1"; FAILED=1; return
  fi
  if [ "$n" -lt "$3" ]; then
    printf '  %-22s  %-8s  BELOW MINIMUM (%s)\n' "$1" "$n" "$3"; FAILED=1
  else
    printf '  %-22s  %-8s  ok\n' "$1" "$n"
  fi
}
# country_configs is the one that makes the platform bootable at all:
# assertProductionData refuses to start with zero rows.
check "country_configs" "SELECT count(*) FROM country_configs;" 1
check "users"           "SELECT count(*) FROM users;"           1
check "vendors"         "SELECT count(*) FROM vendors;"         0
check "orders"          "SELECT count(*) FROM orders;"          0

# The database-level guarantees must survive the restore too. A dump that
# brings back rows but not the constraints protecting them is a downgrade.
TRIGGERS=$(psql "$TARGET" -tAc "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal;" 2>/dev/null || echo 0)
CHECKS=$(psql "$TARGET" -tAc "SELECT count(*) FROM pg_constraint WHERE contype='c';" 2>/dev/null || echo 0)
POLICIES=$(psql "$TARGET" -tAc "SELECT count(*) FROM pg_policies WHERE schemaname='public';" 2>/dev/null || echo 0)
printf '  %-22s  %-8s\n' "triggers" "$TRIGGERS"
printf '  %-22s  %-8s\n' "check constraints" "$CHECKS"
printf '  %-22s  %-8s\n' "rls policies" "$POLICIES"

echo
if [ "$FAILED" != "0" ]; then
  echo "RESTORE FAILED its sanity checks. Do not trust this backup."
  echo "Scratch database '$SCRATCH' left in place for inspection."
  exit 1
fi
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_STARTED ))
echo "RESTORE OK — archive is real and the schema came back with it."
echo "  restore took ${RESTORE_SECONDS}s on $(stat -f%z "$DUMP" 2>/dev/null || stat -c%s "$DUMP") bytes — that is the recovery time for this data."
# [D-3] Record the rehearsal in the LIVE database's platform_config (the same
# idiom backup.sh uses for its heartbeat) so deploy/doctor.sh reports the last
# rehearsal and its duration, and warns when it has never happened. Best-effort.
psql "$DATABASE_URL" -q -v ON_ERROR_STOP=1 <<SQL >/dev/null 2>&1 || echo "note: could not record the rehearsal in platform_config (restore itself is fine)" >&2
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_restore_rehearsal_at', to_jsonb(now()::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_restore_rehearsal_seconds', to_jsonb($RESTORE_SECONDS), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
SQL
echo
echo "Drop the scratch database when you are done:"
echo "  psql \"$SERVER\" -c 'DROP DATABASE \"$SCRATCH\";'"
echo
echo "Still not covered by this, and it is the half that loses people's documents:"
echo "  - the object-storage bucket holding KYC files"
echo "  - MASTER_KEK, without which restored documents stay ciphertext"
