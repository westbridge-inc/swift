"""[TA-S0-003 · R2] The operator adapter (deploy/wall/operator.py through
deploy/rls-logins.sh), run for real against shims: a fake `docker` that plays
the postgres container (the census, CREATE ROLE, and a password check against
the SCRAM verifier it was given), the REAL deploy/swift-secrets store script
over a fake `systemd-creds` (encrypt = copy), and fake `sudo`/`id`. Every shim
records its argv and environment, so the tests can prove no credential ever
travels outside stdin. Nothing here needs root, Docker or a database; the
real PG16 run is the lane's end-to-end evidence.
"""
import base64
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
WRAPPER = DEPLOY / 'rls-logins.sh'
TENANT_RLS = DEPLOY.parent / 'apps' / 'api' / 'src' / 'lib' / 'tenant-rls.ts'

_spec = importlib.util.spec_from_file_location('wall_operator', DEPLOY / 'wall' / 'operator.py')
operator = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(operator)

APP, SYSTEM = 'swift_app_login', 'swift_system_login'

# The fake postgres container. State lives in $FAKE_STATE (JSON): the catalogue
# and, per created role, its parents and the verifier CREATE ROLE was given.
FAKE_DOCKER = r'''#!/usr/bin/env python3
import base64, hashlib, hmac, json, os, re, sys
argv = sys.argv[1:]
stdin = '' if sys.stdin.isatty() else sys.stdin.read()
cfg = json.load(open(CONFIG))
with open(cfg['calls'], 'a') as log:
    log.write(json.dumps({'tool': 'docker', 'argv': argv, 'env': dict(os.environ), 'stdin_bytes': len(stdin)}) + '\n')
if argv[:2] == ['context', 'show']:
    print(cfg.get('FAKE_CONTEXT', 'default')); sys.exit(0)
state_path = cfg['state']
state = json.load(open(state_path))
i = argv.index('exec')
assert argv[i:i + 6] == ['exec', '-T', 'postgres', 'sh', '-c', argv[i + 5]], argv
script, args = argv[i + 5], argv[i + 7:]
if 'POSTGRES_PASSWORD_FILE' in script:          # the migration owner's psql
    if 'ownershipDigest' in stdin:              # census.sql
        cat = dict(state['catalogue'])
        cat['roles'] = {}
        for name, role in state['roles'].items():
            cat['roles'][name] = {'login': True, 'inherit': True, 'superuser': False, 'bypassrls': False,
                                  'createdb': False, 'createrole': False, 'replication': False,
                                  'parents': role['parents'], 'reachable': role['parents'], 'adminMemberships': 0,
                                  'ownedObjects': 0, 'directGrants': 0, 'settings': [], 'memberCount': 0}
        print(json.dumps(cat)); sys.exit(0)
    if 'CREATE ROLE' in stdin:
        if cfg.get('FAKE_CREATE_FAILS'):
            sys.exit(3)
        lines = [line for line in stdin.splitlines() if line.strip()]
        assert lines[0] == 'BEGIN;' and lines[-1] == 'COMMIT;', lines
        name = re.search(r'CREATE ROLE (\w+) ', stdin).group(1)
        verifier = re.search(r"PASSWORD '([^']+)'", stdin).group(1)
        parents = re.findall(r'GRANT (\w+) TO ' + name + ';', stdin)
        state['roles'][name] = {'parents': sorted(parents), 'verifier': verifier, 'stdin': stdin}
        json.dump(state, open(state_path, 'w')); sys.exit(0)
    sys.exit(4)
if 'PGPASSFILE' in script:                       # a login's own new connection
    login, sql = args[0], args[1]
    if cfg.get('FAKE_CONNECT_DOWN'):
        sys.stderr.write('psql: error: connection to server failed: could not connect\n'); sys.exit(2)
    host, port, db, user, password = stdin.rstrip('\n').split(':', 4)
    role = state['roles'].get(login)
    def ok(verifier):
        m = re.fullmatch(r'SCRAM-SHA-256\$(\d+):([^$]+)\$([^:]+):(.+)', verifier)
        salted = hashlib.pbkdf2_hmac('sha256', password.encode(), base64.b64decode(m.group(2)), int(m.group(1)))
        stored = hashlib.sha256(hmac.new(salted, b'Client Key', 'sha256').digest()).digest()
        return base64.b64encode(stored).decode() == m.group(3)
    if not cfg.get('FAKE_TRUST') and (role is None or user != login or not ok(role['verifier'])):
        sys.stderr.write('psql: error: FATAL:  password authentication failed for user "%s"\n' % login); sys.exit(2)
    facts = {'sessionUser': login, 'currentUser': login, 'database': db,
             'requestWallEnforced': login == 'swift_app_login', 'systemCapabilityMember': login == 'swift_system_login'}
    facts.update(json.loads(cfg.get('FAKE_FACTS', '{}')).get(login, {}))
    print(json.dumps(facts)); sys.exit(0)
sys.exit(5)
'''

FAKE_SUDO = r'''#!/usr/bin/env python3
import json, os, sys
with open(json.load(open(CONFIG))['calls'], 'a') as log:
    log.write(json.dumps({'tool': 'sudo', 'argv': sys.argv[1:], 'env': dict(os.environ)}) + '\n')
argv = sys.argv[1:]
if argv[:1] == ['-n']:
    argv = argv[1:]
os.environ['FAKE_UID'] = '0'
os.execvp(argv[0], argv)
'''

FAKE_ID = '#!/bin/sh\nif [ "$1" = "-u" ]; then echo "${FAKE_UID:-1000}"; else exec /usr/bin/id "$@"; fi\n'

FAKE_CREDS = r'''#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
with open(json.load(open(CONFIG))['calls'], 'a') as log:
    log.write(json.dumps({'tool': 'systemd-creds', 'argv': argv, 'env': dict(os.environ)}) + '\n')
if argv[0] == 'encrypt':
    with open(argv[-1], 'w') as out:
        out.write(sys.stdin.read())
elif argv[0] == 'decrypt':
    sys.stdout.write(open(argv[-2]).read())
else:
    sys.exit(2)
'''


def catalogue():
    return {'cluster': '7000000000000000001', 'database': 'swift', 'migration': '20261014180000_fixture',
            'migrationOwner': 'swift', 'ownerIsPrivileged': True, 'tenantTables': 130, 'disabledTables': 0,
            'unforcedTables': 0, 'qrSchemaPresent': True, 'qrUnsafeGrants': 0, 'obsoleteExecutable': 0,
            'parentUpdateMissing': 0, 'appendOnlyUnsafeGrants': 0, 'defaultGrantCount': 0,
            'groupUnsafeAttributes': 0, 'groupUnexpectedParents': 0,
            'ownershipDigest': 'a' * 64, 'aclDigest': 'b' * 64}


class Host:
    """One fake host: bin shims, a store directory, the container state."""

    def __init__(self, case):
        self.tmp = Path(tempfile.mkdtemp(prefix='swift-rls-operator-'))
        case.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        self.config = self.tmp / 'fake.json'
        for name, text in (('docker', FAKE_DOCKER), ('sudo', FAKE_SUDO), ('id', FAKE_ID), ('systemd-creds', FAKE_CREDS)):
            # Children of the adapter get a clean environment, so each shim
            # finds its configuration at a path baked into it.
            if text.startswith('#!/usr/bin/env python3'):
                text = text.replace('#!/usr/bin/env python3', '#!' + sys.executable, 1)
                text = text.replace('CONFIG)', repr(str(self.config)) + ')', 1)
            (self.bin / name).write_text(text)
            (self.bin / name).chmod(0o755)
        (self.bin / 'swift-secrets').symlink_to(DEPLOY / 'swift-secrets')
        self.store = self.tmp / 'store'
        self.run_dir = self.tmp / 'run'
        self.calls = self.tmp / 'calls.jsonl'
        self.calls.write_text('')
        self.state = self.tmp / 'state.json'
        self.state.write_text(json.dumps({'catalogue': catalogue(), 'roles': {}}))
        self.target = self.tmp / 'approved.json'
        self.target.write_text(json.dumps({k: catalogue()[k] for k in operator.logins.TARGET_FIELDS}))
        self.lock = self.tmp / 'rls.lock'
        self.outputs = []

    def run(self, command, *extra, env=None, fake=None, target=True, direct=False):
        args = [sys.executable, str(DEPLOY / 'wall' / 'operator.py'), command] if direct else ['bash', str(WRAPPER), command]
        if target and command in ('plan', 'apply', 'verify'):
            args += ['--approved-target-file', str(self.target)]
        args += ['--project-name', 'rehearsal', '--project-directory', str(self.tmp),
                 '--compose-file', str(self.tmp / 'compose.yml'), '--store-dir', str(self.store),
                 '--run-dir', str(self.run_dir), '--lock-file', str(self.lock), *extra]
        self.config.write_text(json.dumps({'calls': str(self.calls), 'state': str(self.state), **(fake or {})}))
        full = {'PATH': f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.tmp)}
        full.update(env or {})
        result = subprocess.run(args, env=full, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)
        self.outputs.append(result.stdout + result.stderr)
        lines = result.stdout.strip().splitlines()
        report = json.loads(lines[-1]) if lines else {}
        return result, report

    def roles(self):
        return json.loads(self.state.read_text())['roles']

    def stored(self, name):
        path = self.store / (name + '.cred')
        return path.read_text() if path.exists() else None

    def store_snapshot(self):
        if not self.store.exists():
            return {}
        return {p.name: (p.read_bytes(), p.stat().st_mtime_ns) for p in sorted(self.store.iterdir())}

    def credentials(self):
        return [json.loads(self.stored(operator.JOURNAL[name]))['credential'] for name in (APP, SYSTEM)
                if self.stored(operator.JOURNAL[name])]

    def call_records(self):
        return [json.loads(line) for line in self.calls.read_text().splitlines() if line.strip()]


class OperatorEndToEnd(unittest.TestCase):
    def setUp(self):
        self.host = Host(self)

    def test_fingerprint_plan_apply_verify_roles(self):
        result, report = self.host.run('fingerprint')
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(report, {'status': 'fingerprint', 'target': json.loads(self.host.target.read_text())})
        # The saved fingerprint line is itself an approved-target file.
        self.host.target.write_text(result.stdout)
        result, report = self.host.run('plan')
        self.assertEqual(report, {'status': 'plan_only', 'create': [APP, SYSTEM], 'verify': []})
        self.assertEqual(self.host.roles(), {}, 'plan changes nothing')
        self.assertEqual(self.host.store_snapshot(), {}, 'plan writes nothing')
        result, report = self.host.run('apply')
        self.assertEqual(report, {'status': 'verified', 'logins': 2, 'separateConnections': 2}, result.stderr)
        self.assertEqual({n: r['parents'] for n, r in self.host.roles().items()},
                         {APP: ['swift_app'], SYSTEM: ['swift_app', 'swift_bypass_rls']})
        self.assertEqual(sorted(p.name for p in self.host.store.iterdir()),
                         ['DATABASE_URL.cred', 'RLS_LOGIN_SWIFT_APP_LOGIN.cred',
                          'RLS_LOGIN_SWIFT_SYSTEM_LOGIN.cred', 'SYSTEM_DATABASE_URL.cred'])
        app_cred, system_cred = self.host.credentials()
        self.assertNotEqual(app_cred, system_cred)
        self.assertGreaterEqual(len(app_cred), 43)
        self.assertEqual(self.host.stored('DATABASE_URL'), f'postgresql://{APP}:{app_cred}@postgres:5432/swift')
        self.assertEqual(self.host.stored('SYSTEM_DATABASE_URL'), f'postgresql://{SYSTEM}:{system_cred}@postgres:5432/swift')
        for name in (APP, SYSTEM):
            self.assertEqual(json.loads(self.host.stored(operator.JOURNAL[name]))['target'],
                             json.loads(self.host.target.read_text())['target'])
        first = self.host.run('verify')[1]
        second = self.host.run('verify')[1]
        self.assertEqual(first, second)
        self.assertEqual(first['status'], 'verified')
        self.assertEqual(first['c1b'], {
            'attributes': {APP: [True, False, False, False, False, False], SYSTEM: [True, False, False, False, False, False]},
            'memberships': [[APP, 'swift_app'], [SYSTEM, 'swift_app'], [SYSTEM, 'swift_bypass_rls']],
            'ownedObjects': 0, 'ownerMember': 0})
        self.assertEqual(self.host.run('roles')[1]['status'], 'roles_hold')

    def test_no_credential_or_verifier_in_any_argv_environment_or_output(self):
        self.assertEqual(self.host.run('apply')[1]['status'], 'verified')
        self.assertEqual(self.host.run('verify')[1]['status'], 'verified')
        self.assertEqual(self.host.run('roles')[1]['status'], 'roles_hold')
        secrets_ = self.host.credentials()
        self.assertEqual(len(secrets_), 2)
        verifiers = [r['verifier'] for r in self.host.roles().values()]
        records = self.host.call_records()
        self.assertTrue(records)
        for record in records:
            blob = json.dumps({'argv': record['argv'], 'env': record['env']})
            for value in secrets_ + verifiers:
                self.assertNotIn(value, blob, record['tool'])
            self.assertNotIn('postgresql://', blob)
        for output in self.host.outputs:
            for value in secrets_ + verifiers:
                self.assertNotIn(value, output)
            self.assertNotIn('postgresql://', output)
        # The verifier reached the database on stdin, inside one transaction
        # with statement and error logging off; the password itself never did.
        for name, role in self.host.roles().items():
            self.assertTrue(role['verifier'].startswith('SCRAM-SHA-256$4096:'))
            text = role['stdin']
            self.assertIn("SET LOCAL log_statement = 'none';", text)
            self.assertIn("SET LOCAL log_min_error_statement = 'panic';", text)
            self.assertLess(text.index('log_statement'), text.index('CREATE ROLE'))
            for value in secrets_:
                self.assertNotIn(value, text)
            self.assertIn('NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION', text)

    def test_children_get_a_clean_environment(self):
        dirty = {'PGPASSWORD': 'MARKER-PGPASSWORD', 'DATABASE_URL': 'MARKER-URL', 'DOCKER_HOST': 'tcp://elsewhere:2375',
                 'PYTHONPATH': '/nowhere', 'SWIFT_SECRETS_STORE_DIR': '/etc/credstore.encrypted/swift'}
        result, report = self.host.run('apply', env={**dirty, 'LANG': 'C.UTF-8'}, direct=True)
        self.assertEqual(report.get('status'), 'verified', result.stdout + result.stderr)
        # What a shim records when started with exactly PATH, HOME and LANG
        # (some interpreters add their own variables, e.g. the macOS stub).
        subprocess.run([str(self.host.bin / 'docker'), 'context', 'show'], capture_output=True, timeout=300, stdin=subprocess.DEVNULL,
                       env={'PATH': f'{self.host.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.host.tmp), 'LANG': 'C.UTF-8'})
        baseline = set(self.host.call_records()[-1]['env'])
        self.assertTrue({'PATH', 'HOME', 'LANG'} <= baseline)
        checked = 0
        for record in self.host.call_records()[:-1]:
            if record['tool'] in ('docker', 'sudo'):
                checked += 1
                for key in dirty:
                    self.assertNotIn(key, record['env'], record['tool'])
                self.assertEqual(set(record['env']) - {'PWD', 'SHLVL', '_'}, baseline - {'PWD', 'SHLVL', '_'}, record['tool'])
        self.assertGreater(checked, 10)

    def test_the_wrapper_hands_python_only_path_home_and_lang(self):
        deploy = self.host.tmp / 'deploy'
        (deploy / 'wall').mkdir(parents=True)
        shutil.copy(WRAPPER, deploy / 'rls-logins.sh')
        (deploy / 'wall' / 'operator.py').write_text('import json, os, sys\nprint(json.dumps(sorted(os.environ)))\n')
        path = '/usr/bin:/bin:/usr/sbin:/sbin'
        dirty = {'PATH': path, 'HOME': str(self.host.tmp), 'PGPASSWORD': 'MARKER', 'SYSTEM_DATABASE_URL': 'MARKER',
                 'DOCKER_CONTEXT': 'elsewhere', 'FAKE_UID': '1000'}
        sys_env = {'PATH': path, 'HOME': str(self.host.tmp), 'FAKE_UID': '1000'}
        wrapped = subprocess.run(['bash', str(deploy / 'rls-logins.sh'), 'roles'], env=dirty, capture_output=True,
                                 text=True, timeout=120, stdin=subprocess.DEVNULL)
        baseline = subprocess.run(['env', '-i', f'PATH={path}', f'HOME={self.host.tmp}', 'LANG=C.UTF-8', 'python3', '-I',
                                   str(deploy / 'wall' / 'operator.py')], env=sys_env, capture_output=True, text=True,
                                  timeout=120, stdin=subprocess.DEVNULL)
        self.assertEqual(wrapped.returncode, 0, wrapped.stderr)
        self.assertEqual(json.loads(wrapped.stdout), json.loads(baseline.stdout))
        self.assertNotIn('PGPASSWORD', json.loads(wrapped.stdout))

    def test_a_trusting_connection_path_is_never_believed(self):
        result, report = self.host.run('apply', fake={'FAKE_TRUST': '1'})
        self.assertEqual(report, {'status': 'hold', 'reason': 'NEGATIVE_CONTROL_NOT_REFUSED'})
        self.assertIsNone(self.host.stored('DATABASE_URL'))
        self.assertIsNone(self.host.stored('SYSTEM_DATABASE_URL'))

    def test_a_wrong_or_swapped_posture_never_publishes(self):
        for facts in ({APP: {'requestWallEnforced': False}}, {SYSTEM: {'systemCapabilityMember': False}},
                      {APP: {'database': 'other'}}, {SYSTEM: {'sessionUser': APP}}):
            with self.subTest(facts=facts):
                host = Host(self)
                result, report = host.run('apply', fake={'FAKE_FACTS': json.dumps(facts)})
                self.assertEqual(report['status'], 'hold', result.stdout)
                self.assertIsNone(host.stored('DATABASE_URL'))
                self.assertIsNone(host.stored('SYSTEM_DATABASE_URL'))

    def test_a_rerun_writes_nothing_and_keeps_the_credentials(self):
        self.host.run('apply')
        before = self.host.store_snapshot()
        roles = self.host.roles()
        result, report = self.host.run('apply')
        self.assertEqual(report['status'], 'verified', result.stdout)
        self.assertEqual(self.host.store_snapshot(), before)
        self.assertEqual(self.host.roles(), roles)

    def test_an_interrupted_run_recovers_with_the_same_credentials(self):
        result, report = self.host.run('apply', fake={'FAKE_CONNECT_DOWN': '1'})
        self.assertEqual(report['status'], 'hold')
        self.assertEqual(sorted(self.host.roles()), [APP, SYSTEM])
        journals = self.host.credentials()
        self.assertEqual(len(journals), 2)
        self.assertIsNone(self.host.stored('DATABASE_URL'))
        result, report = self.host.run('apply')
        self.assertEqual(report['status'], 'verified', result.stdout)
        self.assertEqual(self.host.credentials(), journals)
        self.assertIn(journals[0], self.host.stored('DATABASE_URL'))
        # A failed CREATE leaves the journal and no role; the next run creates it.
        host = Host(self)
        self.assertEqual(host.run('apply', fake={'FAKE_CREATE_FAILS': '1'})[1]['status'], 'hold')
        self.assertEqual(host.roles(), {})
        kept = host.credentials()
        self.assertEqual(len(kept), 2)
        self.assertEqual(host.run('apply')[1]['status'], 'verified')
        self.assertEqual(host.credentials(), kept)

    def test_an_existing_login_without_its_journal_is_refused_before_any_write(self):
        state = json.loads(self.host.state.read_text())
        state['roles'][APP] = {'parents': ['swift_app'], 'verifier': 'SCRAM-SHA-256$4096:AA==$AA==:AA=='}
        self.host.state.write_text(json.dumps(state))
        result, report = self.host.run('apply')
        self.assertEqual(report, {'status': 'hold', 'reason': 'EXISTING_LOGIN_WITHOUT_JOURNAL'})
        self.assertEqual(self.host.store_snapshot(), {})

    def test_a_published_url_for_another_login_is_a_conflict_before_any_write(self):
        self.host.store.mkdir()
        (self.host.store / 'DATABASE_URL.cred').write_text('postgresql://swift:owner-fixture@postgres:5432/swift')
        result, report = self.host.run('apply')
        self.assertEqual(report, {'status': 'hold', 'reason': 'PUBLISHED_CREDENTIAL_CONFLICT'})
        self.assertEqual(self.host.roles(), {})
        self.assertEqual(sorted(self.host.store_snapshot()), ['DATABASE_URL.cred'])

    def test_a_published_url_for_another_database_host_or_port_is_a_conflict(self):
        self.host.run('apply')
        path = self.host.store / 'DATABASE_URL.cred'
        good = path.read_text()
        credential = self.host.credentials()[0]
        for bad in (f'postgresql://{APP}:{credential}@postgres:5432/otherdb',
                    f'postgresql://{APP}:{credential}@elsewhere:5432/swift',
                    f'postgresql://{APP}:{credential}@postgres:5433/swift',
                    f'postgresql://{APP}:{credential}@postgres:5432/swift?sslmode=disable'):
            with self.subTest(bad=bad.replace(credential, '***')):
                path.write_text(bad)
                self.assertEqual(self.host.run('verify')[1], {'status': 'hold', 'reason': 'PUBLISHED_CREDENTIAL_CONFLICT'})
        path.write_text(good)
        self.assertEqual(self.host.run('verify')[1]['status'], 'verified')

    def test_verify_is_pinned_to_the_target_and_roles_is_not(self):
        self.host.run('apply')
        state = json.loads(self.host.state.read_text())
        state['catalogue']['migration'] = '20261101000000_later'
        state['catalogue']['aclDigest'] = 'c' * 64
        self.host.state.write_text(json.dumps(state))
        self.assertEqual(self.host.run('verify')[1], {'status': 'hold', 'reason': 'TARGET_OR_CATALOGUE_CHANGED'})
        self.assertEqual(self.host.run('apply')[1], {'status': 'hold', 'reason': 'TARGET_OR_CATALOGUE_CHANGED'})
        self.assertEqual(self.host.run('roles')[1]['status'], 'roles_hold')
        # ...but roles still holds the invariants, and both logins must exist.
        for field, value in (('unforcedTables', 1), ('qrUnsafeGrants', 1), ('migration', 'incomplete')):
            with self.subTest(field=field):
                broken = json.loads(self.host.state.read_text())
                broken['catalogue'][field] = value
                self.host.state.write_text(json.dumps(broken))
                self.assertEqual(self.host.run('roles')[1]['status'], 'hold')
                self.host.state.write_text(json.dumps(state))
        state['roles'].pop(SYSTEM)
        self.host.state.write_text(json.dumps(state))
        self.assertEqual(self.host.run('roles')[1], {'status': 'hold', 'reason': 'LOGINS_MISSING'})

    def test_one_run_at_a_time(self):
        import fcntl
        with open(self.host.lock, 'a') as held:
            fcntl.flock(held.fileno(), fcntl.LOCK_EX)
            result, report = self.host.run('apply')
        self.assertEqual(report, {'status': 'hold', 'reason': 'ANOTHER_RUN_HOLDS_THE_LOCK'})
        self.assertEqual(self.host.call_records(), [])

    def test_another_docker_context_is_refused(self):
        result, report = self.host.run('plan', fake={'FAKE_CONTEXT': 'elsewhere'})
        self.assertEqual(report, {'status': 'hold', 'reason': 'DOCKER_CONTEXT_NOT_DEFAULT'})

    def test_target_file_rules_and_the_root_refusal(self):
        self.assertEqual(self.host.run('apply', target=False)[1], {'status': 'hold', 'reason': 'TARGET_FILE_REQUIRED'})
        self.assertEqual(self.host.run('roles', '--approved-target-file', str(self.host.target))[1],
                         {'status': 'hold', 'reason': 'TARGET_FILE_NOT_USED'})
        for bad in ('{"cluster": "x"}', json.dumps({'status': 'plan_only', 'target': catalogue()}), 'not json'):
            self.host.target.write_text(bad)
            self.assertEqual(self.host.run('apply')[1]['status'], 'hold')
        self.host.target.write_text('{"cluster": "x"}')
        self.assertEqual(self.host.run('apply')[1], {'status': 'hold', 'reason': 'TARGET_INVALID'})
        result, report = self.host.run('plan', env={'FAKE_UID': '0'})
        self.assertEqual(report, {'status': 'hold', 'reason': 'RUN_AS_THE_DEPLOY_USER'})
        self.assertEqual(self.host.call_records(), [])

    def test_a_rehearsal_store_names_both_locations_production_names_neither(self):
        ports = operator.HostPorts(['docker', 'compose'], operator.DEFAULT_STORE, [], {'database': 'swift'})
        seen = []
        ports._run = lambda argv, stdin, code: seen.append(argv) or ''
        ports.store_bin = '/usr/local/sbin/swift-secrets'
        ports._names()
        self.assertEqual(seen[-1], ['sudo', '-n', '/usr/local/sbin/swift-secrets', 'list'])
        self.host.run('apply')
        store_calls = [r['argv'] for r in self.host.call_records() if r['tool'] == 'sudo' and 'swift-secrets' in ' '.join(r['argv'])]
        self.assertTrue(store_calls)
        for argv in store_calls:
            self.assertEqual(argv[:4], ['-n', 'env', f'SWIFT_SECRETS_STORE_DIR={self.host.store}',
                                        f'SWIFT_SECRETS_RUN_DIR={self.host.run_dir}'])


class OperatorUnits(unittest.TestCase):
    def test_the_scram_verifier_matches_its_definition(self):
        salt = bytes(range(16))
        verifier = operator.scram_verifier('fixture-password', salt=salt)
        m = re.fullmatch(r'SCRAM-SHA-256\$4096:([^$]+)\$([^:]+):(.+)', verifier)
        salted = hashlib.pbkdf2_hmac('sha256', b'fixture-password', salt, 4096)
        self.assertEqual(base64.b64decode(m.group(1)), salt)
        self.assertEqual(base64.b64decode(m.group(2)),
                         hashlib.sha256(hmac.new(salted, b'Client Key', 'sha256').digest()).digest())
        self.assertEqual(base64.b64decode(m.group(3)), hmac.new(salted, b'Server Key', 'sha256').digest())
        self.assertNotEqual(operator.scram_verifier('fixture-password'), operator.scram_verifier('fixture-password'))

    def test_create_grants_exactly_the_parents_and_refuses_other_names(self):
        sql = operator.create_sql(APP, 'SCRAM-SHA-256$4096:AA==$AA==:AA==')
        self.assertEqual(re.findall(r'GRANT (\w+) TO', sql), ['swift_app'])
        sql = operator.create_sql(SYSTEM, 'SCRAM-SHA-256$4096:AA==$AA==:AA==')
        self.assertEqual(re.findall(r'GRANT (\w+) TO', sql), ['swift_app', 'swift_bypass_rls'])
        for name, verifier in (('swift', 'SCRAM-SHA-256$4096:AA==$AA==:AA=='), (APP, "plain' OR '1"), (APP, 'md5abc')):
            with self.subTest(name=name, verifier=verifier), self.assertRaises(operator.Refusal):
                operator.create_sql(name, verifier)

    def test_the_census_revocation_list_is_the_migrations_list(self):
        """census.sql's `revoked` VALUES mirror APP_ROLE_MIGRATION_REVOCATIONS in tenant-rls.ts."""
        source = TENANT_RLS.read_text()
        block = source[source.index('const APP_ROLE_MIGRATION_REVOCATIONS'):]
        block = block[:block.index('];')]
        everything = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']
        expected = set()
        for table, privileges in re.findall(r"table: '([^']+)', privileges: '([^']+)'", block):
            for privilege in (everything if privileges == 'ALL' else [p.strip() for p in privileges.split(',')]):
                expected.add((table, privilege))
        self.assertGreater(len(expected), 10)
        census = (DEPLOY / 'wall' / 'census.sql').read_text()
        values = census[census.index('revoked(rel, priv) AS ('):]
        values = values[:values.index('\n),')]
        self.assertEqual(set(re.findall(r"\('([^']+)', '([A-Z]+)'\)", values)), expected)

    def test_the_census_only_reads(self):
        census = (DEPLOY / 'wall' / 'census.sql').read_text()
        code = '\n'.join(line.split('--')[0] for line in census.splitlines())
        code = re.sub(r"'[^']*'", "''", code).upper()
        self.assertEqual(re.findall(r'\b(INSERT|UPDATE|DELETE|CREATE|ALTER|GRANT|REVOKE|DROP|TRUNCATE|COPY|SET ROLE|DO)\b', code), [])
        self.assertEqual(code.count(';'), 2)  # SET search_path; and the one SELECT

    def test_the_acl_digest_is_default_explicit_and_order_free(self):
        """A pg_dump/pg_restore copy leaves an ACL that equals its default as
        NULL; the digest must read both alike (the rehearsal compares them)."""
        census = (DEPLOY / 'wall' / 'census.sql').read_text()
        acls = census[census.index('acls AS ('):census.index('SELECT json_build_object(')]
        for default in ("coalesce(s.nspacl, acldefault('n',", 'coalesce(c.relacl, acldefault(',
                        "coalesce(p.proacl, acldefault('f',", "coalesce(t.typacl, acldefault('T',",
                        "coalesce(d.datacl, acldefault('d',"):
            self.assertIn(default, acls)
        self.assertNotIn("'-'", acls)
        self.assertEqual(acls.count('aclexplode('), 7)

    def test_published_urls_parse_back_and_others_do_not(self):
        url = operator.published_url(APP, 'swift', 'a-b_c')
        self.assertEqual(operator.parse_published(url), (APP, 'a-b_c', 'postgres', 5432, 'swift'))
        self.assertIsNone(operator.parse_published('mysql://x:y@postgres:5432/swift'))
        self.assertIsNone(operator.parse_published(url + '?sslmode=disable'))


if __name__ == '__main__':
    unittest.main()
