#!/usr/bin/env bash
# [TA-S0-003 · Phase C] The coordinator's checks around the business-wall
# switch on the production host, run from the deployed checkout as the deploy
# user, in a clean shell. Only `snapshot` writes (one file in $HOME); every
# other step is read-only. Nothing here starts, stops or changes a service:
# the rehearsal is deploy/wall/rehearsal.sh, the switch is deploy/pilot-up.sh.
#
#   ./deploy/wall/phase-c.sh preflight <approved-sha>   B1: identity, checkout, image, posture, leftovers, headroom
#   ./deploy/wall/phase-c.sh snapshot  <approved-sha>   the BEFORE record of the live containers (after a clean preflight)
#   ./deploy/wall/phase-c.sh proof     <approved-sha>   after rehearsal.sh up + down: nothing left, the live stack unchanged
#   ./deploy/wall/phase-c.sh verify    <approved-sha>   C2, after the switch: contract posture, roles, boot lines, health
#
# The owner wall (swift_owner_wall + OWNER_RLS_BIND=1) is NOT part of Phase C:
# every step requires no OWNER_RLS_BIND line and no member of swift_owner_wall.
# Each step prints one line per check — a name, a count, a state, never a
# secret or a row — and ends "PHASE-C <STEP> OK" (exit 0) or "PHASE-C <STEP>
# HOLD: <n> check(s)" (exit 1).
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
ROOT="$(cd "$DEPLOY/.." && pwd)"
STEP="${1:-}"; SHA="${2:-}"
MEM_FLOOR_MIB="${PHASE_C_MEM_FLOOR_MIB:-2048}"
DISK_MARGIN_MIB="${PHASE_C_DISK_MARGIN_MIB:-2048}"
BEFORE="${PHASE_C_BEFORE_FILE:-$HOME/phase-c-live-before.txt}"
MEMINFO="${PHASE_C_MEMINFO:-/proc/meminfo}"
HOLDS=0

usage() { echo "usage: phase-c.sh preflight|snapshot|proof|verify <40-character approved sha>" >&2; exit 2; }
ok() { echo "ok    $*"; }
hold() { echo "HOLD  $*"; HOLDS=$((HOLDS + 1)); }
finish() {
  local name; name="$(printf '%s' "$STEP" | tr '[:lower:]' '[:upper:]')"
  if [ "$HOLDS" -eq 0 ]; then echo "PHASE-C $name OK"; exit 0; fi
  echo "PHASE-C $name HOLD: $HOLDS check(s)"; exit 1
}
case "$STEP" in preflight|snapshot|proof|verify) ;; *) usage ;; esac
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || usage
[ "$(id -u)" -ne 0 ] || { echo "run as the deploy user, not root" >&2; exit 2; }
case "$-" in *x*) echo "shell tracing is on; turn it off (set +x)" >&2; exit 2 ;; esac
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES; do
  [ -z "${!name+set}" ] || { echo "$name is set in this shell; run from a clean shell" >&2; exit 2; }
done

COMPOSE=(docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml")
env_line() { [ -f "$DEPLOY/.env" ] && grep -E "^$1=" "$DEPLOY/.env" | head -1 | cut -d= -f2- | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' || true; }
# As the migration owner inside the postgres container, read-only, one value out.
db() {
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -tA -v ON_ERROR_STOP=1 -c "SET default_transaction_read_only = on; $1"' \
    sh "$1" </dev/null 2>/dev/null | tail -n 1
}
live_record() {
  local ids; ids="$("${COMPOSE[@]}" ps -q </dev/null 2>/dev/null)"
  [ -n "$ids" ] || return 1
  # shellcheck disable=SC2086
  docker inspect -f '{{.Name}} {{.State.StartedAt}} restarts={{.RestartCount}}' $ids </dev/null | LC_ALL=C sort
}
# This host's API, asked from inside its own container (DNS may still point the public name elsewhere).
health() {
  "${COMPOSE[@]}" exec -T api node -e \
    "fetch('http://127.0.0.1:3000/health').then((r) => process.exit(r.status === 200 ? 0 : 1), () => process.exit(1))" \
    </dev/null >/dev/null 2>&1 && ok "this host's API answers /health 200" || hold "this host's API does not answer /health 200"
}
checkout() {
  [ "$(git -C "$ROOT" rev-parse HEAD 2>/dev/null)" = "$SHA" ] && ok "deployed checkout at the approved sha ${SHA:0:8}" ||
    hold "deployed checkout is not at the approved sha ${SHA:0:8} (it is $(git -C "$ROOT" rev-parse --short=8 HEAD 2>/dev/null || echo unknown))"
  [ -z "$(git -C "$ROOT" status --porcelain 2>/dev/null)" ] && ok "deployed checkout clean" || hold "deployed checkout has local changes"
}
owner_wall_off() {
  [ -z "$(env_line OWNER_RLS_BIND)" ] && ok "no OWNER_RLS_BIND line (the owner wall is a separate, later switch)" ||
    hold "deploy/.env sets OWNER_RLS_BIND: the owner wall is not part of Phase C"
  local members; members="$(db "SELECT count(*) FROM pg_auth_members m JOIN pg_roles w ON w.oid = m.roleid WHERE w.rolname = 'swift_owner_wall'")"
  case "$members" in
    0) ok "no database role is a member of swift_owner_wall" ;;
    "") hold "could not count the members of swift_owner_wall" ;;
    *) hold "$members database role(s) are members of swift_owner_wall" ;;
  esac
}
nothing_left() {
  pgrep -af '[w]all/rehearsal.sh|[j]ourneys-on-copy.sh' >/dev/null && hold "a rehearsal or journeys run is alive" || ok "no rehearsal or journeys run alive"
  local c v; c="$(docker ps -aq --filter label=com.docker.compose.project=swift-rehearsal </dev/null | wc -l | tr -d ' ')"
  v="$(docker volume ls -q --filter label=com.docker.compose.project=swift-rehearsal </dev/null | wc -l | tr -d ' ')"
  [ "$c" = 0 ] && [ "$v" = 0 ] && ok "no swift-rehearsal containers or volumes" || hold "swift-rehearsal leftovers: containers=$c volumes=$v"
  sudo -n test -e /etc/credstore.encrypted/swift-rehearsal && hold "the rehearsal's encrypted store is still there" || ok "no rehearsal store"
  sudo -n test -e /run/swift-rehearsal-secrets && hold "the rehearsal's secrets directory is still there" || ok "no rehearsal secrets directory"
}

case "$STEP" in
  preflight)
    [ "$(docker context show 2>/dev/null)" = default ] && ok "docker context default" || hold "docker's context is not this host's own daemon (default)"
    sudo -n true 2>/dev/null && ok "sudo -n works" || hold "sudo -n needs a password (the rehearsal's store is reached with sudo -n)"
    identity="$(db "SELECT environment FROM deployment_identity WHERE id = 'singleton'")"
    [ "$identity" = production ] && ok "deployment identity production" || hold "deployment identity is '${identity:-unknown}', not production"
    checkout
    docker image inspect "swift-api:$SHA" >/dev/null 2>&1 </dev/null && ok "image swift-api:${SHA:0:8} present" ||
      hold "image swift-api:${SHA:0:8} is missing (pilot-up builds it; rehearsal.sh refuses without it)"
    logins="$(db "SELECT count(*) FROM pg_roles WHERE rolname IN ('swift_app_login', 'swift_system_login')")"
    [ "$logins" = 0 ] && ok "runtime logins 0 (Phase C has not run)" || hold "runtime logins: ${logins:-unknown} (expected 0 before Phase C)"
    [ -z "$(env_line TENANT_RLS_BIND)" ] && ok "no TENANT_RLS_BIND line (the expand posture)" || hold "deploy/.env already sets TENANT_RLS_BIND"
    owner_wall_off
    nothing_left
    # Headroom by hand (rehearsal.sh has none): memory beside the running stack, and room for the copy.
    mem="$(awk '/^MemAvailable:/ {print int($2 / 1024)}' "$MEMINFO" 2>/dev/null)"
    [ -n "$mem" ] && [ "$mem" -ge "$MEM_FLOOR_MIB" ] && ok "memory available ${mem} MiB (floor $MEM_FLOOR_MIB)" ||
      hold "memory available ${mem:-unknown} MiB is under the floor $MEM_FLOOR_MIB MiB"
    db_bytes="$(db "SELECT pg_database_size(current_database())")"
    free_mib="$(df -Pm /var/lib/docker 2>/dev/null | awk 'NR == 2 {print $4}')"
    if [[ "$db_bytes" =~ ^[0-9]+$ ]] && [[ "$free_mib" =~ ^[0-9]+$ ]]; then
      need=$(( 2 * db_bytes / 1048576 + DISK_MARGIN_MIB ))
      [ "$free_mib" -ge "$need" ] && ok "docker disk free ${free_mib} MiB (needs 2 x database + $DISK_MARGIN_MIB = $need)" ||
        hold "docker disk free ${free_mib} MiB is under 2 x database + $DISK_MARGIN_MIB = $need MiB"
    else
      hold "could not measure the database size or the docker disk"
    fi
    systemctl list-timers --no-pager 2>/dev/null | grep -q 'swift-backup-hourly' && ok "hourly backup timer listed (start right after a run completes)" ||
      hold "the hourly backup timer is not listed"
    health
    ;;
  snapshot)
    record="$(live_record)" || { hold "no live container to record"; finish; }
    printf '%s\n' "$record" > "$BEFORE" && chmod 600 "$BEFORE" && ok "BEFORE: $(printf '%s\n' "$record" | grep -c .) live containers recorded"
    ;;
  proof)
    nothing_left
    if [ -f "$BEFORE" ]; then
      now="$(live_record || true)"
      [ "$now" = "$(cat "$BEFORE")" ] && ok "live containers unchanged since the BEFORE record" || hold "the live containers changed since the BEFORE record"
    else
      hold "no BEFORE record ($BEFORE): run snapshot before the rehearsal"
    fi
    checkout
    health
    ;;
  verify)
    checkout
    [ "$(env_line TENANT_RLS_BIND)" = 1 ] && ok "TENANT_RLS_BIND=1 (the contract posture)" || hold "deploy/.env does not set TENANT_RLS_BIND=1"
    [ "$(env_line TENANT_UNSCOPED_ACCESS)" = deny ] && ok "TENANT_UNSCOPED_ACCESS=deny" || hold "deploy/.env does not set TENANT_UNSCOPED_ACCESS=deny"
    [ -z "$(env_line TENANT_WALL_EXPAND_ATTESTED)" ] && ok "no TENANT_WALL_EXPAND_ATTESTED line" || hold "deploy/.env still declares the wall-less expand posture"
    owner_wall_off
    roles="$("$DEPLOY/rls-logins.sh" roles 2>/dev/null </dev/null | tail -n 1)"
    case "$roles" in
      *'"status": "roles_hold"'*) ok "the least-privilege logins hold their contract (rls-logins roles)" ;;
      *) hold "the least-privilege logins do not hold their contract: ${roles:-no answer}" ;;
    esac
    for c in api worker; do
      id="$("${COMPOSE[@]}" ps -q "$c" </dev/null 2>/dev/null)"
      if [ -z "$id" ]; then hold "$c is not running"; continue; fi
      names=" $(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$id" </dev/null 2>/dev/null |
        awk -F= 'index($0, "=") > 1 && substr($0, index($0, "=") + 1) != "" { print $1 }' | tr '\n' ' ')"
      case "$names" in *" POSTGRES_PASSWORD_FILE "*|*" POSTGRES_PASSWORD "*) hold "$c still carries the owner's password setting" ;; esac
      case "$names" in *" DATABASE_URL_FILE "*) case "$names" in *" SYSTEM_DATABASE_URL_FILE "*) ok "$c runs on the two least-privilege logins" ;;
        *) hold "$c has no SYSTEM_DATABASE_URL_FILE" ;; esac ;; *) hold "$c has no DATABASE_URL_FILE" ;; esac
      boot="$(docker logs --tail 4000 "$id" </dev/null 2>&1)"
      printf '%s' "$boot" | grep -q 'tenant wall: enforced' && ok "$c attested 'tenant wall: enforced'" || hold "$c has no 'tenant wall: enforced' boot line"
      printf '%s' "$boot" | grep -q 'owner wall: inert' && ok "$c attested 'owner wall: inert'" || hold "$c has no 'owner wall: inert' boot line"
    done
    health
    ;;
esac
finish
