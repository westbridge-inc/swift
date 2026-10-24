"""[TA-S0-003 · R3 + C1] The business wall's contract posture on the stack.

- docker-compose.wall.yml, rendered by `docker compose config`: the API and
  the worker get the two runtime URLs and never the owner's credential.
- pilot-up.sh, run for real against shims: TENANT_RLS_BIND=1 selects the
  overlay and its settings; production refuses the owner login and the expand
  posture once Phase C has run (owner ruling, 14 Oct); staging is unchanged.
- deploy/wall/rehearsal.sh against shims, and its compose layer rendered:
  an isolated copy that only ever reads production.
- doctor.sh's read-only checks of the posture.
Nothing here needs root, a database or a running Docker daemon.
"""
import base64
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]
SHA = 'd' * 40
REAL_DOCKER = shutil.which('docker')
BASE_FILES = ('pilot-up.sh', 'secret-names.sh', 'wait-for-migration.sh', 'verify-journeys-isolation.py', 'check-upload-storage.py', 'Caddyfile',
              'docker-compose.yml', 'docker-compose.routing.yml', 'docker-compose.wall.yml', 'docker-compose.rehearsal.yml',
              'gen-secrets.sh', 'doctor.sh')


def shim(bin_dir: Path, name: str, body: str, python=False) -> None:
    path = bin_dir / name
    path.write_text(('#!/usr/bin/env python3\n' if python else '#!/bin/sh\n') + body + '\n')
    path.chmod(0o755)


def compose_render(*files, project=None, env_text='NODE_ENV=production\nPILOT_ENV=production\n', profiles=()):
    with tempfile.TemporaryDirectory() as tmp:
        here = Path(tmp) / 'deploy'
        here.mkdir()
        for name in files:
            shutil.copy(DEPLOY / name, here / name)
        (here / '.env').write_text(env_text)
        argv = ['docker', 'compose'] + (['-p', project] if project else []) + ['--project-directory', str(here)]
        for name in files:
            argv += ['-f', str(here / name)]
        for profile in profiles:
            argv += ['--profile', profile]
        result = subprocess.run(argv + ['config', '--format', 'json'], text=True, capture_output=True, timeout=60,
                                env={'PATH': os.environ.get('PATH', ''), 'HOME': os.environ.get('HOME', tmp)})
        if result.returncode != 0 and ('unknown' in result.stderr.lower() or 'not found' in result.stderr.lower()):
            raise unittest.SkipTest(f'docker compose cannot render here: {result.stderr.strip()[:120]}')
        assert result.returncode == 0, result.stderr[:600]
        return json.loads(result.stdout)


def wall_env(service):
    env = service.get('environment') or {}
    return {k: v for k, v in env.items() if k.startswith(('POSTGRES', 'DATABASE_URL', 'SYSTEM_DATABASE_URL', 'TENANT_'))}


class WallOverlayRendered(unittest.TestCase):
    def test_api_and_worker_get_the_two_logins_and_no_owner_credential(self):
        # Even a deploy/.env that names owner parts or the expand declaration
        # cannot put them back: an empty value in `environment` beats env_file.
        model = compose_render('docker-compose.yml', 'docker-compose.wall.yml', env_text=(
            'NODE_ENV=production\nPILOT_ENV=production\nPOSTGRES_USER=swift\nPOSTGRES_PASSWORD_FILE=/run/secrets/POSTGRES_PASSWORD\n'
            'TENANT_WALL_EXPAND_ATTESTED=1\nTENANT_UNSCOPED_ACCESS=log\n'))
        for name in ('api', 'worker'):
            with self.subTest(service=name):
                service = model['services'][name]
                self.assertEqual(wall_env(service), {
                    'POSTGRES_HOST': '', 'POSTGRES_PORT': '', 'POSTGRES_USER': '', 'POSTGRES_DB': '', 'POSTGRES_PASSWORD_FILE': '',
                    'DATABASE_URL_FILE': '/run/secrets/DATABASE_URL', 'SYSTEM_DATABASE_URL_FILE': '/run/secrets/SYSTEM_DATABASE_URL',
                    'TENANT_RLS_BIND': '1', 'TENANT_UNSCOPED_ACCESS': 'deny', 'TENANT_WALL_EXPAND_ATTESTED': ''})
                binds = [(v['source'], v['target'], v.get('read_only')) for v in service['volumes'] if v['type'] == 'bind']
                self.assertIn(('/dev/null', '/run/secrets/POSTGRES_PASSWORD', True), binds)
                self.assertIn(('/run/swift-secrets', '/run/secrets', True), binds)
        # Postgres and the one-shot migrate keep the owner, which migrations need.
        for name in ('postgres', 'migrate'):
            self.assertEqual(model['services'][name]['environment']['POSTGRES_PASSWORD_FILE'], '/run/secrets/POSTGRES_PASSWORD')

    def test_without_the_overlay_the_stack_is_unchanged(self):
        model = compose_render('docker-compose.yml')
        for name in ('api', 'worker'):
            env = model['services'][name]['environment']
            self.assertEqual(env['POSTGRES_PASSWORD_FILE'], '/run/secrets/POSTGRES_PASSWORD')
            self.assertNotIn('DATABASE_URL_FILE', env)
            self.assertNotIn('SYSTEM_DATABASE_URL_FILE', env)
            self.assertNotIn('TENANT_RLS_BIND', env)

    def test_the_overlay_names_only_store_secrets_pilot_up_checks(self):
        text = (DEPLOY / 'docker-compose.wall.yml').read_text()
        self.assertEqual(sorted(set(re.findall(r'_FILE: /run/secrets/([A-Z_]+)', text))), ['DATABASE_URL', 'SYSTEM_DATABASE_URL'])
        self.assertNotIn('${', text)


class RehearsalComposeRendered(unittest.TestCase):
    FILES = ('docker-compose.yml', 'docker-compose.wall.yml', 'docker-compose.rehearsal.yml')

    def test_its_own_internal_network_volumes_and_secrets_and_nothing_public(self):
        model = compose_render(*self.FILES, project='swift-rehearsal', profiles=('web', 'admin'))
        self.assertEqual(model['networks'], {'private': {'name': 'swift-rehearsal-private', 'ipam': {}, 'internal': True}})
        for volume in model['volumes'].values():
            self.assertTrue(volume['name'].startswith('swift-rehearsal_'), volume)
        # [Row 312] The copy's own upload malware scanner (no secret: it reads none).
        self.assertEqual(sorted(model['services']), ['api', 'clamd', 'meilisearch', 'migrate', 'postgres', 'redis', 'worker'])
        for name, service in model['services'].items():
            with self.subTest(service=name):
                self.assertNotIn('ports', service)
                self.assertEqual(list(service['networks']), ['private'])
                sources = [v['source'] for v in service.get('volumes', []) if v['type'] == 'bind']
                self.assertNotIn('/run/swift-secrets', sources)
                if name not in ('redis', 'clamd'):
                    self.assertIn('/run/swift-rehearsal-secrets', sources)
        for name in ('api', 'worker'):
            self.assertEqual(wall_env(model['services'][name])['DATABASE_URL_FILE'], '/run/secrets/DATABASE_URL')
            self.assertIn('/dev/null', [v['source'] for v in model['services'][name]['volumes']])
        self.assertIn('-h 127.0.0.1', ' '.join(model['services']['postgres']['healthcheck']['test']))

    def test_the_overlay_names_its_own_project_even_without_p(self):
        """Base first, no -p: the base file's `name: swift` is PRODUCTION's
        project. The rehearsal layer names its own, so a hand run that forgets
        -p still never reaches production's containers or volumes."""
        model = compose_render(*self.FILES)
        self.assertEqual(model['name'], 'swift-rehearsal')
        for volume in model['volumes'].values():
            self.assertTrue(volume['name'].startswith('swift-rehearsal_'), volume)
        self.assertEqual(compose_render('docker-compose.yml')['name'], 'swift')


# ── pilot-up.sh against shims ──────────────────────────────────────────────
FAKE_DOCKER = r'''
import json, os, sys
argv = sys.argv[1:]
line = ' '.join(argv)
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write('docker ' + line + '\n')
if argv[:2] == ['context', 'show']:
    print('default'); sys.exit(0)
if argv[:1] == ['network']:
    if '-f' in argv: print('bridge')
    sys.exit(0)
if argv[:1] == ['inspect']:
    fmt = argv[2]
    print('exited 0' if 'ExitCode' in fmt else 'running'); sys.exit(0)
if argv[:1] == ['compose'] and 'config' in argv and '--format' in argv:
    if any(a.endswith('docker-compose.routing.yml') for a in argv):
        print(json.dumps({'services': {'osrm': {}}}))
    else:
        services = {n: {} for n in ('postgres', 'redis', 'meilisearch', 'migrate', 'api', 'worker')}
        # [Row 324] api and worker render the shared store, as the real Compose does (pilot-up checks it).
        for _svc in ('api', 'worker'):
            services[_svc] = {'environment': {'STORAGE_DEPLOYMENT': 'managed', 'STORAGE_PROVIDER': 's3', 'STORAGE_ALLOW_LOCAL': '0', 'AWS_S3_BUCKET': 'synthetic-bucket'}}
        services['caddy'] = {'ports': [{'published': '80', 'target': 80, 'protocol': 'tcp'}, {'published': '443', 'target': 443, 'protocol': 'tcp'}]}
        print(json.dumps({'services': services}))
    sys.exit(0)
if argv[:1] == ['compose'] and 'ps' in argv:
    service = argv[-1]
    if service in ('migrate', 'postgres'): print(service + '-id')
    sys.exit(0)
if argv[:1] == ['compose'] and 'exec' in argv:
    script = argv[argv.index('-c') + 1]
    rest = argv[argv.index('-c') + 2:]
    if 'deployment_identity' in script:
        print('1:' + os.environ.get('FAKE_IDENTITY', 'production')); sys.exit(0)
    if rest and 'pg_roles' in rest[-1]:
        if os.environ.get('FAKE_LOGINS_FAIL'): sys.exit(2)
        print(os.environ.get('FAKE_LOGINS', '0')); sys.exit(0)
    sys.exit(0)
sys.exit(0)
'''

PRODUCTION = {
    'PILOT_ENV': 'production', 'NODE_ENV': 'production', 'API_HOST': 'api.swift-fixture.com', 'MAPS_PROVIDER': 'osrm',
    'OSRM_URL': 'http://osrm:5000', 'BACKUP_BUCKET': 'fixture-backups', 'API_PUBLIC_URL': 'https://api.swift-fixture.com',
    'APP_PUBLIC_URL': 'https://swift-fixture.com', 'CORS_ORIGIN': 'https://swift-fixture.com', 'STORAGE_PROVIDER': 's3',
    'BACKUP_GPG_FINGERPRINT': 'A' * 40, 'BACKUP_GPG_RECIPIENT_FILE': '/etc/swift/backup-recipient.asc',
    'BACKUP_MAX_AGE_HOURS': '3', 'BILLING_TOPUP_HOLD': '1', 'PAYMENT_PROVIDER': 'disabled', 'CARD_RAIL_KILL': '1',
    'TENANT_WALL_EXPAND_ATTESTED': '1',
}
CONTRACT = {'TENANT_RLS_BIND': '1', 'TENANT_UNSCOPED_ACCESS': 'deny', 'TENANT_WALL_EXPAND_ATTESTED': None}
STAGING = {'PILOT_ENV': 'staging', 'NODE_ENV': 'development', 'API_HOST': 'api-staging.swift-fixture.com',
           'MAPS_PROVIDER': 'osrm', 'OSRM_URL': 'http://osrm:5000', 'BACKUP_BUCKET': 'fixture-backups',
           'TENANT_WALL_EXPAND_ATTESTED': '1'}


class PilotUpHost:
    def __init__(self, case):
        self.tmp = Path(tempfile.mkdtemp(prefix='swift-wall-pilot-'))
        case.addCleanup(shutil.rmtree, self.tmp, True)
        self.here = self.tmp / 'repo' / 'deploy'
        (self.here / 'routing-data' / 'osrm').mkdir(parents=True)
        (self.here / 'routing-data' / 'osrm' / 'guyana-latest.osrm').write_text('')
        for name in BASE_FILES:
            shutil.copy(DEPLOY / name, self.here / name)
        utils = self.tmp / 'repo' / 'apps' / 'api' / 'src' / 'utils'
        utils.mkdir(parents=True)
        shutil.copy(DEPLOY.parent / 'apps' / 'api' / 'src' / 'utils' / 'secret-files.ts', utils / 'secret-files.ts')
        shim(self.here, 'backup.sh', 'exit 0')
        shim(self.here, 'rls-logins.sh', 'echo "rls-logins $*" >> "$CALL_LOG"\n'
             'if [ -n "$FAKE_ROLES_HOLD" ]; then echo \'{"status": "hold", "reason": "ROLE_MEMBERSHIP_UNEXPECTED"}\'; exit 1; fi\n'
             'echo \'{"status": "roles_hold"}\'')
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        self.log = self.tmp / 'calls'
        shim(self.bin, 'docker', FAKE_DOCKER, python=True)
        shim(self.bin, 'git', 'echo "git $*" >> "$CALL_LOG"\n[ "$*" = "rev-parse HEAD" ] && echo "$GIT_HEAD"\nexit 0')
        shim(self.bin, 'id', 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        shim(self.bin, 'sudo', '[ "$1" = -n ] && shift\nexec "$@"')
        shim(self.bin, 'swift-secrets', '[ "$1" = list ] && printf "%s\\n" $STORE_NAMES\nexit 0')
        shim(self.bin, 'systemctl', 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0')
        shim(self.bin, 'sleep', 'exit 0')
        shim(self.bin, 'curl', 'exit 0')
        compose = (DEPLOY / 'docker-compose.yml').read_text()
        self.store = sorted(set(re.findall(r'_FILE: /run/secrets/([A-Z][A-Z0-9_]*)', compose)) | {'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'})

    def run(self, settings, store_extra=(), extra_env=None, mode='--data-only'):
        lines = [f'{k}={v}' for k, v in settings.items() if v is not None]
        (self.here / '.env').write_text('\n'.join(lines) + '\n')
        self.log.write_text('')
        env = {'PATH': f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.tmp), 'CALL_LOG': str(self.log),
               'GIT_HEAD': SHA, 'STORE_NAMES': ' '.join(list(self.store) + list(store_extra))}
        env.update(extra_env or {})
        args = ['bash', str(self.here / 'pilot-up.sh')] + ([mode] if mode else []) + [SHA]
        result = subprocess.run(args, env=env, text=True, capture_output=True, timeout=180, stdin=subprocess.DEVNULL)
        return result, self.log.read_text().splitlines()


def changed(calls):
    """Calls that change the stack (anything past the read-only checks)."""
    return [c for c in calls if re.search(r'docker compose .* (up|stop|pull|build|down|run)\b', c)]


class PilotUpWallPosture(unittest.TestCase):
    def setUp(self):
        self.host = PilotUpHost(self)

    def test_staging_without_the_bind_is_unchanged(self):
        result, calls = self.host.run(STAGING, extra_env={'FAKE_IDENTITY': 'staging'})
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertIn('DATABASE READY', result.stdout)
        self.assertFalse([c for c in calls if 'docker-compose.wall.yml' in c])
        self.assertFalse([c for c in calls if 'pg_roles' in c or c.startswith('rls-logins')])

    def test_production_before_phase_c_deploys_in_the_expand_posture(self):
        result, calls = self.host.run(PRODUCTION)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertIn('DATABASE READY', result.stdout)
        self.assertFalse([c for c in calls if 'docker-compose.wall.yml' in c])
        self.assertTrue([c for c in calls if 'pg_roles' in c], 'production asks the database whether Phase C ran')

    def test_production_refuses_the_owner_login_once_the_store_holds_the_runtime_logins(self):
        for name in ('RLS_LOGIN_SWIFT_APP_LOGIN', 'RLS_LOGIN_SWIFT_SYSTEM_LOGIN', 'DATABASE_URL', 'SYSTEM_DATABASE_URL'):
            with self.subTest(name=name):
                result, calls = self.host.run(PRODUCTION, store_extra=[name])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Phase C', result.stderr)
                self.assertIn('owner ruling, 14 Oct', result.stderr)
                self.assertEqual(changed(calls), [], 'refused before anything changes')

    def test_production_refuses_the_owner_login_once_the_database_has_the_runtime_logins(self):
        for count in ('1', '2'):
            with self.subTest(count=count):
                result, calls = self.host.run(PRODUCTION, extra_env={'FAKE_LOGINS': count})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn('Phase C has run', result.stderr)
                self.assertIn('Nothing was stopped or migrated', result.stderr)
                self.assertFalse([c for c in calls if ' stop ' in c or 'migrate' in c.split()[-1:]])
                self.assertFalse([c for c in calls if 'up -d --force-recreate migrate' in c])

    def test_production_refuses_when_the_database_cannot_say(self):
        result, calls = self.host.run(PRODUCTION, extra_env={'FAKE_LOGINS_FAIL': '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('could not ask the database whether the least-privilege logins exist', result.stderr)
        self.assertFalse([c for c in calls if 'up -d --force-recreate migrate' in c])

    def test_the_contract_posture_selects_the_overlay_and_checks_the_roles_after_migrating(self):
        settings = {**PRODUCTION, **CONTRACT}
        result, calls = self.host.run(settings, store_extra=['DATABASE_URL', 'SYSTEM_DATABASE_URL'], extra_env={'FAKE_LOGINS': '2'})
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertIn('least-privilege logins hold their contract', result.stdout)
        compose = [c for c in calls if c.startswith('docker compose') and 'docker-compose.routing.yml' not in c]
        self.assertTrue(compose)
        self.assertEqual([c for c in compose if 'docker-compose.wall.yml' not in c], [])
        migrated = next(i for i, c in enumerate(calls) if 'up -d --force-recreate migrate' in c)
        roles = next(i for i, c in enumerate(calls) if c == 'rls-logins roles')
        self.assertLess(migrated, roles)

    def test_the_contract_posture_refuses_its_own_misconfigurations_before_anything_changes(self):
        base = {**PRODUCTION, **CONTRACT}
        cases = [
            ({**base, 'TENANT_UNSCOPED_ACCESS': 'log'}, [], 'TENANT_UNSCOPED_ACCESS=deny'),
            ({**base, 'TENANT_WALL_EXPAND_ATTESTED': '1'}, [], 'refuses TENANT_WALL_EXPAND_ATTESTED'),
            ({**base, 'DATABASE_URL_FILE': '/run/secrets/DATABASE_URL'}, [], 'must not set DATABASE_URL_FILE'),
            ({**base, 'SYSTEM_DATABASE_URL_FILE': '/run/secrets/SYSTEM_DATABASE_URL'}, [], 'must not set SYSTEM_DATABASE_URL_FILE'),
            ({**base, 'POSTGRES_PASSWORD_FILE': '/run/secrets/POSTGRES_PASSWORD'}, [], 'must not set POSTGRES_PASSWORD_FILE'),
            ({**base, 'TENANT_RLS_BIND': 'true'}, [], 'TENANT_RLS_BIND to be exactly 1'),
            # [item 20] The owner wall is a separate, later switch: never with Phase C, with or without the contract.
            ({**base, 'OWNER_RLS_BIND': '1'}, [], 'the owner wall is switched separately'),
            ({**PRODUCTION, 'OWNER_RLS_BIND': '0'}, [], 'the owner wall is switched separately'),
            (base, ['SYSTEM_DATABASE_URL'], 'DATABASE_URL is wired as DATABASE_URL_FILE but is not in the encrypted store'),
        ]
        for settings, store, message in cases:
            with self.subTest(message=message):
                result, calls = self.host.run(settings, store_extra=store, extra_env={'FAKE_LOGINS': '2'})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertEqual(changed(calls), [])

    def test_the_contract_posture_needs_both_logins_and_their_contract(self):
        settings = {**PRODUCTION, **CONTRACT}
        store = ['DATABASE_URL', 'SYSTEM_DATABASE_URL']
        result, calls = self.host.run(settings, store_extra=store, extra_env={'FAKE_LOGINS': '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('do not both exist', result.stderr)
        self.assertFalse([c for c in calls if 'up -d --force-recreate migrate' in c])
        result, calls = self.host.run(settings, store_extra=store, extra_env={'FAKE_LOGINS': '2', 'FAKE_ROLES_HOLD': '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('ROLE_MEMBERSHIP_UNEXPECTED', result.stderr)
        self.assertIn('the API and worker were not started', result.stderr)
        self.assertNotIn('DATABASE READY', result.stdout)


# ── deploy/wall/rehearsal.sh against shims ──────────────────────────────────
FAKE_REHEARSAL_DOCKER = r'''
import json, os, sys
argv = sys.argv[1:]
stdin = '' if sys.stdin.isatty() else sys.stdin.read()
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'docker', 'argv': argv, 'stdin_bytes': len(stdin)}) + '\n')
if argv[:2] == ['context', 'show']:
    print('default'); sys.exit(0)
if argv[:2] == ['image', 'inspect']:
    sys.exit(0 if not os.environ.get('FAKE_NO_IMAGE') else 1)
if argv[:1] == ['inspect']:
    print(os.environ.get('FAKE_STATE_' + argv[-1].replace('-', '_'), 'running restarts=0')); sys.exit(0)
rehearsal = argv[:3] == ['compose', '-p', 'swift-rehearsal']
if argv[:1] == ['compose'] and 'config' in argv:
    # Compose itself renders the copy's settings (client-side, no daemon state).
    os.execve(os.environ['REAL_DOCKER'], ['docker'] + argv, {**os.environ, 'HOME': os.environ['REAL_HOME']})
if argv[:1] == ['compose'] and 'ps' in argv:
    if rehearsal and '-aq' in argv:
        print(os.environ.get('FAKE_REHEARSAL_PS', '')); sys.exit(0)
    print(argv[-1] + '-id'); sys.exit(0)
if argv[:1] == ['compose'] and 'logs' in argv:
    rest, services, tail = argv[argv.index('logs') + 1:], [], None
    while rest:
        a = rest.pop(0)
        if a == '--tail':
            tail = int(rest.pop(0))
        elif not a.startswith('-'):
            services.append(a)
    if 'FAKE_LOGS' in os.environ:
        text = os.environ['FAKE_LOGS']
    else:
        text = '\n'.join(os.environ.get('FAKE_LOGS_' + svc.upper(), f'{svc} | tenant wall: enforced role=swift_app_login\n'
                                        f'{svc} | tenant wall: system login is a bypass member') for svc in services)
    lines = text.split('\n')
    print('\n'.join(lines[-tail:] if tail else lines)); sys.exit(0)
if argv[:1] == ['compose'] and 'exec' in argv and 'cat' in argv:
    # The api container's secret mount: the copy's published URL files.
    name = argv[-1].rsplit('/', 1)[-1]
    login = {'DATABASE_URL': 'swift_app_login', 'SYSTEM_DATABASE_URL': 'swift_system_login'}[name]
    user = os.environ.get('FAKE_URL_USER_' + name, login)
    print(f'postgresql://{user}:{os.environ["FAKE_CRED_" + name]}@postgres:5432/swift'); sys.exit(0)
if argv[:1] == ['compose'] and 'exec' in argv and 'PGPASSFILE' in argv[argv.index('-c') + 1]:
    # A login's own new connection: the passfile line must arrive on stdin, for that login.
    login, sql = argv[-2], argv[-1]
    cred = os.environ['FAKE_CRED_' + ('DATABASE_URL' if login == 'swift_app_login' else 'SYSTEM_DATABASE_URL')]
    if stdin.strip() != f'postgres:5432:swift:{login}:{cred}':
        sys.stderr.write('psql: error: FATAL:  password authentication failed\n'); sys.exit(2)
    if 'query_to_xml' in sql:
        print(os.environ.get('FAKE_ROWS_' + login.upper(), '0' if login == 'swift_app_login' else '42')); sys.exit(0)
    if sql.startswith('ALTER TABLE'):
        if os.environ.get('FAKE_ALTER_OK'): sys.exit(0)
        sys.stderr.write('ERROR:  must be owner of table users\n'); sys.exit(1)
    if 'pg_get_userbyid' in sql:
        print(os.environ.get('FAKE_OWNER', 'swift')); sys.exit(0)
    if sql.startswith('SET ROLE'):
        if os.environ.get('FAKE_SET_ROLE_OK'): sys.exit(0)
        sys.stderr.write('ERROR:  permission denied to set role "swift"\n'); sys.exit(1)
    sys.exit(3)
if argv[:1] == ['compose'] and 'exec' in argv:
    script = argv[argv.index('-c') + 1]
    if 'pg_dumpall' in script:
        print("CREATE ROLE swift;\nCREATE ROLE swift_app;\nALTER ROLE swift_app WITH NOSUPERUSER INHERIT NOLOGIN NOBYPASSRLS;\n"
              "CREATE ROLE swift_bypass_rls;\nCREATE ROLE swift_audit_purge_owner;\nCREATE ROLE swift_audit_purge_executor;\n"
              "CREATE ROLE swift_app_login;\nGRANT swift_app TO swift_app_login WITH INHERIT TRUE GRANTED BY swift;")
    elif 'pg_dump ' in script:
        sys.stdout.write('PGDMP-fixture')
    sys.exit(0)
sys.exit(0)
'''

FAKE_RLS = r'''
import json, os, sys
argv = sys.argv[1:]
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'rls-logins', 'argv': argv}) + '\n')
target = {'cluster': 'c-' + ('copy' if 'swift-rehearsal' in argv else 'source'), 'database': 'swift', 'migration': 'm',
          'migrationOwner': 'swift', 'ownershipDigest': 'a' * 64, 'aclDigest': os.environ.get('FAKE_COPY_ACL', 'b' * 64) if 'swift-rehearsal' in argv else 'b' * 64}
step = argv[0]
if step == 'fingerprint':
    print(json.dumps({'status': 'fingerprint', 'target': target}))
elif step == 'plan':
    print(json.dumps({'status': 'plan_only', 'create': ['swift_app_login', 'swift_system_login'], 'verify': []}))
elif step in ('apply', 'verify'):
    print(json.dumps({'status': 'verified', 'logins': 2, 'separateConnections': 2}))
'''

FAKE_STORE = r'''
import json, os, sys
argv = sys.argv[1:]
value = sys.stdin.read() if argv[:1] == ['set'] else ''
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(json.dumps({'tool': 'swift-secrets', 'argv': argv, 'env_store': os.environ.get('SWIFT_SECRETS_STORE_DIR'),
                          'env_run': os.environ.get('SWIFT_SECRETS_RUN_DIR'), 'value_length': len(value)}) + '\n')
if value:
    with open(os.environ['VALUE_LOG'], 'a') as values:
        values.write(value + '\n')
    with open(os.environ['VALUE_LOG'] + '.json', 'a') as values:
        values.write(json.dumps({'name': argv[1], 'value': value}) + '\n')
'''


class RehearsalHost:
    def __init__(self, case):
        self.tmp = Path(tempfile.mkdtemp(prefix='swift-wall-rehearsal-'))
        case.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / 'deploy'
        (self.deploy / 'wall').mkdir(parents=True)
        for name in ('docker-compose.yml', 'docker-compose.wall.yml', 'docker-compose.rehearsal.yml', 'gen-secrets.sh'):
            shutil.copy(DEPLOY / name, self.deploy / name)
        for name in ('rehearsal.sh', 'rehearsal-roles.py', 'walled-rows.sql', 'stand-in.sh', 'redact-log.py'):
            shutil.copy(DEPLOY / 'wall' / name, self.deploy / 'wall' / name)
        shim(self.deploy, 'rls-logins.sh', FAKE_RLS, python=True)
        (self.deploy / '.env').write_text('PILOT_ENV=production\nNODE_ENV=production\n'
                                          'TWILIO_API_KEY_SECRET_FILE=/run/secrets/TWILIO_API_KEY_SECRET\n'
                                          'SMTP_PASS_FILE=/run/secrets/SMTP_PASS\n')
        self.bin = self.tmp / 'bin'
        self.bin.mkdir()
        shim(self.bin, 'docker', FAKE_REHEARSAL_DOCKER, python=True)
        shim(self.bin, 'swift-secrets', FAKE_STORE, python=True)
        shim(self.bin, 'sudo', 'echo "{\\"tool\\": \\"sudo\\", \\"argv\\": \\"$*\\"}" >> "$CALL_LOG"\n[ "$1" = -n ] && shift\n'
             'case "$1" in rm) exit 0 ;; test) [ -n "$FAKE_STORE_EXISTS" ] && exit 0; exit 1 ;; esac\nexec "$@"')
        shim(self.bin, 'id', 'if [ "$1" = "-u" ]; then echo "${FAKE_UID:-1000}"; else exec /usr/bin/id "$@"; fi')
        shim(self.bin, 'sleep', 'exit 0')
        self.calls = self.tmp / 'calls.jsonl'
        self.values = self.tmp / 'values'

    def run(self, *args, extra_env=None):
        self.calls.write_text('')
        self.values.write_text('')
        Path(str(self.values) + '.json').write_text('')
        env = {'PATH': f'{self.bin}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(self.tmp), 'CALL_LOG': str(self.calls),
               'VALUE_LOG': str(self.values), 'SWIFT_REHEARSAL_LOCK': str(self.tmp / 'lock'), 'REAL_DOCKER': REAL_DOCKER or '', 'REAL_HOME': os.environ.get('HOME', str(self.tmp)),
               'FAKE_CRED_DATABASE_URL': 'app-fixture-credential-7Qx', 'FAKE_CRED_SYSTEM_DATABASE_URL': 'system-fixture-credential-9Kw'}
        env.update(extra_env or {})
        result = subprocess.run(['bash', str(self.deploy / 'wall' / 'rehearsal.sh'), *args], env=env, text=True,
                                capture_output=True, timeout=180, stdin=subprocess.DEVNULL)
        return result, [json.loads(line) for line in self.calls.read_text().splitlines() if line.strip()]


class Rehearsal(unittest.TestCase):
    def setUp(self):
        if not REAL_DOCKER:
            self.skipTest('docker compose renders the copy\'s settings; no docker here')
        self.host = RehearsalHost(self)

    def test_up_builds_the_isolated_copy_and_only_reads_production(self):
        result, calls = self.host.run('up', SHA)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('copy faithful except the cluster id', result.stdout)
        self.assertIn('PASSED at ' + SHA, result.stdout)
        docker = [c['argv'] for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['compose']]
        production = [a for a in docker if a[:2] != ['compose', '-p']]
        self.assertTrue(production)
        for argv in production:
            verb = next(a for a in argv[1:] if not a.startswith('-') and '/' not in a)
            self.assertIn(verb, ('ps', 'exec'), argv)
            if verb == 'exec':
                script = argv[argv.index('-c') + 1]
                self.assertTrue('pg_dumpall' in script or 'pg_dump ' in script, script)
                self.assertIn('--roles-only --no-role-passwords', script) if 'pg_dumpall' in script else None
        for argv in docker:
            if argv[:2] == ['compose', '-p']:
                self.assertEqual(argv[2], 'swift-rehearsal')
                self.assertIn(str(self.host.deploy / 'docker-compose.rehearsal.yml'), argv)
        # Roles reached the copy filtered: groups only, never a login.
        rls = [c['argv'] for c in calls if c['tool'] == 'rls-logins']
        self.assertEqual([a[0] for a in rls], ['fingerprint', 'fingerprint', 'plan', 'apply', 'verify', 'verify'])
        for argv in rls[1:]:
            self.assertIn('swift-rehearsal', argv)
            self.assertIn('/etc/credstore.encrypted/swift-rehearsal', argv)
            self.assertIn('/run/swift-rehearsal-secrets', argv)
        self.assertNotIn('swift-rehearsal', rls[0])

    def test_every_secret_is_fresh_its_own_and_never_an_argument(self):
        result, calls = self.host.run('up', SHA)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        stored = [c for c in calls if c['tool'] == 'swift-secrets' and c['argv'][:1] == ['set']]
        names = sorted(c['argv'][1] for c in stored)
        generated = re.search(r'^GENERATED="(.*)"$', (DEPLOY / 'gen-secrets.sh').read_text(), re.M).group(1).split()
        # [AUD-G7-023] The api is hardwired to the emergency-policy signing key, so the copy stands one in too.
        self.assertEqual(names, sorted(generated + ['EMERGENCY_POLICY_SIGNING_KEY', 'SMTP_PASS', 'TWILIO_API_KEY_SECRET']))
        for c in calls:
            if c['tool'] == 'swift-secrets':
                self.assertEqual((c['env_store'], c['env_run']), ('/etc/credstore.encrypted/swift-rehearsal', '/run/swift-rehearsal-secrets'))
        values = [v for v in self.host.values.read_text().splitlines() if v]
        self.assertEqual(len(values), len(stored))
        self.assertEqual(len(set(values)), len(values))
        blob = self.host.calls.read_text() + result.stdout + result.stderr
        for value in values:
            self.assertNotIn(value, blob)
        self.assertEqual(sum(1 for c in calls if c['tool'] == 'swift-secrets' and c['argv'] == ['materialize']), 2)

    def test_refusals_before_anything_changes(self):
        cases = [
            ({'FAKE_UID': '0'}, 'run as the deploy user'),
            ({'FAKE_NO_IMAGE': '1'}, 'is not on this host'),
            ({'FAKE_REHEARSAL_PS': 'old-container'}, 'a rehearsal is already there'),
            ({'FAKE_STORE_EXISTS': '1'}, 'already exists'),
            ({'DOCKER_HOST': 'tcp://elsewhere:2375'}, 'DOCKER_HOST is set'),
        ]
        for env, message in cases:
            with self.subTest(message=message):
                result, calls = self.host.run('up', SHA, extra_env=env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)
                self.assertFalse([c for c in calls if c['tool'] == 'swift-secrets'])
                self.assertFalse([c for c in calls if c['tool'] == 'docker' and 'up' in c['argv']])
        result, _ = self.host.run('up', 'main')
        self.assertIn('full 40-character SHA', result.stderr)

    def test_a_copy_that_differs_from_its_source_switches_nothing(self):
        result, calls = self.host.run('up', SHA, extra_env={'FAKE_COPY_ACL': 'c' * 64})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('copy DIFFERS in aclDigest', result.stdout)
        self.assertFalse([c for c in calls if c['tool'] == 'rls-logins' and c['argv'][0] != 'fingerprint'])

    def test_a_boot_without_both_attestations_or_with_errors_fails(self):
        for logs, message in (('api | tenant wall: enforced role=swift_app_login', 'did not both attest'),
                              ('api | tenant wall: enforced\nworker | tenant wall: enforced\n'
                               'api | tenant wall: system login is a bypass member\nworker | tenant wall: system login is a bypass member\n'
                               'worker | TenantInUnboundTransactionError: tenant model in an unbound transaction', 'TenantInUnboundTransactionError or FATAL')):
            with self.subTest(message=message):
                result, _ = self.host.run('up', SHA, extra_env={'FAKE_LOGS': logs})
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(message, result.stderr)

    def test_passed_only_after_every_step_and_the_wall_through_the_real_logins(self):
        result, calls = self.host.run('up', SHA)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn(f'PASSED at {SHA}: every step held', result.stdout)
        self.assertIn('wall: walled rows seen unbound by swift_app_login=0, by swift_system_login=42', result.stdout)
        self.assertIn('boot: api running restarts=0', result.stdout)
        self.assertIn('boot: worker running restarts=0', result.stdout)
        self.assertNotIn('FAILED', result.stdout + result.stderr)
        # Each login on its own new connection inside the copy; its credential
        # only ever on stdin (the fake refuses any other passfile line).
        connects = [c['argv'] for c in calls if c['tool'] == 'docker' and 'PGPASSFILE' in ' '.join(c['argv'])]
        self.assertEqual(sorted({a[-2] for a in connects}), ['swift_app_login', 'swift_system_login'])
        self.assertTrue(all(a[:3] == ['compose', '-p', 'swift-rehearsal'] for a in connects))
        self.assertTrue(any(a[-1].startswith('ALTER TABLE') for a in connects))
        self.assertTrue(any(a[-1] == 'SET ROLE swift' for a in connects))
        blob = self.host.calls.read_text() + result.stdout + result.stderr
        for credential in ('app-fixture-credential-7Qx', 'system-fixture-credential-9Kw'):
            self.assertNotIn(credential, blob)

    def test_each_wired_provider_secret_gets_a_fresh_stand_in_of_the_shape_its_boot_guard_checks(self):
        """15 Oct, staging: every stand-in was 24 random bytes in hex, and the
        copy's API and worker crash-looped on assertSafeBootConfig (MMG checkout
        keys must be PEM, the SMS allowlist E.164): FATAL=24, no attestation.
        The names come from Compose's own rendering, so a quoted or `export`
        line in deploy/.env is stood in as well."""
        env_file = self.host.deploy / '.env'
        env_file.write_text('PILOT_ENV=staging\nNODE_ENV=loadtest\n'
                            'MMG_CHECKOUT_PUBLIC_KEY_FILE=/run/secrets/MMG_CHECKOUT_PUBLIC_KEY\n'
                            'MMG_CHECKOUT_PRIVATE_KEY_FILE="/run/secrets/MMG_CHECKOUT_PRIVATE_KEY"\n'
                            "export SMS_RECIPIENT_ALLOWLIST_FILE='/run/secrets/SMS_RECIPIENT_ALLOWLIST'\n"
                            'POWERTRANZ_ID_FILE=/run/secrets/POWERTRANZ_ID\n'
                            'POWERTRANZ_GATEWAY_KEY_FILE=/run/secrets/POWERTRANZ_GATEWAY_KEY\n'
                            'CW_ALERT_WEBHOOK_URL_FILE=/run/secrets/CW_ALERT_WEBHOOK_URL\n'
                            'SENTRY_DSN_FILE=/run/secrets/SENTRY_DSN\n'
                            'STRIPE_SECRET_KEY_FILE=/run/secrets/STRIPE_SECRET_KEY\n'
                            'MMG_API_KEY_FILE=/run/secrets/MMG_API_KEY\n')
        walled = {'FAKE_LOGS_API': 'api | tenant wall: enforced role=swift_app_login',
                  'FAKE_LOGS_WORKER': 'worker | tenant wall: enforced role=swift_app_login'}
        result, calls = self.host.run('up', SHA, extra_env=walled)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        stood_in = ['CW_ALERT_WEBHOOK_URL', 'EMERGENCY_POLICY_SIGNING_KEY', 'MMG_API_KEY', 'MMG_CHECKOUT_PRIVATE_KEY', 'MMG_CHECKOUT_PUBLIC_KEY',
                    'POWERTRANZ_GATEWAY_KEY', 'POWERTRANZ_ID', 'SENTRY_DSN', 'SMS_RECIPIENT_ALLOWLIST', 'STRIPE_SECRET_KEY']
        generated = re.search(r'^GENERATED="(.*)"$', (DEPLOY / 'gen-secrets.sh').read_text(), re.M).group(1).split()
        self.assertIn(f'secrets: {len(generated)} generated, {len(stood_in)} provider stand-ins', result.stdout)
        stored = {}
        for line in Path(str(self.host.values) + '.json').read_text().splitlines():
            row = json.loads(line)
            stored[row['name']] = row['value'][:-1] if row['value'].endswith('\n') else row['value']
        self.assertEqual(sorted(n for n in stored if n not in generated), stood_in)
        for name, kind in (('MMG_CHECKOUT_PUBLIC_KEY', 'PUBLIC KEY'), ('MMG_CHECKOUT_PRIVATE_KEY', 'PRIVATE KEY')):
            self.assertRegex(stored[name], rf'^-----BEGIN {kind}-----\n[A-Za-z0-9+/=\n]+\n-----END {kind}-----$', name)
            text = subprocess.run(['openssl', 'pkey', *(['-pubin'] if kind == 'PUBLIC KEY' else []), '-noout', '-text'],
                                  input=stored[name], text=True, capture_output=True, timeout=30).stdout
            self.assertRegex(text, r'\(4096 bit', name)
        self.assertEqual(stored['SMS_RECIPIENT_ALLOWLIST'], '+5920000000')
        self.assertRegex(stored['POWERTRANZ_ID'], r'^[0-9a-f]{16}$')
        self.assertRegex(stored['POWERTRANZ_GATEWAY_KEY'], r'^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
        self.assertRegex(stored['CW_ALERT_WEBHOOK_URL'], r'^https://rehearsal\.invalid/[0-9a-f]{32}$')
        self.assertRegex(stored['SENTRY_DSN'], r'^https://[0-9a-f]{32}@rehearsal\.invalid/1$')
        self.assertRegex(stored['STRIPE_SECRET_KEY'], r'^sk_test_[0-9a-f]{48}$')
        self.assertRegex(stored['MMG_API_KEY'], r'^[0-9a-f]{48}$')
        # [AUD-G7-023] 48 characters: over the API's 32-character floor, so the copy's api boots and signs.
        self.assertRegex(stored['EMERGENCY_POLICY_SIGNING_KEY'], r'^[0-9a-f]{48}$')
        # Fresh on every run, and never an argument or a printed line.
        first = dict(stored)
        result, _ = self.host.run('up', SHA, extra_env=walled)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        again = {json.loads(l)['name']: json.loads(l)['value'] for l in Path(str(self.host.values) + '.json').read_text().splitlines()}
        for name in stood_in:
            if name != 'SMS_RECIPIENT_ALLOWLIST':  # the one fixed, fictional number
                self.assertNotEqual(first[name], again[name].rstrip('\n'), name)
        blob = self.host.calls.read_text() + result.stdout + result.stderr
        for name in stood_in:
            if name != 'SMS_RECIPIENT_ALLOWLIST':
                self.assertNotIn(again[name].strip().splitlines()[-1], blob, name)

    def test_a_failed_boot_keeps_the_copys_logs_redacted_and_prints_the_first_fatal_lines(self):
        """The copy's logs went with the copy (journeys-on-copy removes it), so
        FATAL=24 could not be read. Now the last 400 lines of each process are
        kept, redacted, and the first 20 FATAL lines are in the run's own log."""
        # Built at run time: no secret-shaped literal sits in this source (the secret scanners read it).
        signing = base64.b64encode(b'synthetic signing value 0123456789').decode().rstrip('=')
        key_body = base64.b64encode(b'synthetic key material for the redaction test').decode()
        pem = ('-----' + 'BEGIN ' + 'PRIVATE KEY' + '-----', '-----' + 'END ' + 'PRIVATE KEY' + '-----')
        cred, bearer = 'app-fixture-' + 'credential-7Qx', 'tok-' + '0123456789-abcdef'
        secret_lines = [f'connect postgresql://swift_app_login:{cred}@postgres:5432/swift failed',
                        f'GET /x authorization: Bearer {bearer}', 'JWT_' + 'SECRET=' + signing,
                        'text to +5926123456 for owner.name@example.gy', pem[0], key_body, pem[1]]
        def log(svc, problem):
            lines = [f'{svc}-1  | boot noise {i}' for i in range(260)]
            for i in range(1, 26):
                lines.append(f'{svc}-1  | Failed to start server: Error: FATAL: {problem} Refusing to start. (start {i})')
                lines += [f'{svc}-1  | {line}' for line in secret_lines]
            return '\n'.join(lines + [f'{svc}-1  | last line'])
        results = self.host.tmp / 'results' / 'run-1'
        result, calls = self.host.run('up', SHA, extra_env={
            'REHEARSAL_RESULTS_DIR': str(results),
            'FAKE_LOGS_API': log('api', 'MMG_CHECKOUT_PUBLIC_KEY is not a readable RSA public key (PEM).'),
            'FAKE_LOGS_WORKER': log('worker', 'SMS_RECIPIENT_ALLOWLIST entry 1 is not an E.164 number (+ and digits).')})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('REHEARSAL FAILED at step: boot', result.stderr)
        self.assertIn('did not both attest', result.stderr)
        self.assertEqual(oct(results.stat().st_mode & 0o777), '0o700')
        for svc in ('api', 'worker'):
            saved = (results / f'{svc}.log').read_text()
            self.assertEqual(oct((results / f'{svc}.log').stat().st_mode & 0o777), '0o600')
            self.assertEqual(len(saved.splitlines()), 400, svc)
            self.assertTrue(saved.rstrip().endswith(f'{svc}-1  | last line'))
            self.assertIn('Error: FATAL:', saved)
            saves = [c['argv'] for c in calls if c['tool'] == 'docker' and 'logs' in c['argv'] and '--tail' in c['argv'] and c['argv'][-1] == svc]
            self.assertEqual(len(saves), 1, svc)
            self.assertEqual(saves[0][saves[0].index('--tail') + 1], '400')
        # The run's own log: where the logs are, then the first 20 FATAL lines (the api's first), redacted.
        err = result.stderr.splitlines()
        self.assertIn(f'rehearsal: logs: the copy\'s api and worker logs (last 400 lines each, redacted) are in {results}', err)
        at = err.index('rehearsal: the first FATAL lines (redacted):')
        printed = err[at + 1:at + 21]
        self.assertEqual(len([l for l in err[at + 1:] if 'FATAL' in l and l.startswith('  ')]), 20)
        self.assertTrue(all(l.startswith('  api-1  | Failed to start server: Error: FATAL: MMG_CHECKOUT_PUBLIC_KEY') for l in printed), printed)
        self.assertLess(at, next(i for i, l in enumerate(err) if l.startswith('REHEARSAL FAILED')))
        blob = result.stdout + result.stderr + (results / 'api.log').read_text() + (results / 'worker.log').read_text()
        for leak in (cred, bearer, signing, '+5926123456',
                     '6123456', 'owner.name@example.gy', key_body, 'BEGIN ' + 'PRIVATE'):
            self.assertNotIn(leak, blob)
        self.assertIn('[redacted: key material]', (results / 'api.log').read_text())

    def test_a_passing_run_keeps_the_logs_too_and_a_refused_run_starts_nothing_to_keep(self):
        results = self.host.tmp / 'results' / 'run-2'
        result, _ = self.host.run('up', SHA, extra_env={'REHEARSAL_RESULTS_DIR': str(results)})
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('tenant wall: enforced', (results / 'api.log').read_text())
        self.assertIn('tenant wall: enforced', (results / 'worker.log').read_text())
        self.assertNotIn('the first FATAL lines', result.stderr)
        refused = self.host.tmp / 'results' / 'run-3'
        result, calls = self.host.run('up', SHA, extra_env={'REHEARSAL_RESULTS_DIR': str(refused), 'FAKE_NO_IMAGE': '1'})
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(refused.exists())
        self.assertFalse([c for c in calls if c['tool'] == 'docker' and 'logs' in c['argv']])
        # Without a directory named, the deploy user's own ~/swift-rehearsal/rehearsal-<UTC>.
        result, _ = self.host.run('up', SHA)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        kept = list((self.host.tmp / 'swift-rehearsal').glob('rehearsal-*/api.log'))
        self.assertEqual(len(kept), 1, kept)
        self.assertRegex(kept[0].parent.name, r'^rehearsal-\d{8}T\d{6}Z$')

    def test_any_step_that_does_not_hold_fails_the_run_and_names_it(self):
        both = 'tenant wall: enforced role=swift_app_login\ntenant wall: system login is a bypass member'
        cases = [
            ({'FAKE_STATE_api_id': 'running restarts=1'}, 'boot', 'api is not running cleanly'),
            ({'FAKE_STATE_worker_id': 'exited restarts=0'}, 'boot', 'worker is not running cleanly'),
            # The api attested twice (it restarted), the worker never: the old combined count passed this.
            ({'FAKE_LOGS_API': f'{both}\n{both}', 'FAKE_LOGS_WORKER': 'worker | starting'}, 'boot', 'did not both attest'),
            ({'FAKE_LOGS_WORKER': 'worker | tenant wall: enforced role=swift_app_login'}, 'boot', 'did not both attest'),
            ({'FAKE_ROWS_SWIFT_APP_LOGIN': '3'}, 'wall', 'sees 3 walled rows'),
            ({'FAKE_ROWS_SWIFT_SYSTEM_LOGIN': '0'}, 'wall', 'sees no walled row'),
            ({'FAKE_ALTER_OK': '1'}, 'wall', 'could ALTER a walled table'),
            ({'FAKE_SET_ROLE_OK': '1'}, 'wall', 'could become the database owner'),
            ({'FAKE_OWNER': 'swift; DROP'}, 'wall', 'not a plain role name'),
            # The api's URL file names another login (the owner): no passfile line is made for it.
            ({'FAKE_URL_USER_DATABASE_URL': 'swift'}, 'wall', 'the request login could not count the walled rows'),
        ]
        for env, step, message in cases:
            with self.subTest(message=message, env=sorted(env)):
                result, _ = self.host.run('up', SHA, extra_env=env)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn(message, result.stdout + result.stderr)
                self.assertIn(f'REHEARSAL FAILED at step: {step}', result.stderr)
                self.assertNotIn('PASSED', result.stdout)

    def test_a_non_production_host_needs_each_process_walled_but_not_the_production_only_line(self):
        """The system login's own boot attestation runs only in production mode
        (boot/system-login.ts), so a staging host (NODE_ENV=development) shows
        the enforced line only; each process must still show it."""
        env_file = self.host.deploy / '.env'
        env_file.write_text(env_file.read_text().replace('PILOT_ENV=production\nNODE_ENV=production', 'PILOT_ENV=staging\nNODE_ENV=development'))
        walled = {'FAKE_LOGS_API': 'api | tenant wall: enforced role=swift_app_login',
                  'FAKE_LOGS_WORKER': 'worker | tenant wall: enforced role=swift_app_login'}
        result, _ = self.host.run('up', SHA, extra_env=walled)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn('(mode development)', result.stdout)
        result, _ = self.host.run('up', SHA, extra_env={**walled, 'FAKE_LOGS_WORKER': 'worker | starting'})
        self.assertNotEqual(result.returncode, 0)
        self.assertIn('REHEARSAL FAILED at step: boot', result.stderr)

    def test_down_removes_only_the_rehearsal(self):
        result, calls = self.host.run('down')
        self.assertEqual(result.returncode, 0, result.stderr)
        docker = [c['argv'] for c in calls if c['tool'] == 'docker' and c['argv'][:1] == ['compose']]
        self.assertEqual(len(docker), 1)
        self.assertEqual(docker[0][:3], ['compose', '-p', 'swift-rehearsal'])
        self.assertIn('down', docker[0])
        removals = [c['argv'] for c in calls if c['tool'] == 'sudo' and ' rm ' in f" {c['argv']} "]
        self.assertEqual(removals, ['-n rm -rf -- /etc/credstore.encrypted/swift-rehearsal /run/swift-rehearsal-secrets'])

    def test_the_role_filter_keeps_groups_and_refuses_the_unknown(self):
        groups = ['swift_app', 'swift_bypass_rls', 'swift_audit_purge_owner', 'swift_audit_purge_executor']
        dump = ('SET default_transaction_read_only = off;\nCREATE ROLE swift;\nALTER ROLE swift WITH SUPERUSER LOGIN;\n'
                + ''.join(f'CREATE ROLE {g};\nALTER ROLE {g} WITH NOSUPERUSER NOLOGIN NOBYPASSRLS;\n' for g in groups)
                + 'CREATE ROLE swift_app_login;\nGRANT swift_app TO swift_app_login WITH INHERIT TRUE GRANTED BY swift;\n'
                  'GRANT swift_audit_purge_owner TO swift_audit_purge_executor WITH INHERIT FALSE GRANTED BY swift;\n')
        run = lambda text, names=groups: subprocess.run(['python3', '-I', str(DEPLOY / 'wall' / 'rehearsal-roles.py'), *names],
                                                        input=text, text=True, capture_output=True, timeout=30)
        result = run(dump)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn('swift_app_login', result.stdout)
        self.assertNotIn('ROLE swift;', result.stdout)
        self.assertNotIn('SUPERUSER LOGIN', result.stdout)
        self.assertIn('GRANT swift_audit_purge_owner TO swift_audit_purge_executor', result.stdout)
        self.assertEqual(len(result.stdout.strip().splitlines()), 9)
        for bad in (dump + "ALTER ROLE swift_app SET search_path = 'x';\n", dump + 'COMMENT ON ROLE swift_app IS $$x$$;\n',
                    dump.replace('CREATE ROLE swift_bypass_rls;\n', '')):
            self.assertEqual(run(bad).returncode, 1)

    def test_the_owner_wall_group_is_copied_when_present_and_never_its_members(self):
        """[item 20] swift_owner_wall exists once the owner wall's migrations ran and its policies name it: the copy
        gets the role (else every owner-walled read errors), never a member (Phase C grants none), and a source
        without it still copies."""
        groups = ['swift_app', 'swift_bypass_rls', 'swift_audit_purge_owner', 'swift_audit_purge_executor']
        base = ''.join(f'CREATE ROLE {g};\nALTER ROLE {g} WITH NOSUPERUSER NOLOGIN NOBYPASSRLS;\n' for g in groups)
        wall = ('CREATE ROLE swift_owner_wall;\nALTER ROLE swift_owner_wall WITH NOSUPERUSER INHERIT NOLOGIN NOBYPASSRLS;\n'
                'CREATE ROLE swift_app_login;\nGRANT swift_owner_wall TO swift_app_login WITH INHERIT TRUE GRANTED BY swift;\n')
        run = lambda text, names: subprocess.run(['python3', '-I', str(DEPLOY / 'wall' / 'rehearsal-roles.py'), *names],
                                                 input=text, text=True, capture_output=True, timeout=30)
        result = run(base + wall, [*groups, '--optional', 'swift_owner_wall'])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn('CREATE ROLE swift_owner_wall;', result.stdout)
        self.assertNotIn('GRANT swift_owner_wall', result.stdout)
        self.assertNotIn('swift_app_login', result.stdout)
        absent = run(base, [*groups, '--optional', 'swift_owner_wall'])
        self.assertEqual(absent.returncode, 0, absent.stderr)
        self.assertNotIn('swift_owner_wall', absent.stdout)
        # Without the option the role is dropped as any other; a bare --optional is refused.
        self.assertNotIn('swift_owner_wall', run(base + wall, groups).stdout)
        self.assertEqual(run(base, [*groups, '--optional']).returncode, 1)
        self.assertIn('--optional $OPTIONAL_GROUPS', (DEPLOY / 'wall' / 'rehearsal.sh').read_text())
        self.assertIn('OPTIONAL_GROUPS="swift_owner_wall"', (DEPLOY / 'wall' / 'rehearsal.sh').read_text())


# ── doctor.sh ──────────────────────────────────────────────────────────────
class RedactLog(unittest.TestCase):
    """deploy/wall/redact-log.py on its own: what a kept copy log may never
    carry, and what it must keep so a failure can still be read. Values are
    built at run time so no secret-shaped literal sits in this source."""

    def redact(self, lines):
        result = subprocess.run(['python3', '-I', str(DEPLOY / 'wall' / 'redact-log.py')], input='\n'.join(lines) + '\n',
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result.stdout

    def test_secret_names_personal_fields_bare_numbers_and_url_passwords_never_survive(self):
        word = 'hunter' + '2' + 'secret'
        cases = [
            ('SMTP_' + 'PASS=' + word, word),
            ('{"smtp' + 'Pass":"' + word + '"}', word),
            ('MMG_' + 'MSECRET_' + 'PASS_FILE=' + word, word),
            ('{"pass' + 'phrase":"' + word + '"}', word),
            ('{"private' + 'Material":"' + word + '"}', word),
            ('{"pin":"4821"}', '4821'),
            ('delivery PIN: 4821 for the order', '4821'),
            ('user phone 6123456 not found', '6123456'),
            ('{"phone":"6123456"}', '6123456'),
            ('{"msisdn":"5926123456"}', '6123456'),
            ('{"name":"Jane Doe","address":"12 Main St"}', 'Jane Doe'),
            ('{"name":"Jane Doe","address":"12 Main St"}', '12 Main St'),
            ('{"firstName":"Jane","lastName":"Doe","street":"Main St"}', 'Doe'),
            ('{"email":"jane.doe@example.gy"}', 'jane.doe'),
            ('connect redis://:' + 'p@ss' + '@redis:6379 failed', 'ss@redis'),
            ('connect redis://:' + 'p@ss' + '@redis:6379 failed', 'p@'),
            ('connect postgresql://swift:' + 'ab/cd' + '@postgres:5432/swift failed', 'ab/cd'),
        ]
        for line, leak in cases:
            with self.subTest(line=line):
                self.assertNotIn(leak, self.redact([line]))

    def test_what_failed_and_where_still_reads(self):
        keep = ['api-1  | Failed to start server: Error: FATAL: MMG_CHECKOUT_PUBLIC_KEY is not a readable RSA public key (PEM). Refusing to start.',
                'worker-1  | {"level":30,"msg":"tenant wall: enforced role=swift_app_login tenantTables=131 rlsDisabled=0 ownedUnforced=0"}',
                'api-1  | {"level":30,"req":{"method":"GET","url":"/api/v1/customer/orders"},"msg":"incoming request"}',
                'api-1  | FATAL: SMS_RECIPIENT_ALLOWLIST entry 1 is not an E.164 number (+ and digits). Refusing to start rather than texting no one by mistake.',
                'api-1  | {"passengers":3,"shipping":"standard","statusCode":503}']
        out = self.redact(keep).splitlines()
        self.assertEqual(out, keep)
        # A connection URL keeps its host and port, only the credential goes.
        self.assertEqual(self.redact(['connect redis://:' + 'p@ss' + '@redis:6379 failed']).strip(), 'connect redis://[redacted]@redis:6379 failed')


class DoctorWallPosture(unittest.TestCase):
    def run_doctor(self, settings, env_names, roles_hold=True, owner_wall_members=''):
        tmp = Path(tempfile.mkdtemp(prefix='swift-wall-doctor-'))
        self.addCleanup(shutil.rmtree, tmp, True)
        deploy = tmp / 'deploy'
        deploy.mkdir()
        shutil.copy(DEPLOY / 'doctor.sh', deploy / 'doctor.sh')
        shutil.copy(DEPLOY / 'docker-compose.yml', deploy / 'docker-compose.yml')
        (deploy / '.env').write_text(settings)
        shim(deploy, 'rls-logins.sh', 'echo \'{"status": "roles_hold"}\'' if roles_hold else
             'echo \'{"status": "hold", "reason": "LOGINS_MISSING"}\'; exit 1')
        bin_dir = tmp / 'bin'
        bin_dir.mkdir()
        env_lines = '\\n'.join(env_names)
        shim(bin_dir, 'docker', 'case "$*" in\n'
             f'  *swift_owner_wall*) printf "{owner_wall_members}" ;;\n'
             '  *"ps -q api"*|*"ps -q worker"*|*"ps -q postgres"*|*"ps -q redis"*) echo some-id ;;\n'
             f'  *"range .Config.Env"*) printf "{env_lines}\\n" ;;\n'
             '  *RestartPolicy*) echo unless-stopped ;;\n'
             '  *State.Status*) echo running ;;\n'
             'esac\nexit 0')
        shim(bin_dir, 'curl', 'exit 7')
        shim(bin_dir, 'systemctl', 'exit 0')
        shim(bin_dir, 'gh', 'exit 1')
        result = subprocess.run(['bash', str(deploy / 'doctor.sh')], text=True, capture_output=True, timeout=120,
                                env={'PATH': f'{bin_dir}:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(tmp)}, stdin=subprocess.DEVNULL)
        return result.stdout

    def test_the_contract_posture_is_checked_by_name_never_by_value(self):
        good = ['DATABASE_URL_FILE=/run/secrets/DATABASE_URL', 'SYSTEM_DATABASE_URL_FILE=/run/secrets/SYSTEM_DATABASE_URL',
                'POSTGRES_PASSWORD_FILE=', 'TENANT_RLS_BIND=1']
        out = self.run_doctor('TENANT_RLS_BIND=1\n', good)
        self.assertIn('ok    the least-privilege logins hold their contract', out)
        self.assertIn('ok    api runs on the least-privilege logins', out)
        self.assertIn('ok    worker runs on the least-privilege logins', out)
        owner = good[:2] + ['POSTGRES_PASSWORD_FILE=/run/secrets/POSTGRES_PASSWORD']
        out = self.run_doctor('TENANT_RLS_BIND=1\n', owner, roles_hold=False)
        self.assertIn("FAIL  api still carries the database owner's password setting", out)
        self.assertIn('FAIL  the least-privilege logins do not hold their contract', out)
        self.assertNotIn('/run/secrets/POSTGRES_PASSWORD', out)
        out = self.run_doctor('PILOT_ENV=staging\n', owner)
        self.assertNotIn('least-privilege', out)

    def test_the_owner_wall_stays_off_until_its_own_switch(self):
        """[item 20] No OWNER_RLS_BIND line and no member of swift_owner_wall: either is a FAIL, by count, never a name."""
        good = ['DATABASE_URL_FILE=/run/secrets/DATABASE_URL', 'SYSTEM_DATABASE_URL_FILE=/run/secrets/SYSTEM_DATABASE_URL',
                'POSTGRES_PASSWORD_FILE=', 'TENANT_RLS_BIND=1']
        out = self.run_doctor('TENANT_RLS_BIND=1\n', good, owner_wall_members='0')
        self.assertIn('ok    no database role is a member of swift_owner_wall', out)
        self.assertNotIn('OWNER_RLS_BIND', out)
        out = self.run_doctor('TENANT_RLS_BIND=1\nOWNER_RLS_BIND=1\n', good, owner_wall_members='1')
        self.assertIn('FAIL  deploy/.env sets OWNER_RLS_BIND', out)
        self.assertIn('FAIL  1 database role(s) are members of swift_owner_wall', out)
        self.assertNotIn('swift_app_login', out)


if __name__ == '__main__':
    unittest.main()
