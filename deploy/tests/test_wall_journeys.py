"""[TA-S0-003 · C1] deploy/wall/journeys-on-copy.sh against shims, and its
compose layer rendered: the walled-login journeys run only on the STAGING
host, on a throwaway copy of staging's database, in the contract posture;
the live staging stack is only read; any failed step fails the run; the copy
is removed however the run ends. Nothing here needs root, a database or a
running Docker daemon (the render needs the docker CLI, else it skips).
"""
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
REPO = DEPLOY.parent
SHA = 'e' * 40
JOURNEYS = 'AUTH-01,CUST-01,CUST-02,VEND-02,VEND-05,RIDE-01,RIDE-02,TAXI-02'
TARGET_SKIPS = 'CUST-01:multi-vendor delivery-fee agreement|CUST-02:MMG checkout|CUST-02:dispute hold'


def skipped(jid, cases, steps=1, reason=None, gate='target'):
    """A runner SKIP result: steps that all passed, and the cases left to the target."""
    reason = reason or ('every executed step passed, but these cases cannot run on this target: '
                        + '; '.join(f'{c} (why)' for c in cases))
    return {'journeyId': jid, 'status': 'SKIP', 'reason': reason,
            'steps': [{'name': f'step {i}', 'ok': True, 'detail': ''} for i in range(steps)],
            'skippedCases': [{'case': c, 'reason': 'why', 'gate': gate} for c in cases]}
FILES = ('docker-compose.yml', 'docker-compose.wall.yml', 'docker-compose.rehearsal.yml', 'docker-compose.journeys-copy.yml')


def histogram(route, counts, method='GET'):
    """Cumulative bucket lines of swift_http_request_duration_seconds for one route."""
    bounds = ('0.01', '0.05', '0.1', '0.25', '0.5', '1', '2.5', '5', '+Inf')
    return [f'swift_http_request_duration_seconds_bucket{{le="{b}",method="{method}",route="{route}",status="200"}} {c}'
            for b, c in zip(bounds, counts)]


def metrics(http=None, pool=(5, 1, 4, 0), kinds=None):
    lines = list(http if http is not None else (
        histogram('/api/v1/cart', (10, 60, 90, 98, 100, 100, 100, 100, 100))
        + histogram('/api/v1/auth/verify-otp', (0, 0, 5, 15, 19, 20, 20, 20, 20), 'POST')
        # The instance's own /metrics reads: far over every budget, and never counted.
        + histogram('/metrics', (0, 0, 0, 0, 0, 0, 0, 0, 5000))))
    if pool is not None:
        lines += [f'swift_db_pool{{state="{state}"}} {value}' for state, value in zip(('open', 'busy', 'idle', 'waiting'), pool)]
    kinds = {'tenant': 40, 'nontenant': 12, 'nontenant_system': 3} if kinds is None else kinds
    lines += [f'swift_tenant_bind_total{{kind="{kind}"}} {value}' for kind, value in kinds.items()]
    return '\n'.join(lines)


def shim(bin_dir: Path, name: str, body: str, python=False) -> None:
    path = bin_dir / name
    path.write_text(('#!/usr/bin/env python3\n' if python else '#!/bin/sh\n') + body + '\n')
    path.chmod(0o755)


FAKE_DOCKER = r'''
import json, os, sys
argv = sys.argv[1:]
stdin = '' if sys.stdin.isatty() else sys.stdin.read()
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'docker', 'argv': argv}) + '\n')
env = os.environ.get
if argv[:2] == ['context', 'show']:
    print('default'); sys.exit(0)
if argv[:1] == ['info']:
    print('/var/lib/docker'); sys.exit(0)
copy = argv[:3] == ['compose', '-p', 'swift-rehearsal']
if argv[:1] == ['compose'] and 'ps' in argv and '-aq' in argv:
    print(env('FAKE_REHEARSAL_PS', '')); sys.exit(0)
if argv[:1] == ['compose'] and 'ps' in argv and '-q' in argv:
    print(env('FAKE_WORKER_PS', '')); sys.exit(0)
if argv[:1] == ['compose'] and 'stop' in argv:
    sys.exit(int(env('FAKE_STOP_RC', '0')))
if argv[:1] == ['compose'] and 'exec' in argv and 'postgres' in argv and argv[-1].startswith('SELECT environment'):
    if copy:
        # FAKE_COPY_IDENTITY_LATER: what the copy says from its second read on (the fixture reset's re-check).
        counter = os.environ['CALL_LOG'] + '.copy-identity'
        n = int(open(counter).read() or 0) if os.path.exists(counter) else 0
        open(counter, 'w').write(str(n + 1))
        later = env('FAKE_COPY_IDENTITY_LATER')
        print(later if n > 0 and later else env('FAKE_COPY_IDENTITY', 'staging')); sys.exit(0)
    if env('FAKE_LIVE_FAIL'): sys.exit(1)
    print(env('FAKE_LIVE_IDENTITY', 'staging')); sys.exit(0)
if argv[:1] == ['compose'] and 'exec' in argv and 'postgres' in argv and argv[-1].startswith('SELECT pg_database_size'):
    if copy: sys.exit(5)
    print(env('FAKE_DB_BYTES', str(300 * 1048576))); sys.exit(0)
if argv[:1] == ['compose'] and 'exec' in argv and 'postgres' in argv and argv[-1].startswith('SELECT system_identifier'):
    # Each Postgres cluster's own id: the copy is a separate cluster from the live one.
    if copy:
        print(env('FAKE_COPY_CLUSTER', '7400000000000000002')); sys.exit(int(env('FAKE_COPY_CLUSTER_RC', '0')))
    print(env('FAKE_LIVE_CLUSTER', '7400000000000000001')); sys.exit(0)
if argv[:1] == ['compose'] and 'exec' in argv and 'postgres' in argv and argv[-1].startswith('-- deploy/wall/fixture-fees.sql'):
    if not copy: sys.exit(7)
    print(env('FAKE_FIXTURES', '12 4')); sys.exit(int(env('FAKE_FIXTURES_RC', '0')))
if argv[:1] == ['compose'] and 'up' in argv and 'api-journeys' in argv:
    sys.exit(0)
if argv[:1] == ['compose'] and 'logs' in argv:
    rest = argv[argv.index('logs') + 1:]
    services = [a for i, a in enumerate(rest) if not a.startswith('-') and (i == 0 or rest[i - 1] != '--tail')]
    if services == ['api-journeys']:
        print(env('FAKE_INSTANCE_LOGS', 'tenant wall: enforced role=swift_app_login\nServer listening at http://0.0.0.0:3000'))
    else:
        print(env('FAKE_LOGS', 'api | ready\nworker | ready\napi-journeys | ready'))
    sys.exit(0)
if argv[:1] == ['compose'] and 'run' in argv:
    out = os.environ['JOURNEYS_RESULTS_DIR']
    statuses = json.loads(env('FAKE_RESULTS', '{}'))
    only = next(a for a in argv if a.startswith('--only='))[len('--only='):].split(',')
    objects = json.loads(env('FAKE_RESULT_OBJECTS', '{}'))
    if not env('FAKE_NO_RESULTS'):
        results = [objects.get(j) or {'journeyId': j, 'status': statuses.get(j, 'PASS')} for j in only if statuses.get(j) != 'DROP']
        with open(os.path.join(out, 'journeys-result.json'), 'w') as f:
            json.dump(results, f)
    sys.exit(int(env('FAKE_RUNNER_RC', '0')))
if argv[:1] == ['compose'] and 'exec' in argv and 'node' in argv:
    if argv[argv.index('node') - 1] != 'api-journeys':
        sys.exit(9)
    if '/metrics' in argv[argv.index('-e') + 1]:
        # The instance's own metrics; FAKE_WAITING_ONCE = the first read only (a sample mid-window).
        counter = os.environ['CALL_LOG'] + '.metrics'
        n = int(open(counter).read() or 0) if os.path.exists(counter) else 0
        open(counter, 'w').write(str(n + 1))
        text = env('FAKE_METRICS', os.environ['DEFAULT_METRICS'])
        if n == 0 and env('FAKE_WAITING_ONCE'):
            text = text.replace('swift_db_pool{state="waiting"} 0', 'swift_db_pool{state="waiting"} ' + env('FAKE_WAITING_ONCE'))
        print(text)
        sys.exit(int(env('FAKE_METRICS_RC', '0')))
    for name in argv[argv.index('-e') + 2:]:
        print(f'job {name}: completed')
    sys.exit(int(env('FAKE_JOBS_RC', '0')))
sys.exit(0)
'''

FAKE_REHEARSAL = r'''
import json, os, sys
with open(os.environ['CALL_LOG'], 'a') as log:
    row = {'tool': 'rehearsal.sh', 'argv': sys.argv[1:]}
    if sys.argv[1:2] == ['up']:
        row['results'] = os.environ.get('REHEARSAL_RESULTS_DIR')
    log.write(json.dumps(row) + '\n')
if sys.argv[1:2] == ['up']:
    print('rehearsal: PASSED at ' + sys.argv[2])
    sys.exit(int(os.environ.get('FAKE_REHEARSAL_UP_RC', '0')))
sys.exit(0)
'''


class JourneysHost:
    def __init__(self, case):
        self.tmp = Path(tempfile.mkdtemp(prefix='swift-wall-journeys-'))
        case.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / 'deploy'
        (self.deploy / 'wall').mkdir(parents=True)
        for name in FILES:
            shutil.copy(DEPLOY / name, self.deploy / name)
        for name in ('journeys-on-copy.sh', 'redact-log.py', 'fixture-fees.sql'):
            shutil.copy(DEPLOY / 'wall' / name, self.deploy / 'wall' / name)
        shim(self.deploy / 'wall', 'rehearsal.sh', FAKE_REHEARSAL, python=True)
        self.env_file = self.deploy / '.env'
        self.env_file.write_text('PILOT_ENV=staging\nNODE_ENV=development\nAPI_HOST=api.example.org\n')
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        shim(self.bin, 'docker', FAKE_DOCKER, python=True)
        shim(self.bin, 'sudo', 'echo "{\\"tool\\": \\"sudo\\", \\"argv\\": \\"$*\\"}" >> "$CALL_LOG"\n[ "$1" = -n ] && shift\n'
             'case "$1" in test) [ -n "$FAKE_STORE_EXISTS" ] && exit 0; exit 1 ;; esac\nexit 0')
        shim(self.bin, 'id', 'if [ "$1" = "-u" ]; then echo "${FAKE_UID:-1000}"; elif [ "$1" = "-g" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        shim(self.bin, 'sleep', 'exit 0')
        # Host headroom: `free -m` (available = column 7) and `df -Pm` of Docker's data directory.
        shim(self.bin, 'free', 'echo "               total        used        free      shared  buff/cache   available"\n'
             'echo "Mem:            7951        2650         512          40        4788  ${FAKE_MEM_MB:-5000}"\n'
             'echo "Swap:              0           0           0"')
        shim(self.bin, 'df', '[ "$1" = -Pm ] && [ "$2" = /var/lib/docker ] || exit 2\n'
             'echo "Filesystem 1048576-blocks  Used Available Capacity Mounted on"\n'
             'echo "/dev/vda1  80000 40000 ${FAKE_DISK_MB:-30000} 58% /"')
        self.calls = self.tmp / 'calls.jsonl'
        self.results = self.tmp / 'results'

    def run(self, *args, extra_env=None):
        self.calls.write_text('')
        Path(str(self.calls) + '.metrics').unlink(missing_ok=True)
        Path(str(self.calls) + '.copy-identity').unlink(missing_ok=True)
        env = {'PATH': f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.tmp), 'CALL_LOG': str(self.calls),
               'LIVETEST_ADMIN_PHONE': '+5920400000', 'JOURNEYS_RESULTS_BASE': str(self.results),
               'DEFAULT_METRICS': metrics()}
        env.update(extra_env or {})
        result = subprocess.run(['bash', str(self.deploy / 'wall' / 'journeys-on-copy.sh'), *(args or (SHA,))], env=env,
                                text=True, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
        return result, [json.loads(line) for line in self.calls.read_text().splitlines() if line.strip()]


def index(calls, predicate):
    return next((i for i, c in enumerate(calls) if predicate(c)), -1)


FIXTURE_SQL = DEPLOY / 'wall' / 'fixture-fees.sql'


def is_fixture_reset(call):
    # The statement exactly as the script reads it ($(cat …) drops the final newline).
    return call['tool'] == 'docker' and call['argv'][-1:] == [FIXTURE_SQL.read_text().rstrip('\n')]


def sql_without_comments(text):
    return '\n'.join(line.split('--', 1)[0] for line in text.splitlines())


def journey_partner_phones():
    """The journey roster's partners, read from scripts/livetest/roster.ts: its
    stores (VENDORS, but the SERVICE store JOURNEY_VENDORS leaves out) and its
    movers (MOVERS plus the ones JOURNEY_MOVERS adds)."""
    roster = (REPO / 'scripts' / 'livetest' / 'roster.ts').read_text()
    assert "const JOURNEY_VENDORS = VENDORS.filter((v) => v.id !== 'SV1');" in roster, 'JOURNEY_VENDORS changed: update this reader'
    phones = set()
    for line in roster.splitlines():
        m = re.search(r"\{ id: '([A-Z0-9]+)', phone: '(\+[0-9]+)'", line)
        if not m or m.group(1) == 'SV1':
            continue
        if re.search(r"\btype: '", line) or re.search(r"\bkind: '(rider|driver)'", line):
            phones.add(m.group(2))
    return phones


class JourneysOnCopy(unittest.TestCase):
    def setUp(self):
        self.host = JourneysHost(self)

    def test_the_journeys_pass_on_the_walled_copy_and_the_copy_is_removed(self):
        result, calls = self.host.run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'JOURNEYS PASSED at {SHA}', result.stdout)
        for journey in JOURNEYS.split(','):
            self.assertIn(f'journeys-on-copy: {journey} PASS', result.stdout)
        self.assertNotIn('FAILED', result.stdout + result.stderr)
        # The measurements: every request but the instance's own /metrics reads, the pool
        # through the window, the binding counters (system work never inside a caller's transaction).
        self.assertIn('journeys-on-copy: latency: p95 <= 0.5 s over 120 requests (budget 1 s)', result.stdout)
        self.assertIn('journeys-on-copy: latency: slowest POST /api/v1/auth/verify-otp p95 <= 0.5 s (20 requests)', result.stdout)
        self.assertRegex(result.stdout, r'journeys-on-copy: pool: [1-9][0-9]* samples, open max 5, busy max 1, waiting max 0')
        self.assertIn('journeys-on-copy: binding: nontenant=12, nontenant_system=3, tenant=40', result.stdout)
        up = index(calls, lambda c: c['tool'] == 'rehearsal.sh' and c['argv'] == ['up', SHA])
        stop = index(calls, lambda c: c['tool'] == 'docker' and 'stop' in c['argv'])
        fixtures = index(calls, is_fixture_reset)
        instance = index(calls, lambda c: c['tool'] == 'docker' and 'up' in c['argv'] and 'api-journeys' in c['argv'])
        runner = index(calls, lambda c: c['tool'] == 'docker' and 'run' in c['argv'])
        jobs = index(calls, lambda c: c['tool'] == 'docker' and 'node' in c['argv'] and 'compliance-sample' in c['argv'])
        reads = [i for i, c in enumerate(calls) if c['tool'] == 'docker' and 'node' in c['argv'] and '/metrics' in ' '.join(c['argv'])]
        down = index(calls, lambda c: c['tool'] == 'rehearsal.sh' and c['argv'] == ['down'])
        self.assertTrue(-1 < up < stop < fixtures < instance < runner < jobs < down, (up, stop, fixtures, instance, runner, jobs, down))
        self.assertEqual(down, len(calls) - 1)
        # Sampled from before the journeys; the last read after the jobs; none after the copy goes.
        self.assertGreaterEqual(len(reads), 2)
        self.assertTrue(instance < reads[0] < runner and jobs < reads[-1] < down, (reads, runner, jobs))
        self.assertEqual(calls[stop]['argv'][-1], 'worker')
        self.assertIn(f'--only={JOURNEYS}', calls[runner]['argv'])
        self.assertEqual(calls[jobs]['argv'][-2:], ['compliance-sample', 'expiry-sweep'])
        self.assertIn('verification-jobs', ' '.join(calls[jobs]['argv']))
        # The live staging stack is only READ: its identity, its size and its cluster id
        # (which proves the fixture reset's target is another cluster), nothing else.
        docker = [c['argv'] for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['compose']]
        live = [a for a in docker if a[:2] != ['compose', '-p']]
        self.assertEqual([a[-1] for a in live], ["SELECT environment FROM deployment_identity WHERE id = 'singleton'",
                                                 'SELECT pg_database_size(current_database())',
                                                 'SELECT system_identifier::text FROM pg_control_system()'])
        self.assertTrue(all('exec' in a and 'postgres' in a for a in live))
        self.assertIn('journeys-on-copy: headroom: 5000 MiB memory available, 30000 MiB disk free (database 300 MiB)', result.stdout)
        self.assertIn('before the hold on staging lifts: the live /health and the build-9 smoke', result.stderr)
        for argv in docker:
            if argv[:2] == ['compose', '-p']:
                self.assertEqual(argv[2], 'swift-rehearsal')
                self.assertIn(str(self.host.deploy / 'docker-compose.rehearsal.yml'), argv)
        for argv in (calls[instance]['argv'], calls[runner]['argv']):
            self.assertIn(str(self.host.deploy / 'docker-compose.journeys-copy.yml'), argv)
            self.assertIn('journeys-copy', argv[argv.index('--profile') + 1])

    def test_the_copys_logs_are_kept_redacted_before_the_copy_is_removed(self):
        """15 Oct: the copy failed at boot (FATAL=24) and its logs went with it.
        Now every end keeps the copy's api, worker and api-journeys logs (last
        400 lines each, redacted) in the run's results, BEFORE rehearsal.sh down."""
        instance = ('api-journeys-1  | Failed to start server: Error: FATAL: SMS_RECIPIENT_ALLOWLIST entry 1 is not an E.164 number. Refusing to start.\n'
                    'api-journeys-1  | texting +5926123456 and +447700900123 owner.name@example.gy with token=abc123secretvalue')
        result, calls = self.host.run(extra_env={'FAKE_INSTANCE_LOGS': instance,
                                                 'FAKE_LOGS': 'api-1  | ready postgresql://swift_app_login:pw-fixture-9@postgres/swift'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('JOURNEYS FAILED at step: instance', result.stderr)
        runs = list(self.host.results.glob('copy-*'))
        self.assertEqual(len(runs), 1, runs)
        logs = runs[0] / 'copy-logs'
        self.assertEqual(oct(logs.stat().st_mode & 0o777), '0o700')
        self.assertEqual(sorted(p.name for p in logs.iterdir()), ['api-journeys.log', 'api.log', 'worker.log'])
        saved = ''.join((logs / n).read_text() for n in ('api.log', 'worker.log', 'api-journeys.log'))
        self.assertIn('FATAL: SMS_RECIPIENT_ALLOWLIST entry 1 is not an E.164 number', (logs / 'api-journeys.log').read_text())
        for leak in ('+5926123456', '447700900123', 'owner.name@example.gy', 'abc123secretvalue', 'pw-fixture-9'):
            self.assertNotIn(leak, saved + result.stdout + result.stderr)
        saves = [i for i, c in enumerate(calls) if c['tool'] == 'docker' and 'logs' in c['argv'] and '--tail' in c['argv']]
        self.assertEqual(sorted(calls[i]['argv'][-1] for i in saves), ['api', 'api-journeys', 'worker'])
        for i in saves:
            self.assertEqual(calls[i]['argv'][calls[i]['argv'].index('--tail') + 1], '400')
            self.assertIn(str(self.host.deploy / 'docker-compose.journeys-copy.yml'), calls[i]['argv'])
        down = index(calls, lambda c: c['tool'] == 'rehearsal.sh' and c['argv'] == ['down'])
        self.assertTrue(max(saves) < down, (saves, down))
        err = result.stderr.splitlines()
        at = err.index('journeys-on-copy: the first FATAL lines (redacted):')
        self.assertTrue(err[at + 1].startswith('  api-journeys-1  | Failed to start server: Error: FATAL: SMS_RECIPIENT_ALLOWLIST'), err[at + 1])
        self.assertIn(f"journeys-on-copy: logs: the copy's api, worker and api-journeys logs (last 400 lines each, redacted) are in {logs}", err)

    def test_a_copy_that_does_not_boot_keeps_its_logs_where_the_rehearsal_was_told(self):
        result, calls = self.host.run(extra_env={'FAKE_REHEARSAL_UP_RC': '1', 'FAKE_LOGS': 'api-1  | Error: FATAL: something'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('JOURNEYS FAILED at step: copy', result.stderr)
        runs = list(self.host.results.glob('copy-*'))
        self.assertEqual(len(runs), 1, runs)
        up = next(c for c in calls if c['tool'] == 'rehearsal.sh' and c['argv'][:1] == ['up'])
        self.assertEqual(up['results'], str(runs[0] / 'copy-logs'))
        self.assertTrue((runs[0] / 'copy-logs' / 'api.log').is_file())
        # The rehearsal printed its own FATAL lines for the copy step: not printed twice.
        self.assertNotIn('journeys-on-copy: the first FATAL lines', result.stderr)

    def test_a_passing_run_keeps_the_logs_beside_its_results(self):
        result, _ = self.host.run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        run = next(self.host.results.glob('copy-*'))
        self.assertTrue((run / 'journeys-result.json').is_file())
        self.assertEqual(sorted(p.name for p in (run / 'copy-logs').iterdir()), ['api-journeys.log', 'api.log', 'worker.log'])
        self.assertNotIn('the first FATAL lines', result.stderr)

    def test_a_skip_passes_only_for_the_named_cases_no_staging_copy_can_run(self):
        both = {'CUST-01': skipped('CUST-01', ['multi-vendor delivery-fee agreement'], steps=9),
                'CUST-02': skipped('CUST-02', ['MMG checkout', 'dispute hold'], steps=14)}
        result, _ = self.host.run(extra_env={'FAKE_RESULT_OBJECTS': json.dumps(both)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('journeys-on-copy: CUST-01 PASS (all 9 executed steps passed; not runnable on a staging copy: '
                      'multi-vendor delivery-fee agreement)', result.stdout)
        self.assertIn('journeys-on-copy: CUST-02 PASS (all 14 executed steps passed; not runnable on a staging copy: '
                      'MMG checkout, dispute hold)', result.stdout)
        self.assertIn('JOURNEYS PASSED', result.stdout)

    def test_the_roster_fixture_fees_are_reset_on_the_copy_only_before_the_instance_starts(self):
        """16 Oct: the first copy that booted ran every journey into staging's own
        fee history: the roster partners' trials ended on 8 Oct and billing had
        suspended every one (riders/drivers refused at go-online, stores
        SUSPENDED), 0/8 PASS. On the COPY only, after its worker stops and before
        the journeys instance starts, the roster's fees get a fresh trial; the
        count of rows touched is printed, no personal data."""
        result, calls = self.host.run()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('journeys-on-copy: fixtures: 12 roster weekly fees set to a fresh 14-day trial on the copy, '
                      '4 billing-suspended roster stores reopened (no payment, receipt or ledger row; nothing on live staging)',
                      result.stdout)
        resets = [i for i, c in enumerate(calls) if is_fixture_reset(c)]
        self.assertEqual(len(resets), 1, 'one reset, one statement')
        reset = calls[resets[0]]['argv']
        self.assertEqual(reset[:3], ['compose', '-p', 'swift-rehearsal'])
        self.assertIn(str(self.host.deploy / 'docker-compose.rehearsal.yml'), reset)
        self.assertIn('ON_ERROR_STOP=1', ' '.join(reset))
        # Proved the copy first: both clusters read, then the copy's identity again, then the reset.
        cluster = [i for i, c in enumerate(calls) if c['tool'] == 'docker' and c['argv'][-1:] == ['SELECT system_identifier::text FROM pg_control_system()']]
        self.assertEqual(len(cluster), 2)
        self.assertEqual(sorted(calls[i]['argv'][:2] == ['compose', '-p'] for i in cluster), [False, True])
        identity = [i for i, c in enumerate(calls) if c['tool'] == 'docker' and c['argv'][:2] == ['compose', '-p']
                    and c['argv'][-1].startswith('SELECT environment')]
        stop = index(calls, lambda c: c['tool'] == 'docker' and 'stop' in c['argv'])
        instance = index(calls, lambda c: c['tool'] == 'docker' and 'up' in c['argv'] and 'api-journeys' in c['argv'])
        self.assertTrue(stop < min(cluster) and max(cluster) < identity[-1] < resets[0] < instance, (stop, cluster, identity, resets, instance))

    def test_the_fixture_reset_refuses_any_target_but_the_copy_and_any_doubtful_answer(self):
        cases = [
            ({'FAKE_COPY_CLUSTER': '7400000000000000001'}, 'the fixture reset would reach the live staging cluster, not the copy: nothing was changed'),
            ({'FAKE_COPY_CLUSTER_RC': '1'}, "could not read the copy's and the live cluster ids (the fixture reset needs both)"),
            ({'FAKE_COPY_CLUSTER': ''}, "could not read the copy's and the live cluster ids (the fixture reset needs both)"),
            ({'FAKE_COPY_IDENTITY_LATER': 'production'}, "the fixture reset's target says 'production', not staging: nothing was changed"),
            ({'FAKE_FIXTURES_RC': '3'}, 'the journey roster fixture fees could not be reset on the copy'),
            ({'FAKE_FIXTURES': 'UPDATE 12'}, 'the fixture reset answered unexpectedly'),
        ]
        for env, message in cases:
            with self.subTest(message=message):
                result, calls = self.host.run(extra_env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f'JOURNEYS HOLD: {message}', result.stderr)
                self.assertIn('JOURNEYS FAILED at step: fixtures', result.stderr)
                self.assertNotIn('JOURNEYS PASSED', result.stdout)
                refused_before = 'FAKE_FIXTURES' not in ' '.join(env)
                self.assertEqual(bool([c for c in calls if is_fixture_reset(c)]), not refused_before, calls)
                self.assertFalse([c for c in calls if c['tool'] == 'docker' and 'up' in c['argv'] and 'api-journeys' in c['argv']])
                self.assertEqual(index(calls, lambda c: c['tool'] == 'rehearsal.sh' and c['argv'] == ['down']), len(calls) - 1)

    def test_the_fixture_sql_touches_only_the_journey_roster_fees_and_billing_suspensions(self):
        text = FIXTURE_SQL.read_text()
        self.assertTrue(text.startswith('-- deploy/wall/fixture-fees.sql'))
        sql = sql_without_comments(text)
        # Exactly the journey roster's partners (scripts/livetest/roster.ts), all fictional +5920.
        phones = set(re.findall(r"'(\+[0-9]+)'", sql))
        self.assertEqual(phones, journey_partner_phones())
        self.assertEqual(len(phones), 12)
        self.assertTrue(all(p.startswith('+5920') for p in phones))
        self.assertIn("u.phone LIKE '+5920%'", sql)
        # Refuses by itself on any database that is not staging (a copy of staging says staging).
        self.assertIn("(SELECT d.environment FROM deployment_identity d WHERE d.id = 'singleton') = 'staging'", sql)
        # Writes two tables only, by UPDATE; never inserts, deletes or touches money, ledger or clock tables.
        words = re.findall(r'[A-Za-z_]+', sql.upper())
        for verb in ('INSERT', 'DELETE', 'TRUNCATE', 'ALTER', 'DROP', 'CREATE', 'COPY', 'GRANT', 'MERGE'):
            self.assertNotIn(verb, words)
        self.assertEqual(re.findall(r'\bUPDATE\s+([a-z_"]+)', sql), ['subscriptions', 'vendors'])
        tables = set(re.findall(r'\b(?:FROM|JOIN)\s+([a-z_]+)', sql))
        self.assertEqual(tables, {'users', 'deployment_identity', 'subscriptions', 'riders', 'drivers', 'vendors', 'vendor_owners', 'reset', 'roster', 'fees', 'stores'})
        # A store gets back only what billing took (restoreBillingAccess): other suspensions stay.
        stores = sql[sql.index('UPDATE vendors'):]
        self.assertIn("AND \"suspensionSource\" = 'BILLING'", stores)
        self.assertIn('"acceptingOrders" = ("acceptingOrders" OR "isVerified")', stores)
        # A new partner's trial: TRIAL, 14 days (SubscriptionService activation, TRIAL_DAYS).
        days = re.search(r'export const TRIAL_DAYS = (\d+);', (REPO / 'apps/api/src/modules/subscription/subscription.service.ts').read_text())
        self.assertEqual(sql.count(f"now() + interval '{days.group(1)} days'"), 3)
        self.assertIn("status = 'TRIAL'", sql)
        # Counts only.
        self.assertTrue(sql.rstrip().endswith("(SELECT count(*) FROM reset)::text || ' ' || (SELECT count(*) FROM stores)::text AS touched;"))

    def test_refusals_before_anything_changes(self):
        cases = [
            ({'.env': 'PILOT_ENV=production\nNODE_ENV=production\n'}, 'STAGING host only'),
            ({'.env': 'PILOT_ENV=staging\nNODE_ENV=production\n'}, 'NODE_ENV=production here'),
            ({'.env': 'PILOT_ENV=staging\nNODE_ENV="production"\n'}, 'NODE_ENV=production here'),
            ({'.env': 'PILOT_ENV=staging\nNODE_ENV=development\nexport NODE_ENV=production\n'}, 'NODE_ENV=production here'),
            ({'.env': 'PILOT_ENV=staging\n  NODE_ENV = production # later\n'}, 'NODE_ENV=production here'),
            # Room for the copy beside the live stack the reviewers use.
            ({'FAKE_MEM_MB': '1500'}, 'only 1500 MiB of memory available; the copy needs 2048 MiB'),
            ({'FAKE_MEM_MB': 'n/a'}, "could not read this host's available memory"),
            ({'FAKE_DB_BYTES': str(20000 * 1048576)}, 'only 30000 MiB of disk free for Docker; the copy needs 42048 MiB'),
            ({'FAKE_DISK_MB': '2500', 'FAKE_DB_BYTES': str(300 * 1048576)}, 'the copy needs 2648 MiB'),
            ({'FAKE_DB_BYTES': 'ERROR'}, "could not read the database's size"),
            ({'.env': 'NODE_ENV=development\n'}, 'STAGING host only'),
            ({'LIVETEST_ADMIN_PHONE': '+5926001234'}, "fictional seed admin"),
            ({'LIVETEST_ADMIN_PHONE': ''}, "fictional seed admin"),
            ({'FAKE_LIVE_IDENTITY': 'production'}, "says 'production', not staging"),
            ({'FAKE_LIVE_FAIL': '1'}, 'could not read this host'),
            ({'FAKE_REHEARSAL_PS': 'old-container'}, 'already there'),
            ({'FAKE_STORE_EXISTS': '1'}, 'already exists'),
            ({'DOCKER_HOST': 'tcp://elsewhere:2375'}, 'DOCKER_HOST is set'),
            ({'FAKE_UID': '0'}, 'not root'),
        ]
        for env, message in cases:
            with self.subTest(message=message, env=env):
                env = dict(env)
                if '.env' in env:
                    self.host.env_file.write_text(env.pop('.env'))
                result, calls = self.host.run(extra_env=env)
                self.host.env_file.write_text('PILOT_ENV=staging\nNODE_ENV=development\nAPI_HOST=api.example.org\n')
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual([c for c in calls if c['tool'] == 'rehearsal.sh'], [], 'nothing built, nothing removed')
                self.assertNotIn('JOURNEYS FAILED', result.stderr)
                self.assertFalse([c for c in calls if c['tool'] == 'docker' and ('up' in c['argv'] or 'run' in c['argv'])])
        result, calls = self.host.run('main')
        self.assertIn('full 40-character SHA', result.stderr)
        self.assertFalse([c for c in calls if c['tool'] == 'rehearsal.sh'])

    def test_any_failed_step_fails_the_run_and_still_removes_the_copy(self):
        cases = [
            ({'FAKE_REHEARSAL_UP_RC': '1'}, 'copy', 'did not pass'),
            ({'FAKE_COPY_IDENTITY': 'production'}, 'copy', "the copy says 'production'"),
            ({'FAKE_INSTANCE_LOGS': 'tenant wall: enforced role=swift_app_login'}, 'instance', 'did not attest the wall and listen'),
            ({'FAKE_INSTANCE_LOGS': 'tenant wall: bypassed(SUPERUSER)\nServer listening'}, 'instance', 'did not attest the wall and listen'),
            ({'FAKE_STOP_RC': '1'}, 'instance', "the copy's worker could not be stopped"),
            ({'FAKE_WORKER_PS': 'worker-id'}, 'instance', 'must be the only queue consumer'),
            ({'FAKE_RESULTS': json.dumps({'RIDE-02': 'SKIP'})}, 'journeys', 'a journey did not PASS'),
            ({'FAKE_RESULTS': json.dumps({'CUST-02': 'FAIL'})}, 'journeys', 'a journey did not PASS'),
            ({'FAKE_RESULTS': json.dumps({'VEND-05': 'DROP'})}, 'journeys', 'a journey did not PASS'),
            ({'FAKE_NO_RESULTS': '1'}, 'journeys', 'a journey did not PASS'),
            # A case no list names; a named case on another journey; the whole journey skipped;
            # no step ran; a step that did not pass; a device-gate entry only.
            ({'FAKE_RESULT_OBJECTS': json.dumps({'CUST-02': skipped('CUST-02', ['MMG checkout', 'convert to pickup'])})},
             'journeys', 'CUST-02 SKIP not accepted'),
            ({'FAKE_RESULT_OBJECTS': json.dumps({'VEND-02': skipped('VEND-02', ['MMG checkout'])})}, 'journeys', 'VEND-02 SKIP not accepted'),
            ({'FAKE_RESULT_OBJECTS': json.dumps({'CUST-02': skipped('CUST-02', ['MMG checkout'], reason='no store could be made here')})},
             'journeys', 'CUST-02 SKIP not accepted (no store could be made here)'),
            ({'FAKE_RESULT_OBJECTS': json.dumps({'CUST-02': skipped('CUST-02', ['MMG checkout'], steps=0)})}, 'journeys', 'CUST-02 SKIP not accepted'),
            ({'FAKE_RESULT_OBJECTS': json.dumps({'CUST-02': {**skipped('CUST-02', ['MMG checkout']),
                                                            'steps': [{'name': 'x', 'ok': False, 'detail': ''}]}})},
             'journeys', 'CUST-02 SKIP not accepted'),
            ({'FAKE_RESULT_OBJECTS': json.dumps({'CUST-02': skipped('CUST-02', ['MMG checkout'], gate='device')})}, 'journeys', 'CUST-02 SKIP not accepted'),
            ({'FAKE_RUNNER_RC': '2'}, 'journeys', 'ended with exit 2'),
            ({'FAKE_JOBS_RC': '1'}, 'jobs', 'did not complete'),
            ({'FAKE_METRICS_RC': '2'}, 'measure', "could not read the journeys instance's metrics"),
            ({'FAKE_METRICS': metrics(http=histogram('/api/v1/cart', (0, 0, 10, 40, 80, 90, 98, 100, 100)))}, 'measure',
             'p95 2.5 s is over the 1 s budget'),
            ({'FAKE_METRICS': metrics(http=histogram('/api/v1/cart', (5, 5, 5, 5, 5, 5, 5, 5, 5)))}, 'measure',
             'only 5 requests measured (at least 20)'),
            ({'FAKE_METRICS': metrics(http=[])}, 'measure', 'only 0 requests measured'),
            ({'FAKE_METRICS': metrics(pool=(5, 5, 0, 3))}, 'measure', 'queries waited for a pool connection (max 3)'),
            # A wait seen by a sample mid-window only (the last read is calm again).
            ({'FAKE_WAITING_ONCE': '2'}, 'measure', 'queries waited for a pool connection (max 2)'),
            ({'FAKE_METRICS': metrics(pool=None)}, 'measure', 'the pool was never measured'),
            ({'FAKE_METRICS': metrics(kinds={'tenant': 40, 'nontenant': 12, 'nontenant_system_in_tx': 1})}, 'measure',
             "system work ran inside a caller's transaction (nontenant_system_in_tx=1)"),
            ({'FAKE_METRICS': metrics(kinds={'tenant': 40})}, 'measure', 'no nontenant binding ran'),
            ({'FAKE_METRICS': metrics(kinds={'nontenant': 12})}, 'measure', 'no tenant binding ran'),
            ({'FAKE_LOGS': 'worker | FATAL: boom'}, 'logs', 'TenantInUnboundTransactionError or FATAL'),
            ({'FAKE_LOGS': 'api | TenantInUnboundTransactionError: x'}, 'logs', 'TenantInUnboundTransactionError or FATAL'),
        ]
        for env, step, message in cases:
            with self.subTest(message=message, env=env):
                result, calls = self.host.run(extra_env=env)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(message, result.stdout + result.stderr)
                self.assertIn(f'JOURNEYS FAILED at step: {step}', result.stderr)
                self.assertNotIn('JOURNEYS PASSED', result.stdout)
                self.assertEqual(calls[-1], {'tool': 'rehearsal.sh', 'argv': ['down']})

    def test_the_journey_list_is_the_ruling_and_exists_in_the_suite(self):
        """An OTP sign-in, the vendor route, rider and driver profiles, the dispatch offer, cart to checkout."""
        script = (DEPLOY / 'wall' / 'journeys-on-copy.sh').read_text()
        self.assertIn(f'JOURNEYS={JOURNEYS}\n', script)
        self.assertIn('JOBS="compliance-sample expiry-sweep"\n', script)
        self.assertIn(f"TARGET_SKIPS='{TARGET_SKIPS}'\n", script)
        suite = ''.join(p.read_text() for p in (REPO / 'scripts' / 'livetest' / 'journeys').glob('*.ts'))
        for journey in JOURNEYS.split(','):
            self.assertIn(f"id: '{journey}'", suite)
        # Each allowed target skip is a case that journey really leaves to the target, and the
        # runner's own wording of a SKIP whose executed steps all passed is what the script reads.
        for entry in TARGET_SKIPS.split('|'):
            jid, case = entry.split(':', 1)
            body = suite[suite.index(f"id: '{jid}'"):]
            nxt = re.search(r"\n\s*id: '[A-Z]+-[0-9]+'", body[1:])
            body = body[:nxt.start() + 1] if nxt else body
            self.assertIn(f"rec.skipCase('{case}'", body, entry)
        runner = (REPO / 'scripts' / 'livetest' / 'journey.ts').read_text()
        self.assertIn("reason = `every executed step passed, but these cases cannot run on this target:", runner)
        self.assertIn("} else if (rec.skipped.some((c) => c.gate === 'target')) {\n    status = 'SKIP';", runner)
        queue = (REPO / 'apps' / 'api' / 'src' / 'jobs' / 'queue.ts').read_text()
        self.assertIn("VERIFICATION: 'verification-jobs'", queue)
        for job in ('compliance-sample', 'expiry-sweep'):
            self.assertIn(f"job.name === '{job}'", queue)


class JourneysLayerRendered(unittest.TestCase):
    def test_the_instance_and_runner_live_only_on_the_copys_internal_network_with_its_secrets(self):
        with tempfile.TemporaryDirectory() as tmp:
            here = Path(tmp) / 'deploy'
            here.mkdir()
            for name in FILES:
                shutil.copy(DEPLOY / name, here / name)
            (here / '.env').write_text('NODE_ENV=development\nPILOT_ENV=staging\nAPI_HOST=api.example.org\n')
            argv = ['docker', 'compose', '-p', 'swift-rehearsal', '--project-directory', str(here)]
            for name in FILES:
                argv += ['-f', str(here / name)]
            result = subprocess.run(argv + ['--profile', 'journeys-copy', 'config', '--format', 'json'], text=True,
                                    capture_output=True, timeout=60,
                                    env={'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', tmp)})
            if result.returncode != 0 and ('unknown' in result.stderr.lower() or 'not found' in result.stderr.lower()):
                raise unittest.SkipTest(f'docker compose cannot render here: {result.stderr.strip()[:120]}')
            self.assertEqual(result.returncode, 0, result.stderr[:600])
            model = json.loads(result.stdout)
        self.assertEqual(model['name'], 'swift-rehearsal')
        self.assertEqual(model['networks'], {'private': {'name': 'swift-rehearsal-private', 'ipam': {}, 'internal': True}})
        instance, runner = model['services']['api-journeys'], model['services']['journeys-copy']
        for service in (instance, runner):
            self.assertEqual(list(service['networks']), ['private'])
            self.assertFalse(service.get('ports'))
        # Uploads go to a store that dies with the container, never a volume or the live bucket.
        self.assertEqual(instance['tmpfs'], ['/srv/swift/uploads:uid=1000,gid=1000,mode=0700'])
        self.assertFalse([v for v in instance['volumes'] if v['type'] == 'volume'])
        binds = [(v['source'], v['target']) for v in instance['volumes'] if v['type'] == 'bind']
        self.assertEqual(binds, [('/run/swift-rehearsal-secrets', '/run/secrets'), ('/dev/null', '/run/secrets/POSTGRES_PASSWORD')])
        env = instance['environment']
        for name, value in (('DEV_OTP_BYPASS', '1'), ('TEST_CONTROL_ENABLED', '1'), ('TENANT_RLS_BIND', '1'),
                            ('TENANT_UNSCOPED_ACCESS', 'deny'), ('DATABASE_URL_FILE', '/run/secrets/DATABASE_URL'),
                            ('SYSTEM_DATABASE_URL_FILE', '/run/secrets/SYSTEM_DATABASE_URL'), ('RUN_WORKERS', '1'),
                            ('METRICS_TOKEN_FILE', '/run/secrets/METRICS_TOKEN'),
                            ('STORAGE_PROVIDER', 'local'), ('STORAGE_ALLOW_LOCAL', '1'), ('UPLOAD_DIR', '/srv/swift/uploads'),
                            ('POSTGRES_PASSWORD_FILE', ''), ('POSTGRES_USER', ''), ('POSTGRES_HOST', ''),
                            ('TENANT_WALL_EXPAND_ATTESTED', ''), ('NOTIFICATION_PROVIDER', 'dev'), ('EMAIL_PROVIDER', 'dev'),
                            ('PUSH_PROVIDER', 'dev')):
            with self.subTest(name=name):
                self.assertEqual(env.get(name), value)
        self.assertEqual(runner['environment']['LIVETEST_BASE_URL'], 'http://api-journeys:3000')
        self.assertEqual(runner['environment']['LIVETEST_EXPECT_ENVIRONMENT'], 'staging')
        self.assertTrue(runner['read_only'])
        for service in model['services'].values():
            sources = [v['source'] for v in service.get('volumes', []) if v['type'] == 'bind']
            self.assertNotIn('/run/swift-secrets', sources)
        # Nothing public: Caddy, the website and the console stay out.
        self.assertFalse({'caddy', 'web', 'admin'} & set(model['services']))


if __name__ == '__main__':
    unittest.main()
