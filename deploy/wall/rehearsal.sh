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
# the four group roles, plus swift_owner_wall when the source has it), a pg_dump
# streamed straight into the copy, and the read-only census. Every line printed is a step, a count, a digest or a
# reason code: never a secret, never a row.
#
# Every provider secret the copy's processes are wired to read gets a fresh
# throwaway stand-in in the shape the API's boot guards check
# (deploy/wall/stand-in.sh), so the copy boots in its host's own posture. Once
# the copy's API and worker have started, their logs (the last 400 lines each,
# redacted by deploy/wall/redact-log.py) are kept in the results directory
# ($REHEARSAL_RESULTS_DIR, else ~/swift-rehearsal/rehearsal-<UTC>) however the
# run ends, and the first FATAL lines are printed, so a failed boot can be
# diagnosed after the copy is gone.
#
# It FAILS (non-zero exit, "REHEARSAL FAILED at step: …") on any step that does
# not hold, and prints "PASSED" only after every step held: the copy, the
# logins, each process's boot attestation (running, never restarted) and the
# wall itself through the real logins (the request login bound to no tenant
# sees no walled row, the system login sees the copy's rows, neither can take
# the wall down). The walled-login journeys run on a copy of STAGING's
# database, never on this copy of production's (deploy/wall/journeys-on-copy.sh).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
PROJECT=swift-rehearsal
STORE_DIR=/etc/credstore.encrypted/swift-rehearsal
RUN_DIR=/run/swift-rehearsal-secrets
# (Not GROUPS: bash reserves that name and ignores assignments to it.)
WALL_GROUPS="swift_app swift_bypass_rls swift_audit_purge_owner swift_audit_purge_executor"
LOCK="${SWIFT_REHEARSAL_LOCK:-/run/lock/swift-rls-logins.lock}"
RESULTS="${REHEARSAL_RESULTS_DIR:-$HOME/swift-rehearsal/rehearsal-$(date -u +%Y%m%dT%H%M%SZ)}"
# Set once the copy's API and worker were asked to start: from then on their logs are kept.
STARTED=0

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
# The host's runtime mode, as Compose reads deploy/.env (the last line wins):
# the system login's own boot attestation runs only in production mode.
HOST_MODE="$(grep -E '^NODE_ENV=' "$DEPLOY/.env" | tail -1 | cut -d= -f2- || true)"
STEP=start
# A login's own new connection inside the copy's postgres container: the
# passfile line arrives on stdin and lives only in a 0600 tmpfs file for one
# psql call. $1 = the login, $2 = the SQL (never a value).
CONNECT='set -eu; umask 077; f="$(mktemp /dev/shm/rehearsal-wall.XXXXXX)"; trap '"'"'rm -f "$f"'"'"' EXIT; cat > "$f"; PGPASSFILE="$f" psql "host=postgres port=5432 dbname=$POSTGRES_DB user=$1 sslmode=disable connect_timeout=10" -X -q -tA -v ON_ERROR_STOP=1 -c "$2"'
# The URL file the api container reads, turned into a passfile line for that
# login only; anything else answers nothing. Never printed: it goes down a pipe.
PASSLINE='import sys
from urllib.parse import unquote, urlsplit
u = urlsplit(sys.stdin.read().strip())
if u.scheme in ("postgresql", "postgres") and unquote(u.username or "") == sys.argv[1] and u.password:
    esc = lambda v: v.replace("\\", "\\\\").replace(":", "\\:")
    print(":".join(["postgres", "5432", esc(unquote(u.path[1:])), esc(sys.argv[1]), esc(unquote(u.password))]))'
# The rendered Compose configuration in, the store names the copy's migrate, api
# and worker read as NAME_FILE=/run/secrets/<store name> out (one per line).
WIRED='import json, re, sys
services = json.load(sys.stdin)["services"]
names = set()
for service in ("migrate", "api", "worker"):
    for key, value in ((services.get(service) or {}).get("environment") or {}).items():
        m = re.fullmatch(r"/run/secrets/([A-Z][A-Z0-9_]*)", str(value or "").strip())
        if key.endswith("_FILE") and m:
            names.add(m.group(1))
print("\n".join(sorted(names)))'
# save_logs: the copy's API and worker logs, the last 400 lines each, redacted,
# into the results directory (0700); then the first 20 FATAL lines, so the run's
# own log says why a process refused. Best effort: it never changes the outcome.
save_logs() {
  local svc
  [ "$STARTED" = 1 ] || return 0
  ( umask 077; mkdir -p "$RESULTS" && chmod 700 "$RESULTS" ) 2>/dev/null || { echo "rehearsal: could not create $RESULTS for the copy's logs" >&2; return 0; }
  for svc in api worker; do
    ( umask 077; "${REH[@]}" logs --no-color --tail 400 "$svc" 2>/dev/null | python3 -I "$HERE/redact-log.py" >"$RESULTS/$svc.log" ) || true
  done
  echo "rehearsal: logs: the copy's api and worker logs (last 400 lines each, redacted) are in $RESULTS" >&2
  if grep -q FATAL "$RESULTS/api.log" "$RESULTS/worker.log" 2>/dev/null; then
    echo "rehearsal: the first FATAL lines (redacted):" >&2
    { grep -h FATAL "$RESULTS/api.log" "$RESULTS/worker.log" 2>/dev/null || true; } | head -n 20 | cut -c1-400 | sed 's/^/  /' >&2
  fi
  return 0
}

cmd_down() {
  STEP=down
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
  [ -r "$HERE/walled-rows.sql" ] || die "deploy/wall/walled-rows.sql is missing (the wall check's query)"
  export SWIFT_TAG="$sha"

  # 1. Secrets: fresh, the rehearsal's own. Values go through a pipe only.
  STEP=secrets
  generated="$(sed -n 's/^GENERATED="\(.*\)"$/\1/p' "$DEPLOY/gen-secrets.sh")"
  [ -n "$generated" ] || die "could not read the generated secret names from gen-secrets.sh"
  for name in $generated; do
    gen_value "$name" >/dev/null || die "gen-secrets.sh generates $name, which this rehearsal does not know how to generate; teach gen_value"
    gen_value "$name" | store set "$name" >/dev/null || die "could not store the rehearsal's $name"
  done
  # Provider secrets the copy's processes are wired to read, exactly as Compose
  # renders their settings (deploy/.env in any spelling Compose accepts):
  # fresh stand-ins of the shape each boot guard checks (stand-in.sh). Nothing
  # can leave the internal network, so no real one is ever needed or read.
  wired="$("${REH[@]}" config --format json 2>/dev/null | python3 -I -c "$WIRED")" ||
    die "could not read which secret files the copy's processes are wired to read (docker compose config)"
  count=0
  for name in $wired; do
    case " $generated DATABASE_URL SYSTEM_DATABASE_URL " in *" $name "*) continue ;; esac
    "$HERE/stand-in.sh" "$name" | store set "$name" >/dev/null || die "could not store a stand-in for $name"
    count=$((count + 1))
  done
  store materialize >/dev/null || die "could not materialize the rehearsal secrets"
  say "secrets: $(set -- $generated; echo $#) generated, $count provider stand-ins (no production value)"

  # 2. The copy's database and its neighbours, on the rehearsal network.
  STEP=copy
  "${REH[@]}" up -d --wait postgres redis meilisearch >/dev/null || die "the rehearsal database did not become healthy"
  # 3. The four group roles (and the owner wall's swift_owner_wall when the source has it: its
  #    addresses policy names the role, and pg_dump does not carry cluster roles), without
  #    passwords, then production's database streamed in.
  "${PROD[@]}" exec -T postgres sh -c "$OWNER"' exec pg_dumpall -h 127.0.0.1 -U "$POSTGRES_USER" --roles-only --no-role-passwords' |
    python3 -I "$HERE/rehearsal-roles.py" $WALL_GROUPS --optional swift_owner_wall |
    "${REH[@]}" exec -T postgres sh -c "$OWNER"' exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -X -q -v ON_ERROR_STOP=1' >/dev/null ||
    die "could not copy the group roles"
  "${REH[@]}" exec -T postgres sh -c "$OWNER"' printf "DROP DATABASE \"%s\" WITH (FORCE);\nCREATE DATABASE \"%s\" OWNER \"%s\";\n" "$POSTGRES_DB" "$POSTGRES_DB" "$POSTGRES_USER" | psql -h 127.0.0.1 -U "$POSTGRES_USER" -d postgres -X -q -v ON_ERROR_STOP=1' >/dev/null ||
    die "could not prepare the copy's empty database"
  "${PROD[@]}" exec -T postgres sh -c "$OWNER"' exec pg_dump -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' |
    "${REH[@]}" exec -T postgres sh -c "$OWNER"' exec pg_restore -h 127.0.0.1 -U "$POSTGRES_USER" --exit-on-error -d "$POSTGRES_DB"' >/dev/null ||
    die "could not restore production's database into the copy"
  # 4. The copy is faithful: every catalogue field but the cluster's own id.
  STEP=faithful
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
  STEP=logins
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
  # 6. The real API and worker, in this host's mode, deny posture, on the copy.
  # EACH process must attest the wall in its own log (and, in production
  # mode, its system login), be running and never have restarted.
  STEP=boot
  STARTED=1
  "${REH[@]}" up -d migrate api worker >/dev/null || die "the rehearsal API and worker could not start"
  local svc state log ok=0
  attested() {
    local own
    own="$("${REH[@]}" logs --no-color "$1" 2>/dev/null || true)"
    grep -q 'tenant wall: enforced' <<<"$own" || return 1
    [ "$HOST_MODE" != production ] || grep -q 'tenant wall: system login is a bypass member' <<<"$own"
  }
  for _ in $(seq 1 90); do
    if attested api && attested worker; then ok=1; break; fi
    sleep 2
  done
  log="$("${REH[@]}" logs --no-color api worker 2>/dev/null || true)"
  say "attestation lines: enforced=$(grep -c 'tenant wall: enforced' <<<"$log" || true) system-login=$(grep -c 'tenant wall: system login is a bypass member' <<<"$log" || true) (mode ${HOST_MODE:-unset})"
  say "errors: TenantInUnboundTransactionError=$(grep -c TenantInUnboundTransactionError <<<"$log" || true) FATAL=$(grep -c FATAL <<<"$log" || true)"
  [ "$ok" = 1 ] || die "the API and the worker did not both attest the wall in deny mode within 3 minutes, each in its own log (their FATAL lines follow; logs kept in $RESULTS)"
  for svc in api worker; do
    state="$(docker inspect -f '{{.State.Status}} restarts={{.RestartCount}}' "$("${REH[@]}" ps -q "$svc")" 2>/dev/null || echo missing)"
    say "boot: $svc $state"
    [ "$state" = "running restarts=0" ] || die "$svc is not running cleanly on the copy ($state)"
  done
  [ "$(grep -c -e TenantInUnboundTransactionError -e FATAL <<<"$log" || true)" = 0 ] || die "the boot window logged TenantInUnboundTransactionError or FATAL lines"

  # 7. The wall itself, through the copy's published logins on new connections.
  STEP=wall
  as_login() {  # as_login <url file> <login> <sql>: one answer (stdout), or a non-zero exit with the error on stderr
    "${REH[@]}" exec -T api cat "/run/secrets/$1" | python3 -I -c "$PASSLINE" "$2" |
      "${REH[@]}" exec -T postgres sh -c "$CONNECT" sh "$2" "$3"
  }
  local rows_sql rows_app rows_system owner err
  rows_sql="$(cat "$HERE/walled-rows.sql")" || die "could not read deploy/wall/walled-rows.sql"
  rows_app="$(as_login DATABASE_URL swift_app_login "$rows_sql" 2>/dev/null)" || die "the request login could not count the walled rows"
  rows_system="$(as_login SYSTEM_DATABASE_URL swift_system_login "$rows_sql" 2>/dev/null)" || die "the system login could not count the walled rows"
  say "wall: walled rows seen unbound by swift_app_login=$rows_app, by swift_system_login=$rows_system"
  [ "$rows_app" = 0 ] || die "the request login, bound to no tenant, sees $rows_app walled rows: the wall does not hold"
  [[ "$rows_system" =~ ^[1-9][0-9]*$ ]] || die "the system login sees no walled row on the copy (so the request login's 0 proves nothing)"
  err="$(as_login DATABASE_URL swift_app_login 'ALTER TABLE public.users NO FORCE ROW LEVEL SECURITY' 2>&1 >/dev/null)" &&
    die "the request login could ALTER a walled table"
  grep -q 'must be owner' <<<"$err" || die "the request login's ALTER was refused for another reason than ownership"
  owner="$(as_login SYSTEM_DATABASE_URL swift_system_login "SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid = 'public._prisma_migrations'::regclass" 2>/dev/null)" ||
    die "could not read the migration owner's name"
  [[ "$owner" =~ ^[a-z_][a-z0-9_]*$ ]] || die "the migration owner's name is not a plain role name"
  err="$(as_login SYSTEM_DATABASE_URL swift_system_login "SET ROLE $owner" 2>&1 >/dev/null)" &&
    die "the system login could become the database owner"
  grep -q 'permission denied to set role' <<<"$err" || die "the system login's SET ROLE was refused for another reason"
  say "wall: the request login cannot ALTER a walled table; the system login cannot become the owner"
  STEP=done
  say "PASSED at $sha: every step held (copy, logins, each process's boot, the wall). Remove it now: ./deploy/wall/rehearsal.sh down"
}

WORK="$(mktemp -d)"
# Any step that does not hold ends the run non-zero, and says where.
trap 'rc=$?; rm -rf "$WORK"; save_logs; if [ "$rc" -ne 0 ]; then echo "REHEARSAL FAILED at step: $STEP (exit $rc). Nothing passed. Remove it with: ./deploy/wall/rehearsal.sh down" >&2; fi' EXIT
case "${1:-}" in
  up) shift; [ $# -eq 1 ] || die "usage: rehearsal.sh up <sha>"; cmd_up "$1" ;;
  down) shift; [ $# -eq 0 ] || die "usage: rehearsal.sh down"; cmd_down ;;
  *) die "usage: rehearsal.sh up <sha> | down" ;;
esac
