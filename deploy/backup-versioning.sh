#!/usr/bin/env bash
# ===========================================================================
# [SEC-BACKUP] Turn on versioning for the BACKUP bucket, and say what it is.
#
# With versioning a dump that is overwritten or deleted keeps its previous
# version, which can be brought back. On DigitalOcean Spaces versioning is set
# only through the S3 API (the control panel shows it), with a key that has
# full access to buckets: PutBucketVersioning needs it, and a key limited to
# one bucket cannot. So this runs with the API's storage key from the main
# store (the full-access key), ONCE, before that key is narrowed to the uploads
# bucket (owner sheet BACKUP-KEY-SETUP). It is an owner operation, not a
# backup unit: the backup units never load the API's key.
#
#   sudo systemd-run --pipe --wait --collect --uid=swift-deploy --gid=swift-deploy \
#     -p SupplementaryGroups=docker -p WorkingDirectory=/opt/swift \
#     -p "UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE" \
#     -p LoadCredentialEncrypted=AWS_ACCESS_KEY_ID:/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred \
#     -p LoadCredentialEncrypted=AWS_SECRET_ACCESS_KEY:/etc/credstore.encrypted/swift/AWS_SECRET_ACCESS_KEY.cred \
#     /opt/swift/deploy/backup-versioning.sh [--status]
#
# --status only reads it. Settings from deploy/.env (BACKUP_BUCKET,
# AWS_S3_ENDPOINT: the REGIONAL endpoint, https://<region>.digitaloceanspaces.com,
# AWS_REGION, AWS_CLI_IMAGE); the keys from the credential directory. The AWS
# CLI runs in the pinned container, credentials by name only.
# ===========================================================================
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "FATAL: $*" >&2; exit 1; }
STATUS_ONLY=0
case "${1:-}" in
  "") ;;
  --status) STATUS_ONLY=1 ;;
  *) die "usage: backup-versioning.sh [--status]" ;;
esac
env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
for var in BACKUP_BUCKET AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
AWS_REGION="${AWS_REGION:-auto}"
[ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is not set in deploy/.env"
printf '%s\n' "${AWS_CLI_IMAGE:-}" | grep -Eq '@sha256:[0-9a-f]{64}$' || die "AWS_CLI_IMAGE must pin an image@sha256:<64-hex> digest"
command -v docker >/dev/null 2>&1 || die "Docker is required (the pinned AWS CLI container)"
. "$HERE/secret-env.sh"
load_secret_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || exit 1
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || die "the storage key with full access is not loaded (see the usage above)"
s3api() {
  local endpoint=()
  [ -z "${AWS_S3_ENDPOINT:-}" ] || endpoint=(--endpoint-url "$AWS_S3_ENDPOINT")
  docker run --rm -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION "$AWS_CLI_IMAGE" \
    ${endpoint[@]+"${endpoint[@]}"} s3api "$@"
}
if [ "$STATUS_ONLY" = 0 ]; then
  s3api put-bucket-versioning --bucket "$BACKUP_BUCKET" --versioning-configuration Status=Enabled ||
    die "the bucket refused versioning: the key needs FULL access (a limited key cannot), and AWS_S3_ENDPOINT must be the regional endpoint, not the bucket's origin endpoint"
fi
STATE="$(s3api get-bucket-versioning --bucket "$BACKUP_BUCKET" --query Status --output text 2>/dev/null || true)"
case "$STATE" in
  Enabled) echo "backup bucket versioning: Enabled" ;;
  Suspended) echo "backup bucket versioning: Suspended (old versions are kept, new writes are not versioned)"; exit 1 ;;
  *) echo "backup bucket versioning: NOT enabled"; exit 1 ;;
esac
