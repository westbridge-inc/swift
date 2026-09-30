#!/usr/bin/env bash
# STAGING-ONLY: the PLAT-02 worker crash drill (STG-DRILLS D7). Run as the
# deploy user on the staging host, after the journeys of the same run:
#
#   LIVETEST_ADMIN_PHONE=+5920400000 LIVETEST_RUN_ID=<run id> ./deploy/drill-crash.sh
#
# The journey runner is an HTTP client with no Docker socket (by design), so
# the crash is split between it and this host script:
#
#   1. setup   the runner (scripts/livetest, --suite=crash-drill) signs in a
#              roster customer, store and riders on the private api-journeys
#              instance, places an express cash delivery, has the store accept
#              it, and waits until a rider holds a live offer — mid-offer —
#              then writes crash-drill-state.json and exits;
#   2. crash   HERE: docker kill the worker (SIGKILL, no graceful drain), wait
#              15 s, docker start it again; the facts go to crash-drill-host.json;
#   3. verify  the runner, within 120 s of the restart, proves through the API
#              that the offer cascade resumed (a fresh offer attempt) or was
#              reconciled, that nothing ran twice (never two live offers at
#              once, no dead letter from the drill window), then walks the
#              order to the door exactly once. It writes the PLAT-02 row in the
#              journeys-result.json format (plat02-crash-drill.json) and, when
#              the run's journeys-result.json exists, replaces its PLAT-02 row.
#
# Whatever happens, the worker is started again on exit and the private
# instance is removed. Refuses unless this is the staging pilot with the drill
# marker (drill-common.sh), and the runner refuses any public or production
# target by itself (scripts/livetest/guard.ts). Exit: the verify phase's (0 no
# FAIL, 1 PLAT-02 failed, 2 harness error, 3 target refused), or 1 for a
# refused precondition or a failed setup.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/drill-common.sh"
JOURNEYS=("${BASE[@]}" -f "$HERE/docker-compose.journeys.yml" --profile journeys)

[[ "${LIVETEST_ADMIN_PHONE:-}" =~ ^\+5920[0-9]{6}$ ]] ||
  die "set LIVETEST_ADMIN_PHONE to the seed admin's never-a-subscriber phone (+5920 and 6 digits; staging: +5920400000)"
[ -z "${LIVETEST_ADMIN2_PHONE:-}" ] || [[ "$LIVETEST_ADMIN2_PHONE" =~ ^\+5920[0-9]{6}$ ]] ||
  die "LIVETEST_ADMIN2_PHONE, when set, is the second admin's never-a-subscriber +5920 phone"
RUN_ID="${LIVETEST_RUN_ID:-}"
drill_run_id_ok "$RUN_ID" || die "set LIVETEST_RUN_ID to the journeys run whose results get the PLAT-02 row"
drill_preconditions
for tool in curl sleep; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
API_HOST="$(env_value API_HOST)"
[[ "$API_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || die "API_HOST must be the staging DNS name"
docker image inspect "swift-api:$SHA" >/dev/null 2>&1 || die "swift-api:$SHA is not built; deploy it with pilot-up.sh first"

# The same isolation contract and public-route proof journeys-run.sh makes.
"${JOURNEYS[@]}" config --quiet
"${JOURNEYS[@]}" config --format json |
  python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" --require-journeys ||
  die "journeys isolation check failed"
PUBLIC=(curl -sS --resolve "$API_HOST:443:127.0.0.1" --connect-timeout 5 --max-time 15)
code="$("${PUBLIC[@]}" -o /dev/null -w '%{http_code}' "https://$API_HOST/api/v1/test-control/identity")"
[ "$code" = 404 ] || die "the public API answered $code for /test-control/identity (expected 404): TEST_CONTROL_ENABLED is on"
body="$("${PUBLIC[@]}" -H 'content-type: application/json' -d '{"phone":"+5920499999","code":"000000"}' \
  "https://$API_HOST/api/v1/auth/verify-otp")"
grep -q '"INVALID_OTP"' <<< "$body" ||
  die "the public API did not refuse the dev OTP code; DEV_OTP_BYPASS may be on, or retry after a minute if RATE_LIMITED"

RESULTS="${JOURNEYS_RESULTS_DIR:-$HOME/swift-journeys}/$RUN_ID"
mkdir -p "$RESULTS"
export LIVETEST_RUN_ID="$RUN_ID" JOURNEYS_RESULTS_DIR="$RESULTS" LIVETEST_ADMIN_PHONE
export LIVETEST_ADMIN2_PHONE="${LIVETEST_ADMIN2_PHONE:-}" LIVETEST_DRILL_MANIFEST=""
export JOURNEYS_UID="$(id -u)" JOURNEYS_GID="$(id -g)"
rm -f "$RESULTS/crash-drill-state.json" "$RESULTS/crash-drill-host.json"

worker_running() { [ "$(docker inspect -f '{{.State.Running}}' "$WORKER_ID" 2>/dev/null)" = true ]; }
cleanup() {
  # Never leave staging without its worker, whatever stopped this script.
  worker_running || docker start "$WORKER_ID" >/dev/null 2>&1 || echo "WARNING: could not restart the worker ($WORKER_ID); run: docker start $WORKER_ID" >&2
  "${JOURNEYS[@]}" rm --stop --force api-journeys >/dev/null 2>&1 || true
}
trap cleanup EXIT

"${JOURNEYS[@]}" up -d --no-deps --no-build --pull never api-journeys
PRIVATE_ID=""
for _ in $(seq 1 80); do
  PRIVATE_ID="$("${JOURNEYS[@]}" ps -q api-journeys)"
  if [ -n "$PRIVATE_ID" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$PRIVATE_ID")" = healthy ]; then
    break
  fi
  sleep 3
done
[ -n "$PRIVATE_ID" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' "$PRIVATE_ID")" = healthy ] ||
  die "api-journeys did not become healthy; inspect: docker compose ... logs api-journeys"
[ -z "$(docker port "$PRIVATE_ID")" ] || die "api-journeys has a published port"

RUNNER=("${JOURNEYS[@]}" run --rm --no-deps --pull never --entrypoint apps/api/node_modules/.bin/tsx journeys scripts/livetest/run.ts --suite=crash-drill)

# 1. setup: an order whose offer is live on a rider's phone.
"${RUNNER[@]}" --phase=setup || die "the crash drill could not reach mid-offer; nothing was killed (see $RESULTS)"
[ -s "$RESULTS/crash-drill-state.json" ] || die "the setup phase wrote no crash-drill-state.json; nothing was killed"

# 2. crash: SIGKILL, no graceful shutdown, then the same container again.
KILLED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
docker kill "$WORKER_ID" >/dev/null
DOWN=false
for _ in $(seq 1 10); do
  if ! worker_running; then DOWN=true; break; fi
  sleep 0.5
done
sleep 15
DOWN_AFTER_WAIT=false
worker_running || DOWN_AFTER_WAIT=true
docker start "$WORKER_ID" >/dev/null
RESTARTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
worker_running || die "the worker did not start again; run: docker start $WORKER_ID"
python3 - "$RESULTS/crash-drill-host.json" "$KILLED_AT" "$RESTARTED_AT" "$DOWN" "$DOWN_AFTER_WAIT" "$(docker inspect -f '{{.Name}}' "$WORKER_ID")" <<'PY'
import json, sys
path, killed, restarted, down, down_after, name = sys.argv[1:7]
json.dump({
    "worker": name.lstrip("/"),
    "signal": "SIGKILL",
    "killedAt": killed,
    "restartedAt": restarted,
    "downRightAfterKill": down == "true",
    "downAfterTheWait": down_after == "true",
    "waitSeconds": 15,
}, open(path, "w"), indent=2)
PY
echo "worker $WORKER_ID killed at $KILLED_AT, started again at $RESTARTED_AT"

# 3. verify: the cascade resumed, nothing ran twice, one completion.
set +e
"${RUNNER[@]}" --phase=verify
STATUS=$?
set -e
echo "crash drill for run $RUN_ID finished with status $STATUS; PLAT-02 row in $RESULTS/plat02-crash-drill.json"
exit "$STATUS"
