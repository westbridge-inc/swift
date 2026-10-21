#!/usr/bin/env bash
# Restore a local or off-site custom dump into a NEW scratch database only.
# The live database is never a target. Keep the scratch DB for inspection.
#
#   ./deploy/restore.sh [--compare-source] <dump-file|s3://backup-bucket/key|-> [new-scratch-db]
#   ./deploy/restore.sh --fetch-encrypted s3://backup-bucket/key.dump.gpg > file
#
# [BACKUP-ENC] Production dumps are encrypted to the OWNER's key (backup.sh),
# and this server never decrypts: an encrypted dump (.gpg) given here is
# refused. The drill runs from the owner's computer (deploy/backup-drill.sh):
# this script's --fetch-encrypted streams the encrypted object out on stdout,
# the owner's computer decrypts it, and the plain dump comes back on stdin
# (source `-`) into the same scratch restore and checks as any other dump.
#
# [PROD-PATH] --compare-source judges the restore against the LIVE database it
# was dumped from, instead of fixed minimums (a new production database has no
# user yet, so "at least one user" cannot prove anything there). In schemas
# public and swift_qr the scratch copy must equal the source in every table's
# row count AND content checksum, column definitions and defaults, the RLS
# switches, policies, constraints, indexes, triggers, function definitions,
# view definitions and options, grants and sequence positions (POSTURE_SQL
# below). Use it on a quiet database, right after the backup: any row written
# to the live database since the dump is a mismatch, reported by table. The
# backup and rehearsal heartbeats in platform_config are left out — backup.sh
# writes them after the dump by design.
#
# [item 196] A restored copy is QUARANTINED and the LIVE erasure ledger is
# replayed onto it before anything is reported. The scratch database is closed
# to every login role except the operator's own (and superusers) from the moment
# it exists, before any row arrives. A backup is older than the live database:
# people who closed their account, documents purged and keys destroyed since
# the dump are still whole in it. restore-erasure-ledger.sql says what is read
# from the live database, restore-replay-erasures.sql re-applies it to the copy
# in one transaction; a failure leaves the copy quarantined and unreported. On a
# fresh dump the replay changes nothing, so --compare-source still proves the
# copy equal to its source.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
die() { echo "FATAL: $*" >&2; exit 1; }
COMPARE_SOURCE=0
FETCH_ENCRYPTED=0
# [#1977] Disaster recovery: with the live database gone there is no live ledger. Both flags or nothing.
NO_LIVE_LEDGER=0
LIVE_IS_GONE=0
# [#1977] A failed replay drops the copy (it holds people the live database erased) unless kept.
KEEP_FAILED=0
# [#1977 · copy run #5c] The Compose project that holds the target Postgres, named explicitly: the
# base file says `name: swift`, so without it a restore on a rehearsal host lands in LIVE's stack.
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) [ $# -ge 2 ] || die "--project needs the Compose project name"; PROJECT="$2"; shift ;;
    --compare-source) COMPARE_SOURCE=1 ;;
    --fetch-encrypted) FETCH_ENCRYPTED=1 ;;
    --no-live-ledger) NO_LIVE_LEDGER=1 ;;
    --i-know-live-is-gone) LIVE_IS_GONE=1 ;;
    --keep-failed) KEEP_FAILED=1 ;;
    --*) die "unknown option $1" ;;
    *) break ;;
  esac
  shift
done
if [ "$NO_LIVE_LEDGER" = 1 ] || [ "$LIVE_IS_GONE" = 1 ]; then
  [ "$NO_LIVE_LEDGER" = 1 ] && [ "$LIVE_IS_GONE" = 1 ] ||
    die "the disaster-recovery restore needs BOTH --no-live-ledger and --i-know-live-is-gone: without the live database there is no erasure ledger, and the copy will not be erasure-complete"
  [ "$COMPARE_SOURCE" = 0 ] && [ "$FETCH_ENCRYPTED" = 0 ] ||
    die "--no-live-ledger --i-know-live-is-gone restores without a live database: it cannot be combined with --compare-source or --fetch-encrypted"
fi
SOURCE="${1:-}"
SCRATCH="${2:-swift_restore_$(date -u +%Y%m%d%H%M%S)}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
TMP_DIR=""
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
# [#1977 · REVIEW-G S4-1] Every read of the LIVE database's ledger runs read-only: this path never writes live.
db_psql_ro() {
  local database="$1"; shift
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; export PGOPTIONS="-c default_transaction_read_only=on"; db="$1"; shift; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$db" -v ON_ERROR_STOP=1 "$@"' \
    sh "$database" "$@"
}
# [#1977 · REVIEW-F S4-1] Once rows are in the copy, a failure DROPS it: a copy the replay did not
# finish still holds people the live database has erased. --keep-failed keeps it, quarantined.
ROWS_IN=0
die_copy() {
  [ "$ROWS_IN" = 1 ] || die "$*; scratch database retained (quarantined, empty), not restored"
  if [ "$KEEP_FAILED" = 1 ]; then
    die "$*; scratch database $SCRATCH retained (quarantined) because --keep-failed was given. It may hold people the live database erased: drop it as soon as you are done"
  fi
  if db_psql postgres -q -c "DROP DATABASE \"$SCRATCH\" WITH (FORCE);"; then
    die "$*; the scratch database (quarantined until now) was dropped: it held people the live database has erased. Fix and rerun, or pass --keep-failed to inspect it"
  fi
  die "$*; DROPPING the scratch database $SCRATCH FAILED: drop it by hand now, it holds people the live database has erased"
}
# [#1977 · REVIEW-F S4-2] Which deployment a database belongs to (environment/deploymentId), or none/none.
deployment_identity_of() {
  local fn="$2" has
  has="$("$fn" "$1" -tAc "SELECT to_regclass('public.deployment_identity') IS NOT NULL;" | tr -d '[:space:]')" || return 1
  if [ "$has" != t ]; then echo "none/none"; return 0; fi
  "$fn" "$1" -tAc "SELECT coalesce(max(environment), 'none') || '/' || coalesce(max(\"deploymentId\"), 'none') FROM deployment_identity;" | tr -d '[:space:]'
}
cleanup() { [ -z "$TMP_DIR" ] || rm -rf -- "$TMP_DIR"; }
trap cleanup EXIT
private_tmp() { [ -n "$TMP_DIR" ] || { TMP_DIR="$(mktemp -d)"; chmod 700 "$TMP_DIR"; }; }

# [item 196] Only the operator's own login (and superusers) may connect to the
# scratch copy: not PUBLIC, not any application login. Checked, not assumed.
quarantine_scratch() {
  db_psql postgres -q <<SQL
REVOKE ALL ON DATABASE "$SCRATCH" FROM PUBLIC;
DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname <> current_user LOOP
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', '$SCRATCH', r.rolname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname <> current_user
             AND has_database_privilege(rolname, '$SCRATCH', 'CONNECT')) THEN
    RAISE EXCEPTION 'the scratch database could not be closed to application logins';
  END IF;
END \$\$;
SQL
}

# [item 196] Read the live erasure ledger and replay it onto the scratch copy,
# in one transaction on the copy. Prints the replay's summary line.
LEDGER_SQL="$HERE/restore-erasure-ledger.sql"
REPLAY_SQL="$HERE/restore-replay-erasures.sql"
replay_erasure_ledger() {
  local has names=() selects=() name="" line i script summary live_id copy_id
  [ -f "$LEDGER_SQL" ] && [ -f "$REPLAY_SQL" ] ||
    die_copy "the erasure ledger files are missing next to restore.sh; not restored"
  live_id="$(deployment_identity_of "$LIVE_DB" db_psql_ro)" || die_copy "could not read the deployment identity of $LIVE_DB; not restored"
  copy_id="$(deployment_identity_of "$SCRATCH" db_psql)" || die_copy "could not read the deployment identity of the restored copy; not restored"
  echo "live database identity : $live_id"
  echo "restored copy identity : $copy_id"
  if [ "${live_id%%/*}" != none ] && [ "${copy_id%%/*}" != none ] && [ "${live_id%%/*}" != "${copy_id%%/*}" ]; then
    die_copy "the live database ($live_id) and the restored copy ($copy_id) belong to different environments: the live ledger does not describe this copy; not restored"
  fi
  has="$(db_psql_ro "$LIVE_DB" -tAc "SELECT to_regclass('public.deletion_receipt') IS NOT NULL;" | tr -d '[:space:]')" ||
    die_copy "could not read the erasure ledger of $LIVE_DB; not restored"
  if [ "$has" != t ]; then
    echo "erasure ledger: $LIVE_DB keeps none (no deletion_receipt table); nothing to replay"
    return 0
  fi
  while IFS= read -r line; do
    if [[ "$line" =~ ^--\ ledger:\ ([a-z_]+)$ ]]; then name="${BASH_REMATCH[1]}"; continue; fi
    if [ -n "$name" ] && [[ "$line" == SELECT\ * ]]; then names+=("$name"); selects+=("$line"); name=""; fi
  done < "$LEDGER_SQL"
  [ "${#names[@]}" -gt 0 ] || die_copy "the erasure ledger file names no entries; not restored"
  private_tmp
  script="$TMP_DIR/erasure-replay.sql"
  # The live rows travel through this run's private directory only (ids,
  # timestamps and already de-identified account columns).
  ( umask 077
    { echo 'BEGIN;'
      for i in "${!names[@]}"; do
        echo "CREATE TEMP TABLE restore_ledger_${names[$i]} ON COMMIT DROP AS ${selects[$i]} WITH NO DATA;"
      done
      for i in "${!names[@]}"; do
        echo "COPY restore_ledger_${names[$i]} FROM STDIN WITH (FORMAT csv);"
        db_psql_ro "$LIVE_DB" -q -c "COPY (${selects[$i]}) TO STDOUT WITH (FORMAT csv);" || exit 1
        printf '%s\n' '\.'
      done
      cat "$REPLAY_SQL"
      echo 'COMMIT;'
    } > "$script" ) || die_copy "could not read the erasure ledger of $LIVE_DB; not restored"
  summary="$(db_psql "$SCRATCH" -q -tA < "$script")" ||
    die_copy "the erasure ledger replay failed; not restored"
  rm -f -- "$script"
  printf '%s\n' "$summary" | grep -E '^erasure ledger replayed: ' ||
    die_copy "the erasure ledger replay reported nothing; not restored"
}

[ -n "$SOURCE" ] || die "usage: restore.sh [--compare-source] <dump-file|s3://backup-bucket/key|-> [new-scratch-db], or restore.sh --fetch-encrypted s3://backup-bucket/key.dump.gpg"
if [ "$FETCH_ENCRYPTED" = 1 ]; then
  [[ "$SOURCE" == s3://*.dump.gpg ]] || die "--fetch-encrypted streams only an encrypted off-site dump (s3://…/….dump.gpg); a plain dump never leaves this way"
  [ ! -t 1 ] || die "--fetch-encrypted writes the encrypted dump to stdout; redirect or pipe it (deploy/backup-drill.sh does)"
elif [[ "$SOURCE" == *.gpg ]]; then
  die "this dump is encrypted to the owner's key and this server never decrypts it: run deploy/backup-drill.sh on the owner's computer (it fetches, decrypts there, and restores through this script)"
fi
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
  if [ "$FETCH_ENCRYPTED" = 1 ]; then
    # Only ciphertext: an OpenPGP message, never a plain archive.
    if pg_restore --list "$DUMP" >/dev/null 2>&1; then die "the object is a PLAIN dump, not encrypted; refusing to stream it out"; fi
    # [S3-1, Opus review 14 Oct] And positively an encrypted one: gpg also
    # "decrypts" a message that carries no encryption (gpg --store) or only a
    # passphrase. Its first packets must be public-key session keys, followed
    # directly by the encrypted data. Read from the head only, never decrypted.
    command -v gpg >/dev/null 2>&1 || die "gpg is required to check that the object is encrypted (apt-get install gnupg)"
    mkdir -m 700 "$TMP_DIR/gnupg"
    head -c 4096 -- "$DUMP" > "$TMP_DIR/head"
    KINDS="$(gpg --homedir "$TMP_DIR/gnupg" --batch --no-autostart --list-only --list-packets "$TMP_DIR/head" 2>/dev/null |
      sed -n 's/^:\([a-z ]*\):.*/\1/p' || true)"
    printf '%s\n' "$KINDS" | awk '
      $0 == "pubkey enc packet" { keys++; next }
      { ok = keys > 0 && ($0 == "encrypted data packet" || $0 == "aead encrypted packet"); exit }
      END { exit ok ? 0 : 1 }' ||
      die "the object is not encrypted to a key (an OpenPGP message must start with public-key session keys, followed by the encrypted data); refusing to stream it out"
    cat -- "$DUMP"
    exit 0
  fi
elif [ "$SOURCE" = - ]; then
  # The plain dump on stdin (backup-drill.sh decrypts it on the owner's
  # computer), held only in this run's private temporary directory.
  [ ! -t 0 ] || die "source - reads the dump from stdin; pipe it in (deploy/backup-drill.sh does)"
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  DUMP="$TMP_DIR/restore.dump"
  (umask 077; cat > "$DUMP")
  [ -s "$DUMP" ] || die "nothing arrived on stdin"
else
  DUMP="$SOURCE"
fi
[ -f "$DUMP" ] || die "dump file does not exist"
pg_restore --list "$DUMP" >/dev/null 2>&1 || die "pg_restore cannot read this archive"

[ -n "$PROJECT" ] ||
  die "name the Compose project that holds the target Postgres: --project <name> (live is 'swift', a rehearsal copy e.g. 'swift-rehearsal'); restore.sh never guesses"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die "--project must be a Compose project name (lowercase letters, digits, - and _)"
COMPOSE+=(-p "$PROJECT")
echo "compose project : $PROJECT (its postgres service)"
echo "archive : $(basename "$DUMP")"
echo "scratch : $SCRATCH"
EXISTS="$(db_psql postgres -tAc "SELECT 1 FROM pg_database WHERE datname = '$SCRATCH';")"
[ -z "$EXISTS" ] || die "scratch database already exists; choose a new name"
# [#1977 · copy run #5c gap (a)] Closed from birth: created refusing every connection, then closed
# to PUBLIC and to each login, and only then opened, for the restore.
db_psql postgres -q -c "CREATE DATABASE \"$SCRATCH\" WITH ALLOW_CONNECTIONS false;"
quarantine_scratch || die "the scratch database could not be quarantined; it was created empty and is retained"
db_psql postgres -q -c "ALTER DATABASE \"$SCRATCH\" WITH ALLOW_CONNECTIONS true;" ||
  die "the quarantined scratch database could not be opened for the restore; it was created empty and is retained"

STARTED="$(date +%s)"
ROWS_IN=1
"${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" --exit-on-error --no-owner --dbname="$1"' \
  sh "$SCRATCH" < "$DUMP" || die_copy "pg_restore failed; not restored"
quarantine_scratch || die_copy "the restored scratch database could not be kept quarantined"
if [ "$NO_LIVE_LEDGER" = 1 ]; then
  echo "DISASTER-RECOVERY MODE: no live erasure ledger was replayed (--no-live-ledger --i-know-live-is-gone)"
else
  replay_erasure_ledger
fi

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
#   view       view or materialized view: kind, options (security_invoker,
#              security_barrier, check_option) and a checksum of its definition;
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
  SELECT format('view|%s.%s|kind=%s|options=%s|definition=%s', n.nspname, c.relname, c.relkind,
    coalesce(c.reloptions::text, ''), md5(pg_get_viewdef(c.oid, true)))
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'swift_qr') AND c.relkind IN ('v', 'm')
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
  grep -q '^rows|' <<<"$live_snapshot" || die "the source database $LIVE_DB has no tables to compare; scratch database retained"
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
      $1 == "view" { views++ }
      $1 == "grant" { grants++ }
      $1 == "sequence" { sequences++ }
      END { printf "%s: %d tables, %d rows, %d columns, RLS enabled on %d, forced on %d, %d policies, %d constraints, %d indexes, %d triggers, %d functions, %d views, %d grant entries, %d sequences\n", who, tables, rows, columns, rls, forced, policies, constraints, indexes, triggers, functions, views, grants, sequences }'
  }
  summarize "$live_snapshot" "source ($LIVE_DB)"
  summarize "$scratch_snapshot" "scratch ($SCRATCH)"
  if [ "$live_snapshot" != "$scratch_snapshot" ]; then
    echo "MISMATCH between the source and the scratch restore (first differences; < source, > scratch):"
    diff <(printf '%s\n' "$live_snapshot") <(printf '%s\n' "$scratch_snapshot") | grep -E '^[<>]' | cut -c1-240 | head -40 || true
    die "the restore does not match its source; scratch database retained"
  fi
  echo "compare-source: in schemas public and swift_qr the scratch restore equals its source in every table's row count and content checksum, column definitions and defaults, RLS switches, policies, constraints, indexes, triggers, function definitions, view definitions and options, grants and sequence positions"
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
if [ "$NO_LIVE_LEDGER" = 1 ]; then
  # [#1977 COORD ruling] Never "RESTORE OK", never a rehearsal heartbeat, a distinct exit code.
  echo "quarantine: only the operator's login (and superusers) can connect to $SCRATCH; no application login can"
  echo "NOT erasure-complete: replay the off-site ledger before use"
  echo "NOT erasure-complete: replay the off-site ledger before use" >&2
  echo "This copy is the backup's state: anyone erased after the backup is still whole in it. Re-apply those erasures (the off-site erasure ledger, or by hand from the erasure receipts) before anything from it is used. Keep it quarantined until then."
  echo "DR restore of $SCRATCH finished in ${SECONDS_TAKEN}s; scratch database retained, quarantined, NOT for use"
  exit 3
fi
echo "quarantine: only the operator's login (and superusers) can connect to $SCRATCH; no application login can"
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
echo "The quarantine covers the logins that exist now: re-run the quarantine before use (a login created later is not covered), and drop the copy after use (psql inside the Postgres container)."
echo "Document objects and MASTER_KEK require separate recovery proof."
echo "Before anything from this copy is used, replay the erasure ledger again against the live database of that day."
