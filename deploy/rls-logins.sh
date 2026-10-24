#!/usr/bin/env bash
# [TA-S0-003 · R2] The least-privilege runtime logins, run by the operator on
# the stack's host as the deploy user (never root: the store is reached with
# `sudo -n`, like pilot-up.sh does).
#
#   ./deploy/rls-logins.sh fingerprint                       the target to approve (names, counts, digests)
#   ./deploy/rls-logins.sh plan   --approved-target-file F   what apply would create; changes nothing
#   ./deploy/rls-logins.sh apply  --approved-target-file F   create, attest and publish both logins
#   ./deploy/rls-logins.sh verify --approved-target-file F   read-only repeat check, in the apply window
#   ./deploy/rls-logins.sh roles                             read-only role check for later deploys
#
# Output is one JSON line: names, counts, digests and constant reason codes.
# Never a password, a verifier or a URL. See deploy/wall/operator.py.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
[ "$(id -u)" -ne 0 ] || { echo '{"status": "hold", "reason": "RUN_AS_THE_DEPLOY_USER"}'; exit 1; }
case "$-" in *x*) echo '{"status": "hold", "reason": "SHELL_TRACING_ON"}'; exit 1 ;; esac
# A clean environment: nothing this shell carries (a DOCKER_* switch, a
# PYTHON* path, a stray secret) reaches the adapter or its children.
exec env -i PATH="$PATH" HOME="$HOME" LANG=C.UTF-8 python3 -I "$HERE/wall/operator.py" "$@"
