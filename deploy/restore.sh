#!/usr/bin/env bash
# Restore a local or off-site custom dump into a NEW scratch database only.
# The live database is never a target. Keep the scratch DB for inspection.
#
#   ./deploy/restore.sh [--compare-source] <dump-file|s3://backup-bucket/key> [new-scratch-db]
#
# [PROD-PATH] --compare-source judges the restore against the LIVE database it
# was dumped from, instead of fixed minimums (a new production database has no
# user yet, so "at least one user" cannot prove anything there). In schemas
# public and swift_qr the scratch copy must equal the source in every table's
# row count AND content checksum, column definitions and defaults, the RLS
# switches, policies, constraints, indexes, triggers, function definitions,
# grants and sequence positions (POSTURE_SQL below). Use it on a quiet
# database, right after the backup: any row written to the live database
# since the dump is a mismatch, reported by table. The backup and rehearsal
# heartbeats in platform_config are left out — backup.sh writes them after
# the dump by design.
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
# [PROD-PATH] One read of a database's contents and shape, the same query on
# both sides, over the schemas public and swift_qr. A line per:
#   rows       table: row count and a content checksum (md5 over every row's
#              text, in md5 order, so physical order does not matter);
#   column     table column: position (among live columns), type, NOT NULL, default;
#   rls        table: row-level security enabled, forced;
#   policy     policy: command, roles, USING and WITH CHECK;
#   constraint constraint: definition;   index    index: definition;
#   trigger    user trigger: definition and enabled state;
#   function   function: kind, language, security definer, settings, volatility,
#              and a checksum of its body;
#   grant      table, sequence, function and schema privileges, default privileges;
#   sequence   sequence: last value;   extension  extension: version.
# Sorted, so two equal databases give byte-equal snapshots. The session pins
# its time zone, date and interval style and float digits, so a row's text
# cannot differ by setting.
POSTURE_SQL="-- posture-snapshot
SET TIME ZONE 'UTC'; SET DateStyle TO 'ISO, YMD'; SET IntervalStyle TO 'postgres'; SET extra_float_digits TO 1;
SELECT line FROM (
  SELECT format('rows|%s.%s|%s|%s', t.table_schema, t.table_name,
    (xpath('/row/c/text()', x))[1]::text, (xpath('/row/h/text()', x))[1]::text) AS line
  FROM information_schema.tables t
  CROSS JOIN LATERAL query_to_xml(format(
    'SELECT count(*) AS c, md5(coalesce(string_agg(md5(r::text), '','' ORDER BY md5(r::text) COLLATE \"C\"), '''')) AS h FROM %I.%I r %s',
    t.table_schema, t.table_name,
    CASE WHEN t.table_schema = 'public' AND t.table_name = 'platform_config'
      THEN 'WHERE r.key NOT IN (''last_backup_at'', ''last_backup_offsite'', ''last_restore_rehearsal_at'', ''last_restore_rehearsal_seconds'')'
      ELSE '' END), false, true, '') AS x
  WHERE t.table_schema IN ('public', 'swift_qr') AND t.table_type = 'BASE TABLE'
  UNION ALL
  SELECT format('column|%s.%s|%s|%s|%s|notnull=%s|default=%s', n.nspname, c.relname, a.attname,
    row_number() OVER (PARTITION BY a.attrelid ORDER BY a.attnum),
    format_type(a.atttypid, a.atttypmod), a.attnotnull, coalesce(pg_get_expr(d.adbin, d.adrelid), ''))
  FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
  WHERE n.nspname IN ('public', 'swift_qr') AND c.relkind IN ('r', 'p') AND a.attnum > 0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('rls|%s.%s|enabled=%s|forced=%s', n.nspname, c.relname, c.relrowsecurity, c.relforcerowsecurity)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'swift_qr') AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT format('policy|%s.%s|%s|%s|%s|%s|%s|%s', p.schemaname, p.tablename, p.policyname, p.permissive, p.roles::text, p.cmd, coalesce(p.qual, ''), coalesce(p.with_check, ''))
  FROM pg_policies p WHERE p.schemaname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('constraint|%s|%s|%s', c.conrelid::regclass::text, c.conname, pg_get_constraintdef(c.oid))
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace WHERE n.nspname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('index|%s.%s|%s|%s', i.schemaname, i.tablename, i.indexname, i.indexdef)
  FROM pg_indexes i WHERE i.schemaname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('trigger|%s|%s|enabled=%s|%s', tg.tgrelid::regclass::text, tg.tgname, tg.tgenabled, pg_get_triggerdef(tg.oid))
  FROM pg_trigger tg JOIN pg_class c ON c.oid = tg.tgrelid JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'swift_qr') AND NOT tg.tgisinternal
  UNION ALL
  SELECT format('function|%s.%s(%s)|kind=%s|lang=%s|definer=%s|config=%s|volatile=%s|body=%s', n.nspname, p.proname,
    pg_get_function_identity_arguments(p.oid), p.prokind, l.lanname, p.prosecdef, coalesce(p.proconfig::text, ''), p.provolatile, md5(coalesce(p.prosrc, '')))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace JOIN pg_language l ON l.oid = p.prolang
  WHERE n.nspname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('grant|relation|%s.%s|%s', n.nspname, c.relname, coalesce(c.relacl::text, ''))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'swift_qr') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT format('grant|function|%s.%s(%s)|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), coalesce(p.proacl::text, ''))
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('grant|schema|%s|%s', n.nspname, coalesce(n.nspacl::text, ''))
  FROM pg_namespace n WHERE n.nspname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('grant|default|%s|%s|%s', coalesce(n.nspname, ''), d.defaclobjtype, d.defaclacl::text)
  FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
  UNION ALL
  SELECT format('sequence|%s.%s|last=%s', s.schemaname, s.sequencename, coalesce(s.last_value::text, 'unused'))
  FROM pg_sequences s WHERE s.schemaname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('extension|%s|%s', e.extname, e.extversion) FROM pg_extension e
) s ORDER BY line COLLATE \"C\";"
compare_with_source() {
  local live_snapshot scratch_snapshot
  live_snapshot="$(db_psql "$LIVE_DB" -q -tA -c "$POSTURE_SQL")" || die "could not read the source database $LIVE_DB; scratch database retained"
  scratch_snapshot="$(db_psql "$SCRATCH" -q -tA -c "$POSTURE_SQL")" || die "could not read the scratch database; scratch database retained"
  printf '%s\n' "$live_snapshot" | grep -q '^rows|' || die "the source database $LIVE_DB has no tables to compare; scratch database retained"
  summarize() {
    printf '%s\n' "$1" | awk -F'|' -v who="$2" '
      $1 == "rows" { tables++; rows += $3 }
      $1 == "column" { columns++ }
      $1 == "rls" && $3 == "enabled=t" { rls++ }
      $1 == "rls" && $4 == "forced=t" { forced++ }
      $1 == "policy" { policies++ }
      $1 == "constraint" { constraints++ }
      $1 == "index" { indexes++ }
      $1 == "trigger" { triggers++ }
      $1 == "function" { functions++ }
      $1 == "grant" { grants++ }
      $1 == "sequence" { sequences++ }
      END { printf "%s: %d tables, %d rows, %d columns, RLS enabled on %d, forced on %d, %d policies, %d constraints, %d indexes, %d triggers, %d functions, %d grant entries, %d sequences\n", who, tables, rows, columns, rls, forced, policies, constraints, indexes, triggers, functions, grants, sequences }'
  }
  summarize "$live_snapshot" "source ($LIVE_DB)"
  summarize "$scratch_snapshot" "scratch ($SCRATCH)"
  if [ "$live_snapshot" != "$scratch_snapshot" ]; then
    echo "MISMATCH between the source and the scratch restore (first differences; < source, > scratch):"
    diff <(printf '%s\n' "$live_snapshot") <(printf '%s\n' "$scratch_snapshot") | grep -E '^[<>]' | cut -c1-240 | head -40 || true
    die "the restore does not match its source; scratch database retained"
  fi
  echo "compare-source: in schemas public and swift_qr the scratch restore equals its source in every table's row count and content checksum, column definitions and defaults, RLS switches, policies, constraints, indexes, triggers, function definitions, grants and sequence positions"
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
