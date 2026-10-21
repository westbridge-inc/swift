"""deploy/wall/phase-c.sh against shims: the coordinator's Phase C checks on a
fake production host. No docker, database, sudo or network is reached: every
tool the script calls is a shim answering from environment knobs, and each
call is logged so the tests can prove the script only reads."""
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

DEPLOY = Path(__file__).resolve().parents[1]

FAKE_DOCKER = r'''#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
with open(os.environ['PHASE_C_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'docker', 'argv': argv}) + '\n')
k = lambda name, default='': os.environ.get('FAKE_' + name, default)
text = ' '.join(argv)
def out(value, code=0):
    if value:
        print(value)
    sys.exit(code)
if argv[:2] == ['context', 'show']:
    out(k('CONTEXT', 'default'))
if argv[:2] == ['image', 'inspect']:
    sys.exit(0 if k('IMAGE', '1') == '1' else 1)
if argv[:1] == ['ps'] and 'swift-rehearsal' in text:
    out('\n'.join('leftover%d' % i for i in range(int(k('REH_CONTAINERS', '0')))))
if argv[:2] == ['volume', 'ls']:
    out('\n'.join('vol%d' % i for i in range(int(k('REH_VOLUMES', '0')))))
if argv[:1] == ['inspect'] and argv[1:3] == ['-f', '{{.State.StartedAt}}']:
    out(k('STARTED', '2026-10-21T00:00:00.123456789Z'))
if argv[:1] == ['inspect'] and '.Config.Env' in text:
    out(k('ENV_' + argv[-1].upper(), 'DATABASE_URL_FILE=/run/secrets/a\nSYSTEM_DATABASE_URL_FILE=/run/secrets/b\nPOSTGRES_PASSWORD_FILE='))
if argv[:1] == ['inspect']:
    out('\n'.join('/swift-%s-1 2026-10-21T00:00:00Z restarts=0' % c for c in k('LIVE', 'api worker postgres').split()))
if argv[:1] == ['logs']:
    if argv[1:3] != ['--since', k('STARTED', '2026-10-21T00:00:00.123456789Z')]:
        out('', 6)
    print(k('BOOT', 'tenant wall: enforced role=swift_app_login\nowner wall: inert (OWNER_RLS_BIND off, login not walled)'))
    if k('BIG_LOG') == '1':  # the boot lines come first, then far more than one pipe buffer of later log
        sys.stdout.write(('{"level":30,"msg":"request completed"}\n') * 20000)
    sys.exit(0)
if argv[:1] == ['compose']:
    if 'ps' in argv and '-q' in argv:
        service = argv[-1] if argv[-1] in ('api', 'worker') else None
        if service:
            out(service if service in k('RUNNING', 'api worker').split() else '')
        out(' '.join(k('LIVE', 'api worker postgres').split()))
    if 'exec' in argv and 'api' in argv:
        sys.exit(0 if k('HEALTH', '1') == '1' else 1)
    if 'exec' in argv and 'postgres' in argv:
        # Read-only from the session's start (PGOPTIONS), never a SET inside the one -c transaction.
        if 'PGOPTIONS="-c default_transaction_read_only=on"' not in text or 'SET default_transaction_read_only' in text:
            out('', 3)
        if 'deployment_identity' in text:
            out(k('IDENTITY', 'production'))
        if 'swift_app_login' in text:
            out(k('LOGINS', '0'))
        if 'swift_owner_wall' in text:
            out(k('OWNER_WALL_MEMBERS', '0'))
        if 'pg_database_size' in text:
            out(k('DB_BYTES', str(1024 * 1048576)))
        out('', 4)
sys.exit(5)
'''


def shim(bin_dir, name, body):
    path = bin_dir / name
    path.write_text(body if body.startswith('#!') else '#!/bin/sh\n' + body + '\n')
    path.chmod(0o755)


class PhaseC(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix='swift-phase-c-'))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.root = self.tmp / 'opt-swift'
        (self.root / 'deploy' / 'wall').mkdir(parents=True)
        shutil.copy(DEPLOY / 'wall' / 'phase-c.sh', self.root / 'deploy' / 'wall' / 'phase-c.sh')
        (self.root / 'deploy' / 'docker-compose.yml').write_text('services: {}\n')
        shim(self.root / 'deploy', 'rls-logins.sh', 'echo "{\\"status\\": \\"${FAKE_ROLES:-roles_hold}\\"}"')
        git = ['git', '-C', str(self.root), '-c', 'user.email=t@example.invalid', '-c', 'user.name=t']
        subprocess.run(git + ['init', '-q'], check=True)
        (self.root / '.gitignore').write_text('deploy/.env\n')
        subprocess.run(git + ['add', '-A'], check=True)
        subprocess.run(git + ['commit', '-qm', 'fixture'], check=True)
        self.sha = subprocess.run(git + ['rev-parse', 'HEAD'], capture_output=True, text=True, check=True).stdout.strip()
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        self.log = self.tmp / 'calls.jsonl'
        shim(self.bin, 'docker', FAKE_DOCKER)
        shim(self.bin, 'sudo', 'echo "{\\"tool\\": \\"sudo\\", \\"argv\\": \\"$*\\"}" >> "$PHASE_C_LOG"\n'
                               '[ "$2" = true ] && exit "${FAKE_SUDO:-0}"\n'
                               'case "$*" in *credstore*) exit "${FAKE_STORE_LEFT:-1}" ;; *swift-rehearsal-secrets*) exit "${FAKE_SECRETS_LEFT:-1}" ;; esac\nexit 1')
        shim(self.bin, 'pgrep', 'exit "${FAKE_PGREP:-1}"')
        shim(self.bin, 'systemctl', 'echo "${FAKE_TIMERS:-Tue 05:15 swift-backup-hourly.timer swift-backup.service}"')
        shim(self.bin, 'df', 'echo "Filesystem 1M-blocks Used Available Capacity Mounted"; echo "/dev/vda1 80000 40000 ${FAKE_DISK_FREE:-30000} 50% /"')
        self.meminfo = self.tmp / 'meminfo'

    def run_step(self, step, env_text, sha=None, **knobs):
        (self.root / 'deploy' / '.env').write_text(env_text)
        self.meminfo.write_text('MemTotal: 8000000 kB\nMemAvailable: %s kB\n' % knobs.pop('mem_kb', 4194304))
        env = {'PATH': f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.tmp), 'PHASE_C_LOG': str(self.log),
               'PHASE_C_MEMINFO': str(self.meminfo)}
        env.update({'FAKE_' + key.upper(): str(value) for key, value in knobs.items()})
        result = subprocess.run(['bash', str(self.root / 'deploy' / 'wall' / 'phase-c.sh'), step, sha or self.sha],
                                text=True, capture_output=True, timeout=120, env=env, stdin=subprocess.DEVNULL)
        calls = [json.loads(line) for line in self.log.read_text().splitlines()] if self.log.exists() else []
        return result, calls

    def holds(self, result):
        return [line[6:] for line in result.stdout.splitlines() if line.startswith('HOLD  ')]

    # ── preflight ──
    def test_a_clean_host_passes_preflight_and_only_reads(self):
        result, calls = self.run_step('preflight', 'PILOT_ENV=production\nAPI_HOST=api.example.invalid\n')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('PHASE-C PREFLIGHT OK', result.stdout)
        self.assertEqual(self.holds(result), [])
        for line in ('deployment identity production', 'runtime logins 0', 'no OWNER_RLS_BIND line',
                     'no database role is a member of swift_owner_wall', 'memory available 4096 MiB',
                     'docker disk free 30000 MiB (needs 2 x database + 2048 = 4096)', "this host's API answers /health 200"):
            self.assertIn(line, result.stdout)
        sql = [c for c in calls if c['tool'] == 'docker' and 'postgres' in c['argv']]
        self.assertTrue(sql)
        self.assertTrue(all('PGOPTIONS="-c default_transaction_read_only=on"' in ' '.join(c['argv']) for c in sql))
        self.assertFalse([c for c in calls if c['tool'] == 'docker' and set(c['argv']) & {'up', 'down', 'rm', 'stop', 'restart', 'kill'}])
        self.assertFalse((self.tmp / 'phase-c-live-before.txt').exists())

    def test_every_preflight_check_holds_on_its_own(self):
        base = 'PILOT_ENV=production\n'
        cases = [
            (base, {'context': 'remote'}, "docker's context is not this host's own daemon"),
            (base, {'sudo': 1}, 'sudo -n needs a password'),
            (base, {'identity': 'staging'}, "deployment identity is 'staging', not production"),
            (base, {'image': 0}, 'is missing (pilot-up builds it'),
            (base, {'logins': 2}, 'runtime logins: 2 (expected 0 before Phase C)'),
            (base + 'TENANT_RLS_BIND=1\n', {}, 'deploy/.env already sets TENANT_RLS_BIND'),
            (base + 'OWNER_RLS_BIND=1\n', {}, 'deploy/.env sets OWNER_RLS_BIND: the owner wall is not part of Phase C'),
            (base, {'owner_wall_members': 1}, '1 database role(s) are members of swift_owner_wall'),
            (base, {'pgrep': 0}, 'a rehearsal or journeys run is alive'),
            (base, {'reh_containers': 2}, 'swift-rehearsal leftovers: containers=2 volumes=0'),
            (base, {'reh_volumes': 1}, 'swift-rehearsal leftovers: containers=0 volumes=1'),
            (base, {'store_left': 0}, "the rehearsal's encrypted store is still there"),
            (base, {'secrets_left': 0}, "the rehearsal's secrets directory is still there"),
            (base, {'mem_kb': 1048576}, 'memory available 1024 MiB is under the floor 2048 MiB'),
            (base, {'disk_free': 3000, 'db_bytes': 1024 * 1048576}, 'docker disk free 3000 MiB is under 2 x database + 2048 = 4096 MiB'),
            (base, {'timers': 'none'}, 'the hourly backup timer is not listed'),
            (base, {'health': 0}, "this host's API does not answer /health 200"),
        ]
        for env_text, knobs, message in cases:
            with self.subTest(message=message):
                result, _ = self.run_step('preflight', env_text, **knobs)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, self.holds(result)[0] if len(self.holds(result)) == 1 else '\n'.join(self.holds(result)))
                self.assertEqual(len(self.holds(result)), 1, self.holds(result))
                self.assertIn('PHASE-C PREFLIGHT HOLD: 1 check(s)', result.stdout)

    def test_the_wrong_checkout_holds_and_bad_input_is_refused(self):
        result, _ = self.run_step('preflight', 'PILOT_ENV=production\n', sha='0' * 40)
        self.assertEqual(result.returncode, 1)
        self.assertIn('deployed checkout is not at the approved sha 00000000', result.stdout)
        (self.root / 'stray.txt').write_text('x')
        result, _ = self.run_step('preflight', 'PILOT_ENV=production\n')
        self.assertIn('deployed checkout has local changes', result.stdout)
        for args in (['preflight', 'abc'], ['launch', self.sha], ['preflight']):
            with self.subTest(args=args):
                result = subprocess.run(['bash', str(self.root / 'deploy' / 'wall' / 'phase-c.sh'), *args], text=True,
                                        capture_output=True, timeout=60, env={'PATH': '/usr/bin:/bin', 'HOME': str(self.tmp)})
                self.assertEqual(result.returncode, 2)

    # ── snapshot + proof ──
    def test_the_proof_needs_the_before_record_and_an_unchanged_live_stack(self):
        result, _ = self.run_step('proof', 'PILOT_ENV=production\n')
        self.assertIn('no BEFORE record', result.stdout)
        result, _ = self.run_step('snapshot', 'PILOT_ENV=production\n')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('BEFORE: 3 live containers recorded', result.stdout)
        before = self.tmp / 'phase-c-live-before.txt'
        self.assertEqual(oct(before.stat().st_mode & 0o777), '0o600')
        result, _ = self.run_step('proof', 'PILOT_ENV=production\n')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn('live containers unchanged since the BEFORE record', result.stdout)
        self.assertIn('PHASE-C PROOF OK', result.stdout)
        result, _ = self.run_step('proof', 'PILOT_ENV=production\n', live='api worker postgres caddy')
        self.assertIn('the live containers changed since the BEFORE record', self.holds(result))
        result, _ = self.run_step('proof', 'PILOT_ENV=production\n', reh_containers=1, store_left=0)
        self.assertEqual(len(self.holds(result)), 2)

    # ── verify ──
    def test_verify_wants_the_contract_posture_the_roles_and_both_boot_lines(self):
        good = 'PILOT_ENV=production\nTENANT_RLS_BIND=1\nTENANT_UNSCOPED_ACCESS=deny\n'
        result, _ = self.run_step('verify', good, logins=2)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        for line in ('TENANT_RLS_BIND=1 (the contract posture)', 'the least-privilege logins hold their contract',
                     'api runs on the two least-privilege logins', "worker attested 'tenant wall: enforced'",
                     "api attested 'owner wall: inert'", 'PHASE-C VERIFY OK'):
            self.assertIn(line, result.stdout)
        cases = [
            ('PILOT_ENV=production\nTENANT_UNSCOPED_ACCESS=deny\n', {}, 'deploy/.env does not set TENANT_RLS_BIND=1'),
            ('PILOT_ENV=production\nTENANT_RLS_BIND=1\nTENANT_UNSCOPED_ACCESS=log\n', {}, 'does not set TENANT_UNSCOPED_ACCESS=deny'),
            (good + 'TENANT_WALL_EXPAND_ATTESTED=1\n', {}, 'still declares the wall-less expand posture'),
            (good + 'OWNER_RLS_BIND=1\n', {}, 'the owner wall is not part of Phase C'),
            (good, {'owner_wall_members': 1}, 'members of swift_owner_wall'),
            (good, {'roles': 'hold'}, 'do not hold their contract'),
            (good, {'running': 'api'}, 'worker is not running'),
            (good, {'env_api': 'DATABASE_URL_FILE=/run/secrets/a\nPOSTGRES_PASSWORD_FILE=/run/secrets/p'}, 'api has no SYSTEM_DATABASE_URL_FILE'),
            (good, {'boot': 'owner wall: inert (OWNER_RLS_BIND off, login not walled)'}, "has no 'tenant wall: enforced' boot line"),
            (good, {'boot': 'tenant wall: enforced role=swift_app_login'}, "has no 'owner wall: inert' boot line"),
        ]
        for env_text, knobs, message in cases:
            with self.subTest(message=message):
                result, _ = self.run_step('verify', env_text, **knobs)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertIn(message, '\n'.join(self.holds(result)))
        result, _ = self.run_step('verify', good, env_api='DATABASE_URL_FILE=/run/secrets/a\nSYSTEM_DATABASE_URL_FILE=/run/secrets/b\nPOSTGRES_PASSWORD_FILE=/run/secrets/p')
        self.assertIn("api still carries the owner's password setting", self.holds(result))
        self.assertNotIn('/run/secrets/p', result.stdout)

    def test_verify_reads_the_whole_boot_log_since_start_without_a_pipe(self):
        """[#1967 REVIEW-F S3-1] A healthy stack whose log since start is far longer than a pipe buffer (the boot lines, then
        ~760 KB of later log) still attests both lines: no SIGPIPE false HOLD under pipefail, no fixed --tail."""
        good = 'PILOT_ENV=production\nTENANT_RLS_BIND=1\nTENANT_UNSCOPED_ACCESS=deny\n'
        result, calls = self.run_step('verify', good, logins=2, big_log=1)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("worker attested 'tenant wall: enforced'", result.stdout)
        self.assertIn("api attested 'owner wall: inert'", result.stdout)
        logs = [c['argv'] for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['logs']]
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(a[1:3] == ['--since', '2026-10-21T00:00:00.123456789Z'] and '--tail' not in a for a in logs), logs)

    def test_the_before_record_is_never_readable_by_others_even_for_an_instant(self):
        """[#1967 REVIEW-F S4-1] The BEFORE record is created under umask 077, not written world-readable then chmod-ed."""
        script = (self.root / 'deploy' / 'wall' / 'phase-c.sh').read_text()
        self.assertIn('( umask 077 && printf', script)
        result, _ = self.run_step('snapshot', 'PILOT_ENV=production\n')
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertEqual(oct((self.tmp / 'phase-c-live-before.txt').stat().st_mode & 0o777), '0o600')


if __name__ == '__main__':
    unittest.main()
