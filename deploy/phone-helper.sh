#!/usr/bin/env bash
# STAGING-ONLY: the phone-test counterpart helper [PHONE-HELPER].
#
# The owner tests the Phones-gate journeys holding ONE iPhone. This plays the
# second party of each journey — store, rider, driver, courier, customer,
# provider — as the journeys roster's TEST accounts (+5920… numbers no
# subscriber can hold), through the REAL API of the private api-journeys
# instance: the same image, database and worker as the public API the phone
# uses. Every action is an HTTP call as that account (scripts/livetest/
# phone-helper.ts): no database access, no admin shortcut. deploy/PHONE-TEST-
# SCRIPT.md says which command goes with which step of which journey.
#
# Run as the deploy user on the staging host, with the seed admin's phone
# (the target guard proves the private instance through it):
#
#   export LIVETEST_ADMIN_PHONE=+5920400000
#   ./deploy/phone-helper.sh start                          # once, at the start of the session
#   ./deploy/phone-helper.sh store open --at 6.8013,-58.1551
#   ./deploy/phone-helper.sh rider accept --wait 600
#   ./deploy/phone-helper.sh stop                           # at the end, whatever happened
#
# start  the host guard below (the checks journeys-run.sh makes, public-route
#        proofs included), then the private api-journeys instance, kept up for
#        the session: DEV_OTP_BYPASS exists only there — private network, no
#        published port, no Caddy route.
# <role> <action> [flags]
#        the host guard again (without the dev-OTP probe, which the OTP rate
#        limit would throttle), the instance must be up, healthy and private,
#        then ONE helper command in the journeys runner container. Its output is
#        appended to $JOURNEYS_RESULTS_DIR/phone-helper/<UTC date>.log.
# stop   every helper mover offline, every helper store closed and back at its
#        roster pin, then api-journeys removed.
#
# The runner refuses a public or production target by itself as well
# (scripts/livetest/guard.ts). Exit: the helper's (0 done, 1 a step refused,
# 2 usage, 3 target refused), or 1 for a refused precondition here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BASE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
JOURNEYS=("${BASE[@]}" -f "$HERE/docker-compose.journeys.yml" --profile journeys)

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}
usage() {
  echo "usage: LIVETEST_ADMIN_PHONE=+5920400000 $0 start | stop | <customer|store|rider|driver|courier|provider|all> <action> [flags]" >&2
  echo "       (deploy/PHONE-TEST-SCRIPT.md lists every action and when to run it)" >&2
  exit 2
}

MODE="${1:-}"
case "$MODE" in
  start|stop|customer|store|rider|driver|courier|provider|all) ;;
  *) usage ;;
esac

# ── The host guard: the staging pilot only (journeys-run.sh's checks) ────────
[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
[ -f "$HERE/.env" ] || die "deploy/.env is missing"
[ "$(env_value PILOT_ENV)" = staging ] || die "the phone helper runs only on the staging pilot (PILOT_ENV=staging)"
[ "$(env_value NODE_ENV)" = loadtest ] || die "the phone helper needs NODE_ENV=loadtest; production never hosts it"
API_HOST="$(env_value API_HOST)"
[[ "$API_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || die "API_HOST must be the staging DNS name"
[[ "${LIVETEST_ADMIN_PHONE:-}" =~ ^\+5920[0-9]{6}$ ]] ||
  die "set LIVETEST_ADMIN_PHONE to the seed admin's never-a-subscriber phone (+5920 and 6 digits; staging: +5920400000)"
for tool in git docker curl python3; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done

# The same revision everywhere: the checked-out SHA, its built image, and the running public api.
SHA="$(git -C "$ROOT" rev-parse HEAD)"
export SWIFT_TAG="$SHA"
docker image inspect "swift-api:$SHA" >/dev/null 2>&1 || die "swift-api:$SHA is not built; deploy it with pilot-up.sh first"
API_ID="$("${BASE[@]}" ps -q api)"
[ -n "$API_ID" ] || die "the public api is not running"
[ "$(docker inspect -f '{{.Config.Image}}' "$API_ID")" = "swift-api:$SHA" ] ||
  die "the running api is not the checked-out revision $SHA"

# Isolation contract on the rendered model (ports, networks, switches, Caddy).
"${JOURNEYS[@]}" config --quiet
"${JOURNEYS[@]}" config --format json |
  python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" --require-journeys ||
  die "journeys isolation check failed"

# Live proof on the PUBLIC route: no test control (every time), and the dev code refused (at start).
PUBLIC=(curl -sS --resolve "$API_HOST:443:127.0.0.1" --connect-timeout 5 --max-time 15)
code="$("${PUBLIC[@]}" -o /dev/null -w '%{http_code}' "https://$API_HOST/api/v1/test-control/identity")"
[ "$code" = 404 ] || die "the public API answered $code for /test-control/identity (expected 404): TEST_CONTROL_ENABLED is on"
if [ "$MODE" = start ]; then
  body="$("${PUBLIC[@]}" -H 'content-type: application/json' -d '{"phone":"+5920499999","code":"000000"}' \
    "https://$API_HOST/api/v1/auth/verify-otp")"
  if ! grep -q '"INVALID_OTP"' <<< "$body"; then
    seen="$(grep -oE '"code":"[A-Z_]+"' <<< "$body" | head -1 || true)"
    die "the public API did not refuse the dev OTP code (${seen:-no error code}); DEV_OTP_BYPASS may be on, or retry after a minute if RATE_LIMITED"
  fi
fi

LOGDIR="${JOURNEYS_RESULTS_DIR:-$HOME/swift-journeys}/phone-helper"
mkdir -p "$LOGDIR"
LOG="$LOGDIR/$(date -u +%Y%m%d).log"
export JOURNEYS_RESULTS_DIR="$LOGDIR" LIVETEST_ADMIN_PHONE
export LIVETEST_RUN_ID="phone-helper-$(date -u +%Y%m%d)"
export JOURNEYS_UID="$(id -u)" JOURNEYS_GID="$(id -g)"

private_id() { "${JOURNEYS[@]}" ps -q api-journeys; }
private_healthy() {
  local id; id="$(private_id)"
  [ -n "$id" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$id")" = healthy ]
}
HELPER=("${JOURNEYS[@]}" run --rm --no-deps --pull never --entrypoint apps/api/node_modules/.bin/tsx journeys scripts/livetest/phone-helper-run.ts)

helper() {
  echo "── $(date -u +%H:%M:%SZ) phone-helper $*" >> "$LOG"
  set +e
  "${HELPER[@]}" "$@" 2>&1 | tee -a "$LOG"
  local status=${PIPESTATUS[0]}
  set -e
  return "$status"
}

case "$MODE" in
  start)
    "${JOURNEYS[@]}" up -d --no-deps --no-build --pull never api-journeys
    for _ in $(seq 1 80); do
      if private_healthy; then break; fi
      sleep 3
    done
    private_healthy || die "api-journeys did not become healthy; inspect: docker compose ... logs api-journeys"
    [ -z "$(docker port "$(private_id)")" ] || { "${JOURNEYS[@]}" rm --stop --force api-journeys >/dev/null 2>&1 || true; die "api-journeys has a published port; removed it"; }
    echo "phone helper ready: api-journeys is up (private) on $SHA; log: $LOG"
    echo "end the session with: ./deploy/phone-helper.sh stop"
    ;;
  stop)
    status=0
    if private_healthy; then helper all cleanup || status=$?; fi
    "${JOURNEYS[@]}" rm --stop --force api-journeys >/dev/null 2>&1 || true
    echo "phone helper stopped: api-journeys removed; log: $LOG"
    exit "$status"
    ;;
  *)
    private_healthy || die "api-journeys is not up: run ./deploy/phone-helper.sh start first"
    [ -z "$(docker port "$(private_id)")" ] || die "api-journeys has a published port"
    helper "$@"
    ;;
esac
