#!/usr/bin/env bash
# Run prisma/seed-production.ts — the PRODUCTION SPINE seed (platform config
# plan and the first SUPER_ADMIN; no demo data) — against THIS staging
# database, from the exact deployed revision.
#
#   SEED_ADMIN_PHONE='+592…' ./deploy/seed-production.sh <full-40-char-SHA>
#
# The RUNTIME image cannot run the seed: it carries dist/ but no src/ or tsx.
# This script builds the Dockerfile's `build` stage (which has both) and runs
# the seed in a ONE-OFF compose service (deploy/docker-compose.seed.yml) that
# loads the secret files through dist/boot/secret-files.js and then spawns
# `tsx prisma/seed-production.ts` in the same process — DATABASE_URL is
# assembled in the container's memory only, so it is never printed here, never
# written to a file, and never in argv. The one-off container is removed when
# it exits (compose run --rm).
#
# Refuses to run unless:
#   - a full 40-character commit SHA is passed, it is on origin/main, and it
#     is the current checkout (the exact revision pilot-up.sh deployed);
#   - the target database already carries its deployment_identity row;
#   - SEED_ADMIN_PHONE (E.164) is set in the environment.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SHA="${1:-}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" -f "$HERE/docker-compose.seed.yml")

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() { grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true; }

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "pass a full 40-character git commit SHA (the exact revision pilot-up.sh deployed)"
[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
[ -f "$HERE/.env" ] || die "deploy/.env is missing"
[ "$(env_value PILOT_ENV)" = staging ] || die "PILOT_ENV must be staging"
SEED_ADMIN_PHONE="${SEED_ADMIN_PHONE:-}"
[ -n "$SEED_ADMIN_PHONE" ] || die "set SEED_ADMIN_PHONE (the first SUPER_ADMIN's E.164 phone) in the environment"
# +592600 is DEMO_PHONE_PREFIX (apps/api/src/modules/ops/purge-plan.ts): the
# range every demo seed mints and the demo purge classifies on. A real
# SUPER_ADMIN inside it would be entangled with the demo classification, so
# the ceremony refuses it. The phone value itself is never printed.
[[ "$SEED_ADMIN_PHONE" != +592600* ]] ||
  die "SEED_ADMIN_PHONE must not start with +592600 — that range is the demo-seed/purge classification, never a real admin"
for tool in git docker; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done

# The two-person break-glass ceremony (runbook §6): SEED_SIGN_APPROVER signs one
# approver's half and seeds nothing; SEED_PROMOTION_APPROVALS carries both halves
# to the promotion. Either needs SEED_PLAN_SECRET from the encrypted store, which
# reaches the container only as a FILE — its value is never read or printed here.
SEED_SIGN_APPROVER="${SEED_SIGN_APPROVER:-}"
SEED_PROMOTION_APPROVALS="${SEED_PROMOTION_APPROVALS:-}"
SEED_PLAN_SECRET_FILE=""
if [ -n "$SEED_SIGN_APPROVER" ] || [ -n "$SEED_PROMOTION_APPROVALS" ]; then
  [ -z "$SEED_SIGN_APPROVER" ] || [[ "$SEED_SIGN_APPROVER" =~ ^[a-z][a-z0-9-]{1,31}$ ]] ||
    die "SEED_SIGN_APPROVER must be a short lowercase name (a-z, 0-9, -)"
  STORE_BIN="$(command -v swift-secrets || true)"
  [ -n "$STORE_BIN" ] || die "swift-secrets is not installed"
  sudo -n "$STORE_BIN" list | tr ' ' '\n' | grep -qx SEED_PLAN_SECRET ||
    die "the break-glass ceremony needs SEED_PLAN_SECRET in the encrypted store (sudo swift-secrets set SEED_PLAN_SECRET)"
  sudo -n systemctl restart swift-secrets.service ||
    die "swift-secrets.service could not materialize the store"
  SEED_PLAN_SECRET_FILE=/run/secrets/SEED_PLAN_SECRET
fi
export SEED_SIGN_APPROVER SEED_PROMOTION_APPROVALS SEED_PLAN_SECRET_FILE

# The one-off container joins the stack's private network, so the stack's
# Postgres must be up. This read is also the deployment-identity gate: the
# seed binds its plan to the identity row, so never seed a database that does
# not say which deployment it is. Only the count is captured — never a URL.
IDENTITY="$("${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) FROM deployment_identity;"' 2>/dev/null || true)"
[ "$IDENTITY" = "1" ] || die "could not read the deployment_identity row (is Postgres up and migrated, and was the row written?) — refusing to seed an unidentified database"

cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] ||
  die "checkout has local changes; refusing to build a ceremony image from it"
git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main ||
  die "the requested SHA is not on current origin/main"
[ "$(git rev-parse HEAD)" = "$SHA" ] || die "the checkout is not at the requested SHA; run pilot-up.sh <sha> first"

export SWIFT_TAG="$SHA"
"${COMPOSE[@]}" config --quiet || die "compose configuration is invalid"

# Build the `build` stage of the exact checkout, then run the seed exactly
# once. `--rm` removes the ceremony container; `--no-TTY` keeps it a script.
"${COMPOSE[@]}" build seed || die "the seed ceremony image could not be built"
"${COMPOSE[@]}" run --rm --no-TTY seed
