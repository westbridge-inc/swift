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

[ -n "$SOURCE" ] || die "usage: restore.sh <dump-file|s3://backup-bucket/key> [new-scratch-db]"
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
