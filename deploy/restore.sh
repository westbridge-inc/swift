#!/usr/bin/env bash
# Restore a local or off-site custom dump into a NEW scratch database only.
# The live database is never a target. Keep the scratch DB for inspection.
#
#   ./deploy/restore.sh [--compare-source] <dump-file|s3://backup-bucket/key> [new-scratch-db]
#
# [PROD-PATH] --compare-source judges the restore against the LIVE database it
# was dumped from, instead of fixed minimums (a new production database has no
# user yet, so "at least one user" cannot prove anything there). The scratch
# copy must match the source exactly: the same tables with the same row counts,
# the same row-level-security switches (enabled and forced) on every table, the
# same policies, constraints and indexes. Use it on a quiet database, right
# after the backup: a row written to the live database since the dump is a
# mismatch, reported by table. The backup and rehearsal heartbeats in
# platform_config are left out of the count — backup.sh writes them after the
# dump by design.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
COMPARE_SOURCE=0
if [ "${1:-}" = "--compare-source" ]; then COMPARE_SOURCE=1; shift; fi
SOURCE="${1:-}"
SCRATCH="${2:-swift_restore_$(date -u +%Y%m%d%H%M%S)}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
TMP_DIR=""

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
# [STG-B] The AWS CLI runs INSIDE a pinned container image — there is no host
# `aws` binary, for the same reason as backup.sh: the snap-packaged CLI cannot
# start under a hardened unit (NoNewPrivileges), and that hardening is not
# weakened. Credentials pass BY NAME (-e NAME) so the values never enter argv.
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
db_psql() {
  local database="$1"; shift
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; db="$1"; shift; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"' \
    sh "$database" "$@"
}
cleanup() { [ -z "$TMP_DIR" ] || rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT

[ -n "$SOURCE" ] || die "usage: restore.sh [--compare-source] <dump-file|s3://backup-bucket/key> [new-scratch-db]"
[[ "$SCRATCH" =~ ^[a-z][a-z0-9_]{0,62}$ ]] || die "scratch database name must be a lowercase SQL identifier"
LIVE_DB="$(env_value POSTGRES_DB)"
LIVE_DB="${LIVE_DB:-swift}"
[ "$SCRATCH" != "$LIVE_DB" ] || die "scratch database may not be the live database"
command -v docker >/dev/null 2>&1 || die "Docker is required for the private Postgres connection"
command -v pg_restore >/dev/null 2>&1 || die "pg_restore is required to inspect the archive"

if [[ "$SOURCE" == s3://* ]]; then
  # Settings from the environment, then deploy/.env. The storage KEYS only from
  # the environment, *_FILE or $CREDENTIALS_DIRECTORY (deploy/secret-env.sh):
  # run an off-site drill through a transient unit with LoadCredentialEncrypted=,
  # as the runbook shows.
  for name in BACKUP_BUCKET AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE; do
    if [ -z "${!name:-}" ]; then export "$name=$(env_value "$name")"; fi
  done
  . "$HERE/secret-env.sh"
  load_secret_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || exit 1
  [ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is required for off-site restore"
  [[ "$SOURCE" == "s3://$BACKUP_BUCKET/"* ]] || die "off-site source must be in BACKUP_BUCKET"
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] ||
    die "off-site restore credentials are missing"
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  DUMP="$TMP_DIR/restore.dump"
  aws_cli_image >/dev/null || die "off-site restore needs a pinned AWS_CLI_IMAGE"
  aws_s3 "$TMP_DIR:/data" s3 cp "$SOURCE" /data/restore.dump --only-show-errors
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
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" --exit-on-error --no-owner --dbname="$1"' \
  sh "$SCRATCH" < "$DUMP"

FAILED=0
check() {
  local count
  count="$(db_psql "$SCRATCH" -tAc "$2" | tr -d '[:space:]')" || { echo "$1: ERROR"; FAILED=1; return; }
  [[ "$count" =~ ^[0-9]+$ ]] || { echo "$1: invalid count"; FAILED=1; return; }
  if [ "$count" -lt "$3" ]; then echo "$1: $count (below $3)"; FAILED=1
  else echo "$1: $count (ok)"; fi
}
# [PROD-PATH] One read of a database's shape and contents, the same query on
# both sides: a line per table with its row count, per table its RLS switches,
# per policy its full definition, per constraint and per index its name and
# definition. Sorted, so two equal databases give byte-equal snapshots.
POSTURE_SQL="-- posture-snapshot
SELECT line FROM (
  SELECT format('rows|%s|%s', t.table_name,
    (xpath('/row/c/text()', query_to_xml(format(
      CASE WHEN t.table_name = 'platform_config'
        THEN 'SELECT count(*) AS c FROM %I.%I WHERE key NOT IN (''last_backup_at'', ''last_backup_offsite'', ''last_restore_rehearsal_at'', ''last_restore_rehearsal_seconds'')'
        ELSE 'SELECT count(*) AS c FROM %I.%I' END,
      t.table_schema, t.table_name), false, true, '')))[1]::text) AS line
  FROM information_schema.tables t
  WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
  UNION ALL
  SELECT format('rls|%s|enabled=%s|forced=%s', c.relname, c.relrowsecurity, c.relforcerowsecurity)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT format('policy|%s|%s|%s|%s|%s|%s|%s', p.tablename, p.policyname, p.permissive, p.roles::text, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, ''))
  FROM pg_policies p WHERE p.schemaname = 'public'
  UNION ALL
  SELECT format('constraint|%s|%s|%s', c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid))
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname = 'public'
  UNION ALL
  SELECT format('index|%s|%s|%s', i.tablename, i.indexname, i.indexdef)
  FROM pg_indexes i WHERE i.schemaname = 'public'
) s ORDER BY line;"
compare_with_source() {
  local live_snapshot scratch_snapshot
  live_snapshot="$(db_psql "$LIVE_DB" -tAc "$POSTURE_SQL")" || die "could not read the source database $LIVE_DB; scratch database retained"
  scratch_snapshot="$(db_psql "$SCRATCH" -tAc "$POSTURE_SQL")" || die "could not read the scratch database; scratch database retained"
  [ -n "$live_snapshot" ] || die "the source database $LIVE_DB has no tables to compare; scratch database retained"
  summarize() {
    printf '%s\n' "$1" | awk -F'|' -v who="$2" '
      $1 == "rows" { tables++; rows += $3 }
      $1 == "rls" && $3 == "enabled=t" { rls++ }
      $1 == "rls" && $4 == "forced=t" { forced++ }
      $1 == "policy" { policies++ }
      $1 == "constraint" { constraints++ }
      $1 == "index" { indexes++ }
      END { printf "%s: %d tables, %d rows, RLS enabled on %d, forced on %d, %d policies, %d constraints, %d indexes\n", who, tables, rows, rls, forced, policies, constraints, indexes }'
  }
  summarize "$live_snapshot" "source ($LIVE_DB)"
  summarize "$scratch_snapshot" "scratch ($SCRATCH)"
  if [ "$live_snapshot" != "$scratch_snapshot" ]; then
    echo "MISMATCH between the source and the scratch restore (first differences; < source, > scratch):"
    diff <(printf '%s\n' "$live_snapshot") <(printf '%s\n' "$scratch_snapshot") | grep -E '^[<>]' | cut -c1-200 | head -40 || true
    die "the restore does not match its source; scratch database retained"
  fi
  echo "compare-source: the scratch restore matches its source exactly (tables, row counts, RLS, policies, constraints, indexes)"
}
if [ "$COMPARE_SOURCE" -eq 1 ]; then
  compare_with_source
else
  check country_configs "SELECT count(*) FROM country_configs;" 1
  check users "SELECT count(*) FROM users;" 1
  check vendors "SELECT count(*) FROM vendors;" 0
  check orders "SELECT count(*) FROM orders;" 0
  [ "$FAILED" -eq 0 ] || die "restore failed sanity checks; scratch database retained"
fi

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
