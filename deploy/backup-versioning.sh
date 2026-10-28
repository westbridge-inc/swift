#!/usr/bin/env bash
# ===========================================================================
# [SEC-BACKUP] Turn on versioning for the BACKUP bucket, BOUNDED in time.
#
# With versioning a dump that is overwritten or deleted keeps its previous
# version, which can be brought back. [REVIEW-M S3-2] Every old version is a
# full copy of everyone's data, so they must not live forever: BEFORE versioning
# is enabled, this sets a lifecycle rule on the bucket that expires noncurrent
# versions after BACKUP_VERSION_RETAIN_DAYS days (default 30) and removes the
# delete markers left behind. DigitalOcean documents both for Spaces lifecycle
# rules (noncurrent_version_expiration { days }, expired_object_delete_marker:
# docs.digitalocean.com/reference/terraform/reference/resources/spaces_bucket/).
# The bucket's OTHER lifecycle rules are kept: the rule is added or replaced by
# its own ID, never the whole configuration blindly.
#
# On DigitalOcean Spaces versioning and lifecycle are set only through the S3
# API, with a key that has full access to buckets (PutBucketVersioning and
# PutBucketLifecycleConfiguration need it; a key limited to one bucket cannot).
# So this runs with the API's storage key from the main store (the full-access
# key), ONCE, before that key is narrowed to the uploads bucket (owner sheet
# BACKUP-KEY-SETUP). It is an owner operation, not a backup unit: the backup
# units never load the API's key.
#
#   sudo systemd-run --pipe --wait --collect --uid=swift-deploy --gid=swift-deploy \
#     -p SupplementaryGroups=docker -p WorkingDirectory=/opt/swift \
#     -p "UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE" \
#     -p LoadCredentialEncrypted=AWS_ACCESS_KEY_ID:/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred \
#     -p LoadCredentialEncrypted=AWS_SECRET_ACCESS_KEY:/etc/credstore.encrypted/swift/AWS_SECRET_ACCESS_KEY.cred \
#     /opt/swift/deploy/backup-versioning.sh [--status]
#
# --status only reads both. Settings from deploy/.env (BACKUP_BUCKET,
# AWS_S3_ENDPOINT: the REGIONAL endpoint, https://<region>.digitaloceanspaces.com,
# AWS_REGION, AWS_CLI_IMAGE, BACKUP_VERSION_RETAIN_DAYS); the keys from the
# credential directory. The AWS CLI runs in the pinned container, credentials
# by name only.
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
for var in BACKUP_BUCKET AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE BACKUP_VERSION_RETAIN_DAYS; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
AWS_REGION="${AWS_REGION:-auto}"
DAYS="${BACKUP_VERSION_RETAIN_DAYS:-30}"
[[ "$DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || die "BACKUP_VERSION_RETAIN_DAYS must be a whole number of days, 1 to 9999"
RULE_ID=swift-backup-noncurrent-versions
[ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is not set in deploy/.env"
printf '%s\n' "${AWS_CLI_IMAGE:-}" | grep -Eq '@sha256:[0-9a-f]{64}$' || die "AWS_CLI_IMAGE must pin an image@sha256:<64-hex> digest"
command -v docker >/dev/null 2>&1 || die "Docker is required (the pinned AWS CLI container)"
. "$HERE/secret-env.sh"
load_secret_env AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY || exit 1
[ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] || die "the storage key with full access is not loaded (see the usage above)"
TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
trap 'rm -rf -- "${TMP_DIR:?}"' EXIT
s3api() {
  local endpoint=()
  [ -z "${AWS_S3_ENDPOINT:-}" ] || endpoint=(--endpoint-url "$AWS_S3_ENDPOINT")
  docker run --rm --user "$(id -u):$(id -g)" -v "$TMP_DIR:/data" -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY -e AWS_REGION "$AWS_CLI_IMAGE" \
    ${endpoint[@]+"${endpoint[@]}"} s3api "$@"
}
# The bucket's lifecycle rules now (none is an answer, not an error).
current_rules() {
  local out
  if out="$(s3api get-bucket-lifecycle-configuration --bucket "$BACKUP_BUCKET" --output json 2>"$TMP_DIR/get.err")"; then
    printf '%s\n' "$out"
  elif grep -q 'NoSuchLifecycleConfiguration' "$TMP_DIR/get.err"; then
    echo '{"Rules": []}'
  else
    cat "$TMP_DIR/get.err" >&2
    die "could not read the bucket's lifecycle rules; nothing was changed"
  fi
}
rule_days() {   # the noncurrent-version days of our rule, or empty
  python3 -I -c 'import json, sys
rules = json.load(sys.stdin).get("Rules", [])
for r in rules:
    if r.get("ID") == sys.argv[1] and r.get("Status") == "Enabled":
        print((r.get("NoncurrentVersionExpiration") or {}).get("NoncurrentDays", ""))' "$RULE_ID"
}
if [ "$STATUS_ONLY" = 0 ]; then
  # 1. The bound first, so versioning is never on without it.
  current_rules | python3 -I -c 'import json, sys
cfg = json.load(sys.stdin)
rules = [r for r in cfg.get("Rules", []) if r.get("ID") != sys.argv[1]]
rules.append({"ID": sys.argv[1], "Status": "Enabled", "Prefix": "",
              "NoncurrentVersionExpiration": {"NoncurrentDays": int(sys.argv[2])},
              "Expiration": {"ExpiredObjectDeleteMarker": True}})
json.dump({"Rules": rules}, open(sys.argv[3], "w"))' "$RULE_ID" "$DAYS" "$TMP_DIR/lifecycle.json"
  s3api put-bucket-lifecycle-configuration --bucket "$BACKUP_BUCKET" --lifecycle-configuration file:///data/lifecycle.json ||
    die "the bucket refused the lifecycle rule (a full-access key and the REGIONAL endpoint are needed); versioning was NOT turned on"
  [ "$(current_rules | rule_days)" = "$DAYS" ] ||
    die "the lifecycle rule does not read back as set; versioning was NOT turned on"
  # 2. Only then versioning.
  s3api put-bucket-versioning --bucket "$BACKUP_BUCKET" --versioning-configuration Status=Enabled ||
    die "the bucket refused versioning: the key needs FULL access (a limited key cannot), and AWS_S3_ENDPOINT must be the regional endpoint, not the bucket's origin endpoint"
fi
SET_DAYS="$(current_rules | rule_days)"
STATE="$(s3api get-bucket-versioning --bucket "$BACKUP_BUCKET" --query Status --output text 2>/dev/null || true)"
if [ -n "$SET_DAYS" ]; then
  echo "backup bucket old versions: expire after $SET_DAYS days (lifecycle rule $RULE_ID)"
else
  echo "backup bucket old versions: NO expiry rule"
fi
case "$STATE" in
  Enabled) echo "backup bucket versioning: Enabled" ;;
  Suspended) echo "backup bucket versioning: Suspended (old versions are kept, new writes are not versioned)"; exit 1 ;;
  *) echo "backup bucket versioning: NOT enabled"; exit 1 ;;
esac
[ -n "$SET_DAYS" ] || { echo "FATAL: versioning is on without an expiry for old versions: every old dump would be kept forever. Rerun without --status to set it." >&2; exit 1; }
