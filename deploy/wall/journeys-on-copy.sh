#!/usr/bin/env bash
# [TA-S0-003 · C1, coordinator ruling 15 Oct] The walled-login journeys, on the
# STAGING host only, against a throwaway COPY of STAGING's database (synthetic
# data only), in the contract posture. Never production, never a copy of it.
#
#   LIVETEST_ADMIN_PHONE=+5920… ./deploy/wall/journeys-on-copy.sh <sha>
#
# LIVETEST_ADMIN_PHONE is staging's fictional seed admin (as journeys-run.sh).
#
#   1. Refuses before anything changes unless deploy/.env says PILOT_ENV=staging
#      (and NODE_ENV=production in no spelling), the live staging database's
#      deployment identity says staging (a read-only query), the host has room
#      for a second stack beside the live one Apple reviews (2 GiB of memory
#      available; Docker's disk: twice the database plus 2 GiB free), the admin
#      phone is a +5920…
#      number, and no rehearsal copy is already there.
#   2. ./deploy/wall/rehearsal.sh up <sha>: the isolated copy (its own project,
#      an internal network with no route out, its own volumes and freshly
#      generated secrets), the two logins on it, each process's walled boot and
#      the wall checks. The copy's own identity must then say staging.
#   3. ONE walled process for the whole measured window: the copy's own worker
#      (whose walled boot the rehearsal just attested) is stopped, and a private
#      api-journeys instance in the contract posture
#      (deploy/docker-compose.journeys-copy.yml) serves the requests AND
#      consumes the queues, so its own /metrics covers every request and every
#      job. Then the journey runner on the copy's internal network: an OTP
#      sign-in (AUTH-01), the vendor route (VEND-02, VEND-05), the rider and
#      driver profiles (RIDE-01, TAXI-02), the dispatch offer (RIDE-02) and the
#      cart to checkout (CUST-01, CUST-02). Every one must PASS. A SKIP is a
#      failure here, except the runner's "every executed step passed" SKIP
#      whose only target-gated cases are named in TARGET_SKIPS (cases no
#      staging copy can run: an SMS step-up, MMG pay links).
#   4. The system jobs the wall binds, run once by that instance:
#      compliance-sample and expiry-sweep (verification-jobs). Each must complete.
#   5. The instance's own measurements, sampled through the window (the metrics
#      token never leaves the container): the 95th-percentile request time
#      holds the budget (1 s), no query ever waited for a pool connection, the
#      wall's binding ran (tenant and non-tenant bindings > 0) and system work
#      never ran inside a caller's transaction (nontenant_system_in_tx = 0).
#   6. No TenantInUnboundTransactionError or FATAL line in any copy process.
#
# Always, pass or fail: the copy's own logs (api, worker, api-journeys; the last
# 400 lines each, redacted by deploy/wall/redact-log.py) are kept in the run's
# results directory (copy-logs/), and the first FATAL lines are printed; then
# ./deploy/wall/rehearsal.sh down (the copy, the instance, their volumes, store
# and secrets). "JOURNEYS PASSED" is printed only
# when every step held; any other end is non-zero ("JOURNEYS FAILED at step").
# The live staging API and database are only READ (the identity query, and the
# copy step's dump): nothing here starts, stops or writes to them.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DEPLOY="$(cd "$HERE/.." && pwd)"
PROJECT=swift-rehearsal
STORE_DIR=/etc/credstore.encrypted/swift-rehearsal
RUN_DIR=/run/swift-rehearsal-secrets
JOURNEYS=AUTH-01,CUST-01,CUST-02,VEND-02,VEND-05,RIDE-01,RIDE-02,TAXI-02
JOBS="compliance-sample expiry-sweep"
# The only cases a journey may leave to the target, journey by journey: an MMG
# pay link needs an SMS step-up (DEV_OTP_BYPASS never applies to it) and the
# copy has no SMS provider; the delivery-fee side of a multi-vendor order needs
# a mover online. Any other SKIP fails the run.
TARGET_SKIPS='CUST-01:multi-vendor delivery-fee agreement|CUST-02:MMG checkout|CUST-02:dispute hold'
# The 95th-percentile request time the walled instance must hold, in seconds (a
# bucket bound of swift_http_request_duration_seconds; tools/load: p(95)<1000ms),
# over at least this many requests.
P95_BUDGET_S=1
MIN_REQUESTS=20
STEP=start

die() { echo "JOURNEYS HOLD: $*" >&2; exit 1; }
say() { echo "journeys-on-copy: $*"; }
[ "$(id -u)" -ne 0 ] || die "run as the deploy user, not root (the store is reached with sudo -n)"
case "$-" in *x*) die "shell tracing is on; turn it off (set +x)" ;; esac
[ $# -eq 1 ] || die "usage: journeys-on-copy.sh <sha>"
SHA="$1"
[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "pass the full 40-character SHA whose API image pilot-up built"
[ -f "$DEPLOY/.env" ] || die "deploy/.env is missing"
setting() { grep -E "^$1=" "$DEPLOY/.env" | tail -1 | cut -d= -f2- || true; }
[ "$(setting PILOT_ENV)" = staging ] ||
  die "this runs on the STAGING host only (deploy/.env must say PILOT_ENV=staging): production's rehearsal is ./deploy/wall/rehearsal.sh, with no journeys on a copy of production's data"
# Any line that sets NODE_ENV to production, however it is spelled (quoted, export …).
! grep -qE '^([^#]*[^A-Za-z0-9_#])?NODE_ENV[[:space:]]*[=:][^#]*production' "$DEPLOY/.env" ||
  die "NODE_ENV=production here: the journeys instance signs synthetic accounts in with the dev code, which production mode refuses"
[[ "${LIVETEST_ADMIN_PHONE:-}" =~ ^\+5920[0-9]{6,}$ ]] || die "LIVETEST_ADMIN_PHONE must be staging's fictional seed admin (+5920…)"
for name in DOCKER_HOST DOCKER_CONTEXT DOCKER_CONFIG COMPOSE_PROJECT_NAME COMPOSE_FILE COMPOSE_PROFILES COMPOSE_ENV_FILES; do
  [ -z "${!name+set}" ] || die "$name is set in this shell; run from a clean shell"
done
[ "$(docker context show 2>/dev/null || true)" = default ] || die "docker's current context is not this host's own daemon (default)"

LIVE=(docker compose --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml")
REH=(docker compose -p "$PROJECT" --project-directory "$DEPLOY" -f "$DEPLOY/docker-compose.yml"
     -f "$DEPLOY/docker-compose.wall.yml" -f "$DEPLOY/docker-compose.rehearsal.yml")
JRN=("${REH[@]}" -f "$DEPLOY/docker-compose.journeys-copy.yml" --profile journeys-copy)
IDENTITY_SQL="SELECT environment FROM deployment_identity WHERE id = 'singleton'"
SIZE_SQL="SELECT pg_database_size(current_database())"
read_one() {  # read_one <sql> <compose argv…>: one answer from that database, read-only
  local sql="$1"; shift
  "$@" exec -T postgres sh -c 'export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -tA -v ON_ERROR_STOP=1 -c "$1"' sh "$sql" 2>/dev/null
}
identity_of() { read_one "$IDENTITY_SQL" "$@"; }  # the database's own word
LIVE_IDENTITY="$(identity_of "${LIVE[@]}")" || die "could not read this host's database identity; is the staging stack up?"
[ "$LIVE_IDENTITY" = staging ] || die "this host's database says '$LIVE_IDENTITY', not staging: journeys run only on a copy of staging's synthetic data"
# Headroom: the copy is a second stack on the host Apple reviews. Hold unless
# it fits beside the live one with room to spare.
MIN_MEM_MB=2048
command -v free >/dev/null 2>&1 || die "free is required (the memory headroom check)"
mem_mb="$(free -m | awk '/^Mem:/ {print $7}')"
[[ "$mem_mb" =~ ^[0-9]+$ ]] || die "could not read this host's available memory"
[ "$mem_mb" -ge "$MIN_MEM_MB" ] ||
  die "only ${mem_mb} MiB of memory available; the copy needs ${MIN_MEM_MB} MiB beside the live staging stack: hold"
db_bytes="$(read_one "$SIZE_SQL" "${LIVE[@]}")" || die "could not read the database's size"
[[ "$db_bytes" =~ ^[0-9]+$ ]] || die "could not read the database's size"
docker_root="$(docker info -f '{{.DockerRootDir}}' 2>/dev/null)" || die "could not read Docker's data directory"
disk_mb="$(df -Pm "$docker_root" 2>/dev/null | awk 'NR == 2 {print $4}')"
[[ "$disk_mb" =~ ^[0-9]+$ ]] || die "could not read the free disk under Docker's data directory"
need_mb=$(( 2 * db_bytes / 1048576 + 2048 ))
[ "$disk_mb" -ge "$need_mb" ] ||
  die "only ${disk_mb} MiB of disk free for Docker; the copy needs ${need_mb} MiB (twice the database plus 2 GiB): hold"
say "headroom: ${mem_mb} MiB memory available, ${disk_mb} MiB disk free (database $(( db_bytes / 1048576 )) MiB)"
[ -z "$("${REH[@]}" ps -aq 2>/dev/null)" ] || die "a rehearsal copy is already there; remove it first (./deploy/wall/rehearsal.sh down)"
! sudo -n test -e "$STORE_DIR" || die "a rehearsal store already exists; remove it first (./deploy/wall/rehearsal.sh down)"
! sudo -n test -e "$RUN_DIR" || die "rehearsal secrets already exist; remove them first (./deploy/wall/rehearsal.sh down)"

# From here on the copy exists or is being built: remove it however this ends,
# after keeping its logs in this run's results directory.
RUN_ID="copy-$(date -u +%Y%m%dT%H%M%SZ)"
export JOURNEYS_RESULTS_DIR="${JOURNEYS_RESULTS_BASE:-$HOME/swift-journeys-copy}/$RUN_ID"
mkdir -p "$JOURNEYS_RESULTS_DIR" || die "could not create the results directory $JOURNEYS_RESULTS_DIR"
LOGS_DIR="$JOURNEYS_RESULTS_DIR/copy-logs"
WORK="$(mktemp -d)"
SAMPLER=""
stop_sampler() {
  [ -n "$SAMPLER" ] || return 0
  touch "$WORK/stop"; wait "$SAMPLER" 2>/dev/null || true; SAMPLER=""
}
# save_logs: the copy's processes' own logs, the last 400 lines each, redacted,
# into copy-logs/ (0700), BEFORE the copy goes; then the first 20 FATAL lines
# (the rehearsal already printed its own when the copy step failed).
save_logs() {
  local svc
  ( umask 077; mkdir -p "$LOGS_DIR" && chmod 700 "$LOGS_DIR" ) 2>/dev/null || { echo "journeys-on-copy: could not create $LOGS_DIR for the copy's logs" >&2; return 0; }
  for svc in api worker api-journeys; do
    ( umask 077; "${JRN[@]}" logs --no-color --tail 400 "$svc" 2>/dev/null | python3 -I "$HERE/redact-log.py" >"$LOGS_DIR/$svc.log" ) || true
  done
  echo "journeys-on-copy: logs: the copy's api, worker and api-journeys logs (last 400 lines each, redacted) are in $LOGS_DIR" >&2
  if [ "$STEP" != copy ] && grep -q FATAL "$LOGS_DIR"/*.log 2>/dev/null; then
    echo "journeys-on-copy: the first FATAL lines (redacted):" >&2
    { grep -h FATAL "$LOGS_DIR/api.log" "$LOGS_DIR/worker.log" "$LOGS_DIR/api-journeys.log" 2>/dev/null || true; } | head -n 20 | cut -c1-400 | sed 's/^/  /' >&2
  fi
  return 0
}
cleanup() {
  local rc=$?
  stop_sampler
  save_logs
  rm -rf "$WORK"
  "$HERE/rehearsal.sh" down >/dev/null 2>&1 || echo "journeys-on-copy: the copy could not be removed; run ./deploy/wall/rehearsal.sh down" >&2
  if [ "$rc" -ne 0 ]; then echo "JOURNEYS FAILED at step: $STEP (exit $rc). The copy was removed." >&2; fi
  echo "journeys-on-copy: before the hold on staging lifts: the live /health and the build-9 smoke (PILOT-RUNBOOK §13)" >&2
}
trap cleanup EXIT

STEP=copy
REHEARSAL_RESULTS_DIR="$LOGS_DIR" "$HERE/rehearsal.sh" up "$SHA" || die "the walled copy of staging did not pass (above)"
COPY_IDENTITY="$(identity_of "${REH[@]}")" || die "could not read the copy's identity"
[ "$COPY_IDENTITY" = staging ] || die "the copy says '$COPY_IDENTITY', not staging"

STEP=instance
# The instance is the ONLY queue consumer: the copy's worker stops first.
"${REH[@]}" stop worker >/dev/null || die "the copy's worker could not be stopped"
[ -z "$("${REH[@]}" ps -q worker 2>/dev/null)" ] || die "the copy's worker is still running: the journeys instance must be the only queue consumer"
export SWIFT_TAG="$SHA" LIVETEST_ADMIN_PHONE
"${JRN[@]}" up -d api-journeys >/dev/null || die "the private journeys instance could not start"
ready=0
for _ in $(seq 1 90); do
  own="$("${JRN[@]}" logs --no-color api-journeys 2>/dev/null || true)"
  if grep -q 'tenant wall: enforced' <<<"$own" && grep -q 'Server listening' <<<"$own"; then ready=1; break; fi
  sleep 2
done
[ "$ready" = 1 ] || die "the journeys instance did not attest the wall and listen within 3 minutes"
say "journeys instance: walled and listening on the copy's internal network; the only queue consumer"

# The instance's own /metrics, read INSIDE it with the copy's token file: only
# the latency buckets, the pool gauge and the binding counters come out.
METRICS_JS='const token = require("fs").readFileSync("/run/secrets/METRICS_TOKEN", "utf8").trim();
fetch("http://127.0.0.1:3000/metrics", { headers: { authorization: `Bearer ${token}` } })
  .then(async (r) => {
    if (!r.ok) { console.log(`metrics: HTTP ${r.status}`); process.exit(1); }
    for (const l of (await r.text()).split("\n")) {
      if (/^swift_(http_request_duration_seconds_bucket|db_pool|tenant_bind_total)\{/.test(l)) console.log(l);
    }
  })
  .catch(() => { console.log("metrics: unreachable"); process.exit(2); });'
metrics() { "${JRN[@]}" exec -T api-journeys node -e "$METRICS_JS"; }
# The pool gauge is a moment: sample it every 2 s through the journeys and jobs.
# It also ends by itself once the scratch directory is gone.
( while [ -d "$WORK" ] && [ ! -e "$WORK/stop" ]; do
    metrics >>"$WORK/samples.prom" 2>/dev/null || echo 'sample: failed' >>"$WORK/samples.prom"
    sleep 2
  done ) &
SAMPLER=$!

STEP=journeys
export LIVETEST_RUN_ID="$RUN_ID" JOURNEYS_UID="$(id -u)" JOURNEYS_GID="$(id -g)"
runner=0
"${JRN[@]}" run --rm --no-TTY journeys-copy "--only=$JOURNEYS" || runner=$?
python3 -I - "$JOURNEYS_RESULTS_DIR/journeys-result.json" "$JOURNEYS" "$TARGET_SKIPS" <<'PY' || die "a journey did not PASS on the walled login (results: $JOURNEYS_RESULTS_DIR)"
import json, sys
allowed = {tuple(x.split(':', 1)) for x in sys.argv[3].split('|')}
try:
    results = {r['journeyId']: r for r in json.load(open(sys.argv[1]))}
except (OSError, ValueError, KeyError, TypeError, AttributeError):
    print('journeys-on-copy: no readable journey results'); sys.exit(1)
bad = 0
for jid in sys.argv[2].split(','):
    r = results.get(jid) or {}
    status = r.get('status', 'MISSING')
    if status == 'SKIP':
        steps = r.get('steps') or []
        cases = [c.get('case') for c in r.get('skippedCases') or [] if c.get('gate') == 'target']
        if (steps and all(st.get('ok') or st.get('cleanup') for st in steps) and cases
                and str(r.get('reason', '')).startswith('every executed step passed')
                and all((jid, c) in allowed for c in cases)):
            status = f'PASS (all {len(steps)} executed steps passed; not runnable on a staging copy: {", ".join(cases)})'
        else:
            status = f"SKIP not accepted ({str(r.get('reason', ''))[:160]})"
    print(f'journeys-on-copy: {jid} {status}')
    bad += not status.startswith('PASS')
sys.exit(1 if bad else 0)
PY
[ "$runner" = 0 ] || die "the journey runner ended with exit $runner"

STEP=jobs
# Each job once, by the walled instance (the only consumer), from inside the copy.
JOBS_JS='const { Queue, QueueEvents } = require("bullmq");
const IORedis = require("ioredis");
const conn = () => new IORedis(process.env.REDIS_URL, { maxRetriesPerRequest: null });
(async () => {
  const queue = new Queue("verification-jobs", { connection: conn() });
  const events = new QueueEvents("verification-jobs", { connection: conn() });
  await events.waitUntilReady();
  let bad = 0;
  for (const name of process.argv.slice(1)) {
    const job = await queue.add(name, {}, { attempts: 1, removeOnComplete: false, removeOnFail: false });
    try { await job.waitUntilFinished(events, 300000); console.log(`job ${name}: completed`); }
    catch { console.log(`job ${name}: did not complete`); bad += 1; }
  }
  await queue.close(); await events.close();
  process.exit(bad ? 1 : 0);
})().catch(() => { console.log("jobs: could not be queued"); process.exit(2); });'
# shellcheck disable=SC2086
"${JRN[@]}" exec -T -w /app/apps/api api-journeys node -e "$JOBS_JS" $JOBS || die "a system job the wall binds did not complete on the copy"

STEP=measure
stop_sampler
metrics >"$WORK/final.prom" || die "could not read the journeys instance's metrics"
python3 -I - "$WORK/samples.prom" "$WORK/final.prom" "$P95_BUDGET_S" "$MIN_REQUESTS" <<'PY' || die "the walled instance's measurements did not hold (above)"
import re, sys
LINE = re.compile(r'^([a-z_]+)\{(.*)\}\s+(\S+)$')
LABEL = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')
def parse(path):
    out = []
    try:
        lines = open(path).read().splitlines()
    except OSError:
        return out
    for line in lines:
        m = LINE.match(line.strip())
        if m:
            try:
                out.append((m.group(1), dict(LABEL.findall(m.group(2))), float(m.group(3))))
            except ValueError:
                pass
    return out
samples, final = parse(sys.argv[1]), parse(sys.argv[2])
budget, least = float(sys.argv[3]), int(sys.argv[4])
bad = []
def say(text):
    print(f'journeys-on-copy: {text}')
def le(v):
    return float('inf') if v == '+Inf' else float(v)
def p95(series):
    buckets = {}
    for labels, value in series:
        buckets[le(labels['le'])] = buckets.get(le(labels['le']), 0) + value
    total = buckets.get(float('inf'), 0)
    if not total:
        return None, 0
    return next(b for b in sorted(buckets) if buckets[b] >= 0.95 * total), int(total)
# Latency: every request the instance served in the window but its own /metrics reads.
http = [(l, v) for n, l, v in final if n == 'swift_http_request_duration_seconds_bucket' and l.get('route') != '/metrics']
overall, total = p95(http)
if overall is None or total < least:
    bad.append(f'only {total} requests measured (at least {least})')
else:
    say(f'latency: p95 <= {overall:g} s over {total} requests (budget {budget:g} s)')
    if overall > budget:
        bad.append(f'p95 {overall:g} s is over the {budget:g} s budget')
    routes = {}
    for labels, value in http:
        routes.setdefault((labels.get('method', '?'), labels.get('route', '?')), []).append((labels, value))
    ranked = sorted(((p95(s), k) for k, s in routes.items() if p95(s)[0] is not None), key=lambda x: (-x[0][0], -x[0][1]))
    for (bound, count), (method, route) in ranked[:5]:
        say(f'latency: slowest {method} {route} p95 <= {bound:g} s ({count} requests)')
# The pool, through the window.
pool = {}
for n, l, v in samples + final:
    if n == 'swift_db_pool':
        pool.setdefault(l.get('state'), []).append(v)
if not pool.get('open'):
    bad.append('the pool was never measured')
else:
    say(f"pool: {len(pool['open'])} samples, open max {max(pool['open']):g}, busy max {max(pool.get('busy', [0])):g}, waiting max {max(pool.get('waiting', [0])):g}")
    if max(pool.get('waiting', [0])) > 0:
        bad.append(f"queries waited for a pool connection (max {max(pool['waiting']):g})")
# The wall's binding counters.
kinds = {l.get('kind'): v for n, l, v in final if n == 'swift_tenant_bind_total'}
say('binding: ' + (', '.join(f'{k}={v:g}' for k, v in sorted(kinds.items())) or 'none'))
for kind in ('tenant', 'nontenant'):
    if kinds.get(kind, 0) <= 0:
        bad.append(f'no {kind} binding ran: the journeys did not go through the wall')
if kinds.get('nontenant_system_in_tx', 0) != 0:
    bad.append(f"system work ran inside a caller's transaction (nontenant_system_in_tx={kinds['nontenant_system_in_tx']:g})")
for reason in bad:
    say(f'FAIL {reason}')
sys.exit(1 if bad else 0)
PY

STEP=logs
log="$("${JRN[@]}" logs --no-color api worker api-journeys 2>/dev/null || true)"
unbound="$(grep -c TenantInUnboundTransactionError <<<"$log" || true)"
fatal="$(grep -c FATAL <<<"$log" || true)"
say "errors in the copy's processes: TenantInUnboundTransactionError=$unbound FATAL=$fatal"
[ "$unbound" = 0 ] && [ "$fatal" = 0 ] || die "a copy process logged TenantInUnboundTransactionError or FATAL lines"

STEP=done
say "JOURNEYS PASSED at $SHA: the walled copy, $JOURNEYS, $JOBS and the measurements, all on the least-privilege logins (results: $JOURNEYS_RESULTS_DIR). Removing the copy."
