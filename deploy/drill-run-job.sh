#!/usr/bin/env bash
# STAGING-ONLY: run the allowlisted worker job ONCE, now (STG-DRILLS D4).
# Staging cannot wait for Sunday 00:00 to prove what the settlement digest
# does, so this runs, inside the worker container, the SAME function the
# worker's own processor runs (apps/api/src/modules/ops/drills/jobs.ts):
#
#   ./deploy/drill-run-job.sh settlement-digest   # the Sunday 00:00 sales digest
#
# Nothing else can be named; there is no route and no queue entry behind this.
# The billing jobs are refused for good (AX324 R2): they sweep every due
# subscription on the database and cannot be scoped to drill accounts, so on
# staging they could charge, suspend or notify a real partner. VEND-04's
# billing path is automated-only (GOLD-7).
# Refuses (drill-common.sh, then the drill guard inside the container) unless
# this is the staging pilot with the drill marker set. Prints the job runs as
# one JSON line. Exit: the entry's own (0 done, 1 failed, 2 usage, 3 refused)
# or 1 for a refused precondition here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/drill-common.sh"

ALLOWED='settlement-digest'
[ "$#" -ge 1 ] || { echo "usage: $0 <$ALLOWED> [...]" >&2; exit 2; }
for job in "$@"; do
  case "$job" in
    settlement-digest) ;;
    *) echo "usage: \"$job\" is not an allowlisted drill job ($ALLOWED)" >&2; exit 2 ;;
  esac
done
drill_preconditions

exec "${BASE[@]}" exec -T worker node dist/boot/drill-run-job.js "$@"
