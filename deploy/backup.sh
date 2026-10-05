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
# It also records a heartbeat in the database on success. That is what lets
# something else notice when backups have quietly stopped — a silent backup
# failure is indistinguishable from safety until the day you need the file.
#
# Usage:
#   ./deploy/backup.sh                    # → deploy/backups/swift-<utc>.dump
#   ./deploy/backup.sh /path/to/dir       # → that directory
#   BACKUP_RETAIN_DAYS=14 ./deploy/backup.sh
#
# Reads the bundled Postgres through its private Compose network. No host
# DATABASE_URL or published database port is needed.
# Offsite SETTINGS come from the environment, then deploy/.env:
#   BACKUP_BUCKET      bucket for dumps (e.g. swift-backups)
#   AWS_S3_ENDPOINT    R2/S3 endpoint
#   BACKUP_PREFIX      key prefix, default "db"
#   AWS_CLI_IMAGE      pinned image@sha256 that provides the AWS CLI (no snap)
# The storage KEYS never come from deploy/.env: AWS_ACCESS_KEY_ID and
# AWS_SECRET_ACCESS_KEY are read from the environment, from *_FILE, or from
# $CREDENTIALS_DIRECTORY, where systemd puts them for swift-backup.service via
# LoadCredentialEncrypted= (deploy/secret-env.sh). The database password never
# reaches this host process at all: pg_dump runs inside the postgres container
# and reads POSTGRES_PASSWORD_FILE there.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${1:-$HERE/backups}"
RETAIN_DAYS="${BACKUP_RETAIN_DAYS:-14}"
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
for var in BACKUP_BUCKET BACKUP_PREFIX AWS_S3_BUCKET AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE BACKUP_HEARTBEAT_URL; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
# The storage keys: environment, *_FILE or systemd's credentials directory.
. "$HERE/secret-env.sh"
load_secret_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || exit 1
BACKUP_PREFIX="${BACKUP_PREFIX:-db}"
AWS_REGION="${AWS_REGION:-auto}"

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
