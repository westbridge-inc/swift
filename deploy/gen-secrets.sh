#!/usr/bin/env bash
#
# Generate the secrets a Swift staging/production deploy cannot boot without,
# and put them in the ENCRYPTED HOST STORE — never in deploy/.env, never on
# screen.
#
# Every value is generated locally with openssl and piped ON STDIN into
# `sudo -n swift-secrets set NAME` (deploy/swift-secrets), which encrypts it
# bound to this host under /etc/credstore.encrypted/swift/ and hands it to the
# containers as a file on tmpfs. Nothing is transmitted and nothing is printed
# except NAMES. deploy/.env receives settings only: the value-free template
# plus MASTER_KEK_ESCROW_FINGERPRINT, the sha256 of the key bytes, which is
# what deploy/preflight.ts checks the live key against. An existing .env is
# kept, minus any secret line it still carries (in any spelling Compose would
# load), which is reported by count.
#
# The boot guards these satisfy, from apps/api/src/utils/boot-config.ts:
#   MASTER_KEK              32 bytes, base64. Unset ⇒ verification documents
#                           (government IDs, selfies) are stored UNENCRYPTED.
#                           The guard decodes and checks the length is exactly 32.
#   OTP_HASH_SECRET         >=32 chars (or a >=32 char JWT_SECRET). OTP records
#                           are six digits; an unkeyed hash is recoverable
#                           offline in seconds.
#   STORAGE_SIGNING_SECRET  The ONLY gate on the unauthenticated document-render
#                           route. The default value is published in a PUBLIC
#                           repo, so anyone could forge a token for any docId
#                           and stream a decrypted ID.
#   JWT_SECRET              Session signing.
#   TEST_CONTROL_SECRET     Signs load-test leases; its repository fallback is
#                           refused outside the isolated test mode.
#
# CONSENT_IP_PEPPER, ATTRIB_SALT, IDENTITY_SALT and SCAN_IP_SALT key the hashes
# the ledgers keep instead of raw identifiers; ADS_EVENT_SECRET signs ad event
# tokens. All are required in production. METRICS_TOKEN and HEALTH_DETAIL_TOKEN
# gate the ops endpoints. POSTGRES_PASSWORD and MEILISEARCH_KEY are read by the
# postgres and search containers through deploy/docker-compose.yml.
#
# Usage:
#   ./deploy/gen-secrets.sh            # refuses if MASTER_KEK is already stored
#   ./deploy/gen-secrets.sh --missing  # store only the names not yet stored
#   ./deploy/gen-secrets.sh --force    # rotate: swift-secrets keeps NAME.cred.prev
#
# ROTATION IS NOT FREE. Re-generating MASTER_KEK makes every already-encrypted
# verification document undecryptable, and re-generating STORAGE_SIGNING_SECRET
# invalidates every signed URL in flight. --force keeps the previous encrypted
# version beside the new one and says so; it cannot un-break data that was
# encrypted under the old key. --missing never replaces anything.
#
# Afterwards: sudo systemctl restart swift-secrets.service (or run
# deploy/pilot-up.sh, which does it), then restart api and worker.

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
ENV_FILE="$HERE/.env"
TEMPLATE="$HERE/.env.deploy.example"
FORCE=0
MISSING=0
GENERATED="MASTER_KEK JWT_SECRET OTP_HASH_SECRET STORAGE_SIGNING_SECRET CONSENT_IP_PEPPER POSTGRES_PASSWORD MEILISEARCH_KEY TEST_CONTROL_SECRET METRICS_TOKEN HEALTH_DETAIL_TOKEN ATTRIB_SALT IDENTITY_SALT SCAN_IP_SALT ADS_EVENT_SECRET"

die() { echo "FATAL: $*" >&2; exit 1; }

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=1 ;;
    --missing) MISSING=1 ;;
    -h|--help) sed -n '2,52p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
  esac
done
[ "$FORCE" -eq 0 ] || [ "$MISSING" -eq 0 ] || die "--force and --missing are exclusive"

command -v openssl >/dev/null 2>&1 ||
  die "openssl not found. Every secret here is generated locally with it; there is no fallback worth having."

# ONE definition of which names are secrets (the loader allowlist) and of what
# an env-file declaration looks like — shared with pilot-up.sh.
. "$HERE/secret-names.sh"
ALLOWLIST="$(secret_allowlist "$ROOT")" ||
  die "could not read the secret allowlist (apps/api/src/utils/secret-files.ts); refusing to guess which lines are secrets"

# The store command: swift-secrets on PATH (/usr/local/sbin on the host), else
# the repository copy; through sudo -n unless already root.
STORE_BIN="$(command -v swift-secrets || true)"
[ -n "$STORE_BIN" ] || STORE_BIN="$HERE/swift-secrets"
[ -x "$STORE_BIN" ] || die "swift-secrets not found; install deploy/swift-secrets to /usr/local/sbin first"
if [ "$(id -u)" -eq 0 ]; then
  store() { "$STORE_BIN" "$@"; }
else
  store() { sudo -n "$STORE_BIN" "$@"; }
fi

STORED="$(store list)" || die "could not list the encrypted store"
stored() { grep -qx "$1" <<< "$STORED"; }
if stored MASTER_KEK && [ "$FORCE" -eq 0 ] && [ "$MISSING" -eq 0 ]; then
  cat >&2 <<'MSG'
FATAL: MASTER_KEK is already in the encrypted store.

Refusing to replace it. If this deploy has ever run, that key encrypted every
stored verification document, and replacing it makes those documents
undecryptable — permanently.

To add names this version generates and the store does not hold yet, re-run
with --missing (nothing stored is touched). If you genuinely mean to rotate,
re-run with --force (swift-secrets keeps the previous encrypted version as
MASTER_KEK.cred.prev), and understand that a rotated MASTER_KEK does not
re-encrypt anything that already exists.
MSG
  exit 1
fi
if [ "$FORCE" -eq 1 ] && stored MASTER_KEK; then
  echo "rotating — swift-secrets keeps each previous encrypted version as NAME.cred.prev"
fi

# 32 raw bytes → base64. The guard does Buffer.from(kek,'base64').length !== 32,
# so this must be exactly 32 bytes BEFORE encoding, not 32 characters after.
gen_kek()    { openssl rand -base64 32; }
# 48 raw bytes → ~64 base64 chars, comfortably over every >=32 check.
gen_secret() { openssl rand -base64 48 | tr -d '\n=' ; }
# 32 raw bytes → 64 hex chars: safe in a URL, a header and a shell.
gen_token()  { openssl rand -hex 32; }

MASTER_KEK="$(gen_kek)"
# Prove the one value with a hard length requirement meets it BEFORE it is
# stored, rather than discovering it at boot on the server. (The decoder needs
# a terminating newline on its input; the stored value gets none.)
KEK_BYTES=$(printf '%s\n' "$MASTER_KEK" | openssl base64 -d | wc -c | tr -d ' ')
[ "$KEK_BYTES" = "32" ] || die "MASTER_KEK decoded to ${KEK_BYTES} bytes, not 32 — the boot guard would refuse. Nothing stored."
FINGERPRINT="$(printf '%s\n' "$MASTER_KEK" | openssl base64 -d | shasum -a 256 | cut -d' ' -f1)"
JWT_SECRET="$(gen_secret)"
OTP_HASH_SECRET="$(gen_secret)"
STORAGE_SIGNING_SECRET="$(gen_secret)"
CONSENT_IP_PEPPER="$(gen_secret)"
# The password is percent-encoded when the app assembles DATABASE_URL, and hex
# needs no encoding anywhere (PGPASSWORD, psql, the postgres image).
POSTGRES_PASSWORD=$(openssl rand -hex 32)
MEILISEARCH_KEY="$(gen_secret)"
TEST_CONTROL_SECRET="$(gen_token)"
METRICS_TOKEN="$(gen_token)"
HEALTH_DETAIL_TOKEN="$(gen_token)"
ATTRIB_SALT="$(gen_secret)"
IDENTITY_SALT="$(gen_secret)"
SCAN_IP_SALT="$(gen_secret)"
ADS_EVENT_SECRET="$(gen_secret)"

# Into the store, one value per pipe. `printf '%s'` sends no trailing newline,
# so the stored bytes are exactly the generated ones. With --missing, a name
# the store already holds is kept as it is.
STORED_NOW=""
KEPT=""
MASTER_KEK_STORED=0
store_generated() {
  local name="$1"
  if [ "$MISSING" -eq 1 ] && stored "$name"; then
    KEPT="$KEPT $name"
    return 0
  fi
  printf '%s' "${!name}" | store set "$name"
  STORED_NOW="$STORED_NOW $name"
  [ "$name" != MASTER_KEK ] || MASTER_KEK_STORED=1
}
store_generated MASTER_KEK
store_generated JWT_SECRET
store_generated OTP_HASH_SECRET
store_generated STORAGE_SIGNING_SECRET
store_generated CONSENT_IP_PEPPER
store_generated POSTGRES_PASSWORD
store_generated MEILISEARCH_KEY
store_generated TEST_CONTROL_SECRET
store_generated METRICS_TOKEN
store_generated HEALTH_DETAIL_TOKEN
store_generated ATTRIB_SALT
store_generated IDENTITY_SALT
store_generated SCAN_IP_SALT
store_generated ADS_EVENT_SECRET
unset MASTER_KEK JWT_SECRET OTP_HASH_SECRET STORAGE_SIGNING_SECRET CONSENT_IP_PEPPER POSTGRES_PASSWORD MEILISEARCH_KEY
unset TEST_CONTROL_SECRET METRICS_TOKEN HEALTH_DETAIL_TOKEN ATTRIB_SALT IDENTITY_SALT SCAN_IP_SALT ADS_EVENT_SECRET

# deploy/.env: settings only. Created from the value-free template when absent.
# When it exists, every line is kept EXCEPT secret declarations (any spelling
# Compose would load) and, when the key was generated now, the old fingerprint.
umask 077
REMOVED=0
if [ ! -e "$ENV_FILE" ]; then
  {
    echo "# Generated by deploy/gen-secrets.sh on $(date -u +%Y-%m-%dT%H:%M:%SZ). SETTINGS ONLY."
    echo "# Every secret lives in the encrypted host store: sudo swift-secrets list."
    echo "#"
    echo "# [D-4] A database dump does not save the documents MASTER_KEK protects. Put a"
    echo "# copy of the key somewhere this server's loss cannot take with it (a vault, a"
    echo "# sealed envelope — not this disk, not the backup bucket). The fingerprint is"
    echo "# what deploy/preflight.ts checks the live key against, so a rotated key with a"
    echo "# stale escrow is caught before it costs every document."
    if [ "$MASTER_KEK_STORED" -eq 1 ]; then
      echo "MASTER_KEK_ESCROW_FINGERPRINT=$FINGERPRINT"
    else
      echo "# MASTER_KEK_ESCROW_FINGERPRINT=   (the stored key was kept; record its fingerprint from the escrow copy)"
    fi
    echo
    echo "# ---------------------------------------------------------------------"
    echo "# Everything below is copied from .env.deploy.example. Review it — the"
    echo "# defaults are development-safe, which means several of them are exactly"
    echo "# what the production boot guards refuse to start on (KYC_PROVIDER=sandbox,"
    echo "# PAYMENT_PROVIDER=sandbox, MMG_DRIVER=sandbox, NOTIFICATION_PROVIDER=dev)."
    echo "# Run ./deploy/preflight.sh to see exactly which ones would refuse."
    echo "# ---------------------------------------------------------------------"
    echo
    if [ -f "$TEMPLATE" ]; then
      # The template is value-free by contract; drop any secret defensively.
      strip_secret_declarations "$TEMPLATE" $ALLOWLIST $SECRET_CONSUMER_ALIASES
    fi
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ENV_ACTION="wrote"
else
  TMP="$ENV_FILE.tmp.$$"
  BEFORE=$(wc -l < "$ENV_FILE" | tr -d ' ')
  {
    if [ "$MASTER_KEK_STORED" -eq 1 ]; then
      strip_secret_declarations "$ENV_FILE" $ALLOWLIST $SECRET_CONSUMER_ALIASES | grep -vE '^MASTER_KEK_ESCROW_FINGERPRINT=' || true
      echo "MASTER_KEK_ESCROW_FINGERPRINT=$FINGERPRINT"
    else
      strip_secret_declarations "$ENV_FILE" $ALLOWLIST $SECRET_CONSUMER_ALIASES
    fi
  } > "$TMP"
  chmod 600 "$TMP"
  AFTER=$(strip_secret_declarations "$ENV_FILE" $ALLOWLIST $SECRET_CONSUMER_ALIASES | wc -l | tr -d ' ')
  REMOVED=$((BEFORE - AFTER))
  mv -f "$TMP" "$ENV_FILE"
  ENV_ACTION="updated"
fi

# Report names only. A script that prints secrets puts them in a scrollback
# buffer, a CI log, and a screen recording.
if [ -n "$STORED_NOW" ]; then
  echo "stored in the encrypted host store (names only):"
  for v in $STORED_NOW; do echo "  - $v"; done
fi
if [ -n "$KEPT" ]; then
  echo "already stored, kept (names only):"
  for v in $KEPT; do echo "  - $v"; done
fi
[ "$MASTER_KEK_STORED" -eq 0 ] || echo "verified: MASTER_KEK decodes to exactly 32 bytes"
echo "$ENV_ACTION $(basename "$ENV_FILE") (mode 600, settings only)"
[ "$REMOVED" -eq 0 ] || echo "removed $REMOVED secret line(s) from $(basename "$ENV_FILE") (secrets live in the store)"
echo
echo "Next: sudo systemctl restart swift-secrets.service to deliver the values to the"
echo "containers (deploy/pilot-up.sh does this), and ./deploy/preflight.sh --secrets-dir"
echo "/run/swift-secrets as root to see, per boot guard, what is PRESENT, MISSING, or"
echo "WILL-REFUSE-IN-PRODUCTION."
