# STAGING-ONLY: shared preconditions of the drill scripts (drill-fixtures.sh,
# drill-run-job.sh, drill-crash.sh). Sourced, never run; it defines functions
# and arrays and touches nothing by itself.
#
# drill_preconditions refuses, before any container is touched, unless:
#   * it runs as the non-root deploy user on the staging pilot
#     (deploy/.env: PILOT_ENV=staging, NODE_ENV=loadtest — the pair
#     journeys-run.sh requires; production never hosts a drill);
#   * deploy/.env carries SWIFT_STAGING_DRILLS=1 (set on staging only) AND the
#     RUNNING worker carries it too (an .env edit needs pilot-up.sh to recreate
#     the api and worker before a drill sees it);
#   * the running worker is the checked-out revision's image.
# Inside the container the drill code checks again for itself
# (apps/api/src/modules/ops/drills/guard.ts): the marker, the posture, the
# stack's own Postgres and the database's staging identity. Two layers; either
# one alone refuses production.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
BASE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}

drill_preconditions() {
  [ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
  [ -f "$HERE/.env" ] || die "deploy/.env is missing"
  [ "$(env_value PILOT_ENV)" = staging ] || die "drills run only on the staging pilot (PILOT_ENV=staging)"
  [ "$(env_value NODE_ENV)" = loadtest ] || die "drills need NODE_ENV=loadtest; production never hosts them"
  [ "$(env_value SWIFT_STAGING_DRILLS)" = 1 ] ||
    die "SWIFT_STAGING_DRILLS=1 is not set in deploy/.env (staging only; then recreate the api and worker with pilot-up.sh)"
  local tool
  for tool in git docker python3; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done

  SHA="$(git -C "$ROOT" rev-parse HEAD)"
  export SWIFT_TAG="$SHA"
  WORKER_ID="$("${BASE[@]}" ps -q worker)"
  [ -n "$WORKER_ID" ] || die "the worker is not running"
  [ "$(docker inspect -f '{{.Config.Image}}' "$WORKER_ID")" = "swift-api:$SHA" ] ||
    die "the running worker is not the checked-out revision $SHA"
  # Captured, never printed: the settings file holds no secrets (pilot-up.sh
  # refuses one that does), and only the exact marker line is looked for.
  local worker_env
  worker_env="$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$WORKER_ID")"
  grep -qx 'SWIFT_STAGING_DRILLS=1' <<< "$worker_env" ||
    die "the running worker does not carry SWIFT_STAGING_DRILLS=1; recreate it (./deploy/pilot-up.sh $SHA) after setting it in deploy/.env"
}

# The run id every drill artefact of one staging run is filed under (the same
# rule as LIVETEST_RUN_ID in journeys-run.sh).
drill_run_id_ok() { [[ "${1:-}" =~ ^[A-Za-z0-9._-]{1,64}$ ]]; }
