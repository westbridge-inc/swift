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
#   - on production, the owner's admin email: typed at the script's hidden
#     prompt (or SEED_ADMIN_EMAIL exported after `read -rs`); written on the
#     first SUPER_ADMIN's account (the app's solo approval emails it).
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
# [SOLO SEED] While there is no second admin (owner ruling 13 Oct), the seed
# that mints the FIRST SUPER_ADMIN may be approved by ONE pinned person:
#   1. SEED_SOLO=1 ./deploy/seed-production.sh <sha>  prints a solo request
#      (the words signed say it is one person) and exits 2;
#   2. the approver signs it with seed-approve.sh;
#   3. no earlier than 12 hours after the request was issued (the seed refuses
#      an early run and says when it may run), and within its 48 hours:
#        SEED_SOLO=1 SEED_PLAN_APPROVALS='[<the line>]' ./deploy/seed-production.sh <sha>
# Solo never covers anything else (a later change, or a second admin).
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
# [SOLO SEED] Exactly 1, or unset/empty; solo is the production ceremony only.
case "${SEED_SOLO:-}" in
  "") ;;
  1) [ "$PILOT_ENV" = production ] ||
       die "SEED_SOLO is for the production seed ceremony only (a staging seed applies without approvals)" ;;
  *) die "SEED_SOLO must be exactly 1 (one approver, 12-hour cooling-off) or unset" ;;
esac
SEED_ADMIN_PHONE="${SEED_ADMIN_PHONE:-}"
[ -n "$SEED_ADMIN_PHONE" ] || die "set SEED_ADMIN_PHONE (the first SUPER_ADMIN's E.164 phone) in the environment"
# +592600 is DEMO_PHONE_PREFIX (apps/api/src/modules/ops/purge-plan.ts): the
# range every demo seed mints. The demo purge selects by the synthetic marker
# only (the range is a live carrier range), but a real SUPER_ADMIN inside it
# would still be confusable with the demo accounts, so the ceremony refuses
# it. The phone value itself is never printed.
[[ "$SEED_ADMIN_PHONE" != +592600* ]] ||
  die "SEED_ADMIN_PHONE must not start with +592600 — that range is the demo-seed/purge classification, never a real admin"
# [OWNER EMAIL · Opus money review 14 Oct, S2-L] Solo approval in the apps
# emails the owner (it refuses an admin with no email), and no shipped client
# can add an admin email, so the production seed writes it with the first
# SUPER_ADMIN. Personal data: typed at a hidden prompt (or exported after
# `read -rs`), never an argument, never printed or logged. The signed request
# shows it masked and binds its digest, so print and apply must get the same.
if [ "$PILOT_ENV" = production ]; then
  if [ -z "${SEED_ADMIN_EMAIL:-}" ] && [ -t 0 ]; then
    printf "The owner's admin email (typed, not shown): " >&2
    IFS= read -rs SEED_ADMIN_EMAIL
    echo >&2
  fi
  [ -n "${SEED_ADMIN_EMAIL:-}" ] ||
    die "the production seed needs the owner's admin email: type it at the prompt, or run read -rs SEED_ADMIN_EMAIL; export SEED_ADMIN_EMAIL first"
  # Plain ASCII letters, digits and . _ % + - only, one line, as seed-plan.ts
  # requires: the approver reads the domain exactly, so nothing invisible,
  # right-to-left or look-alike may pass. The value goes through a pipe (printf
  # is a builtin), never an argument; grep runs in the C locale (bytes).
  case "$SEED_ADMIN_EMAIL" in *$'\n'* | *$'\r'*) die "SEED_ADMIN_EMAIL is not an email address (it is not shown)" ;; esac
  [ "${#SEED_ADMIN_EMAIL}" -le 254 ] && printf '%s\n' "$SEED_ADMIN_EMAIL" |
    LC_ALL=C grep -Eq '^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+([.][A-Za-z0-9-]+)+$' ||
    die "SEED_ADMIN_EMAIL is not an email address (it is not shown)"
  export SEED_ADMIN_EMAIL
else
  SEED_ADMIN_EMAIL=""
  export SEED_ADMIN_EMAIL
fi
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
git fetch origin main >&2
git merge-base --is-ancestor "$SHA" origin/main ||
  die "the requested SHA is not on current origin/main"
[ "$(git rev-parse HEAD)" = "$SHA" ] || die "the checkout is not at the requested SHA; run pilot-up.sh <sha> first"

export SWIFT_TAG="$SHA"
"${COMPOSE[@]}" config --quiet >&2 || die "compose configuration is invalid"

# Build the `build` stage of the exact checkout, then run the seed exactly
# once. `--rm` removes the ceremony container; `--no-TTY` keeps it a script.
# Stdout is the seed's own text only (the plan, the request block the signers
# read, the approval lines): every build and progress line goes to stderr,
# so `> request.txt` captures exactly what is signed.
"${COMPOSE[@]}" build seed >&2 || die "the seed ceremony image could not be built"
"${COMPOSE[@]}" run --rm --no-TTY seed
