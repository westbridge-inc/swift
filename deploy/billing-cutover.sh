#!/usr/bin/env bash
# The weekly-fee confirmation cutover backfill (apps/api/BILLING-CONFIRMATION-
# CUTOVER.md, steps 3 and 4) on a pilot host, from the exact deployed revision.
#
#   ./deploy/billing-cutover.sh <full-40-char-SHA> <cutover version>
#   e.g. ./deploy/billing-cutover.sh "$APPROVED_SHA" 20260930180000-v1
#
# [PROD-PATH · #1448 review] Before, the runbook ran the backfill as an inline
# override of the seed container's command, which skipped every check the seed
# makes. This script makes them (the same refusals as seed-production.sh):
#   - a full SHA that is on origin/main and is the clean current checkout;
#   - deploy/.env plain (one setting per name), no Compose setting exported in
#     this shell, no DOCKER_HOST/DOCKER_CONTEXT/DOCKER_CONFIG, and on
#     production NODE_ENV=production and Docker's own default context;
# and also:
#   - the API and worker are stopped: no old writer may run during the
#     cutover (refused, too, when Docker cannot say whether they run);
#   - the database and deployment are READ from the database (its
#     deployment_identity row and current_database()), never typed, and the
#     row's environment is exactly PILOT_ENV. The backfill then re-checks both
#     itself before any write.
# The version is the operator's: the backfill refuses any but its own.
# It runs in the seed's build-stage image (the runtime image has no tsx), the
# secret files loaded in memory exactly as the seed loads them (no URL in argv,
# in a file or in a log), then reads step 4 back: READY with no missing
# coverage, or it fails. Settings are read by name; deploy/.env is never printed.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SHA="${1:-}"
VERSION="${2:-}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml" -f "$HERE/docker-compose.seed.yml")

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() { grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true; }

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "pass a full 40-character git commit SHA (the exact revision pilot-up.sh deployed), then the cutover version"
[[ "$VERSION" =~ ^[0-9]{14}-v[0-9]+$ ]] ||
  die "pass the cutover version after the SHA (e.g. 20260930180000-v1, BILLING-CONFIRMATION-CUTOVER.md step 3)"
[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
[ -f "$HERE/.env" ] || die "deploy/.env is missing"
# One reading of deploy/.env, as seed-production.sh: plain NAME=value lines,
# each name once (Compose takes the last of two). Names a line, never a value.
env_shape="$(awk '{ l = $0; sub(/^[ \t]+/, "", l); if (l == "" || substr(l, 1, 1) == "#") next
  if ($0 !~ /^[A-Za-z_][A-Za-z0-9_]*=/) { print "line " NR " is not a plain NAME=value setting (no export, no indentation)"; exit }
  k = $0; sub(/=.*/, "", k); if (seen[k]++) { print k " is set twice (Compose would take the last)"; exit } }' "$HERE/.env")"
[ -z "$env_shape" ] || die "deploy/.env: $env_shape; fix the file so it has one plain setting per name"
# One configuration: Compose fills ${NAME} from this shell before deploy/.env.
compose_names="$(cat "$HERE/docker-compose.yml" "$HERE/docker-compose.seed.yml" |
  grep -oE '\$\{[A-Za-z_][A-Za-z0-9_]*' | sed 's/^..//' | sort -u)"
for name in $compose_names COMPOSE_PROJECT_NAME COMPOSE_PROFILES COMPOSE_FILE COMPOSE_ENV_FILES; do
  case "$name" in SWIFT_TAG) continue ;; esac
  [ -z "${!name+set}" ] ||
    die "$name is set in this shell, and Compose would use it instead of deploy/.env (which every check here reads); unset it, or run from a clean shell"
done
# One Docker: this host's own daemon.
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
    die "PILOT_ENV=production needs NODE_ENV=production: the production cutover never runs in another posture"
fi
for tool in git docker; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done
if [ "$PILOT_ENV" = production ]; then
  [ "$(docker context show 2>/dev/null || true)" = default ] ||
    die "docker's current context is not this host's own daemon (default); run: docker context use default"
fi

# No old writer during the cutover (BILLING-CONFIRMATION-CUTOVER.md step 1).
# Fail closed: no answer from Docker is not "not running".
for service in api worker; do
  running="$("${COMPOSE[@]}" ps -q "$service")" ||
    die "could not ask Docker whether $service is running; refusing the cutover without that answer"
  [ -z "$running" ] ||
    die "refuses while the api or worker is running ($service is): stop both first (docker compose -f deploy/docker-compose.yml stop api worker)"
done

# The migration owner reads, inside the postgres container (the password stays
# in the container's file). Only the named facts are captured.
db_read() {
  "${COMPOSE[@]}" exec -T postgres sh -c \
    'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -q -v ON_ERROR_STOP=1'
}
# The target, from the database itself: the identity row (which deployment,
# which environment) and the database's own name. Never typed, never guessed.
IDENTITY="$(db_read 2>/dev/null <<'SQL' || true
SELECT count(*) || ':' || coalesce(max(environment), ' ') || ':' || coalesce(max("deploymentId"), ' ') || ':' || current_database() FROM deployment_identity;
SQL
)"
IFS=':' read -r id_count id_env DEPLOYMENT DB_NAME <<< "$IDENTITY"
[ "${id_count:-}" = 1 ] ||
  die "could not read the deployment_identity row (is Postgres up and migrated, and was the row written?); refusing the cutover on an unidentified database"
[ "${id_env:-}" = "$PILOT_ENV" ] ||
  die "PILOT_ENV=$PILOT_ENV, but this database's deployment_identity is not $PILOT_ENV; refusing the cutover (a staging host never runs it on a production database, nor the reverse)"
[[ "${DEPLOYMENT:-}" =~ ^[a-z0-9][a-z0-9_-]*$ ]] ||
  die "the deployment id in deployment_identity is not a plain name ([a-z0-9_-]); refusing to pass it on"
[[ "${DB_NAME:-}" =~ ^[a-z0-9_]+$ ]] ||
  die "the database name is not a plain name ([a-z0-9_]); refusing to pass it on"
echo "cutover target: database $DB_NAME, deployment $DEPLOYMENT ($PILOT_ENV), version $VERSION"

cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] ||
  die "checkout has local changes; refusing to build the cutover image from it"
git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main ||
  die "the requested SHA is not on current origin/main"
[ "$(git rev-parse HEAD)" = "$SHA" ] || die "the checkout is not at the requested SHA; run pilot-up.sh --data-only <sha> first"

export SWIFT_TAG="$SHA"
"${COMPOSE[@]}" config --quiet || die "compose configuration is invalid"
"${COMPOSE[@]}" build seed || die "the seed build-stage image could not be built"
# Step 3: the backfill, once, in a removed one-off container. The target and
# version are argv (names, not secrets); the database URL exists only in the
# container's memory (dist/boot/secret-files.js), as in the seed.
"${COMPOSE[@]}" run --rm --no-TTY seed node -e "require('./dist/boot/secret-files.js'); const r = require('node:child_process').spawnSync(process.execPath, [require.resolve('tsx/cli'), 'src/scripts/backfill-billing-confirmation.ts', '--execute', '--version', process.argv[3], '--expected-database', process.argv[1], '--expected-deployment', process.argv[2]], { stdio: 'inherit' }); if (r.error) { console.error('FATAL: could not start tsx: ' + r.error.message); process.exit(1); } process.exit(r.status ?? 1);" "$DB_NAME" "$DEPLOYMENT" "$VERSION" ||
  die "the backfill did not complete; billing stays BLOCKED (no charge, no dunning). Read its message, fix the cause and run this again (it resumes)"

# Step 4, read back as the migration owner: READY, and no missing coverage.
CHECK="$(db_read 2>/dev/null <<'SQL' || true
SELECT coalesce((SELECT value->>'state' FROM platform_config WHERE key = 'system:billing-confirmation-cutover:v1'), 'MISSING') || ':' || billing_confirmation_missing_coverage();
SQL
)"
[ -n "$CHECK" ] || die "could not read the cutover state back; do not start the API until step 4 reads READY with 0 missing"
state="${CHECK%%:*}"
missing="${CHECK#*:}"
[ "$state" = READY ] && [ "$missing" = 0 ] ||
  die "the cutover is $state with $missing subscription(s) missing coverage, not READY with 0; do not start the API (BILLING-CONFIRMATION-CUTOVER.md, if the backfill refuses)"
echo "BILLING CUTOVER READY at exact SHA $SHA (database $DB_NAME, deployment $DEPLOYMENT, version $VERSION; 0 missing)"
