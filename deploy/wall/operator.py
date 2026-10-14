"""[TA-S0-003 · R2] The operator adapter for the login planner (logins.py).

    deploy/rls-logins.sh fingerprint
    deploy/rls-logins.sh plan    --approved-target-file FILE
    deploy/rls-logins.sh apply   --approved-target-file FILE
    deploy/rls-logins.sh verify  --approved-target-file FILE
    deploy/rls-logins.sh roles

What each port does, on the host that runs the stack:
- census: census.sql through `docker compose exec -T postgres` as the
  migration owner. Names, counts, booleans and digests only.
- read/prepare/publish: the encrypted host store. Writes are
  `sudo -n swift-secrets set NAME` with the value on stdin; reads are
  `sudo -n systemd-creds decrypt --name=NAME STORE/NAME.cred -` into this
  process's memory. The journal RLS_LOGIN_<LOGIN> holds the credential and
  the approved target; the published names are the ones the API reads,
  DATABASE_URL and SYSTEM_DATABASE_URL (R3 wires them as *_FILE).
- create: one transaction as the migration owner, statement logging off for
  it; the password is replaced by a SCRAM-SHA-256 verifier computed here, so
  the server never receives the password itself. GRANT swift_app (and
  swift_bypass_rls for the system login), nothing else.
- connect: a NEW TCP connection from inside the postgres container to the
  service name (127.0.0.1 is `trust` in that image, so it would prove
  nothing), the password in a 0600 file on the container's tmpfs, fed on
  stdin. A wrong password must be refused first, or nothing is believed.

A password never appears in an argument, an environment variable, a log or
this program's output. Every refusal is a constant code. One run at a time
(an exclusive lock), and every child process gets a clean environment.
`verify` is pinned to the approved target (migration head and digests
included), so it holds only in the apply window; later deploys run `roles`,
the same role contract without the target pin.
"""
import argparse
import base64
import fcntl
import hashlib
import hmac
import importlib.util
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import sys
from urllib.parse import quote, unquote, urlsplit

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location('wall_logins', HERE / 'logins.py')
logins = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(logins)
Refusal = logins.Refusal
require = logins.require

JOURNAL = {'swift_app_login': 'RLS_LOGIN_SWIFT_APP_LOGIN', 'swift_system_login': 'RLS_LOGIN_SWIFT_SYSTEM_LOGIN'}
PUBLISHED = {'swift_app_login': 'DATABASE_URL', 'swift_system_login': 'SYSTEM_DATABASE_URL'}
PARENTS = {'swift_app_login': ['swift_app'], 'swift_system_login': ['swift_app', 'swift_bypass_rls']}
DB_HOST, DB_PORT = 'postgres', 5432
DEFAULT_STORE = '/etc/credstore.encrypted/swift'
DEFAULT_LOCK = '/run/lock/swift-rls-logins.lock'
SCRAM_ITERATIONS = 4096
TIMEOUT = 120

# Run inside the postgres container as the migration owner (the A4 / C1b shape).
OWNER_PSQL = ('export PGPASSWORD="$(cat "$POSTGRES_PASSWORD_FILE")"; '
              'exec psql -h 127.0.0.1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -X -q -tA -v ON_ERROR_STOP=1')

# The new-connection probe. The passfile line arrives on stdin and lives only
# in a 0600 file on the container's tmpfs for the length of one psql call. The
# login name comes from a closed set (LOGINS) and is passed as $1, never
# spliced into the script.
CONNECT_SCRIPT = r'''set -eu
umask 077
f="$(mktemp /dev/shm/rls-login.XXXXXX)"
trap 'rm -f "$f"' EXIT
cat > "$f"
PGPASSFILE="$f" psql "host=postgres port=5432 dbname=$POSTGRES_DB user=$1 sslmode=disable connect_timeout=10" -X -q -tA -v ON_ERROR_STOP=1 -c "$2"
'''

# What the login itself sees on its own connection. The verdicts mirror
# apps/api/src/lib/rls-attestation.ts (superuser, BYPASSRLS, swift_bypass_rls
# membership, RLS disabled, owned and not forced), plus one it cannot see from
# flags alone: membership of a role that owns a table or function in the
# walled schemas (an owner member can switch the wall off).
FACTS_SQL = ' '.join('''
WITH me AS (SELECT r.rolsuper, r.rolbypassrls FROM pg_roles r WHERE r.rolname = current_user),
bypass AS (SELECT coalesce((SELECT pg_has_role(current_user, b.oid, 'MEMBER') FROM pg_roles b
                            WHERE b.rolname = 'swift_bypass_rls'), false) AS member),
tenant AS (SELECT c.relrowsecurity, c.relforcerowsecurity, c.relowner FROM pg_class c
             JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
            WHERE c.relkind = 'r' AND EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid = c.oid
                                                AND a.attname = 'tenantId' AND NOT a.attisdropped)),
owners AS (SELECT c.relowner AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname IN ('public', 'swift_qr')
           UNION SELECT p.proowner FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname IN ('public', 'swift_qr')),
f AS (SELECT (SELECT count(*) FROM me) = 1 AS resolved,
             coalesce((SELECT rolsuper FROM me), true) AS super,
             coalesce((SELECT rolbypassrls FROM me), true) AS bypassrls,
             (SELECT member FROM bypass) AS bypass_member,
             (SELECT count(*) FROM tenant) AS tenant_tables,
             (SELECT count(*) FROM tenant WHERE NOT relrowsecurity) AS disabled,
             (SELECT count(*) FROM tenant WHERE relrowsecurity AND NOT relforcerowsecurity
                AND pg_get_userbyid(relowner) = current_user) AS owned_unforced,
             EXISTS (SELECT 1 FROM owners o WHERE pg_has_role(current_user, o.owner, 'MEMBER')) AS owner_member)
SELECT json_build_object(
  'sessionUser', session_user::text, 'currentUser', current_user::text, 'database', current_database()::text,
  'requestWallEnforced', resolved AND NOT super AND NOT bypassrls AND NOT bypass_member AND tenant_tables > 0
                         AND disabled = 0 AND owned_unforced = 0 AND NOT owner_member,
  'systemCapabilityMember', resolved AND bypass_member AND NOT super AND NOT bypassrls AND NOT owner_member)
FROM f
'''.split())


def scram_verifier(password, salt=None, iterations=SCRAM_ITERATIONS):
    """The SCRAM-SHA-256 verifier PostgreSQL stores (RFC 5802/7677). The
    password is ASCII (token_urlsafe), so SASLprep leaves it unchanged."""
    require(type(password) is str and password.isascii() and password.isprintable() and bool(password),
            'CREDENTIAL_SHAPE_INVALID')
    salt = salt if salt is not None else os.urandom(16)
    salted = hashlib.pbkdf2_hmac('sha256', password.encode('ascii'), salt, iterations)
    client_key = hmac.new(salted, b'Client Key', 'sha256').digest()
    server_key = hmac.new(salted, b'Server Key', 'sha256').digest()
    b64 = lambda raw: base64.b64encode(raw).decode('ascii')
    return f'SCRAM-SHA-256${iterations}:{b64(salt)}${b64(hashlib.sha256(client_key).digest())}:{b64(server_key)}'


def create_sql(name, verifier):
    """One transaction: the role and its memberships, nothing else. Statement
    and error logging are off for it, so the verifier never reaches the log."""
    require(name in logins.LOGINS, 'LOGIN_UNKNOWN')
    require(verifier.startswith('SCRAM-SHA-256$') and "'" not in verifier and '\\' not in verifier,
            'VERIFIER_INVALID')
    grants = ''.join(f'GRANT {parent} TO {name};\n' for parent in PARENTS[name])
    return ('BEGIN;\n'
            "SET LOCAL log_statement = 'none';\n"
            'SET LOCAL log_min_duration_statement = -1;\n'
            "SET LOCAL log_min_error_statement = 'panic';\n"
            f'CREATE ROLE {name} WITH LOGIN INHERIT NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE '
            f"NOREPLICATION PASSWORD '{verifier}';\n"
            f'{grants}COMMIT;\n')


def passfile_line(name, database, credential):
    esc = lambda value: value.replace('\\', '\\\\').replace(':', '\\:')
    return f'{DB_HOST}:{DB_PORT}:{esc(database)}:{esc(name)}:{esc(credential)}\n'


def published_url(name, database, credential):
    return f'postgresql://{quote(name, safe="")}:{quote(credential, safe="")}@{DB_HOST}:{DB_PORT}/{quote(database, safe="")}'


def parse_published(raw):
    """(user, password, host, port, database), or None when it is not one URL of that shape."""
    try:
        parts = urlsplit(raw)
        if parts.scheme != 'postgresql' or parts.query or parts.fragment or parts.username is None:
            return None
        return (unquote(parts.username), unquote(parts.password or ''), parts.hostname, parts.port,
                unquote(parts.path[1:]) if parts.path.startswith('/') else None)
    except ValueError:
        return None


class HostPorts:
    """The concrete ports logins.apply/verify call. Nothing here prints."""

    def __init__(self, compose, store_dir, store_env, approved=None):
        self.compose = compose
        self.store_dir = store_dir
        self.store_env = store_env  # ['env', 'SWIFT_SECRETS_STORE_DIR=…'] for a non-default store, else []
        self.approved = approved
        self.child_env = {k: os.environ[k] for k in ('PATH', 'HOME', 'LANG') if k in os.environ}
        self.store_bin = None

    def _run(self, argv, stdin, code):
        try:
            result = subprocess.run(argv, input=stdin, capture_output=True, text=True, env=self.child_env,
                                    timeout=TIMEOUT, check=False)
        except (OSError, subprocess.SubprocessError):
            raise Refusal(code) from None
        if result.returncode != 0:
            raise Refusal(code)
        return result.stdout

    def _exec(self, script, stdin, code, *args):
        return self._run([*self.compose, 'exec', '-T', 'postgres', 'sh', '-c', script, 'sh', *args], stdin, code)

    def docker_ready(self):
        context = self._run(['docker', 'context', 'show'], '', 'DOCKER_CONTEXT_UNKNOWN').strip()
        require(context == 'default', 'DOCKER_CONTEXT_NOT_DEFAULT')

    # ── catalogue ────────────────────────────────────────────────────────
    def census(self):
        out = self._exec(OWNER_PSQL, (HERE / 'census.sql').read_text(encoding='utf-8'), 'CENSUS_FAILED')
        lines = [line for line in out.splitlines() if line.strip()]
        require(len(lines) == 1, 'CENSUS_UNKNOWN')
        try:
            catalogue = json.loads(lines[0])
        except ValueError:
            raise Refusal('CENSUS_UNKNOWN') from None
        require(type(catalogue) is dict, 'CENSUS_UNKNOWN')
        return catalogue

    # ── encrypted store ──────────────────────────────────────────────────
    def _store(self):
        """The store tool on the child PATH (production: /usr/local/sbin), else this checkout's copy."""
        if self.store_bin is None:
            self.store_bin = shutil.which('swift-secrets', path=self.child_env.get('PATH', '')) or str(HERE.parent / 'swift-secrets')
            require(os.access(self.store_bin, os.X_OK), 'STORE_TOOL_MISSING')
        return self.store_bin

    def _names(self):
        out = self._run(['sudo', '-n', *self.store_env, self._store(), 'list'], '', 'STORE_LIST_FAILED')
        return set(out.split())

    def _decrypt(self, store_name):
        if store_name not in self._names():
            return None
        value = self._run(['sudo', '-n', 'systemd-creds', 'decrypt', f'--name={store_name}',
                           os.path.join(self.store_dir, store_name + '.cred'), '-'], '', 'STORE_READ_FAILED')
        require(value != '', 'STORE_READ_FAILED')
        return value

    def _set(self, store_name, value):
        self._run(['sudo', '-n', *self.store_env, self._store(), 'set', store_name], value, 'STORE_WRITE_FAILED')

    def _journal(self, name):
        raw = self._decrypt(JOURNAL[name])
        if raw is None:
            return None
        try:
            journal = json.loads(raw)
        except ValueError:
            raise Refusal('CREDENTIAL_JOURNAL_INVALID') from None
        require(type(journal) is dict and set(journal) == {'credential', 'target'}, 'CREDENTIAL_JOURNAL_INVALID')
        return journal

    def read(self, name):
        if not name.endswith(':published'):
            require(name in logins.LOGINS, 'LOGIN_UNKNOWN')
            return self._journal(name)
        login = name[:-len(':published')]
        require(login in logins.LOGINS, 'LOGIN_UNKNOWN')
        raw = self._decrypt(PUBLISHED[login])
        if raw is None:
            return None
        journal = self._journal(login)
        parsed = parse_published(raw)
        # Anything but this login's URL at the service name, for the approved
        # database, compares unequal to the journal: the planner refuses it.
        if (journal is None or parsed is None or parsed[0] != login or parsed[2] != DB_HOST
                or parsed[3] != DB_PORT or parsed[4] != self.approved.get('database')):
            return {'credential': None, 'target': None}
        return {'credential': parsed[1], 'target': journal['target']}

    def prepare(self, name):
        require(name in logins.LOGINS, 'LOGIN_UNKNOWN')
        require(JOURNAL[name] not in self._names(), 'JOURNAL_ALREADY_PRESENT')
        prepared = {'credential': secrets.token_urlsafe(32), 'target': self.approved}
        self._set(JOURNAL[name], json.dumps(prepared, sort_keys=True))
        require(self._journal(name) == prepared, 'PREPARED_CREDENTIAL_NOT_DURABLE')
        return prepared

    def publish(self, name, secret):
        url = published_url(name, self.approved['database'], secret['credential'])
        if self._decrypt(PUBLISHED[name]) == url:
            return  # already published: a re-run writes nothing
        self._set(PUBLISHED[name], url)
        require(self._decrypt(PUBLISHED[name]) == url, 'PUBLICATION_NOT_DURABLE')

    # ── the database ─────────────────────────────────────────────────────
    def create(self, name, secret):
        self._exec(OWNER_PSQL, create_sql(name, scram_verifier(secret['credential'])), 'CREATE_FAILED')

    def _login(self, name, credential):
        line = passfile_line(name, self.approved['database'], credential)
        try:
            result = subprocess.run([*self.compose, 'exec', '-T', 'postgres', 'sh', '-c', CONNECT_SCRIPT, 'sh',
                                     name, FACTS_SQL], input=line, capture_output=True, text=True,
                                    env=self.child_env, timeout=TIMEOUT, check=False)
        except (OSError, subprocess.SubprocessError):
            raise Refusal('CONNECTION_PROBE_FAILED') from None
        return result

    def connect(self, name, secret):
        require(name in logins.LOGINS, 'LOGIN_UNKNOWN')
        # Negative control: a wrong password on the same path must be refused,
        # by password authentication, or this path proves nothing.
        wrong = self._login(name, secrets.token_urlsafe(32))
        require(wrong.returncode != 0 and 'password authentication failed' in wrong.stderr,
                'NEGATIVE_CONTROL_NOT_REFUSED')
        right = self._login(name, secret['credential'])
        require(right.returncode == 0, 'CONNECTION_REFUSED')
        lines = [line for line in right.stdout.splitlines() if line.strip()]
        require(len(lines) == 1, 'CONNECTION_FACTS_UNKNOWN')
        try:
            facts = json.loads(lines[0])
        except ValueError:
            raise Refusal('CONNECTION_FACTS_UNKNOWN') from None
        require(type(facts) is dict and facts.get('database') == self.approved['database'],
                'CONNECTION_DATABASE_MISMATCH')
        return facts


def target_of(catalogue):
    return {field: catalogue.get(field) for field in logins.TARGET_FIELDS}


def c1b_block(catalogue):
    """The C1b read-out (PROD runbook): attributes, memberships, ownership."""
    roles = catalogue.get('roles') or {}
    return {
        'attributes': {name: [roles[name].get(k) for k in ('login', 'superuser', 'bypassrls', 'createdb',
                                                            'createrole', 'replication')]
                       for name in sorted(roles)},
        'memberships': sorted([name, parent] for name in roles for parent in roles[name].get('parents', [])),
        'ownedObjects': sum(roles[name].get('ownedObjects', 0) for name in roles),
        'ownerMember': sum(1 for name in roles
                           if catalogue.get('migrationOwner') in roles[name].get('reachable', [])),
    }


def roles_check(catalogue):
    """After the apply window: the same role and catalogue contract as the
    planner, both logins present, without the approved-target pin (a later
    migration changes the head and the digests; it must not change these)."""
    require(type(catalogue) is dict, 'CENSUS_UNKNOWN')
    pinned = dict(target_of(catalogue))
    require(all(type(v) is str and v for v in pinned.values()), 'CENSUS_UNKNOWN')
    require(pinned['migration'] != 'incomplete', 'MIGRATION_INCOMPLETE')
    decisions = logins.plan(catalogue, pinned)
    require(not decisions['create'], 'LOGINS_MISSING')
    return {'status': 'roles_hold', 'logins': len(logins.LOGINS), 'c1b': c1b_block(catalogue)}


def load_target(path):
    try:
        with open(path, encoding='utf-8') as file:
            approved = json.load(file)
    except (OSError, ValueError):
        raise Refusal('TARGET_UNREADABLE') from None
    # The fingerprint line itself, saved by the operator after review, or the bare target.
    if type(approved) is dict and set(approved) == {'status', 'target'} and approved['status'] == 'fingerprint':
        approved = approved['target']
    require(type(approved) is dict and set(approved) == set(logins.TARGET_FIELDS), 'TARGET_INVALID')
    return approved


def compose_argv(args):
    argv = ['docker', 'compose']
    if args.project_name:
        argv += ['-p', args.project_name]
    argv += ['--project-directory', args.project_directory]
    for path in args.compose_file:
        argv += ['-f', path]
    return argv


def main(argv=None):
    deploy = HERE.parent
    parser = argparse.ArgumentParser(description='Least-privilege runtime logins (TA-S0-003 R2).')
    parser.add_argument('command', choices=['fingerprint', 'plan', 'apply', 'verify', 'roles'])
    parser.add_argument('--approved-target-file')
    parser.add_argument('--compose-file', action='append')
    parser.add_argument('--project-directory', default=str(deploy))
    parser.add_argument('--project-name')
    parser.add_argument('--store-dir', default=DEFAULT_STORE)
    parser.add_argument('--run-dir')
    parser.add_argument('--lock-file', default=DEFAULT_LOCK)
    args = parser.parse_args(argv)
    args.compose_file = args.compose_file or [str(deploy / 'docker-compose.yml')]
    store_env = []
    if args.store_dir != DEFAULT_STORE or args.run_dir:
        # A rehearsal store, never production's: both locations are named.
        if not args.run_dir:
            print(json.dumps({'status': 'hold', 'reason': 'REHEARSAL_STORE_NEEDS_RUN_DIR'}))
            return 1
        store_env = ['env', f'SWIFT_SECRETS_STORE_DIR={args.store_dir}', f'SWIFT_SECRETS_RUN_DIR={args.run_dir}']
    try:
        lock = open(args.lock_file, 'a', encoding='utf-8')
    except OSError:
        print(json.dumps({'status': 'hold', 'reason': 'LOCK_UNAVAILABLE'}))
        return 1
    with lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            print(json.dumps({'status': 'hold', 'reason': 'ANOTHER_RUN_HOLDS_THE_LOCK'}))
            return 1
        try:
            needs_target = args.command in ('plan', 'apply', 'verify')
            require(not needs_target or bool(args.approved_target_file), 'TARGET_FILE_REQUIRED')
            require(needs_target or not args.approved_target_file, 'TARGET_FILE_NOT_USED')
            approved = load_target(args.approved_target_file) if needs_target else None
            ports = HostPorts(compose_argv(args), args.store_dir, store_env, approved)
            ports.docker_ready()
            if args.command == 'fingerprint':
                catalogue = ports.census()
                report = {'status': 'fingerprint', 'target': target_of(catalogue)}
            elif args.command == 'plan':
                report = {'status': 'plan_only', **logins.plan(ports.census(), approved)}
            elif args.command == 'apply':
                report = logins.apply(ports, approved)
            elif args.command == 'verify':
                report = logins.verify(ports, approved)
                report['c1b'] = c1b_block(ports.census())
            else:
                report = roles_check(ports.census())
            print(json.dumps(report, sort_keys=True))
            return 0
        except Refusal as error:
            print(json.dumps({'status': 'hold', 'reason': str(error)}))
            return 1
        except Exception:
            print(json.dumps({'status': 'hold', 'reason': 'OPERATOR_FAILED'}))
            return 1


if __name__ == '__main__':
    sys.exit(main())
