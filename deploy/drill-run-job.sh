#!/usr/bin/env bash
# STAGING-ONLY: run allowlisted worker jobs ONCE, now (STG-DRILLS D2, D4).
# Staging cannot wait for the schedule to prove what these jobs do, so this
# runs, inside the worker container, the SAME functions the worker's own
# processors run (apps/api/src/modules/ops/drills/jobs.ts), each once, in the
# order named:
#
#   ./deploy/drill-run-job.sh settlement-digest            # the Sunday 00:00 sales digest
#   ./deploy/drill-run-job.sh convert-trials billing-cycle # the 03:00 conversion, then the hourly billing cycle
#
# Nothing else can be named; there is no route and no queue entry behind this.
# Refuses (drill-common.sh, then the drill guard inside the container) unless
# this is the staging pilot with the drill marker set. Prints the job runs as
# one JSON line. Exit: the entry's own (0 done, 1 failed, 2 usage, 3 refused)
# or 1 for a refused precondition here.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
. "$HERE/drill-common.sh"

ALLOWED='settlement-digest|convert-trials|billing-cycle'
[ "$#" -ge 1 ] || { echo "usage: $0 <$ALLOWED> [...]" >&2; exit 2; }
for job in "$@"; do
  case "$job" in
    settlement-digest|convert-trials|billing-cycle) ;;
    *) echo "usage: \"$job\" is not an allowlisted drill job ($ALLOWED)" >&2; exit 2 ;;
  esac
done
drill_preconditions

exec "${BASE[@]}" exec -T worker node dist/boot/drill-run-job.js "$@"
