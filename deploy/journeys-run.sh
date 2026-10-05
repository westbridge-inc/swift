#!/usr/bin/env bash
# STAGING-ONLY: run the pilot journey suite (scripts/livetest, --suite=journeys)
# against a PRIVATE api instance, then remove that instance.
#
# Run as the deploy user, after pilot-up.sh has deployed the checked-out SHA
# and the seed admin exists (seed-production with a fictional SEED_ADMIN_PHONE):
#
#   LIVETEST_ADMIN_PHONE=+5920400000 ./deploy/journeys-run.sh
#
# LIVETEST_ADMIN_PHONE is the seed admin (seed-production SEED_ADMIN_PHONE).
# Every phone the suite uses is +5920… — a 0 after +592 is never a subscriber
# number — because the shared worker serves api-journeys with the PUBLIC
# provider settings: once real SMS is on (Phase B) it would text a live number.
# Optional: LIVETEST_ADMIN2_PHONE (a second admin minted by the seed
# break-glass ceremony) lets the two-person admin cases run; without it they
# are reported SKIP with the reason.
#
# Safety model (deploy/docker-compose.journeys.yml):
#   * The PUBLIC api behind Caddy never carries DEV_OTP_BYPASS or
#     TEST_CONTROL_ENABLED; this script proves it on the live public route
#     before it starts anything (test-control 404, the dev code refused).
#   * api-journeys runs the public api's exact image with both switches on,
#     only on the private network: no published port, no Caddy route. It is
#     started for this run and removed when the run ends, whatever the outcome.
#   * The runner refuses a public or production target by itself as well
#     (scripts/livetest/guard.ts).
#
# Results: $JOURNEYS_RESULTS_DIR (default ~/swift-journeys)/<run id>/
#   journeys-result.json, journeys-summary.md
# Exit status: the runner's (0 no FAIL, 1 a journey failed, 2 harness error,
# 3 target refused), or 1 for a refused precondition here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BASE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
JOURNEYS=("${BASE[@]}" -f "$HERE/docker-compose.journeys.yml" --profile journeys)

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}

[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
[ -f "$HERE/.env" ] || die "deploy/.env is missing"
[ "$(env_value PILOT_ENV)" = staging ] || die "journeys run only on the staging pilot (PILOT_ENV=staging)"
[ "$(env_value NODE_ENV)" = loadtest ] || die "journeys need NODE_ENV=loadtest; production never hosts them"
API_HOST="$(env_value API_HOST)"
[[ "$API_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] || die "API_HOST must be the staging DNS name"
[[ "${LIVETEST_ADMIN_PHONE:-}" =~ ^\+5920[0-9]{6}$ ]] ||
  die "set LIVETEST_ADMIN_PHONE to the seed admin's never-a-subscriber phone (+5920 and 6 digits; staging: +5920400000)"
[ -z "${LIVETEST_ADMIN2_PHONE:-}" ] || [[ "$LIVETEST_ADMIN2_PHONE" =~ ^\+5920[0-9]{6}$ ]] ||
  die "LIVETEST_ADMIN2_PHONE, when set, is the second admin's never-a-subscriber +5920 phone"
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

# Live proof on the PUBLIC route: no test control, and the dev code is refused.
PUBLIC=(curl -sS --resolve "$API_HOST:443:127.0.0.1" --connect-timeout 5 --max-time 15)
code="$("${PUBLIC[@]}" -o /dev/null -w '%{http_code}' "https://$API_HOST/api/v1/test-control/identity")"
[ "$code" = 404 ] || die "the public API answered $code for /test-control/identity (expected 404): TEST_CONTROL_ENABLED is on"
body="$("${PUBLIC[@]}" -H 'content-type: application/json' -d '{"phone":"+5920499999","code":"000000"}' \
  "https://$API_HOST/api/v1/auth/verify-otp")"
if ! grep -q '"INVALID_OTP"' <<< "$body"; then
  seen="$(grep -oE '"code":"[A-Z_]+"' <<< "$body" | head -1 || true)"
  die "the public API did not refuse the dev OTP code (${seen:-no error code}); DEV_OTP_BYPASS may be on, or retry after a minute if RATE_LIMITED"
fi

RUN_ID="${LIVETEST_RUN_ID:-staging-$(date -u +%Y%m%dT%H%M%SZ)}"
[[ "$RUN_ID" =~ ^[A-Za-z0-9._-]{1,64}$ ]] || die "LIVETEST_RUN_ID may use letters, digits, dot, dash and underscore only"
RESULTS="${JOURNEYS_RESULTS_DIR:-$HOME/swift-journeys}/$RUN_ID"
mkdir -p "$RESULTS"
# The web-taxi refusal needs an origin the API allows: the first CORS_ORIGIN entry.
LIVETEST_WEB_ORIGIN="${LIVETEST_WEB_ORIGIN:-$(env_value CORS_ORIGIN | cut -d, -f1 | tr -d '[:space:]')}"
export LIVETEST_RUN_ID="$RUN_ID" JOURNEYS_RESULTS_DIR="$RESULTS" LIVETEST_ADMIN_PHONE LIVETEST_WEB_ORIGIN
export LIVETEST_ADMIN2_PHONE="${LIVETEST_ADMIN2_PHONE:-}"
export JOURNEYS_UID="$(id -u)" JOURNEYS_GID="$(id -g)"

# The private instance exists only for this run.
cleanup() { "${JOURNEYS[@]}" rm --stop --force api-journeys >/dev/null 2>&1 || true; }
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

set +e
"${JOURNEYS[@]}" run --rm --no-deps --pull never journeys
STATUS=$?
set -e
echo "journeys run $RUN_ID finished with status $STATUS; results in $RESULTS"
exit "$STATUS"
