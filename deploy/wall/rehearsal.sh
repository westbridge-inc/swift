#!/usr/bin/env bash
# [TA-S0-003 · C1] The Phase C rehearsal, on the host that runs the stack, as
# the deploy user, before the owner's go for Phase C (G2). It builds an
# ISOLATED copy (project swift-rehearsal, deploy/docker-compose.rehearsal.yml:
# its own internal network with no route out, its own volumes, its own freshly
# generated secrets, nothing public) and proves the switch on it:
#
#   ./deploy/wall/rehearsal.sh up <sha>    copy, logins (plan, apply, verify twice), deny-mode boot, attestation
#   ./deploy/wall/rehearsal.sh down        remove the rehearsal project, its volumes and its secrets
#
# `up` refuses before changing anything unless the API image for <sha> exists
# (pilot-up builds it), production's database is running (the copy's source),
# and no rehearsal is already there. Production is only READ: a role list
# without passwords (pg_dumpall --roles-only --no-role-passwords, filtered to
# the four group roles), a pg_dump streamed straight into the copy, and the
# read-only census. Every line printed is a step, a count, a digest or a
# reason code: never a secret, never a row.
#
# Not covered here (R4, the coordinator's part, on this same copy): the
# journeys, the isolation probes, every launch job and the rollback test.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
PROJECT=swift-rehearsal
STORE_DIR=/etc/credstore.encrypted/swift-rehearsal
RUN_DIR=/run/swift-rehearsal-secrets
# (Not GROUPS: bash reserves that name and ignores assignments to it.)
WALL_GROUPS="swift_app swift_bypass_rls swift_audit_purge_owner swift_audit_purge_executor"
LOCK="${SWIFT_REHEARSAL_LOCK:-/run/lock/swift-rls-logins.lock}"

die() { echo "REHEARSAL HOLD: $*" >&2; exit 1; }
say() { echo "rehearsal: $*"; }
[ "$(id -u)" -ne 0 ] || die "run as the deploy user, not root (the store is reached with sudo -n)"
case "$-" in *x*) die "shell tracing is on; turn it off (set +x): nothing here may be traced" ;; esac
[ -f "$DEPLOY/.env" ] || die "deploy/.env is missing"
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES; do
  [ -z "${!name+set}" ] || die "$name is set in this shell; run from a clean shell"
done
[ "$(docker context show 2>/dev/null || true)" = default ] || die "docker's current context is not this host's own daemon (default)"

PROD=(docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml")
REH=(docker compose -p "$PROJECT" --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml"
     -f "$DEPLOY/docker-compose.wall.yml" -f "$DEPLOY/docker-compose.rehearsal.yml")
RLS=("$DEPLOY/rls-logins.sh")
RLS_REH=(--project-name "$PROJECT" --project-directory "$DEPLOY" --compose-file "$DEPLOY/docker-compose.yml"
         --compose-file "$DEPLOY/docker-compose.wall.yml" --compose-file "$DEPLOY/docker-compose.rehearsal.yml"
         --store-dir "$STORE_DIR" --run-dir "$RUN_DIR" --lock-file "$LOCK")
STORE_BIN="$(command -v swift-secrets || true)"
[ -n "$STORE_BIN" ] || STORE_BIN="$DEPLOY/swift-secrets"
store() { sudo -n env SWIFT_SECRETS_STORE_DIR="$STORE_DIR" SWIFT_SECRETS_RUN_DIR="$RUN_DIR" "$STORE_BIN" "$@"; }
OWNER='export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")";'

cmd_down() {
  # Only ever the rehearsal project: its containers, network and volumes.
  "${REH[@]}" down -v --remove-orphans >/dev/null 2>&1 || die "could not remove the rehearsal project"
  sudo -n rm -rf -- "$STORE_DIR" "$RUN_DIR" || die "could not remove the rehearsal secrets"
  say "removed (project $PROJECT, its volumes, its store and its secrets)"
}

# Fresh generated secrets, in the formats gen-secrets.sh uses; the names come
# from gen-secrets.sh itself, so a name it adds cannot be silently skipped.
gen_value() {
  case "$1" in
    MASTER_KEK) openssl rand -base64 32 | tr -d '\n' ;;
    POSTGRES_PASSWORD | TEST_CONTROL_SECRET | METRICS_TOKEN | HEALTH_DETAIL_TOKEN) openssl rand -hex 32 ;;
    JWT_SECRET | OTP_HASH_SECRET | STORAGE_SIGNING_SECRET | CONSENT_IP_PEPPER | MEILISEARCH_KEY | ATTRIB_SALT | IDENTITY_SALT | SCAN_IP_SALT | ADS_EVENT_SECRET)
      openssl rand -base64 48 | tr -d '\n=' ;;
    *) return 1 ;;
  esac
}

cmd_up() {
  local sha="$1" generated wired name count
  [[ "$sha" =~ ^[0-9a-f]{40}$ ]] || die "pass the full 40-character SHA whose API image pilot-up built"
  docker image inspect "swift-api:$sha" >/dev/null 2>&1 || die "the API image swift-api:<sha> is not on this host (pilot-up --data-only builds it)"
  [ -n "$("${PROD[@]}" ps -q postgres 2>/dev/null)" ] || die "production's database is not running; it is the copy's source"
  [ -z "$("${REH[@]}" ps -aq 2>/dev/null)" ] || die "a rehearsal is already there; run: ./deploy/wall/rehearsal.sh down"
  ! sudo -n test -e "$STORE_DIR" || die "a rehearsal store already exists; run: ./deploy/wall/rehearsal.sh down"
  ! sudo -n test -e "$RUN_DIR" || die "rehearsal secrets already exist; run: ./deploy/wall/rehearsal.sh down"
  command -v openssl >/dev/null 2>&1 || die "openssl is required"
  command -v python3 >/dev/null 2>&1 || die "python3 is required"
  export SWIFT_TAG="$sha"

  # 1. Secrets: fresh, the rehearsal's own. Values go through a pipe only.
  generated="$(sed -n 's/^GENERATED="\(.*\)"$/\1/p' "$DEPLOY/gen-secrets.sh")"
  [ -n "$generated" ] || die "could not read the generated secret names from gen-secrets.sh"
  for name in $generated; do
    gen_value "$name" >/dev/null || die "gen-secrets.sh generates $name, which this rehearsal does not know how to generate; teach gen_value"
    gen_value "$name" | store set "$name" >/dev/null || die "could not store the rehearsal's $name"
  done
  # Provider secrets the settings wire as NAME_FILE: random stand-ins (nothing
  # can leave the internal network, so no real one is ever needed or read).
  wired="$(grep -oE '^[A-Z][A-Z0-9_]*_FILE=/run/secrets/[A-Z][A-Z0-9_]*' "$DEPLOY/.env" | sed -E 's#.*/run/secrets/##' | sort -u || true)"
  count=0
  for name in $wired; do
    case " $generated DATABASE_URL SYSTEM_DATABASE_URL " in *" $name "*) continue ;; esac
    openssl rand -hex 24 | store set "$name" >/dev/null || die "could not store a stand-in for $name"
    count=$((count + 1))
  done
  store materialize >/dev/null || die "could not materialize the rehearsal secrets"
  say "secrets: $(set -- $generated; echo $#) generated, $count provider stand-ins (no production value)"

  # 2. The copy's database and its neighbours, on the rehearsal network.
  "${REH[@]}" up -d --wait postgres redis meilisearch >/dev/null || die "the rehearsal database did not become healthy"
  # 3. The four group roles, without passwords, then production's database streamed in.
  "${PROD[@]}" exec -T postgres sh -c "$OWNER"' exec pg_dumpall -h 127.0.0.1 -U "$POSTGRES_USER" --roles-only --no-role-passwords' |
    python3 -I "$HERE/rehearsal-roles.py" $WALL_GROUPS |
    "${REH[@]}" exec -T postgres sh -c "$OWNER"' exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -X -q -v ON_ERROR_STOP=1' >/dev/null ||
    die "could not copy the group roles"
  "${REH[@]}" exec -T postgres sh -c "$OWNER"' printf "DROP DATABASE \"%s\" WITH (FORCE);\nCREATE DATABASE \"%s\" OWNER \"%s\";\n" "$POSTGRES_DB" "$POSTGRES_DB" "$POSTGRES_USER" | psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -X -q -v ON_ERROR_STOP=1' >/dev/null ||
    die "could not prepare the copy's empty database"
  "${PROD[@]}" exec -T postgres sh -c "$OWNER"' exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' |
    "${REH[@]}" exec -T postgres sh -c "$OWNER"' exec pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" --exit-on-error -d "$POSTGRES_DB"' >/dev/null ||
    die "could not restore production's database into the copy"
  # 4. The copy is faithful: every catalogue field but the cluster's own id.
  "${RLS[@]}" fingerprint >"$WORK/source.json" || die "could not fingerprint the source ($(cat "$WORK/source.json"))"
  "${RLS[@]}" fingerprint "${RLS_REH[@]}" >"$WORK/copy.json" || die "could not fingerprint the copy ($(cat "$WORK/copy.json"))"
  python3 -I - "$WORK/source.json" "$WORK/copy.json" <<'PY' || die "the copy differs from its source in a catalogue field (above); nothing was switched"
import json, sys
a, b = (json.load(open(p))['target'] for p in sys.argv[1:3])
differ = sorted(k for k in a if k != 'cluster' and a.get(k) != b.get(k))
print('rehearsal: copy faithful except the cluster id' if not differ else 'rehearsal: copy DIFFERS in ' + ', '.join(differ))
sys.exit(1 if differ else 0)
PY
  cp "$WORK/copy.json" "$WORK/approved.json"
  # 5. R2 on the copy: plan, apply, verify twice (identical).
  for step in plan apply verify verify; do
    "${RLS[@]}" "$step" --approved-target-file "$WORK/approved.json" "${RLS_REH[@]}" >"$WORK/$step.json" ||
      die "rls-logins $step held on the copy: $(cat "$WORK/$step.json")"
    if [ "$step" = verify ] && [ -f "$WORK/verify.prev" ]; then
      cmp -s "$WORK/verify.prev" "$WORK/verify.json" || die "the two verify runs differ"
    fi
    [ "$step" != verify ] || cp "$WORK/verify.json" "$WORK/verify.prev"
    say "rls-logins $step: $(python3 -I -c 'import json,sys; print(json.load(sys.stdin)["status"])' <"$WORK/$step.json")"
  done
  store materialize >/dev/null || die "could not materialize the published logins"
  # 6. The real API and worker, in production mode, deny posture, on the copy.
  "${REH[@]}" up -d migrate api worker >/dev/null || die "the rehearsal API and worker could not start"
  local api worker ok=0 log
  for _ in $(seq 1 90); do
    log="$("${REH[@]}" logs --no-color api worker 2>/dev/null || true)"
    if [ "$(grep -c 'tenant wall: enforced' <<<"$log" || true)" -ge 2 ] &&
       [ "$(grep -c 'tenant wall: system login is a bypass member' <<<"$log" || true)" -ge 2 ]; then
      ok=1; break
    fi
    sleep 2
  done
  api="$("${REH[@]}" ps -q api)"; worker="$("${REH[@]}" ps -q worker)"
  log="$("${REH[@]}" logs --no-color api worker 2>/dev/null || true)"
  say "boot: api $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$api" 2>/dev/null || echo missing), worker $(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$worker" 2>/dev/null || echo missing)"
  say "attestation lines: enforced=$(grep -c 'tenant wall: enforced' <<<"$log" || true) system-login=$(grep -c 'tenant wall: system login is a bypass member' <<<"$log" || true)"
  say "errors: TenantInUnboundTransactionError=$(grep -c TenantInUnboundTransactionError <<<"$log" || true) FATAL=$(grep -c FATAL <<<"$log" || true)"
  [ "$ok" = 1 ] || die "the API and the worker did not both attest the wall in deny mode within 3 minutes (inspect: docker compose -p $PROJECT logs api worker)"
  [ "$(grep -c -e TenantInUnboundTransactionError -e FATAL <<<"$log" || true)" = 0 ] || die "the boot window logged TenantInUnboundTransactionError or FATAL lines"
  say "PASSED at $sha (left running for the coordinator's R4 steps; remove with: ./deploy/wall/rehearsal.sh down)"
}

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
case "${1:-}" in
  up) shift; [ $# -eq 1 ] || die "usage: rehearsal.sh up <sha>"; cmd_up "$1" ;;
  down) shift; [ $# -eq 0 ] || die "usage: rehearsal.sh down"; cmd_down ;;
  *) die "usage: rehearsal.sh up <sha> | down" ;;
esac
