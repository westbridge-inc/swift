#!/usr/bin/env bash
# STAGING-ONLY: the PLAT-02 worker crash drill (STG-DRILLS D7). Run as the
# deploy user on the staging host, after the journeys of the same run:
#
#   LIVETEST_ADMIN_PHONE=+5920400000 LIVETEST_RUN_ID=<run id> ./deploy/drill-crash.sh
#
# The journey runner is an HTTP client with no Docker socket (by design), so
# the crash is split between it and this host script:
#
#   0. guard   HERE, inside the worker container this script will kill: the
#              full drill guard (drill_guard_in_worker, AX324 R3) — its posture,
#              every database connection and the database's staging identity.
#              The runner is then pinned to that deployment identity
#              (LIVETEST_EXPECT_DEPLOYMENT_ID), so the private API it drives and
#              the worker killed here serve one database;
#   1. setup   the runner (scripts/livetest, --suite=crash-drill) signs in a
#              roster customer, store and riders on the private api-journeys
#              instance, checks the dead-letter page is valid and EMPTY (else
#              PLAT-02 could never pass; nothing is killed), places an express
#              cash delivery, has the store accept it, and waits until a rider
#              holds a live offer — mid-offer — then writes
#              crash-drill-state.json and exits;
#   2. crash   HERE: the guard again, then docker kill the worker (SIGKILL, no
#              graceful drain), wait 15 s, docker start it again; the facts go
#              to crash-drill-host.json;
#   3. verify  the runner, within 120 s of the restart, proves through the API
#              that the offer cascade resumed (a fresh offer attempt) or was
#              reconciled, then walks the order to the door exactly once —
#              watching EVERY rider's offers and legs the whole way, through
#              completion (crash-drill-verify.json);
#   4. evidence HERE, inside the worker: the durable rows of that one order
#              (offer publications, offer pushes, the dispatch journal, the
#              status log; read-only, guarded) → crash-drill-evidence.json;
#   5. finalize the runner judges the durable evidence (every attempt
#              published and pushed once, every status logged once, one
#              assignment) with the live record and writes the PLAT-02 row in
#              the journeys-result.json format (plat02-crash-drill.json); when
#              the run's journeys-result.json exists, its PLAT-02 row is replaced.
#
# Whatever happens, the worker is started again on exit and the private
# instance is removed. Refuses unless this is the staging pilot with the drill
# marker (drill-common.sh), and the runner refuses any public or production
# target by itself (scripts/livetest/guard.ts). Exit: the verify phase's (0 no
# FAIL, 1 PLAT-02 failed, 2 harness error, 3 target refused) — now the
# finalize phase's — or 1 for a refused precondition or a failed setup.
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
# 0. [AX324 R3] The worker this script will kill must pass the FULL guard from
#    inside itself, before anything else is touched.
drill_guard_in_worker
GUARDED_DEPLOYMENT_ID="$DRILL_DEPLOYMENT_ID"
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
# The runner refuses a private API whose database is not the one the worker's
# guard just judged (scripts/livetest/guard.ts pins).
export LIVETEST_EXPECT_DEPLOYMENT_ID="$GUARDED_DEPLOYMENT_ID" LIVETEST_EXPECT_ENVIRONMENT=staging
export JOURNEYS_UID="$(id -u)" JOURNEYS_GID="$(id -g)"
rm -f "$RESULTS/crash-drill-state.json" "$RESULTS/crash-drill-host.json" "$RESULTS/crash-drill-verify.json" "$RESULTS/crash-drill-evidence.json"

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

# 2. crash: the guard once more, inside the same container, right before the
#    kill; then SIGKILL, no graceful shutdown, and the same container again.
drill_guard_in_worker
[ "$DRILL_DEPLOYMENT_ID" = "$GUARDED_DEPLOYMENT_ID" ] ||
  die "the worker's database identity changed during setup ($GUARDED_DEPLOYMENT_ID → $DRILL_DEPLOYMENT_ID); nothing was killed"
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

# 3. verify: the cascade resumed; the order is walked to the door once, watched throughout.
set +e
"${RUNNER[@]}" --phase=verify
VERIFY_STATUS=$?
set -e
echo "verify phase finished with status $VERIFY_STATUS"

# 4. evidence: the order's durable rows, read inside the worker (guarded, read-only).
ORDER_ID="$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["orderId"])' "$RESULTS/crash-drill-state.json")"
[[ "$ORDER_ID" =~ ^[a-z0-9]{20,40}$ ]] || die "crash-drill-state.json names no valid order id"
set +e
evidence="$(docker exec "$WORKER_ID" node dist/boot/drill-evidence.js crash --order "$ORDER_ID")"
EVIDENCE_STATUS=$?
set -e
if [ "$EVIDENCE_STATUS" -eq 0 ]; then
  printf '%s\n' "$evidence" | tail -n 1 > "$RESULTS/crash-drill-evidence.json"
else
  echo "WARNING: the durable evidence could not be read (exit $EVIDENCE_STATUS); PLAT-02 cannot pass without it" >&2
fi

# 5. finalize: judge the durable evidence with the live record; write the PLAT-02 row.
set +e
"${RUNNER[@]}" --phase=finalize
STATUS=$?
set -e
echo "crash drill for run $RUN_ID finished with status $STATUS; PLAT-02 row in $RESULTS/plat02-crash-drill.json"
exit "$STATUS"
