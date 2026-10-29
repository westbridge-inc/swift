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
# [BACKUP-FU2 · owner ruling 29 Oct] The CURRENT hourly dumps are kept
# BACKUP_OFFSITE_RETAIN_DAYS days (default 30): a second rule, set in the same
# configuration, deletes every object whose key starts with
# "$BACKUP_PREFIX/swift-" (the dumps backup.sh uploads, swift-<stamp>.dump[.gpg],
# and their .sig) that many days after it was made. DigitalOcean documents
# lifecycle expiration by key prefix, "the number of days after object
# creation" (Terraform reference for Spaces buckets, lifecycle_rule prefix and
# expiration days); tag-based rules are not supported (Spaces S3 compatibility).
# It NEVER touches the erasure ledger ("$BACKUP_PREFIX/erasure-ledger/"): a
# restore needs every signed batch of that chain. Before anything is written,
# every enabled rule of the resulting configuration (the bucket's own rules
# included) is checked, and if any would expire a current object under the
# ledger prefix NOTHING is changed: that rule must be narrowed first. With
# versioning on, an expired dump stays as an old version for
# BACKUP_VERSION_RETAIN_DAYS more days before the first rule deletes it.
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
# --status only reads them (and fails without either rule, or with a rule that
# would expire the ledger). Settings from deploy/.env (BACKUP_BUCKET,
# BACKUP_PREFIX, AWS_S3_ENDPOINT: the REGIONAL endpoint,
# https://<region>.digitaloceanspaces.com, AWS_REGION, AWS_CLI_IMAGE,
# BACKUP_VERSION_RETAIN_DAYS, BACKUP_OFFSITE_RETAIN_DAYS); the keys from the
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
for var in BACKUP_BUCKET BACKUP_PREFIX AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE BACKUP_VERSION_RETAIN_DAYS BACKUP_OFFSITE_RETAIN_DAYS; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
AWS_REGION="${AWS_REGION:-auto}"
DAYS="${BACKUP_VERSION_RETAIN_DAYS:-30}"
[[ "$DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || die "BACKUP_VERSION_RETAIN_DAYS must be a whole number of days, 1 to 9999"
RULE_ID=swift-backup-noncurrent-versions
DUMP_DAYS="${BACKUP_OFFSITE_RETAIN_DAYS:-30}"
[[ "$DUMP_DAYS" =~ ^[1-9][0-9]{0,3}$ ]] || die "BACKUP_OFFSITE_RETAIN_DAYS must be a whole number of days, 1 to 9999"
DUMP_RULE_ID=swift-backup-dump-retention
# The same prefix backup.sh and erasure-ledger-ship.sh write under (default db).
PREFIX="${BACKUP_PREFIX:-db}"
[[ "$PREFIX" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*(/[A-Za-z0-9][A-Za-z0-9_-]*)*$ ]] ||
  die "BACKUP_PREFIX must be a plain key prefix (letters, digits, - and _, parts joined by /, no leading or trailing /)"
DUMP_PREFIX="$PREFIX/swift-"
LEDGER_PREFIX="$PREFIX/erasure-ledger/"
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
dump_rule_days() {   # the days of our dump rule when it is exactly ours (enabled, the dumps' prefix), or empty
  python3 -I -c 'import json, sys
rules = json.load(sys.stdin).get("Rules", [])
for r in rules:
    if r.get("ID") == sys.argv[1] and r.get("Status") == "Enabled" and r.get("Prefix") == sys.argv[2] and not r.get("Filter"):
        print((r.get("Expiration") or {}).get("Days", ""))' "$DUMP_RULE_ID" "$DUMP_PREFIX"
}
# [BACKUP-FU2] Every enabled rule that would delete a CURRENT object under the ledger prefix (an
# Expiration with Days or Date whose prefix covers some ledger key; no prefix covers every key).
# Noncurrent-version and delete-marker cleanup never delete a current object. Prints one line per
# rule ID and fails when there is any.
ledger_safe() {
  python3 -I -c 'import json, sys
ledger = sys.argv[1]
bad = []
for r in json.load(sys.stdin).get("Rules", []):
    if r.get("Status") != "Enabled":
        continue
    exp = r.get("Expiration") or {}
    if "Days" not in exp and "Date" not in exp:
        continue
    f = r.get("Filter") or {}
    prefix = r.get("Prefix", f.get("Prefix", (f.get("And") or {}).get("Prefix", ""))) or ""
    if ledger.startswith(prefix) or prefix.startswith(ledger):
        bad.append(r.get("ID") or "(no ID)")
for rule in bad:
    print(rule)
sys.exit(1 if bad else 0)' "$LEDGER_PREFIX"
}
refuse_ledger_expiry() {   # stdin: the IDs ledger_safe printed
  local id
  while IFS= read -r id; do
    echo "FATAL: lifecycle rule $id would delete the erasure ledger ($LEDGER_PREFIX): a restore needs every signed batch of it. Narrow that rule to a prefix that leaves $LEDGER_PREFIX alone; nothing was changed" >&2
  done
  exit 1
}
if [ "$STATUS_ONLY" = 0 ]; then
  # 1. The bounds first, so versioning is never on without them: old versions expire after DAYS,
  # current dumps (only "$PREFIX/swift-") after DUMP_DAYS, in one configuration.
  current_rules > "$TMP_DIR/current.json"
  python3 -I -c 'import json, sys
cfg = json.load(open(sys.argv[1]))
rules = [r for r in cfg.get("Rules", []) if r.get("ID") not in (sys.argv[2], sys.argv[4])]
rules.append({"ID": sys.argv[2], "Status": "Enabled", "Prefix": "",
              "NoncurrentVersionExpiration": {"NoncurrentDays": int(sys.argv[3])},
              "Expiration": {"ExpiredObjectDeleteMarker": True}})
rules.append({"ID": sys.argv[4], "Status": "Enabled", "Prefix": sys.argv[5],
              "Expiration": {"Days": int(sys.argv[6])}})
json.dump({"Rules": rules}, open(sys.argv[7], "w"))' "$TMP_DIR/current.json" "$RULE_ID" "$DAYS" "$DUMP_RULE_ID" "$DUMP_PREFIX" "$DUMP_DAYS" "$TMP_DIR/lifecycle.json"
  # Never a configuration that deletes the erasure ledger (the bucket's own rules included).
  ledger_safe < "$TMP_DIR/lifecycle.json" > "$TMP_DIR/unsafe" || refuse_ledger_expiry < "$TMP_DIR/unsafe"
  s3api put-bucket-lifecycle-configuration --bucket "$BACKUP_BUCKET" --lifecycle-configuration file:///data/lifecycle.json ||
    die "the bucket refused the lifecycle rules (a full-access key and the REGIONAL endpoint are needed); versioning was NOT turned on"
  current_rules > "$TMP_DIR/after.json"
  [ "$(rule_days < "$TMP_DIR/after.json")" = "$DAYS" ] && [ "$(dump_rule_days < "$TMP_DIR/after.json")" = "$DUMP_DAYS" ] ||
    die "the lifecycle rules do not read back as set; versioning was NOT turned on"
  # 2. Only then versioning.
  s3api put-bucket-versioning --bucket "$BACKUP_BUCKET" --versioning-configuration Status=Enabled ||
    die "the bucket refused versioning: the key needs FULL access (a limited key cannot), and AWS_S3_ENDPOINT must be the regional endpoint, not the bucket's origin endpoint"
fi
current_rules > "$TMP_DIR/now.json"
SET_DAYS="$(rule_days < "$TMP_DIR/now.json")"
SET_DUMP_DAYS="$(dump_rule_days < "$TMP_DIR/now.json")"
STATE="$(s3api get-bucket-versioning --bucket "$BACKUP_BUCKET" --query Status --output text 2>/dev/null || true)"
if [ -n "$SET_DAYS" ]; then
  echo "backup bucket old versions: expire after $SET_DAYS days (lifecycle rule $RULE_ID)"
else
  echo "backup bucket old versions: NO expiry rule"
fi
if [ -n "$SET_DUMP_DAYS" ]; then
  echo "backup bucket hourly dumps: deleted $SET_DUMP_DAYS days after they were made (lifecycle rule $DUMP_RULE_ID, prefix $DUMP_PREFIX; the erasure ledger is never expired)"
else
  echo "backup bucket hourly dumps: NO expiry rule (owner ruling: kept $DUMP_DAYS days). Rerun without --status to set it."
fi
ledger_safe < "$TMP_DIR/now.json" > "$TMP_DIR/unsafe" || refuse_ledger_expiry < "$TMP_DIR/unsafe"
case "$STATE" in
  Enabled) echo "backup bucket versioning: Enabled" ;;
  Suspended) echo "backup bucket versioning: Suspended (old versions are kept, new writes are not versioned)"; exit 1 ;;
  *) echo "backup bucket versioning: NOT enabled"; exit 1 ;;
esac
[ -n "$SET_DAYS" ] || { echo "FATAL: versioning is on without an expiry for old versions: every old dump would be kept forever. Rerun without --status to set it." >&2; exit 1; }
[ -n "$SET_DUMP_DAYS" ] || { echo "FATAL: no expiry rule for the hourly dumps: every dump would be kept forever. Rerun without --status to set it." >&2; exit 1; }
