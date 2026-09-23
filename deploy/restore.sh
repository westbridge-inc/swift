#!/usr/bin/env bash
# Restore a local or off-site custom dump into a NEW scratch database only.
# The live database is never a target. Keep the scratch DB for inspection.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SOURCE="${1:-}"
SCRATCH="${2:-swift_restore_$(date -u +%Y%m%d%H%M%S)}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
TMP_DIR=""

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
aws_s3() {
  if [ -n "${AWS_S3_ENDPOINT:-}" ]; then aws --endpoint-url "$AWS_S3_ENDPOINT" "$@"
  else aws "$@"; fi
}
db_psql() {
  local database="$1"; shift
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$POSTGRES_PASSWORD"; db="$1"; shift; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"' \
    sh "$database" "$@"
}
cleanup() { [ -z "$TMP_DIR" ] || rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT

[ -n "$SOURCE" ] || die "usage: restore.sh <dump-file|s3://backup-bucket/key> [new-scratch-db]"
[[ "$SCRATCH" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "scratch database name must be a lowercase SQL identifier"
LIVE_DB="$(env_value POSTGRES_DB)"
LIVE_DB="${LIVE_DB:-swift}"
[ "$SCRATCH" != "$LIVE_DB" ] || die "scratch database may not be the live database"
command -v docker >/dev/null 2>&1 || die "Docker is required for the private Postgres connection"
command -v pg_restore >/dev/null 2>&1 || die "pg_restore is required to inspect the archive"

if [[ "$SOURCE" == s3://* ]]; then
  for name in BACKUP_BUCKET AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_S3_ENDPOINT AWS_REGION; do
    if [ -z "${!name:-}" ]; then export "$name=$(env_value "$name")"; fi
  done
  [ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is required for off-site restore"
  [[ "$SOURCE" == "s3://$BACKUP_BUCKET/"* ]] || die "off-site source must be in BACKUP_BUCKET"
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] ||
    die "off-site restore credentials are missing"
  command -v aws >/dev/null 2>&1 || die "AWS CLI is required for off-site restore"
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  DUMP="$TMP_DIR/restore.dump"
  aws_s3 s3 cp "$SOURCE" "$DUMP" --only-show-errors
  chmod 600 "$DUMP"
else
  DUMP="$SOURCE"
fi
[ -f "$DUMP" ] || die "dump file does not exist"
pg_restore --list "$DUMP" >/dev/null 2>&1 || die "pg_restore cannot read this archive"

echo "archive : $(basename "$DUMP")"
echo "scratch : $SCRATCH"
EXISTS="$(db_psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH';")"
[ -z "$EXISTS" ] || die "scratch database already exists; choose a new name"
db_psql postgres -q -c "CREATE DATABASE \"$SCRATCH\";"

STARTED="$(date +%s)"
"${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$POSTGRES_PASSWORD"; exec pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" --exit-on-error --no-owner --dbname="$1"' \
  sh "$SCRATCH" < "$DUMP"

FAILED=0
check() {
  local count
  count="$(db_psql "$SCRATCH" -tAc "$2" | tr -d '[:space:]')" || { echo "$1: ERROR"; FAILED=1; return; }
  [[ "$count" =~ ^[0-9]+$ ]] || { echo "$1: invalid count"; FAILED=1; return; }
  if [ "$count" -lt "$3" ]; then echo "$1: $count (below $3)"; FAILED=1
  else echo "$1: $count (ok)"; fi
}
check country_configs "SELECT count(*) FROM country_configs;" 1
check users "SELECT count(*) FROM users;" 1
check vendors "SELECT count(*) FROM vendors;" 0
check orders "SELECT count(*) FROM orders;" 0
[ "$FAILED" -eq 0 ] || die "restore failed sanity checks; scratch database retained"

SECONDS_TAKEN=$(( $(date +%s) - STARTED ))
echo "RESTORE OK — ${SECONDS_TAKEN}s; scratch database retained for inspection"
# A failed rehearsal heartbeat cannot turn a verified scratch restore into a
# failure, but doctor.sh will keep warning until a successful record exists.
db_psql "$LIVE_DB" -q <<SQL >/dev/null 2>&1 || echo "note: rehearsal heartbeat write failed" >&2
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_restore_rehearsal_at', to_jsonb(now()::text), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
INSERT INTO platform_config (id, key, value, "updatedAt")
VALUES (md5(random()::text || clock_timestamp()::text), 'last_restore_rehearsal_seconds', to_jsonb($SECONDS_TAKEN), now())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, "updatedAt" = now();
SQL
echo "Inspect the scratch DB before dropping it with psql inside the Postgres container."
echo "Document objects and MASTER_KEK require separate recovery proof."
