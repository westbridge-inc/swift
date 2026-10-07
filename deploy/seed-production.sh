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
#
# [PROD-PATH] PILOT_ENV is staging or production, and the database must say
# the same thing: a production host seeds only a database whose
# deployment_identity names production (NODE_ENV=production, and the
# operator-recorded SEED_FX_GYD_PER_USD), and a staging host never seeds one
# that does. On production the spine needs TWO different people
# (approver-signatures.ts), each with their OWN key made on their own computer;
# the server pins only their public keys (SEED_APPROVER_KEYS in the store):
#   1. a first run prints the plan and the request to sign, and exits 2;
#   2. each approver signs that request on their own computer:
#        ./deploy/seed-approve.sh <their-name> <their-key> < request.txt
#   3. the operator applies with both printed lines:
#        SEED_PLAN_APPROVALS='[<first>,<second>]' ./deploy/seed-production.sh <sha>
# A break-glass promotion works the same way (exit 3, SEED_PROMOTION_APPROVALS).
# Approvals expire and are single-use. The pinned keys reach the seed container
# only as a file from the encrypted store.
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
# [PROD-PATH] One reading of deploy/.env. Compose takes the LAST of two lines
# for the same name and honours `export NAME=` lines; every check here reads
# the first plain `NAME=` line. So the file must be plain: each line blank, a
# comment, or `NAME=value` at the start of the line, and each name once.
# Anything else is refused (the line number or name, never a value).
env_shape="$(awk '{ l = $0; sub(/^[ \t]+/, "", l); if (l == "" || substr(l, 1, 1) == "#") next
  if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) { print "line " NR " is not a plain NAME=value setting (no export, no indentation)"; exit }
  k = $0; sub(/=.*/, "", k); if (seen[k]++) { print k " is set twice (Compose would take the last)"; exit } }' "$HERE/.env")"
[ -z "$env_shape" ] || die "deploy/.env: $env_shape; fix the file so it has one plain setting per name"
# [PROD-PATH] One configuration: Compose fills ${NAME} from this shell before
# deploy/.env, and the checks here read deploy/.env. Only the ceremony's own
# inputs (SEED_*) and SWIFT_TAG (set below) may come from the shell.
compose_names="$(cat "$HERE/docker-compose.yml" "$HERE/docker-compose.seed.yml" |
  grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' | sed 's/^..//' | sort -u)"
for name in $compose_names COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE COMPOSE_ENV_FILES; do
  case "$name" in SWIFT_TAG | SEED_*) continue ;; esac
  [ -z "${!name+set}" ] ||
    die "$name is set in this shell, and Compose would use it instead of deploy/.env (which every check here reads); unset it, or run from a clean shell"
done
# [PROD-PATH] One Docker: this host's own daemon, never another one named by
# DOCKER_HOST, DOCKER_CONTEXT or DOCKER_CONFIG in this shell.
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG; do
  [ -z "${!name+set}" ] ||
    die "$name is set in this shell, and Docker would act on another daemon than this host's; unset it, or run from a clean shell"
done
PILOT_ENV="$(env_value PILOT_ENV)"
case "$PILOT_ENV" in
  staging | production) ;;
  *) die "PILOT_ENV must be staging or production" ;;
esac
if [ "$PILOT_ENV" = production ]; then
  [ "$(env_value NODE_ENV | sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//')" = production ] ||
    die "PILOT_ENV=production needs NODE_ENV=production: the production spine is never seeded in another posture"
  [[ "${SEED_FX_GYD_PER_USD:-}" =~ ^[0-9]+(\.[0-9]+)?$ ]] && [[ "${SEED_FX_GYD_PER_USD}" =~ [1-9] ]] ||
    die "set SEED_FX_GYD_PER_USD (today's GYD per USD, a positive number) in the environment: production records the rate the operator observed, never a constant"
fi
SEED_ADMIN_PHONE="${SEED_ADMIN_PHONE:-}"
[ -n "$SEED_ADMIN_PHONE" ] || die "set SEED_ADMIN_PHONE (the first SUPER_ADMIN's E.164 phone) in the environment"
# +592600 is DEMO_PHONE_PREFIX (apps/api/src/modules/ops/purge-plan.ts): the
# range every demo seed mints and the demo purge classifies on. A real
# SUPER_ADMIN inside it would be entangled with the demo classification, so
# the ceremony refuses it. The phone value itself is never printed.
[[ "$SEED_ADMIN_PHONE" != +592600* ]] ||
  die "SEED_ADMIN_PHONE must not start with +592600 — that range is the demo-seed/purge classification, never a real admin"
for tool in git docker; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
if [ "$PILOT_ENV" = production ]; then
  [ "$(docker context show 2>/dev/null || true)" = default ] ||
    die "docker's current context is not this host's own daemon (default); run: docker context use default"
fi

# The two-person ceremony (runbook §6b and §12): approvals are signatures
# by pinned approver keys. When approvals are given, the pinned keys must be in
# the encrypted store; they reach the container only as a file. The approval
# lines themselves are not secrets.
SEED_PROMOTION_APPROVALS="${SEED_PROMOTION_APPROVALS:-}"
SEED_PLAN_APPROVALS="${SEED_PLAN_APPROVALS:-}"
SEED_APPROVER_KEYS_FILE=""
if [ -n "$SEED_PROMOTION_APPROVALS" ] || [ -n "$SEED_PLAN_APPROVALS" ]; then
  STORE_BIN="$(command -v swift-secrets || true)"
  [ -n "$STORE_BIN" ] || die "swift-secrets is not installed"
  sudo -n "$STORE_BIN" list | tr ' ' '\n' | grep -qx SEED_APPROVER_KEYS ||
    die "approvals need the approvers' pinned public keys in the encrypted store: pin them with swift-secrets set SEED_APPROVER_KEYS (runbook 6b)"
  sudo -n systemctl restart swift-secrets.service ||
    die "swift-secrets.service could not materialize the store"
  SEED_APPROVER_KEYS_FILE=/run/secrets/SEED_APPROVER_KEYS
fi
export SEED_PROMOTION_APPROVALS SEED_PLAN_APPROVALS SEED_APPROVER_KEYS_FILE

# The one-off container joins the stack's private network, so the stack's
# Postgres must be up. This read is also the deployment-identity gate: the
# seed binds its plan to the identity row, so never seed a database that does
# not say which deployment it is. Only the count is captured — never a URL.
# [PROD-PATH] The row's environment is read too, and must agree with this host.
IDENTITY="$("${COMPOSE[@]}" exec -T postgres sh -c \
  'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT count(*) || chr(58) || coalesce(max(environment), chr(32)) FROM deployment_identity;"' 2>/dev/null || true)"
[ "${IDENTITY%%:*}" = "1" ] || die "could not read the deployment_identity row (is Postgres up and migrated, and was the row written?) — refusing to seed an unidentified database"
IDENTITY_ENV="${IDENTITY#*:}"
# Exactly equal, both ways: a production host seeds only a database that says
# production, a staging host only one that says staging (never test, blank or
# a misspelling, and never production).
[ "$IDENTITY_ENV" = "$PILOT_ENV" ] ||
  die "PILOT_ENV=$PILOT_ENV, but this database's deployment_identity is not $PILOT_ENV — refusing to seed it (a staging host never seeds a production database, nor the reverse)"

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
