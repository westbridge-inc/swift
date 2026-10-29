#!/usr/bin/env bash
# ===========================================================================
# [Off-site erasure ledger · #1977 COORD ruling, 21 Oct] Ship every erasure's ledger entry off-site.
#
# A backup is older than the live database: an erasure done after the newest backup exists only in
# the live database. Every erasure writes an entry into erasure_ledger_entry in its own transaction
# (database triggers). This script, run every minute by swift-erasure-ledger.timer, sends the
# entries not yet shipped to the off-site backup bucket, encrypted to the owner's backup key (the
# same pinned public key and the same proof backup.sh uses), and records each shipment. A restore
# without the live database replays them (restore.sh --ledger-from).
#
# [BACKUP-FU] SIGNED, as every dump is: each encrypted batch is signed on this host with the backup
# signing key (BACKUP_SIGNING_KEY, from the backup store; deploy/backup-signature.py, binding the
# plain batch's SHA-256 too), the signature is proven against this host's allowed-signers file
# exactly as a restore will check it, and <batch>.sig is uploaded beside the batch before anything
# is recorded as shipped. restore.sh replays a batch only once its signature verifies. A host that
# has never signed a batch still ships, unsigned, with a loud warning (the old unit has no signing
# key); once one signed batch has shipped (recorded in BACKUP_FIRST_SIGNED_LEDGER_FILE), a run
# without a working key ships NOTHING: an unsigned batch from after that could never be replayed,
# so the entries wait and page (the 10-minute watch) instead.
#
# An entry holds ids, timestamps and de-identified columns only. The plain batch exists only in this
# run's private directory and is removed before the upload; only the .gpg leaves the host. Settings
# and storage keys as backup.sh: deploy/.env (settings only); the keys are the backup bucket's own
# pair (BACKUP_AWS_*, from the backup store the containers never see) or, until it exists, the API's
# pair with a loud warning, from the environment, *_FILE or $CREDENTIALS_DIRECTORY. The database
# password stays inside the postgres container.
#
# Usage: deploy/erasure-ledger-ship.sh --project <compose project>     (live is 'swift')
# Exit 0: shipped (or nothing to ship). Anything else: nothing was recorded as shipped.
# ===========================================================================
set -euo pipefail
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
die() { echo "FATAL: $*" >&2; exit 1; }
PROJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --project) [ $# -ge 2 ] || die "--project needs the Compose project name"; PROJECT="$2"; shift ;;
    *) die "unknown argument $1 (usage: erasure-ledger-ship.sh --project <compose project>)" ;;
  esac
  shift
done
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] ||
  die "name the Compose project that holds the live Postgres: --project <name> (live is 'swift'); this script never guesses"
COMPOSE=(docker compose --project-directory "$HERE" -p "$PROJECT" -f "$HERE/docker-compose.yml")
BATCH_LIMIT=5000

env_value() {
  [ -f "$HERE/.env" ] || return 0
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
for var in BACKUP_BUCKET BACKUP_PREFIX AWS_S3_BUCKET AWS_S3_ENDPOINT AWS_REGION AWS_CLI_IMAGE PILOT_ENV BACKUP_GPG_RECIPIENT_FILE BACKUP_GPG_FINGERPRINT BACKUP_SIGNING_ALLOWED_SIGNERS BACKUP_FIRST_SIGNED_LEDGER_FILE; do
  if [ -z "${!var:-}" ]; then export "$var=$(env_value "$var")"; fi
done
BACKUP_PREFIX="${BACKUP_PREFIX:-db}"
AWS_REGION="${AWS_REGION:-auto}"
# [BACKUP-FU] The signing key, as a FILE (as backup.sh reads it): the unit's credential directory, or
# BACKUP_SIGNING_KEY_FILE. The PUBLIC keys a restore trusts. When signing began.
SIGNING_KEY="${BACKUP_SIGNING_KEY_FILE:-}"
if [ -z "$SIGNING_KEY" ] && [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -e "$CREDENTIALS_DIRECTORY/BACKUP_SIGNING_KEY" ]; then
  SIGNING_KEY="$CREDENTIALS_DIRECTORY/BACKUP_SIGNING_KEY"
fi
ALLOWED_SIGNERS="${BACKUP_SIGNING_ALLOWED_SIGNERS:-/etc/swift/backup-allowed-signers}"
FIRST_SIGNED="${BACKUP_FIRST_SIGNED_LEDGER_FILE:-/var/backups/swift/.first-signed-erasure-ledger}"

# The database (read-only for the read; the shipment record is its own write).
db_psql() {
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -tA "$@"' \
    sh "$@"
}
db_psql_ro() {
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; export PGOPTIONS="-c default_transaction_read_only=on"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -q -tA "$@"' \
    sh "$@"
}

command -v docker >/dev/null 2>&1 || die "Docker is required for the private Postgres connection"
HAS="$(db_psql_ro -c "SELECT to_regclass('public.erasure_ledger_entry') IS NOT NULL;" | tr -d '[:space:]')" ||
  die "could not read the live database"
[ "$HAS" = t ] || { echo "erasure ledger: this database has no erasure_ledger_entry table yet; nothing to ship"; exit 0; }

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
GPG_HOME=""
cleanup() { rm -rf -- "$TMP_DIR"; [ -z "$GPG_HOME" ] || rm -rf -- "$GPG_HOME"; }
trap cleanup EXIT

# The oldest unshipped entries, one JSON object per line: {id, kind, entry, createdAt}.
BATCH="$TMP_DIR/batch.jsonl"
db_psql_ro -c "SELECT json_build_object('id', e.id, 'kind', e.kind, 'entry', e.entry,
    'createdAt', to_char(e.\"createdAt\", 'YYYY-MM-DD\"T\"HH24:MI:SS.MS'))::text
  FROM erasure_ledger_entry e
  WHERE NOT EXISTS (SELECT 1 FROM erasure_ledger_shipment s WHERE s.\"entryId\" = e.id)
  ORDER BY e.\"createdAt\", e.id LIMIT $BATCH_LIMIT;" > "$BATCH" || die "could not read the unshipped erasure ledger entries"
COUNT="$(grep -c . "$BATCH" || true)"
if [ "$COUNT" = 0 ]; then echo "erasure ledger: nothing to ship"; exit 0; fi
IDS="$(python3 -c '
import json, re, sys
ids = [json.loads(l)["id"] for l in open(sys.argv[1]) if l.strip()]
assert all(re.fullmatch(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", i) for i in ids)
print(",".join(ids))' "$BATCH")" || die "the unshipped batch is not well-formed; nothing was shipped"

# Off-site is not optional for this ledger: without the bucket there is nothing to ship to.
[ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is not set: $COUNT erasure ledger entr(ies) cannot leave this host"
if [ -n "${AWS_S3_BUCKET:-}" ] && [ "$BACKUP_BUCKET" = "$AWS_S3_BUCKET" ]; then die "BACKUP_BUCKET must differ from AWS_S3_BUCKET"; fi
. "$HERE/secret-env.sh"
# [SEC-BACKUP F1] The backup bucket's own key pair; the API's only as a loud fallback.
load_backup_storage_keys || exit 1

# The owner's key, proven exactly as every backup proves it (backup.sh --check-key). Required in every
# environment [#1984 REVIEW-F S4-1]: staging serves real people until the cutover, so no batch ever
# leaves in clear.
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="erasure-ledger-$STAMP-${IDS:0:8}.jsonl"
OUT="$TMP_DIR/$NAME"
[ -n "${BACKUP_GPG_RECIPIENT_FILE:-}" ] && [ -n "${BACKUP_GPG_FINGERPRINT:-}" ] ||
  die "the owner's backup key is not configured (BACKUP_GPG_RECIPIENT_FILE and BACKUP_GPG_FINGERPRINT): no erasure ledger batch leaves this host in clear; nothing was shipped"
"$HERE/backup.sh" --check-key >/dev/null || die "the owner's backup key is not proven (backup.sh --check-key); nothing was shipped"
GPG_HOME="$(mktemp -d)"
chmod 700 "$GPG_HOME"
KEYIDS="$(gpg --homedir "$GPG_HOME" --no-autostart --batch --with-colons --show-keys "$BACKUP_GPG_RECIPIENT_FILE" 2>/dev/null |
  awk -F: '/^(pub|sub):/ { print $5 }' | sort -u)"
gpg --homedir "$GPG_HOME" --no-autostart --batch --no-tty --yes --quiet --trust-model always \
  --recipient-file "$BACKUP_GPG_RECIPIENT_FILE" --output "$OUT.gpg" --encrypt "$BATCH" ||
  die "encrypting the batch to the owner's key failed; nothing was shipped"
RECIPIENTS="$(gpg --homedir "$GPG_HOME" --no-autostart --batch --list-packets "$OUT.gpg" 2>/dev/null |
  sed -n 's/^:pubkey enc packet:.* keyid \([0-9A-F]\{16\}\).*/\1/p' | sort -u || true)"
[ -n "$RECIPIENTS" ] || die "the encrypted batch names no recipient; nothing was shipped"
for keyid in $RECIPIENTS; do
  printf '%s\n' "$KEYIDS" | grep -qx "$keyid" || die "the encrypted batch names a recipient that is not the owner's key; nothing was shipped"
done
PLAIN_SHA256="$(python3 -I -c 'import hashlib, sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$BATCH")" ||
  die "could not read the batch's digest; nothing was shipped"
rm -f -- "$BATCH"
OUT="$OUT.gpg"
NAME="$NAME.gpg"

# ── SIGNATURE [BACKUP-FU] ──────────────────────────────────────────────────
# The encrypted batch and the plain batch's digest, signed and proven here, before it leaves.
SIGNED=0
if [ -n "$SIGNING_KEY" ]; then
  [ -r "$SIGNING_KEY" ] || die "the backup signing key ($SIGNING_KEY) cannot be read; nothing was shipped"
  python3 -I "$HERE/backup-signature.py" sign --key "$SIGNING_KEY" --object "$OUT" --out "$OUT.sig" \
    --plain-sha256 "$PLAIN_SHA256" --created "$STAMP" >/dev/null ||
    die "signing the batch with the backup signing key failed; nothing was shipped (the next run retries)"
  python3 -I "$HERE/backup-signature.py" verify --allowed-signers "$ALLOWED_SIGNERS" --sig "$OUT.sig" --name "$NAME" --object "$OUT" ||
    die "the batch is signed but the signature does NOT verify against $ALLOWED_SIGNERS, so every restore would refuse it; nothing was shipped. Run: sudo swift-secrets backup init"
  SIGNED=1
elif [ -e "$FIRST_SIGNED" ]; then
  die "this run has no backup signing key (BACKUP_SIGNING_KEY), but signed batches have shipped since $(head -1 "$FIRST_SIGNED" 2>/dev/null || echo '?'): an unsigned batch from now on would be refused by every restore. Nothing was shipped; install the current swift-erasure-ledger.service (deploy/owner/swift-backup-key.command)"
else
  echo "WARNING: ERASURE LEDGER BATCH NOT SIGNED: this unit has no backup signing key (BACKUP_SIGNING_KEY). A restore replays it only with --allow-unsigned-legacy. Install the backup store (sudo swift-secrets backup init) and the current swift-erasure-ledger.service (owner sheet BACKUP-KEY-SETUP)." >&2
fi

# The pinned AWS CLI container, as backup.sh runs it (credentials by NAME only).
image="${AWS_CLI_IMAGE:-}"
printf '%s\n' "$image" | grep -Eq '@sha256:[0-9a-f]{64}$' || die "AWS_CLI_IMAGE must pin an image@sha256:<64-hex> digest"
aws_s3() {
  local endpoint=()
  [ -z "${AWS_S3_ENDPOINT:-}" ] || endpoint=(--endpoint-url "$AWS_S3_ENDPOINT")
  docker run --rm --user "$(id -u):$(id -g)" \
    -e AWS_ACCESS_KEY_ID -e AWS_SECRET_ACCESS_KEY ${AWS_REGION:+-e AWS_REGION} \
    -v "$TMP_DIR:/data:ro" "$image" ${endpoint[@]+"${endpoint[@]}"} "$@"
}
# Under the backups' own prefix: the same bucket lifecycle as the backups, never shorter.
KEY="$BACKUP_PREFIX/erasure-ledger/$NAME"
SIZE="$(wc -c < "$OUT" | tr -d ' ')"
aws_s3 s3 cp "/data/$NAME" "s3://$BACKUP_BUCKET/$KEY" --only-show-errors ||
  die "the off-site upload failed; nothing was recorded as shipped (the next run retries)"
REMOTE_SIZE="$(aws_s3 s3api head-object --bucket "$BACKUP_BUCKET" --key "$KEY" --query 'ContentLength' --output text 2>/dev/null || true)"
[ "$REMOTE_SIZE" = "$SIZE" ] || die "the uploaded batch is $REMOTE_SIZE bytes, local $SIZE; nothing was recorded as shipped"
# The signature beside it, proven the same way. (A batch left without its signature by a failure
# here is shipped again, signed, by the next run; a restore sets the unsigned copy aside.)
if [ "$SIGNED" = 1 ]; then
  SIG_SIZE="$(wc -c < "$OUT.sig" | tr -d ' ')"
  aws_s3 s3 cp "/data/$NAME.sig" "s3://$BACKUP_BUCKET/$KEY.sig" --only-show-errors ||
    die "the batch is off-site but its signature could not be uploaded; nothing was recorded as shipped (the next run retries)"
  REMOTE_SIG_SIZE="$(aws_s3 s3api head-object --bucket "$BACKUP_BUCKET" --key "$KEY.sig" --query 'ContentLength' --output text 2>/dev/null || true)"
  [ "$REMOTE_SIG_SIZE" = "$SIG_SIZE" ] ||
    die "the uploaded signature is $REMOTE_SIG_SIZE bytes, local $SIG_SIZE; nothing was recorded as shipped"
fi

# Only now: the shipment, one row per entry, in one transaction.
db_psql -c "INSERT INTO erasure_ledger_shipment (\"entryId\", \"objectKey\")
  SELECT x::uuid, '$KEY' FROM unnest(string_to_array('$IDS', ',')) AS x
  ON CONFLICT (\"entryId\") DO NOTHING;" >/dev/null ||
  die "the batch is off-site ($KEY) but the shipment could not be recorded; the next run ships these entries again"
if [ "$SIGNED" = 1 ]; then
  echo "erasure ledger: shipped $COUNT entr(ies) → s3://$BACKUP_BUCKET/$KEY (signed → $NAME.sig)"
  # When signing began: recorded once, after the first signed batch is off-site and recorded.
  # restore.sh accepts an UNSIGNED batch with --allow-unsigned-legacy only from before this moment.
  if [ ! -e "$FIRST_SIGNED" ]; then
    (umask 077; printf '%s\n' "$STAMP" > "$FIRST_SIGNED.partial" && mv -f "$FIRST_SIGNED.partial" "$FIRST_SIGNED") &&
      echo "erasure ledger signing began: $STAMP (recorded in $FIRST_SIGNED; keep a copy of this stamp with the allowed-signers file)" ||
      echo "WARNING: could not record when erasure ledger signing began in $FIRST_SIGNED" >&2
  fi
else
  echo "erasure ledger: shipped $COUNT entr(ies) → s3://$BACKUP_BUCKET/$KEY (UNSIGNED)"
fi
