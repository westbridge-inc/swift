#!/usr/bin/env bash
# STAGING-ONLY: create or remove the staging drill fixtures (STG-DRILLS D5, D6)
# that let the recusal and cross-tenant journeys run. Run as the deploy user, after
# pilot-up.sh has deployed the checked-out SHA with SWIFT_STAGING_DRILLS=1 in
# deploy/.env:
#
#   LIVETEST_ADMIN_PHONE=+5920400000 ./deploy/drill-fixtures.sh create <run-id>
#   ./deploy/drill-fixtures.sh cleanup <run-id>
#
# create builds, inside the worker container (node dist/boot/drill-fixtures.js),
# the fixtures the journeys need, named DRILL-<run-id>:
#   D5     a partner applicant in the test admin's identity cluster (ADMIN-01);
#   D6     a second tenant, swift-drill, with a store, a customer, an order and
#          a partner (PLAT-01).
# (There are no billing fixtures: the billing jobs are platform-wide and no
# drill may run them — AX324 R2; VEND-04's billing path is automated-only.)
# It writes the manifest to $JOURNEYS_RESULTS_DIR (default ~/swift-journeys)
# /drills/<run-id>/drill-manifest.json; hand that path to journeys-run.sh as
# LIVETEST_DRILL_MANIFEST. Re-running create with the same run id returns the
# same fixtures. cleanup removes them through their parent rows and writes
# drill-cleanup.json beside the manifest; it exits 1 if anything was kept.
#
# Refuses (drill-common.sh, then the drill guard inside the container) unless
# this is the staging pilot with the drill marker set. Exit: the entry's own
# (0 done, 1 failed, 2 usage, 3 refused) or 1 for a refused precondition here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/drill-common.sh"

MODE="${1:-}"
RUN_ID="${2:-${LIVETEST_RUN_ID:-}}"
case "$MODE" in
  create|cleanup) ;;
  *) echo "usage: LIVETEST_ADMIN_PHONE=+5920400000 $0 create <run-id> | $0 cleanup <run-id>" >&2; exit 2 ;;
esac
drill_run_id_ok "$RUN_ID" || die "pass a run id (letters, digits, dot, dash, underscore; 1-64)"
if [ "$MODE" = create ]; then
  [[ "${LIVETEST_ADMIN_PHONE:-}" =~ ^\+5920[0-9]{6}$ ]] ||
    die "set LIVETEST_ADMIN_PHONE to the seed admin's never-a-subscriber phone (+5920 and 6 digits; staging: +5920400000)"
fi
drill_preconditions

OUT="${JOURNEYS_RESULTS_DIR:-$HOME/swift-journeys}/drills/$RUN_ID"
mkdir -p "$OUT"
ENTRY=(node dist/boot/drill-fixtures.js "$MODE" --run-id "$RUN_ID")
[ "$MODE" = cleanup ] || ENTRY+=(--admin-phone "$LIVETEST_ADMIN_PHONE")

set +e
output="$("${BASE[@]}" exec -T worker "${ENTRY[@]}")"
status=$?
set -e
# The entry prints exactly one JSON document on its last stdout line; logs go to stderr.
document="$(printf '%s\n' "$output" | tail -n 1)"

if [ "$MODE" = create ]; then
  [ "$status" -eq 0 ] || die "drill fixture creation failed (exit $status); nothing to hand the journeys"
  printf '%s\n' "$document" | python3 -c '
import json, sys
m = json.load(sys.stdin)
if m.get("version") != 2 or m.get("runId") != sys.argv[1]:
    sys.exit("the manifest does not describe run " + sys.argv[1])
' "$RUN_ID" || die "the drill fixture manifest is not valid"
  printf '%s\n' "$document" > "$OUT/drill-manifest.json"
  chmod 0644 "$OUT/drill-manifest.json"
  echo "drill fixtures for $RUN_ID: $OUT/drill-manifest.json"
  echo "next: LIVETEST_DRILL_MANIFEST=$OUT/drill-manifest.json LIVETEST_RUN_ID=$RUN_ID ./deploy/journeys-run.sh"
  exit 0
fi

if printf '%s\n' "$document" | python3 -c 'import json, sys; json.load(sys.stdin)' 2>/dev/null; then
  printf '%s\n' "$document" > "$OUT/drill-cleanup.json"
  echo "drill cleanup for $RUN_ID: $OUT/drill-cleanup.json"
  cat "$OUT/drill-cleanup.json"
fi
exit "$status"
