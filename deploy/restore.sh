#!/usr/bin/env bash
# Restore a local or off-site custom dump into a NEW scratch database only, in
# a THROWAWAY Postgres instance. The live database and the live cluster are
# never a target. Keep the scratch instance for inspection.
#
#   ./deploy/restore.sh [--compare-source] [--allow-unsigned-legacy] <dump-file|s3://backup-bucket/key|-> [new-scratch-db]
#   ./deploy/restore.sh --fetch-encrypted s3://backup-bucket/key.dump.gpg > file
#   ./deploy/restore.sh --fetch-signature s3://backup-bucket/key.dump.gpg > file   (verified; or the
#                       line "swift-backup-signature none" when the object has no signature)
#   ... --signature-b64 <bundle> --signed-object <name> -     (the drill's plain dump on stdin)
#   ... --keep-for-inspection   keep the throwaway instance afterwards (otherwise it is removed)
#
# [SEC-BACKUP F2] SIGNED DUMPS ONLY. backup.sh signs every dump on the host
# (deploy/backup-signature.py) and keeps the signature beside it as
# <object>.sig. Before anything is created this script verifies it against the
# allowed-signers file of PUBLIC backup signing keys
# (BACKUP_SIGNING_ALLOWED_SIGNERS, default /etc/swift/backup-allowed-signers):
# the signature, the object's name, its size and SHA-256 (for the decrypted
# dump the drill pipes in, the plain dump's SHA-256 that was signed with the
# encrypted copy). Whoever can write to the backup bucket cannot plant a dump
# that passes. A dump with NO signature (made before signing existed) is
# restored only with --allow-unsigned-legacy, an explicit owner decision that
# warns loudly; a signature that is present but does not verify is refused
# whatever the flags.
#
# [SEC-BACKUP F2] A THROWAWAY INSTANCE, A NON-SUPERUSER RESTORE. The archive is
# restored into a new container of the live database's own image (same major
# version, same extensions) with NO network, its own volume, and nothing of the
# live stack mounted. Inside it, the restore logs in as a role named like the
# live database's owner (POSTGRES_USER) that is NOT a superuser: it owns only
# the scratch database, may bypass row security (to load and read every row, as
# the source's owner did) and nothing else. The instance's own superuser only
# prepares it: the roles the dump grants to (no login), and the extensions the
# dump names, from a fixed allowlist (an untrusted extension such as PostGIS
# cannot be created by a non-superuser); the archive's extension entries and
# the rows of extension-owned tables are left to the extension itself. Nothing
# from the archive ever runs with superuser rights, and nothing from it reaches
# the live cluster: the live database is only read (the erasure ledger, the
# --compare-source snapshot) and gets the rehearsal heartbeat.
#
# [SEC-BACKUP · REVIEW-M S3-1] THROWN AWAY. The copy holds every person's data,
# and is erasure-complete only at the moment of the restore: the instance AND
# its volume are removed when the run ends, whatever the outcome (success, a
# failed comparison or check, any error). Only --keep-for-inspection keeps it,
# and says how and by when to remove it (doctor.sh lists every labelled
# restore volume and FAILS on one older than a day). A disaster-recovery
# restore exists to keep its copy, so it needs --keep-for-inspection up front.
#
# [SEC-BACKUP · REVIEW-G S4-1] --allow-unsigned-legacy is bounded in time: an
# off-site object is accepted unsigned only when the bucket's own LastModified
# predates the first signed backup (recorded by backup.sh in
# /var/backups/swift/.first-signed-backup, BACKUP_FIRST_SIGNED_FILE; or the
# owner's copy of that stamp, BACKUP_SIGNED_SINCE, on a new host).
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
# [SEC-BACKUP · REVIEW-M S3-1] Keep the instance after the run (it is removed otherwise).
KEEP_INSPECT=0
# [#1977 · copy run #5c] The Compose project that holds the target Postgres, named explicitly: the
# base file says `name: swift`, so without it a restore on a rehearsal host lands in LIVE's stack.
PROJECT=""
# [Off-site erasure ledger] The shipped entries, decrypted by the owner on his own computer: a plain
# JSONL file only this login can read. They join the live ledger, or stand alone in a DR restore.
LEDGER_FROM=""
# [SEC-BACKUP F2] The signature: the owner's explicit flag for a dump made before signing existed;
# the drill's verified bundle (base64) and object name for the plain dump it pipes in; and
# --fetch-signature, which prints an off-site object's verified signature.
ALLOW_UNSIGNED=0
FETCH_SIGNATURE=0
SIGNATURE_B64=""
SIGNED_OBJECT=""
while [ $# -gt 0 ]; do
  case "$1" in
    --allow-unsigned-legacy) ALLOW_UNSIGNED=1 ;;
    --fetch-signature) FETCH_SIGNATURE=1 ;;
    --signature-b64) [ $# -ge 2 ] || die "--signature-b64 needs the signature bundle"; SIGNATURE_B64="$2"; shift ;;
    --signed-object) [ $# -ge 2 ] || die "--signed-object needs the signed object's name"; SIGNED_OBJECT="$2"; shift ;;
    --ledger-from) [ $# -ge 2 ] || die "--ledger-from needs the decrypted off-site ledger file"; LEDGER_FROM="$2"; shift ;;
    --project) [ $# -ge 2 ] || die "--project needs the Compose project name"; PROJECT="$2"; shift ;;
    --compare-source) COMPARE_SOURCE=1 ;;
    --fetch-encrypted) FETCH_ENCRYPTED=1 ;;
    --no-live-ledger) NO_LIVE_LEDGER=1 ;;
    --i-know-live-is-gone) LIVE_IS_GONE=1 ;;
    --keep-failed) KEEP_FAILED=1 ;;
    --keep-for-inspection) KEEP_INSPECT=1; KEEP_FAILED=1 ;;
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
  [ "$KEEP_INSPECT" = 1 ] ||
    die "a disaster-recovery restore exists to keep its copy, and every copy is removed at the end unless kept: add --keep-for-inspection (nothing was started)"
fi
SOURCE="${1:-}"
SCRATCH="${2:-swift_restore_$(date -u +%Y%m%d%H%M%S)}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
TMP_DIR=""
# [SEC-BACKUP F2] The throwaway instance: its superuser prepares it, the restore login (named like
# the live owner, NOT a superuser there) does everything that touches the archive.
SCRATCH_ADMIN=swift_restore_admin
SCRATCH_CTR=""
INSTANCE_UP=0
# Extensions the throwaway's superuser may create because the archive names them.
EXTENSION_ALLOWLIST="plpgsql postgis postgis_topology postgis_raster postgis_tiger_geocoder fuzzystrmatch address_standardizer address_standardizer_data_us pg_trgm pgcrypto citext uuid-ossp btree_gin btree_gist unaccent"
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
# [SEC-BACKUP F2] The scratch database lives in the throwaway instance: every call reaches it over
# the instance's own socket, as the restore login (never a superuser) or, to prepare it, as the
# instance's superuser. Neither is the live cluster.
scratch_psql() {
  local database="$1"; shift
  docker exec -i "$SCRATCH_CTR" sh -c \
    "db=\"\$1\"; shift; exec psql -X -h /var/run/postgresql -U $RESTORE_LOGIN -d \"\$db\" -v ON_ERROR_STOP=1 \"\$@\"" \
    sh "$database" "$@"
}
scratch_admin_psql() {
  local database="$1"; shift
  docker exec -i "$SCRATCH_CTR" sh -c \
    "db=\"\$1\"; shift; exec psql -X -h /var/run/postgresql -U $SCRATCH_ADMIN -d \"\$db\" -v ON_ERROR_STOP=1 \"\$@\"" \
    sh "$database" "$@"
}
remove_instance() {
  [ "$INSTANCE_UP" = 1 ] || return 0
  docker rm -f "$SCRATCH_CTR" >/dev/null 2>&1 && docker volume rm "$SCRATCH_CTR" >/dev/null 2>&1 || return 1
  INSTANCE_UP=0
}
# [#1977 · REVIEW-F S4-1] Once rows are in the copy, a failure DROPS it: a copy the replay did not
# finish still holds people the live database has erased. --keep-failed keeps it, quarantined.
ROWS_IN=0
die_copy() {
  if [ "$ROWS_IN" != 1 ]; then
    remove_instance || die "$*; removing the EMPTY scratch instance $SCRATCH_CTR failed (docker rm -f $SCRATCH_CTR; docker volume rm $SCRATCH_CTR), not restored"
    die "$*; the empty scratch instance was removed, not restored"
  fi
  if [ "$KEEP_FAILED" = 1 ]; then
    die "$*; scratch database $SCRATCH retained (quarantined, in the throwaway instance $SCRATCH_CTR) because --keep-failed was given. It may hold people the live database erased: remove it as soon as you are done (docker rm -f $SCRATCH_CTR && docker volume rm $SCRATCH_CTR)"
  fi
  if remove_instance; then
    die "$*; the scratch database (quarantined until now) was dropped with its throwaway instance: it held people the live database has erased. Fix and rerun, or pass --keep-failed to inspect it"
  fi
  die "$*; DROPPING the scratch database $SCRATCH FAILED: remove its instance by hand now (docker rm -f $SCRATCH_CTR && docker volume rm $SCRATCH_CTR), it holds people the live database has erased"
}
# [#1977 · REVIEW-F S4-2] Which deployment a database belongs to (environment/deploymentId), or none/none.
deployment_identity_of() {
  local fn="$2" has
  has="$("$fn" "$1" -tAc "SELECT to_regclass('public.deployment_identity') IS NOT NULL;" | tr -d '[:space:]')" || return 1
  if [ "$has" != t ]; then echo "none/none"; return 0; fi
  "$fn" "$1" -tAc "SELECT coalesce(max(environment), 'none') || '/' || coalesce(max(\"deploymentId\"), 'none') FROM deployment_identity;" | tr -d '[:space:]'
}
# Whatever ends the run, an instance nobody asked to keep goes with it (a failure that kept it on
# purpose, --keep-failed / --keep-for-inspection, already said so).
cleanup() {
  [ -z "$TMP_DIR" ] || rm -rf -- "$TMP_DIR"
  if [ "$INSTANCE_UP" = 1 ] && [ "$KEEP_FAILED" = 0 ]; then
    remove_instance || echo "FATAL: removing the scratch instance $SCRATCH_CTR FAILED: remove it now (docker rm -f $SCRATCH_CTR && docker volume rm $SCRATCH_CTR), it holds a copy of the database" >&2
  fi
}
trap cleanup EXIT
private_tmp() { [ -n "$TMP_DIR" ] || { TMP_DIR="$(mktemp -d)"; chmod 700 "$TMP_DIR"; }; }

# [item 196] Only the restore login (and the instance's superuser) may connect to the
# scratch copy: not PUBLIC, not any other login. Checked, not assumed. (The
# throwaway instance has no network at all; this keeps the rule inside it too.)
quarantine_scratch() {
  scratch_admin_psql postgres -q <<SQL
REVOKE ALL ON DATABASE "$SCRATCH" FROM PUBLIC;
DO \$\$ DECLARE r record; BEGIN
  FOR r IN SELECT rolname FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname NOT IN (current_user, '$RESTORE_LOGIN') LOOP
    EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM %I', '$SCRATCH', r.rolname);
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolcanlogin AND NOT rolsuper AND rolname NOT IN (current_user, '$RESTORE_LOGIN')
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
OFFSITE_SQL="$HERE/restore-offsite-ledger.sql"
OFFSITE_CSV=""
OFFSITE_NEWEST=""
# [Off-site erasure ledger] Check the file before anything is created: readable by this login only,
# every line one entry {id (uuid), kind (a known kind), entry (an object), createdAt}. Converted to CSV
# (one JSON value per row) in this run's private directory; prints the newest entry's time.
read_offsite_ledger() {
  [ -f "$LEDGER_FROM" ] || die "--ledger-from: $LEDGER_FROM is not a file"
  private_tmp
  OFFSITE_CSV="$TMP_DIR/offsite-ledger.csv"
  OFFSITE_NEWEST="$(umask 077; python3 -I - "$LEDGER_FROM" "$OFFSITE_CSV" <<'PY'
import csv, json, os, re, stat, sys
src, dst = sys.argv[1], sys.argv[2]
if os.stat(src).st_mode & (stat.S_IRWXG | stat.S_IRWXO):
    sys.exit("--ledger-from: the ledger file is readable by others; chmod 600 it")
kinds = {"receipts", "destroyed_keys", "retired_documents", "shredded_runs", "shredded_fields",
         "closed_accounts", "deleted_rows", "erased_rating_text", "erased_outbox_text"}
uuid = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
stamp = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?")
newest, n = "", 0
with open(src) as f, open(dst, "w", newline="") as out:
    w = csv.writer(out, lineterminator="\n")
    for no, line in enumerate(f, 1):
        if not line.strip():
            continue
        try:
            e = json.loads(line)
        except ValueError:
            sys.exit(f"--ledger-from: line {no} is not JSON")
        if not (isinstance(e, dict) and isinstance(e.get("id"), str) and uuid.fullmatch(e["id"]) and e.get("kind") in kinds
                and isinstance(e.get("entry"), dict) and isinstance(e.get("createdAt"), str) and stamp.fullmatch(e["createdAt"])):
            sys.exit(f"--ledger-from: line {no} is not an erasure ledger entry")
        w.writerow([json.dumps(e)])
        newest = max(newest, e["createdAt"])
        n += 1
if n == 0:
    sys.exit("--ledger-from: the ledger file holds no entry")
print(newest)
PY
)" || die "--ledger-from: the off-site ledger was refused (above); nothing was created"
  [ -f "$OFFSITE_SQL" ] || die "--ledger-from: restore-offsite-ledger.sql is missing next to restore.sh"
  echo "off-site ledger : $(grep -c . "$OFFSITE_CSV") entr(ies), newest $OFFSITE_NEWEST"
}
replay_erasure_ledger() {
  local has=f names=() selects=() name="" line i script summary live_id copy_id
  [ -f "$LEDGER_SQL" ] && [ -f "$REPLAY_SQL" ] ||
    die_copy "the erasure ledger files are missing next to restore.sh; not restored"
  copy_id="$(deployment_identity_of "$SCRATCH" scratch_psql)" || die_copy "could not read the deployment identity of the restored copy; not restored"
  if [ "$NO_LIVE_LEDGER" = 1 ]; then
    echo "live database identity : gone (disaster recovery: the off-site ledger only)"
    echo "restored copy identity : $copy_id"
  else
    live_id="$(deployment_identity_of "$LIVE_DB" db_psql_ro)" || die_copy "could not read the deployment identity of $LIVE_DB; not restored"
    echo "live database identity : $live_id"
    echo "restored copy identity : $copy_id"
    if [ "${live_id%%/*}" != none ] && [ "${copy_id%%/*}" != none ] && [ "${live_id%%/*}" != "${copy_id%%/*}" ]; then
      die_copy "the live database ($live_id) and the restored copy ($copy_id) belong to different environments: the live ledger does not describe this copy; not restored"
    fi
    has="$(db_psql_ro "$LIVE_DB" -tAc "SELECT to_regclass('public.deletion_receipt') IS NOT NULL;" | tr -d '[:space:]')" ||
      die_copy "could not read the erasure ledger of $LIVE_DB; not restored"
    if [ "$has" != t ] && [ -z "$LEDGER_FROM" ]; then
      echo "erasure ledger: $LIVE_DB keeps none (no deletion_receipt table); nothing to replay"
      return 0
    fi
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
      if [ "$has" = t ]; then
        for i in "${!names[@]}"; do
          echo "COPY restore_ledger_${names[$i]} FROM STDIN WITH (FORMAT csv);"
          db_psql_ro "$LIVE_DB" -q -c "COPY (${selects[$i]}) TO STDOUT WITH (FORMAT csv);" || exit 1
          printf '%s\n' '\.'
        done
      fi
      if [ -n "$LEDGER_FROM" ]; then
        echo "CREATE TEMP TABLE restore_offsite (line jsonb NOT NULL) ON COMMIT DROP;"
        echo "COPY restore_offsite (line) FROM STDIN WITH (FORMAT csv);"
        cat "$OFFSITE_CSV"
        printf '%s\n' '\.'
        cat "$OFFSITE_SQL"
      fi
      cat "$REPLAY_SQL"
      echo 'COMMIT;'
    } > "$script" ) || die_copy "could not read the erasure ledger of $LIVE_DB; not restored"
  summary="$(scratch_psql "$SCRATCH" -q -tA < "$script")" ||
    die_copy "the erasure ledger replay failed; not restored"
  rm -f -- "$script"
  printf '%s\n' "$summary" | grep -E '^erasure ledger replayed: ' ||
    die_copy "the erasure ledger replay reported nothing; not restored"
}

[ -n "$SOURCE" ] || die "usage: restore.sh [--compare-source] [--allow-unsigned-legacy] <dump-file|s3://backup-bucket/key|-> [new-scratch-db], or restore.sh --fetch-encrypted|--fetch-signature s3://backup-bucket/key.dump.gpg"
if [ "$FETCH_SIGNATURE" = 1 ]; then
  [ "$FETCH_ENCRYPTED" = 0 ] || die "--fetch-signature and --fetch-encrypted are separate calls"
  [[ "$SOURCE" == s3://*.dump.gpg ]] || [[ "$SOURCE" == s3://*.dump ]] || die "--fetch-signature prints the signature of an off-site dump (s3://…/….dump or ….dump.gpg)"
  [ ! -t 1 ] || die "--fetch-signature writes the verified signature to stdout; redirect or pipe it (deploy/backup-drill.sh does)"
fi
if [ -n "$SIGNATURE_B64$SIGNED_OBJECT" ]; then
  [ "$SOURCE" = - ] || die "--signature-b64 and --signed-object go with the dump on stdin (source -) only; a file or off-site dump is verified from its own .sig"
  [ -n "$SIGNATURE_B64" ] && [ -n "$SIGNED_OBJECT" ] || die "--signature-b64 and --signed-object go together"
  [[ "$SIGNED_OBJECT" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$ ]] || die "--signed-object must be the signed object's file name"
  [[ "$SIGNATURE_B64" =~ ^[A-Za-z0-9+/=]+$ ]] && [ "${#SIGNATURE_B64}" -le 24000 ] || die "--signature-b64 must be the base64 of the signature file"
fi
if [ "$ALLOW_UNSIGNED" = 1 ]; then
  echo "WARNING: --allow-unsigned-legacy: a dump WITHOUT a signature will be restored. Use it only for a dump made before backups were signed: an unsigned dump could have been planted by anyone who could write to the backup bucket. A signature that is present must still verify." >&2
fi
ALLOWED_SIGNERS="${BACKUP_SIGNING_ALLOWED_SIGNERS:-$(env_value BACKUP_SIGNING_ALLOWED_SIGNERS)}"
ALLOWED_SIGNERS="${ALLOWED_SIGNERS:-/etc/swift/backup-allowed-signers}"
# verify_signature SIG NAME [--object FILE] [--plain FILE] [--print]: refuse unless SIG is a valid
# signature of NAME by a trusted backup signing key (and the bytes match).
verify_signature() {
  local sig="$1" name="$2" rc=0
  shift 2
  python3 -I "$HERE/backup-signature.py" verify --allowed-signers "$ALLOWED_SIGNERS" --sig "$sig" --name "$name" "$@" || rc=$?
  case "$rc" in
    0) return 0 ;;
    4) die "the backup signature cannot be checked: the allowed-signers file is unusable (above); nothing was restored" ;;
    *) die "the backup signature of $name was REFUSED (above): this dump was not made and signed by a Swift backup host, or it was changed. Nothing was restored; --allow-unsigned-legacy does not override a signature that fails" ;;
  esac
}
# [SEC-BACKUP · REVIEW-G S4-1] When signing began here: the owner's stamp, or backup.sh's record.
signed_since() {
  local stamp="${BACKUP_SIGNED_SINCE:-$(env_value BACKUP_SIGNED_SINCE)}" file
  if [ -z "$stamp" ]; then
    file="${BACKUP_FIRST_SIGNED_FILE:-$(env_value BACKUP_FIRST_SIGNED_FILE)}"
    file="${file:-/var/backups/swift/.first-signed-backup}"
    [ -r "$file" ] && stamp="$(head -1 "$file" | tr -d '[:space:]')"
  fi
  [ -z "$stamp" ] && return 0
  [[ "$stamp" =~ ^[0-9]{8}T[0-9]{6}Z$ ]] || die "the record of the first signed backup is malformed ($stamp); nothing was restored"
  printf '%s\n' "$stamp"
}
# unsigned_or_die WHAT WHY [WRITTEN]: WRITTEN is when the object was written, as UTC
# YYYYmmddTHHMMSSZ (the bucket's own LastModified, or a local dump's name stamp).
unsigned_or_die() {
  local since="" written="${3:-}"
  [ "$ALLOW_UNSIGNED" = 1 ] ||
    die "$1 has NO signature ($2). Swift backups are signed; an unsigned dump is refused, because anyone who can write to the backup bucket could have planted it. For a dump made before signing existed, the owner may pass --allow-unsigned-legacy"
  since="$(signed_since)"
  if [ -n "$since" ] && [ -n "${4:-}" ]; then
    { [ -n "$written" ] && [[ "$written" < "$since" ]]; } ||
      die "$1 has NO signature and was written after the first signed backup (server time ${written:-unknown}, signing began $since): an unsigned object from after that is not a legacy dump. Refused even with --allow-unsigned-legacy; nothing was restored"
    echo "legacy check: $1 was written at server time $written, before the first signed backup ($since)" >&2
  elif [ -n "${4:-}" ]; then
    echo "WARNING: there is no record of the first signed backup on this host (BACKUP_FIRST_SIGNED_FILE / BACKUP_SIGNED_SINCE): the object's time (${written:-unknown}) cannot be checked against it." >&2
  fi
  echo "WARNING: RESTORING AN UNSIGNED DUMP ($1) because --allow-unsigned-legacy was given. Its origin is NOT proven." >&2
}
# A server or name time as UTC YYYYmmddTHHMMSSZ (empty when it cannot be read).
utc_stamp() {
  python3 -I -c 'import datetime, re, sys
v = sys.argv[1].strip()
m = re.search(r"(\d{8}T\d{6}Z)", v)
if m and not re.search(r"\d{4}-\d{2}-\d{2}", v):
    print(m.group(1)); sys.exit(0)
try:
    t = datetime.datetime.fromisoformat(v.replace("Z", "+00:00"))
except ValueError:
    sys.exit(0)
if t.tzinfo is None:
    t = t.replace(tzinfo=datetime.timezone.utc)
print(t.astimezone(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ"))' "$1"
}
if [ "$FETCH_ENCRYPTED" = 1 ]; then
  [[ "$SOURCE" == s3://*.dump.gpg ]] || die "--fetch-encrypted streams only an encrypted off-site dump (s3://…/….dump.gpg); a plain dump never leaves this way"
  [ ! -t 1 ] || die "--fetch-encrypted writes the encrypted dump to stdout; redirect or pipe it (deploy/backup-drill.sh does)"
elif [ "$FETCH_SIGNATURE" = 0 ] && [[ "$SOURCE" == *.gpg ]]; then
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
  # [SEC-BACKUP F1] The backup bucket's own key pair (the API's only as a loud fallback).
  . "$HERE/secret-env.sh"
  load_backup_storage_keys || exit 1
  [ -n "${BACKUP_BUCKET:-}" ] || die "BACKUP_BUCKET is required for off-site restore"
  [[ "$SOURCE" == "s3://$BACKUP_BUCKET/"* ]] || die "off-site source must be in BACKUP_BUCKET"
  [ -n "${AWS_ACCESS_KEY_ID:-}" ] && [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] ||
    die "off-site restore credentials are missing"
  TMP_DIR="$(mktemp -d)"
  chmod 700 "$TMP_DIR"
  DUMP="$TMP_DIR/restore.dump"
  aws_cli_image >/dev/null || die "off-site restore needs a pinned AWS_CLI_IMAGE"
  # [SEC-BACKUP F2] The signature first: a missing one is told apart from a failed fetch.
  SIG="$TMP_DIR/restore.sig"
  HAVE_SIG=1
  if ! aws_s3 "$TMP_DIR:/data" s3 cp "$SOURCE.sig" /data/restore.sig --only-show-errors 2>"$TMP_DIR/sig.err"; then
    if grep -qE '404|Not Found|NoSuchKey|does not exist' "$TMP_DIR/sig.err"; then HAVE_SIG=0
    else cat "$TMP_DIR/sig.err" >&2; die "could not fetch the signature $SOURCE.sig; nothing was restored"; fi
  fi
  if [ "$FETCH_SIGNATURE" = 1 ]; then
    # No signature is an answer, not an error: the drill decides (--allow-unsigned-legacy).
    if [ "$HAVE_SIG" = 0 ]; then echo "swift-backup-signature none"; exit 0; fi
    verify_signature "$SIG" "$(basename "$SOURCE")" --print
    exit 0
  fi
  aws_s3 "$TMP_DIR:/data" s3 cp "$SOURCE" /data/restore.dump --only-show-errors
  chmod 600 "$DUMP"
  if [ "$HAVE_SIG" = 1 ]; then
    verify_signature "$SIG" "$(basename "$SOURCE")" --object "$DUMP"
  else
    KEY_PATH="${SOURCE#s3://"$BACKUP_BUCKET"/}"
    WRITTEN="$(aws_s3 "$TMP_DIR:/data" s3api head-object --bucket "$BACKUP_BUCKET" --key "$KEY_PATH" --query LastModified --output text 2>/dev/null || true)"
    echo "legacy check: the bucket says $(basename "$SOURCE") was written at server time ${WRITTEN:-unknown}" >&2
    unsigned_or_die "$SOURCE" "no $(basename "$SOURCE").sig beside it in the bucket" "$(utc_stamp "$WRITTEN")" checked
  fi
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
  # [SEC-BACKUP F2] The drill's bundle: the signature of the encrypted object it decrypted, which
  # also carries the plain dump's digest. Checked here, on the host, against this host's keys.
  if [ -n "$SIGNATURE_B64" ]; then
    (umask 077; printf '%s' "$SIGNATURE_B64" | python3 -I -c 'import base64, sys; sys.stdout.buffer.write(base64.b64decode(sys.stdin.read(), validate=True))' > "$TMP_DIR/restore.sig") ||
      die "--signature-b64 is not valid base64; nothing was restored"
    verify_signature "$TMP_DIR/restore.sig" "$SIGNED_OBJECT" --plain "$DUMP"
  else
    unsigned_or_die "the dump on stdin" "no --signature-b64 bundle was given"
  fi
else
  DUMP="$SOURCE"
  [ -f "$DUMP" ] || die "dump file does not exist"
  if [ -f "$DUMP.sig" ]; then
    verify_signature "$DUMP.sig" "$(basename "$DUMP")" --object "$DUMP"
  else
    unsigned_or_die "$DUMP" "no $(basename "$DUMP").sig beside it" "$(utc_stamp "$(basename "$DUMP")")" checked
  fi
fi
[ -f "$DUMP" ] || die "dump file does not exist"
pg_restore --list "$DUMP" >/dev/null 2>&1 || die "pg_restore cannot read this archive"

[ -z "$LEDGER_FROM" ] || read_offsite_ledger
[ -n "$PROJECT" ] ||
  die "name the Compose project that holds the target Postgres: --project <name> (live is 'swift', a rehearsal copy e.g. 'swift-rehearsal'); restore.sh never guesses"
[[ "$PROJECT" =~ ^[a-z0-9][a-z0-9_-]{0,62}$ ]] || die "--project must be a Compose project name (lowercase letters, digits, - and _)"
COMPOSE+=(-p "$PROJECT")
echo "compose project : $PROJECT (its postgres service: read for the ledger and the comparison, never restored into)"
echo "archive : $(basename "$DUMP")"
echo "scratch : $SCRATCH"
# The restore login has the live owner's NAME (so ownership, grants and default privileges read
# exactly as in the source) and none of its power: NOT a superuser in the throwaway instance.
RESTORE_LOGIN="${POSTGRES_USER:-$(env_value POSTGRES_USER)}"
RESTORE_LOGIN="${RESTORE_LOGIN:-swift}"
[[ "$RESTORE_LOGIN" =~ ^[a-z_][a-z0-9_]{0,62}$ ]] || die "POSTGRES_USER must be a lowercase SQL identifier"
[ "$RESTORE_LOGIN" != "$SCRATCH_ADMIN" ] || die "POSTGRES_USER may not be the throwaway instance's own superuser name"
SCRATCH_CTR="swift-restore-$SCRATCH"
! docker container inspect "$SCRATCH_CTR" >/dev/null 2>&1 || die "a scratch instance named $SCRATCH_CTR already exists; choose a new scratch name"
! docker volume inspect "$SCRATCH_CTR" >/dev/null 2>&1 || die "a scratch volume named $SCRATCH_CTR already exists; choose a new scratch name"
# The live database's own image: the same server version and extension builds as the dump's source.
LIVE_CTR="$("${COMPOSE[@]}" ps -q postgres 2>/dev/null | head -1 || true)"
if [ -n "$LIVE_CTR" ]; then
  SCRATCH_IMAGE="$(docker inspect --format '{{.Image}}' "$LIVE_CTR")" || die "could not read the live database's image"
else
  SCRATCH_IMAGE="$("${COMPOSE[@]}" config --format json 2>/dev/null | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["services"]["postgres"]["image"])')" ||
    die "could not read the postgres image from the Compose file"
fi
[ -n "$SCRATCH_IMAGE" ] || die "no postgres image to start the scratch instance from"
echo "scratch instance : $SCRATCH_CTR (throwaway, no network, its own volume; restore login $RESTORE_LOGIN is NOT a superuser there)"
docker volume create --label swift.restore=1 "$SCRATCH_CTR" >/dev/null || die "could not create the scratch volume"
INSTANCE_UP=1
docker run -d --name "$SCRATCH_CTR" --label swift.restore=1 --network none \
  -e POSTGRES_USER="$SCRATCH_ADMIN" -e POSTGRES_DB=postgres -e POSTGRES_HOST_AUTH_METHOD=trust \
  -v "$SCRATCH_CTR:/var/lib/postgresql/data" "$SCRATCH_IMAGE" >/dev/null ||
  die_copy "the throwaway instance could not be started"
READY=0
# [SEC-BACKUP · CI 28 Oct] 180 SECONDS, by the clock: a `sleep` that returns at once must not
# turn the wait into 180 quick tries.
READY_BY=$((SECONDS + 180))
while [ "$SECONDS" -lt "$READY_BY" ]; do
  INIT_LOG="$(docker logs "$SCRATCH_CTR" 2>&1 || true)"
  if [[ "$INIT_LOG" == *"PostgreSQL init process complete"* ]] &&
     docker exec "$SCRATCH_CTR" pg_isready -q -h /var/run/postgresql -U "$SCRATCH_ADMIN" >/dev/null 2>&1; then
    READY=1; break
  fi
  sleep 1
done
[ "$READY" = 1 ] || die_copy "the throwaway instance did not become ready"
# Prepared by its superuser, before any byte of the archive is read into it: the restore login,
# the scratch database (closed from birth), then the quarantine, then opened for the restore.
scratch_admin_psql postgres -q -c "CREATE ROLE \"$RESTORE_LOGIN\" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION BYPASSRLS;" ||
  die_copy "the restore login could not be created in the throwaway instance"
scratch_admin_psql postgres -q -c "CREATE DATABASE \"$SCRATCH\" OWNER \"$RESTORE_LOGIN\" TEMPLATE template0 ALLOW_CONNECTIONS false;" ||
  die_copy "the scratch database could not be created"
quarantine_scratch || die_copy "the scratch database could not be quarantined"
scratch_admin_psql postgres -q -c "ALTER DATABASE \"$SCRATCH\" WITH ALLOW_CONNECTIONS true;" ||
  die_copy "the quarantined scratch database could not be opened for the restore"
# What the archive needs that a non-superuser cannot make: the roles it grants to (created without
# login and without any attribute), and the extensions it names (allowlisted only).
private_tmp
TOC="$TMP_DIR/archive.toc"
docker exec -i "$SCRATCH_CTR" pg_restore --list < "$DUMP" > "$TOC" || die_copy "the throwaway instance's pg_restore cannot read this archive"
EXTENSIONS="$(sed -n 's/^[0-9]*; [0-9]* [0-9]* EXTENSION - \([^ ]*\) .*$/\1/p; s/^[0-9]*; [0-9]* [0-9]* EXTENSION - \([^ ]*\)$/\1/p' "$TOC" | sort -u)"
for ext in $EXTENSIONS; do
  case " $EXTENSION_ALLOWLIST " in *" $ext "*) ;; *) die_copy "the archive needs the extension $ext, which this restore does not create (not in its allowlist)";; esac
done
grep -E '^[0-9]+; [0-9]+ [0-9]+ (ACL|POLICY|DEFAULT ACL) ' "$TOC" > "$TMP_DIR/grants.toc" || true
ROLES=""
if [ -s "$TMP_DIR/grants.toc" ]; then
  docker exec -i "$SCRATCH_CTR" sh -c 'umask 077; cat > /tmp/grants.toc' < "$TMP_DIR/grants.toc" || die_copy "could not stage the archive's grant list"
  ROLES="$(docker exec -i "$SCRATCH_CTR" pg_restore -f - -L /tmp/grants.toc < "$DUMP" | python3 -I -c '
import re, sys
ident = r"(?:\"[^\"]+\"|[A-Za-z_][A-Za-z0-9_$]*)"
roles = set()
def add(listing):
    for r in re.findall(ident, listing):
        roles.add(r.strip("\""))
for line in sys.stdin:
    m = re.match(r"(?:GRANT|REVOKE) .* (?:TO|FROM) (" + ident + r"(?:, " + ident + r")*)(?: WITH GRANT OPTION| GRANTED BY .*)?;\s*$", line)
    if m: add(m.group(1))
    m = re.match(r"CREATE POLICY .* TO (" + ident + r"(?:, " + ident + r")*)(?: USING| WITH CHECK|;|$)", line)
    if m: add(m.group(1))
    m = re.match(r"ALTER DEFAULT PRIVILEGES FOR ROLE (" + ident + r")", line)
    if m: add(m.group(1))
skip = {"public", "current_user", "session_user", "current_role"}
for r in sorted(roles):
    if r.lower() in skip or r.startswith("pg_"):
        continue
    if re.fullmatch(r"[a-z_][a-z0-9_]{0,62}", r):
        print(r)
')" || die_copy "could not read the roles the archive grants to"
fi
for role in $ROLES; do
  [ "$role" != "$SCRATCH_ADMIN" ] && [ "$role" != "$RESTORE_LOGIN" ] || continue
  # A fresh instance holds no such role: create it bare, and let the restore login act for it
  # (ALTER DEFAULT PRIVILEGES FOR ROLE needs that). Never for a role that already exists.
  scratch_admin_psql postgres -q -c "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '$role') THEN CREATE ROLE \"$role\" NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT \"$role\" TO \"$RESTORE_LOGIN\"; END IF; END \$\$;" ||
    die_copy "the role $role could not be prepared in the throwaway instance"
done
# The extensions are created by a short-lived superuser role and then handed, with everything they
# made, to the restore login: so the archive's grants on extension objects apply as they do in the
# source (where the owner created them), and still nothing of the archive runs as a superuser.
if [ -n "$EXTENSIONS" ]; then
  { echo "CREATE ROLE swift_restore_ext NOLOGIN SUPERUSER;"
    echo "SET ROLE swift_restore_ext;"
    for ext in $EXTENSIONS; do echo "CREATE EXTENSION IF NOT EXISTS \"$ext\" CASCADE;"; done
    echo "RESET ROLE;"
    echo "REASSIGN OWNED BY swift_restore_ext TO \"$RESTORE_LOGIN\";"
    echo "DROP ROLE swift_restore_ext;"
  } | scratch_admin_psql "$SCRATCH" -q >/dev/null || die_copy "the extensions the archive names could not be created in the throwaway instance"
fi
# The restore list: everything in the archive except what the extensions themselves made (their
# entries and the comments on them, the schemas they created, and the rows of their own tables and
# sequences: an extension fills those when it is created).
OWNED="$(scratch_admin_psql "$SCRATCH" -tA -c "SELECT 'rel ' || n.nspname || ' ' || c.relname FROM pg_depend d JOIN pg_class c ON c.oid = d.objid JOIN pg_namespace n ON n.oid = c.relnamespace WHERE d.classid = 'pg_class'::regclass AND d.deptype = 'e' UNION ALL SELECT 'schema ' || nspname FROM pg_namespace WHERE nspname <> 'public' AND nspname !~ '^pg_' AND nspname <> 'information_schema';")" ||
  die_copy "could not read what the extensions own in the throwaway instance"
printf '%s\n' "$OWNED" > "$TMP_DIR/owned.txt"
python3 -I - "$TOC" "$TMP_DIR/owned.txt" > "$TMP_DIR/restore.toc" <<'PY' || die_copy "could not build the restore list"
import re, sys
toc, owned_file = sys.argv[1], sys.argv[2]
rels, schemas = set(), set()
for line in open(owned_file):
    parts = line.split()
    if parts[:1] == ["rel"] and len(parts) == 3: rels.add((parts[1], parts[2]))
    if parts[:1] == ["schema"] and len(parts) == 2: schemas.add(parts[1])
entry = re.compile(r"^\d+; \d+ \d+ (.*)$")
for line in open(toc):
    m = entry.match(line.rstrip("\n"))
    if not m:
        sys.stdout.write(line); continue
    body = m.group(1)
    if re.match(r"(EXTENSION|COMMENT) - (EXTENSION )?\S+", body) and ("EXTENSION" in body.split()[:3]):
        continue
    t = re.match(r"(TABLE DATA|SEQUENCE SET) (\S+) (\S+) ", body + " ")
    if t and (t.group(2), t.group(3)) in rels:
        continue
    t = re.match(r"SCHEMA - (\S+) ", body + " ")
    if t and t.group(1) in schemas:
        continue
    sys.stdout.write(line)
PY
docker exec -i "$SCRATCH_CTR" sh -c 'umask 077; cat > /tmp/restore.toc' < "$TMP_DIR/restore.toc" || die_copy "could not stage the restore list"
# Proven, not assumed: the login that will read the archive is not a superuser.
SUPER="$(scratch_psql "$SCRATCH" -tAc "SELECT rolsuper FROM pg_roles WHERE rolname = current_user;" | tr -d '[:space:]')" ||
  die_copy "could not check the restore login"
[ "$SUPER" = f ] || die_copy "the restore login is a superuser in the scratch instance; refusing to restore"

STARTED="$(date +%s)"
ROWS_IN=1
docker exec -i "$SCRATCH_CTR" pg_restore -h /var/run/postgresql -U "$RESTORE_LOGIN" --exit-on-error --no-owner -L /tmp/restore.toc --dbname="$SCRATCH" \
  < "$DUMP" || die_copy "pg_restore failed; not restored"
quarantine_scratch || die_copy "the restored scratch database could not be kept quarantined"
if [ "$NO_LIVE_LEDGER" = 1 ] && [ -z "$LEDGER_FROM" ]; then
  echo "DISASTER-RECOVERY MODE: no live erasure ledger was replayed (--no-live-ledger --i-know-live-is-gone)"
elif [ "$NO_LIVE_LEDGER" = 1 ]; then
  echo "DISASTER-RECOVERY MODE: replaying the off-site erasure ledger only (the live database is gone)"
  replay_erasure_ledger
else
  replay_erasure_ledger
fi

FAILED=0
check() {
  local count
  count="$(scratch_psql "$SCRATCH" -tAc "$2" | tr -d '[:space:]')" || { echo "$1: ERROR"; FAILED=1; return; }
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
#   grant      table, sequence, function and schema privileges, default privileges
#              (the object's owner reads OWNER and an explicit ACL equal to the
#              default reads as the default, on both sides: the scratch copy is
#              restored by a login of its own, and extension objects there are
#              created by the throwaway instance);
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
      THEN 'WHERE r.key NOT IN (''last_backup_at'', ''last_backup_offsite'', ''last_backup_signed'', ''last_backup_storage_key'', ''last_restore_rehearsal_at'', ''last_restore_rehearsal_seconds'')'
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
  SELECT format('grant|relation|%s.%s|%s', n.nspname, c.relname, CASE WHEN c.relacl IS NULL OR c.relacl = acldefault((CASE WHEN c.relkind = 'S' THEN 's' ELSE 'r' END)::\"char\", c.relowner) THEN '' ELSE coalesce((SELECT string_agg(format('%s>%s:%s%s',
      CASE WHEN a.grantor = c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = c.relowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,
      a.privilege_type, CASE WHEN a.is_grantable THEN '*' ELSE '' END), ',' ORDER BY 1) FROM aclexplode(c.relacl) a), '{}') END)
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname IN ('public', 'swift_qr') AND c.relkind IN ('r', 'p', 'v', 'm', 'S', 'f')
  UNION ALL
  SELECT format('grant|function|%s.%s(%s)|%s', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid), CASE WHEN p.proacl IS NULL OR p.proacl = acldefault('f'::\"char\", p.proowner) THEN '' ELSE coalesce((SELECT string_agg(format('%s>%s:%s%s',
      CASE WHEN a.grantor = p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = p.proowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,
      a.privilege_type, CASE WHEN a.is_grantable THEN '*' ELSE '' END), ',' ORDER BY 1) FROM aclexplode(p.proacl) a), '{}') END)
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace WHERE n.nspname IN ('public', 'swift_qr')
  UNION ALL
  SELECT format('grant|schema|%s|%s', n.nspname, CASE WHEN n.nspacl IS NULL OR n.nspacl = acldefault('n'::\"char\", n.nspowner) THEN '' ELSE coalesce((SELECT string_agg(format('%s>%s:%s%s',
      CASE WHEN a.grantor = n.nspowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantor) END,
      CASE WHEN a.grantee = 0 THEN 'PUBLIC' WHEN a.grantee = n.nspowner THEN 'OWNER' ELSE pg_get_userbyid(a.grantee) END,
      a.privilege_type, CASE WHEN a.is_grantable THEN '*' ELSE '' END), ',' ORDER BY 1) FROM aclexplode(n.nspacl) a), '{}') END)
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
  live_snapshot="$(db_psql "$LIVE_DB" -q -tA -c "$POSTURE_SQL")" || die_copy "could not read the source database $LIVE_DB"
  scratch_snapshot="$(scratch_psql "$SCRATCH" -q -tA -c "$POSTURE_SQL")" || die_copy "could not read the scratch database"
  grep -q '^rows|' <<<"$live_snapshot" || die_copy "the source database $LIVE_DB has no tables to compare"
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
    die_copy "the restore does not match its source"
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
  [ "$FAILED" -eq 0 ] || die_copy "restore failed sanity checks"
fi

SECONDS_TAKEN=$(( $(date +%s) - STARTED ))
# [#1984 COORD ruling 14:11Z] The replay covers documents, keys, receipts, tombstones, the closure's
# rows and rating text; it does not yet re-run the app's own erasure passes, so the de-identifications
# #1905 and #1945 add (updates, not deletes) are not replayed. Every restore says so until it does.
echo "NOT erasure-complete for #1905/#1945 de-identifications: re-apply them to this copy (the app's erasure passes, for every closed account) before anything from it is used"
echo "NOT erasure-complete for #1905/#1945 de-identifications: re-apply them to this copy (the app's erasure passes, for every closed account) before anything from it is used" >&2
if [ "$NO_LIVE_LEDGER" = 1 ]; then
  # [#1977 COORD ruling] Never "RESTORE OK", never a rehearsal heartbeat, a distinct exit code.
  echo "quarantine: $SCRATCH lives in the throwaway instance $SCRATCH_CTR (no network); only the restore login (and the instance's superuser) can connect; no application login can"
  if [ -n "$LEDGER_FROM" ]; then
    echo "erasure-complete up to $OFFSITE_NEWEST (the newest entry of the off-site ledger)"
    echo "erasure-complete up to $OFFSITE_NEWEST (the newest entry of the off-site ledger)" >&2
    echo "Anything erased after $OFFSITE_NEWEST never reached the off-site ledger and is still whole in this copy: check the erasure receipts and the ops pages for an unshipped ledger before anything from it is used. Keep it quarantined until then."
  else
    echo "NOT erasure-complete: replay the off-site ledger before use"
    echo "NOT erasure-complete: replay the off-site ledger before use" >&2
    echo "This copy is the backup's state: anyone erased after the backup is still whole in it. Re-apply those erasures (the off-site erasure ledger, or by hand from the erasure receipts) before anything from it is used. Keep it quarantined until then."
  fi
  echo "DR restore of $SCRATCH finished in ${SECONDS_TAKEN}s; scratch database kept in $SCRATCH_CTR (--keep-for-inspection), quarantined, NOT for use (remove: docker rm -f $SCRATCH_CTR && docker volume rm $SCRATCH_CTR)"
  exit 3
fi
echo "quarantine: $SCRATCH lives in the throwaway instance $SCRATCH_CTR (no network); only the restore login (and the instance's superuser) can connect; no application login can"
echo "RESTORE OK — ${SECONDS_TAKEN}s (in the throwaway instance $SCRATCH_CTR)"
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
echo "Document objects and MASTER_KEK require separate recovery proof."
if [ "$KEEP_INSPECT" = 1 ]; then
  echo "KEPT (--keep-for-inspection): $SCRATCH_CTR holds a full copy of the database. Inspect it: docker exec -it $SCRATCH_CTR psql -h /var/run/postgresql -U $RESTORE_LOGIN -d $SCRATCH. The quarantine covers the logins that exist now: re-run the quarantine before use (a login created later is not covered)."
  echo "Remove it within 24 hours (doctor.sh fails after that), and drop the copy after use: docker rm -f $SCRATCH_CTR && docker volume rm $SCRATCH_CTR"
  echo "Before anything from this copy is used, replay the erasure ledger again against the live database of that day."
else
  remove_instance ||
    die "the restore passed but removing the scratch instance $SCRATCH_CTR FAILED: remove it now (docker rm -f $SCRATCH_CTR && docker volume rm $SCRATCH_CTR), it holds a copy of the database"
  echo "the scratch instance $SCRATCH_CTR was removed with its volume (pass --keep-for-inspection to keep a copy)"
fi
