"""[item 196] restore.sh quarantines the scratch copy and replays the live
erasure ledger onto it BEFORE it reports a restore. Drives the real script with
command stand-ins (no services): every docker call is logged with the database
it targets and what it was fed. The SQL itself is proven on real databases by
apps/api/src/__tests__/restore-erasure-replay.test.ts.

[SEC-BACKUP F2] The scratch copy lives in a throwaway instance (`docker run`,
then `docker exec <instance>`), the live database stays behind `docker compose
exec postgres`: the stand-in logs both in the same shape, and every dump here is
signed as backup.sh signs it."""
import hashlib
import json
import os
import sys
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]

FAKE_DOCKER = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
INSTANCE = 'swift-restore-swift_restore_privacy'
def note(line):
    with open(os.environ['CALL_LOG'], 'a') as log:
        log.write(line + '\n')
if args[:1] == ['compose']:
    with open(os.environ['CALL_LOG'] + '.compose', 'a') as composed:
        composed.write(' '.join(args)[:120] + '\n')
    if '-p' in args:
        with open(os.environ['CALL_LOG'] + '.projects', 'a') as projects:
            projects.write(args[args.index('-p') + 1] + '\n')
    if 'ps' in args: sys.exit(0)
    if 'config' in args:
        print('{"services":{"postgres":{"image":"postgis/postgis:16-3.4"}}}'); sys.exit(0)
    # compose ... exec -T postgres sh -c <script> sh <database> <psql args...>
    i = args.index('postgres')
else:
    # the throwaway instance
    if args[:2] in (['container', 'inspect'], ['volume', 'inspect']): sys.exit(1)
    if args[:1] == ['run'] and 'list-objects-v2' in args:
        # [BACKUP-FU] the off-site ledger listing (read-only)
        note('LIST ' + args[args.index('--prefix') + 1])
        if os.environ.get('FAIL') == 'list': sys.exit(255)
        print(os.environ.get('FAKE_LEDGER_KEYS', 'None')); sys.exit(0)
    if args[:1] == ['run'] and 'get-bucket-versioning' in args:
        if os.environ.get('FAKE_VERSIONING') == 'fail': sys.exit(255)
        print(os.environ.get('FAKE_VERSIONING', 'None')); sys.exit(0)
    if args[:1] == ['run'] and 'list-object-versions' in args:
        note('VERSIONS ' + args[args.index('--prefix') + 1])
        if os.environ.get('FAIL') == 'versions': sys.exit(255)
        print(os.environ.get('FAKE_LEDGER_VERSIONS', '{}')); sys.exit(0)
    if args[:1] in (['volume'], ['run']): sys.exit(0)
    if args[:1] == ['rm']:
        note('INSTANCE REMOVED ' + ' '.join(args[1:])); sys.exit(0)
    if args[:1] == ['logs']:
        print('PostgreSQL init process complete; ready for start up.'); sys.exit(0)
    assert args[:1] == ['exec'], args
    i = args.index(INSTANCE)
    cmd = args[i + 1:]
    if cmd[:1] == ['pg_isready']: sys.exit(0)
    if cmd[:1] == ['pg_restore']:
        if '--list' in cmd:
            print('4002; 1259 16400 TABLE public users swift'); sys.exit(0)
        if '-f' in cmd: sys.exit(0)
        db = next(a.split('=', 1)[1] for a in cmd if a.startswith('--dbname='))
        note(f'pg_restore db={db} :: as={cmd[cmd.index("-U") + 1]} in={INSTANCE}')
        sys.exit(0)
    if cmd[:2] == ['sh', '-c'] and 'cat >' in cmd[2]:
        sys.stdin.read(); sys.exit(0)
script = args[i + 3]
target = args[i + 5] if len(args) > i + 5 else ''
rest = args[i + 6:]
with open(os.environ['CALL_LOG'] + ('.live' if args[:1] == ['compose'] else '.instance'), 'a') as where:
    where.write(target + '\n')
fed = '' if sys.stdin.isatty() else sys.stdin.read()
sql = rest[rest.index('-c') + 1] if '-c' in rest else (rest[rest.index('-tAc') + 1] if '-tAc' in rest else fed)
kind = 'pg_restore' if 'pg_restore' in script else 'psql'
ro = ' [ro]' if 'default_transaction_read_only=on' in script else ''
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(f'{kind} db={target} :: {" ".join(sql.split())[:300]}{ro}\n')
fail = os.environ.get('FAIL', '')
if kind == 'pg_restore':
    sys.exit(0)
if 'REVOKE CONNECT' in sql and fail == 'quarantine': sys.exit(3)
if "to_regclass('public.deletion_receipt')" in sql:
    print('f' if fail == 'no-ledger' else 't'); sys.exit(0)
if sql.startswith('COPY (') and 'TO STDOUT' in sql:
    if fail == 'export': sys.exit(8)
    sys.exit(0)
if 'restore_ledger_' in sql and 'BEGIN;' in sql:
    with open(os.environ['CALL_LOG'] + '.replay', 'w') as saved:
        saved.write(sql)
    if fail == 'replay': sys.exit(9)
    print('erasure ledger replayed: 0 destroyed keys, 0 receipts, 0 retired documents, 0 closed accounts in the live ledger; changed in this copy: nothing (the copy already matched)')
    sys.exit(0)
if 'rolsuper FROM pg_roles WHERE rolname = current_user' in sql:
    print('f'); sys.exit(0)
if "to_regclass('public.deployment_identity')" in sql:
    print('t' if os.environ.get('IDENT_LIVE') or os.environ.get('IDENT_COPY') else 'f'); sys.exit(0)
if 'FROM deployment_identity' in sql:
    print(os.environ.get('IDENT_COPY' if target == 'swift_restore_privacy' else 'IDENT_LIVE', 'none/none')); sys.exit(0)
if 'pg_database WHERE datname' in sql: sys.exit(0)
if 'count(*)' in sql: print('1')
'''


class RestoreQuarantineAndReplay(unittest.TestCase):
    def run_restore(self, fail='', extra_args=(), project=('--project', 'swift-restore-test'), trust='', **env_extra):
        root = Path(tempfile.mkdtemp(prefix='swift-restore-privacy-'))
        self.addCleanup(shutil.rmtree, root, True)
        deploy = root / 'deploy'
        deploy.mkdir()
        for name in ('restore.sh', 'restore-erasure-ledger.sql', 'restore-replay-erasures.sql', 'restore-offsite-ledger.sql',
                     'secret-env.sh', 'backup-signature.py'):
            shutil.copy2(DEPLOY / name, deploy / name)
        (deploy / '.env').write_text('POSTGRES_DB=swift_live_fixture\n')
        bins = root / 'bin'
        bins.mkdir()
        (bins / 'docker').write_text(FAKE_DOCKER)
        (bins / 'pg_restore').write_text('#!/bin/sh\n[ "$1" = "--list" ]\n')
        for b in bins.iterdir():
            b.chmod(0o755)
        dump = root / 'backup.dump'
        dump.write_bytes(b'PGDMP synthetic')
        # [SEC-BACKUP F2] signed as backup.sh signs it
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'swift-backup-signing', '-f', str(root / 'signing')], check=True)
        allowed = root / 'allowed_signers'
        allowed.write_text('swift-backup namespaces="swift-backup" ' + ' '.join((root / 'signing.pub').read_text().split()[:2]) + '\n' + trust)
        allowed.chmod(0o644)
        subprocess.run([sys.executable, '-I', str(DEPLOY / 'backup-signature.py'), 'sign', '--key', str(root / 'signing'),
                        '--object', str(dump), '--out', f'{dump}.sig', '--created', '20261028T000000Z'], check=True, capture_output=True)
        log = root / 'calls'
        log.write_text('')
        env = {k: v for k, v in os.environ.items() if not k.startswith(('BACKUP_', 'POSTGRES_'))}
        env.update(PATH=f'{bins}:{os.environ["PATH"]}', CALL_LOG=str(log), FAIL=fail, BACKUP_SIGNING_ALLOWED_SIGNERS=str(allowed), **env_extra)
        self.replay_script = ''
        r = subprocess.run(['bash', str(deploy / 'restore.sh'), *project, *extra_args, str(dump), 'swift_restore_privacy'],
                           env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
        replay = Path(str(log) + '.replay')
        self.replay_script = replay.read_text() if replay.exists() else ''
        projects = Path(str(log) + '.projects')
        self.projects = projects.read_text().split() if projects.exists() else []
        composed = Path(str(log) + '.compose')
        self.compose_calls = composed.read_text().splitlines() if composed.exists() else []
        read = lambda suffix: set(Path(str(log) + suffix).read_text().split()) if Path(str(log) + suffix).exists() else set()
        self.live_dbs, self.instance_dbs = read('.live'), read('.instance')
        return r, log.read_text().splitlines()

    @staticmethod
    def first(lines, fragment):
        return next(i for i, l in enumerate(lines) if fragment in l)

    def test_quarantined_before_any_row_arrives_and_the_ledger_replayed_before_the_report(self):
        r, calls = self.run_restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        create = self.first(calls, 'CREATE DATABASE')
        revoke = self.first(calls, 'REVOKE ALL ON DATABASE "swift_restore_privacy" FROM PUBLIC')
        restore = self.first(calls, 'pg_restore db=swift_restore_privacy')
        self.assertLess(create, revoke)
        self.assertLess(revoke, restore)
        # quarantined again after the restore, then the ledger is READ from the
        # live database and REPLAYED onto the scratch copy, in that order
        self.assertTrue(any('REVOKE CONNECT' in l for l in calls[restore + 1:]))
        export = self.first(calls, 'psql db=swift_live_fixture :: COPY (SELECT "fileKey"')
        replay = self.first(calls, 'psql db=swift_restore_privacy :: BEGIN; CREATE TEMP TABLE restore_ledger_destroyed_keys')
        self.assertLess(restore, export)
        self.assertLess(export, replay)
        # every ledger entry is read from the live database, none from the copy
        exports = [l for l in calls if ':: COPY (' in l]
        self.assertEqual(len(exports), 10, exports)
        self.assertTrue(all(l.startswith('psql db=swift_live_fixture') for l in exports))
        self.assertIn('erasure ledger replayed:', r.stdout)
        self.assertIn('no application login can', r.stdout)
        self.assertLess(r.stdout.index('erasure ledger replayed:'), r.stdout.index('RESTORE OK'))

    def test_compare_source_also_replays_before_it_compares(self):
        r, calls = self.run_restore(extra_args=('--compare-source',))
        replay = self.first(calls, 'BEGIN; CREATE TEMP TABLE restore_ledger_')
        compare = self.first(calls, 'posture-snapshot')
        self.assertLess(replay, compare)

    def test_a_scratch_that_cannot_be_quarantined_is_never_restored_into(self):
        r, calls = self.run_restore('quarantine')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('could not be quarantined', r.stderr)
        self.assertFalse(any(l.startswith('pg_restore db=') for l in calls))
        self.assertNotIn('RESTORE OK', r.stdout)

    def test_an_unreadable_live_ledger_is_a_failed_restore(self):
        r, calls = self.run_restore('export')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('could not read the erasure ledger', r.stderr)
        self.assertIn('quarantined', r.stderr)
        self.assertFalse(any('BEGIN; CREATE TEMP TABLE restore_ledger_' in l for l in calls))
        self.assertNotIn('RESTORE OK', r.stdout)

    def test_a_failed_replay_is_a_failed_restore(self):
        r, _ = self.run_restore('replay')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('erasure ledger replay failed', r.stderr)
        self.assertNotIn('RESTORE OK', r.stdout)

    def test_a_database_without_an_erasure_ledger_has_nothing_to_replay(self):
        r, calls = self.run_restore('no-ledger')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('nothing to replay', r.stdout)
        self.assertFalse(any(':: COPY (' in l for l in calls))
        self.assertIn('RESTORE OK', r.stdout)


    # [#1977 COORD ruling 10:55Z] F S4-1: a failed replay leaves erased people whole in the copy, so the
    # copy is DROPPED unless the operator asks to keep it (--keep-failed).
    def test_a_failed_replay_drops_the_copy_unless_kept(self):
        for fail in ('replay', 'export'):
            with self.subTest(fail=fail):
                r, calls = self.run_restore(fail)
                self.assertNotEqual(r.returncode, 0)
                restore = self.first(calls, 'pg_restore db=swift_restore_privacy')
                drop = self.first(calls, 'INSTANCE REMOVED -f swift-restore-swift_restore_privacy')
                self.assertLess(restore, drop)
                self.assertIn('was dropped', r.stderr)
                self.assertNotIn('RESTORE OK', r.stdout)
        r, calls = self.run_restore('replay', ('--keep-failed',))
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(any('INSTANCE REMOVED' in l for l in calls))
        self.assertIn('--keep-failed', r.stderr)
        self.assertIn('quarantined', r.stderr)

    # F S4-2 + G: both deployment identities are printed before the replay; two different
    # environments are never mixed (the ledger would not describe the copy).
    def test_both_identities_are_printed_before_the_replay(self):
        r, calls = self.run_restore(IDENT_LIVE='production/dep-a', IDENT_COPY='production/dep-a')
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('live database identity : production/dep-a', r.stdout)
        self.assertIn('restored copy identity : production/dep-a', r.stdout)
        self.assertLess(r.stdout.index('restored copy identity'), r.stdout.index('erasure ledger replayed:'))
        r, calls = self.run_restore(IDENT_LIVE='staging/dep-s', IDENT_COPY='production/dep-a')
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('different environments', r.stderr)
        self.assertFalse(any('BEGIN; CREATE TEMP TABLE restore_ledger_' in l for l in calls))
        self.assertTrue(any('INSTANCE REMOVED -f swift-restore-swift_restore_privacy' in l for l in calls))

    # G S4-1: the production path can never write the live database while it reads the ledger.
    def test_every_ledger_read_of_the_live_database_is_read_only(self):
        r, calls = self.run_restore(IDENT_LIVE='production/dep-a', IDENT_COPY='production/dep-a')
        self.assertEqual(r.returncode, 0, r.stderr)
        reads = [l for l in calls if l.startswith('psql db=swift_live_fixture') and ('COPY (' in l or 'to_regclass' in l or 'deployment_identity' in l)]
        self.assertGreaterEqual(len(reads), 12, reads)
        self.assertEqual([l for l in reads if not l.endswith('[ro]')], [])

    # G S4-2: the closing words say the quarantine covers today's logins only.
    def test_the_report_says_to_requarantine_before_use_and_drop_after(self):
        # [SEC-BACKUP · REVIEW-M S3-1] only a copy kept on purpose is left to use; by default it is gone
        r, calls = self.run_restore('', ('--keep-for-inspection',))
        self.assertIn('re-run the quarantine before use', r.stdout)
        self.assertIn('drop the copy after use', r.stdout)
        self.assertFalse(any('INSTANCE REMOVED' in l for l in calls))
        r, calls = self.run_restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(any('INSTANCE REMOVED -f swift-restore-swift_restore_privacy' in l for l in calls))
        self.assertIn('was removed with its volume', r.stdout)

    # [#1977 · copy run #5c gap (a)] Closed from birth: the new database is created refusing every
    # connection, closed to PUBLIC and to each login, and only then opened for the restore.
    def test_the_copy_is_created_refusing_connections_and_opened_only_after_the_quarantine(self):
        r, calls = self.run_restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        create = self.first(calls, 'CREATE DATABASE')
        self.assertIn('ALLOW_CONNECTIONS false', calls[create])
        revoke = self.first(calls, 'REVOKE ALL ON DATABASE "swift_restore_privacy" FROM PUBLIC')
        opened = self.first(calls, 'ALTER DATABASE "swift_restore_privacy" WITH ALLOW_CONNECTIONS true')
        restore = self.first(calls, 'pg_restore db=swift_restore_privacy')
        self.assertLess(create, revoke)
        self.assertLess(revoke, opened)
        self.assertLess(opened, restore)

    # [#1977 · copy run #5c] restore.sh never guesses which stack it works on: the Compose project is
    # named explicitly, printed, and used for every database call.
    def test_the_compose_project_must_be_named_and_is_used_for_every_call(self):
        r, calls = self.run_restore(project=())
        self.assertNotEqual(r.returncode, 0)
        self.assertIn('--project', r.stderr)
        self.assertEqual(calls, [])
        for bad in ('Swift', '-x', 'a b'):
            r, calls = self.run_restore(project=('--project', bad))
            self.assertNotEqual(r.returncode, 0, bad)
            self.assertEqual(calls, [], bad)
        r, calls = self.run_restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('compose project : swift-restore-test', r.stdout)
        self.assertTrue(self.compose_calls)
        self.assertEqual(len(self.projects), len(self.compose_calls))
        self.assertEqual(set(self.projects), {'swift-restore-test'})
        # [SEC-BACKUP F2] and only the LIVE database goes through it: the copy never does
        self.assertNotIn('swift_restore_privacy', self.live_dbs)
        self.assertIn('swift_restore_privacy', self.instance_dbs)
        self.assertNotIn('swift_live_fixture', self.instance_dbs)
        self.assertIn('pg_restore db=swift_restore_privacy :: as=swift in=swift-restore-swift_restore_privacy', calls)


class DisasterRecoveryWithoutTheLiveDatabase(unittest.TestCase):
    """[#1977 COORD ruling, REVIEW-F S3-1] With the live database gone there is no live ledger. A loud
    DR mode restores the copy and keeps it quarantined, but never calls it restored."""
    run_restore = RestoreQuarantineAndReplay.run_restore
    first = staticmethod(RestoreQuarantineAndReplay.first)

    def test_the_dr_mode_needs_both_flags_and_refuses_before_anything(self):
        for args in (('--no-live-ledger',), ('--i-know-live-is-gone',), ('--no-live-ledger', '--i-know-live-is-gone', '--compare-source')):
            with self.subTest(args=args):
                r, calls = self.run_restore('', args)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('--i-know-live-is-gone', r.stderr)
                self.assertFalse(any('CREATE DATABASE' in l for l in calls))
                self.assertNotIn('RESTORE OK', r.stdout)

    def test_the_dr_mode_restores_quarantined_and_never_says_restore_ok(self):
        # [SEC-BACKUP · REVIEW-M S3-1] a DR restore keeps its copy, so it says so up front
        r, calls = self.run_restore('', ('--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection'))
        self.assertEqual(r.returncode, 3, r.stderr)
        create = self.first(calls, 'CREATE DATABASE')
        revoke = self.first(calls, 'REVOKE ALL ON DATABASE "swift_restore_privacy" FROM PUBLIC')
        restore = self.first(calls, 'pg_restore db=swift_restore_privacy')
        self.assertLess(create, revoke)
        self.assertLess(revoke, restore)
        self.assertTrue(any('REVOKE CONNECT' in l for l in calls[restore + 1:]))
        # nothing is read from or written to a live database that is gone
        self.assertEqual([l for l in calls if 'db=swift_live_fixture' in l], [])
        self.assertIn('NOT erasure-complete: replay the off-site ledger before use', r.stdout + r.stderr)
        self.assertNotIn('RESTORE OK', r.stdout + r.stderr)
        self.assertFalse(any('INSTANCE REMOVED' in l for l in calls))



OFFSITE = [
    {"id": "0b9f0c3e-1111-4a2b-8c3d-000000000001", "kind": "closed_accounts", "entry": {"id": "synthetic-closed", "kept": []}, "createdAt": "2026-10-21T12:00:00.000"},
    {"id": "0b9f0c3e-1111-4a2b-8c3d-000000000002", "kind": "destroyed_keys", "entry": {"fileKey": "k", "createdBy": "synthetic-closed", "shreddedAt": None}, "createdAt": "2026-10-21T12:00:01.000"},
]


class TheOffsiteLedger(unittest.TestCase):
    """[Off-site erasure ledger] restore.sh --ledger-from <directory>: the batches the host unit shipped,
    decrypted by the owner on his own computer, each beside its signature. They join the live ledger, or
    stand alone when the live database is gone. [BACKUP-FU] A batch is replayed only once its signature
    verifies; an unsigned one only as a legacy batch from before signing began."""
    run_restore = RestoreQuarantineAndReplay.run_restore
    first = staticmethod(RestoreQuarantineAndReplay.first)

    def setUp(self):
        self.keys = Path(tempfile.mkdtemp(prefix='swift-ledger-signing-'))
        self.addCleanup(shutil.rmtree, self.keys, True)
        self.key = self.make_key('ledger-signing')
        self.trust = 'swift-backup namespaces="swift-backup" ' + ' '.join(Path(str(self.key) + '.pub').read_text().split()[:2]) + '\n'

    def make_key(self, name):
        key = self.keys / name
        subprocess.run(['ssh-keygen', '-q', '-t', 'ed25519', '-N', '', '-C', 'swift-backup-signing', '-f', str(key)], check=True)
        return key

    def ledger(self, *batches, mode=0o700):
        """A directory as the owner leaves it: each batch's decrypted .jsonl beside the .jsonl.gpg.sig the
        shipper uploaded (signed over the encrypted copy and the plain batch's SHA-256)."""
        d = Path(tempfile.mkdtemp(prefix='swift-offsite-ledger-'))
        self.addCleanup(shutil.rmtree, d, True)
        last = None  # [BACKUP-FU · COORD] each signed batch links to the one signed before it
        for b in batches:
            base = f"erasure-ledger-{b.get('stamp', '20261028T100000Z')}-{b.get('id8', '0b9f0c3e')}"
            plain = d / f'{base}.jsonl'
            plain.write_text(''.join((l if isinstance(l, str) else json.dumps(l)) + '\n' for l in b.get('lines', OFFSITE)))
            plain.chmod(b.get('mode', 0o600))
            if b.get('signed', True):
                enc = d / f'{base}.jsonl.gpg'
                enc.write_bytes(b'synthetic ciphertext ' + base.encode())
                sha = hashlib.sha256(plain.read_bytes()).hexdigest()
                prev = b.get('prev', last[0] if last else 'none')
                chain = [] if prev is None else ['--prev', prev] + ([] if prev == 'none' else ['--prev-sha256', b.get('prev_sha', last[1] if last else '0' * 64)])
                subprocess.run([sys.executable, '-I', str(DEPLOY / 'backup-signature.py'), 'sign', '--key', str(b.get('key', self.key)),
                                '--object', str(enc), '--out', f'{enc}.sig', '--plain-sha256', sha, '--created', b.get('stamp', '20261028T100000Z'), *chain],
                               check=True, capture_output=True)
                last = (f'{base}.jsonl.gpg', hashlib.sha256(Path(f'{enc}.sig').read_bytes()).hexdigest())
                if not b.get('keep_gpg', False):
                    enc.unlink()
            if 'after' in b:
                b['after'](d, base)
        d.chmod(mode)
        return str(d)

    def restore_with(self, *args, **env):
        return self.run_restore('', args, trust=self.trust, **env)

    def assert_refused_before_anything(self, r, calls, *needles):
        self.assertNotEqual(r.returncode, 0)
        for n in needles:
            self.assertIn(n, r.stderr)
        self.assertFalse(any('CREATE DATABASE' in l for l in calls))
        self.assertFalse(any(l.startswith('pg_restore') for l in calls))
        self.assertNotIn('RESTORE OK', r.stdout)

    def test_a_ledger_others_can_read_or_a_malformed_one_is_refused_before_anything(self):
        plain_file = Path(self.ledger({})) / 'erasure-ledger-20261028T100000Z-0b9f0c3e.jsonl'
        for path in (self.ledger({}, mode=0o755), self.ledger({'mode': 0o644}), self.ledger({'lines': ['not json']}),
                     self.ledger({'lines': [{**OFFSITE[0], 'kind': 'something_else'}]}),
                     self.ledger({'lines': [{**OFFSITE[0], 'id': 'not-a-uuid'}]}), '/nonexistent/ledger', str(plain_file),
                     self.ledger({'after': lambda d, base: (d / 'notes.txt').write_text('x')})):
            with self.subTest(path=path):
                r, calls = self.restore_with('--ledger-from', path)
                self.assert_refused_before_anything(r, calls, '--ledger-from')

    def test_a_single_concatenated_file_is_refused_the_batches_are_checked_one_by_one(self):
        plain_file = Path(self.ledger({})) / 'erasure-ledger-20261028T100000Z-0b9f0c3e.jsonl'
        r, calls = self.restore_with('--ledger-from', str(plain_file))
        self.assert_refused_before_anything(r, calls, 'is not a directory; nothing was created')

    def test_with_the_live_database_the_offsite_entries_join_the_live_ledger(self):
        r, calls = self.restore_with('--ledger-from', self.ledger({'keep_gpg': True}))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('signature OK: erasure-ledger-20261028T100000Z-0b9f0c3e.jsonl.gpg was signed by the trusted backup signing key', r.stderr)
        self.assertIn('off-site ledger : 1 signed batch(es) verified, 2 entr(ies)', r.stdout)
        self.assertTrue(any(':: COPY (' in l and l.startswith('psql db=swift_live_fixture') for l in calls))
        script = self.replay_script
        self.assertIn('CREATE TEMP TABLE restore_offsite', script)
        self.assertIn('"kind": "destroyed_keys"', script.replace('""', '"'))
        self.assertLess(script.index('INSERT INTO restore_ledger_closed_account_rows'), script.index('REPLAY THE LIVE ERASURE LEDGER'))
        self.assertIn('RESTORE OK', r.stdout)

    def test_without_the_live_database_the_offsite_ledger_makes_the_copy_erasure_complete_up_to_its_newest_entry(self):
        later = {**OFFSITE[1], 'id': '0b9f0c3e-1111-4a2b-8c3d-000000000003', 'createdAt': '2026-10-28T09:59:00.000'}
        r, calls = self.restore_with('--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection',
                                     '--ledger-from', self.ledger({}, {'stamp': '20261028T110000Z', 'id8': '0b9f0c3f', 'lines': [later]}))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual([l for l in calls if 'db=swift_live_fixture' in l], [])
        self.assertIn('CREATE TEMP TABLE restore_ledger_closed_accounts', self.replay_script)
        self.assertIn('CREATE TEMP TABLE restore_offsite', self.replay_script)
        out = r.stdout + r.stderr
        self.assertIn('off-site ledger : 2 signed batch(es) verified, 3 entr(ies)', out)
        self.assertIn('erasure-complete up to 2026-10-28T09:59:00.000', out)
        self.assertNotIn('NOT erasure-complete: replay the off-site ledger', out)
        self.assertNotIn('RESTORE OK', out)

    # ── [BACKUP-FU] signed batches only ──────────────────────────────────────
    def test_an_unsigned_batch_is_refused_before_anything(self):
        r, calls = self.restore_with('--ledger-from', self.ledger({}, {'stamp': '20261028T110000Z', 'id8': '0b9f0c3f', 'signed': False,
                                                                     'lines': [{**OFFSITE[0], 'id': '0b9f0c3e-1111-4a2b-8c3d-00000000000a'}]}))
        self.assert_refused_before_anything(r, calls, 'erasure-ledger-20261028T110000Z-0b9f0c3f has NO signature')

    def test_a_batch_changed_after_it_was_signed_is_refused_whatever_the_flags(self):
        tamper = lambda d, base: (d / f'{base}.jsonl').write_text((d / f'{base}.jsonl').read_text().replace('synthetic-closed', 'someone-else'))
        r, calls = self.restore_with('--allow-unsigned-legacy', '--legacy-without-signing-record', '--ledger-from', self.ledger({'after': tamper}))
        self.assert_refused_before_anything(r, calls, 'REFUSED', 'was REFUSED')

    def test_a_signature_moved_onto_another_batch_is_refused(self):
        def rename(d, base):
            other = 'erasure-ledger-20261028T120000Z-0b9f0c40'
            (d / f'{base}.jsonl').rename(d / f'{other}.jsonl')
            (d / f'{base}.jsonl.gpg.sig').rename(d / f'{other}.jsonl.gpg.sig')
        r, calls = self.restore_with('--ledger-from', self.ledger({'after': rename}))
        self.assert_refused_before_anything(r, calls, 'cannot be renamed into another')

    def test_a_batch_signed_by_a_key_that_is_not_trusted_is_refused(self):
        r, calls = self.restore_with('--allow-unsigned-legacy', '--ledger-from', self.ledger({'key': self.make_key('stranger')}))
        self.assert_refused_before_anything(r, calls, 'does not verify against the trusted backup signing key')

    def test_a_signature_whose_batch_was_not_decrypted_is_refused(self):
        drop = lambda d, base: (d / f'{base}.jsonl').unlink()
        r, calls = self.restore_with('--ledger-from', self.ledger({}, {'stamp': '20261028T110000Z', 'id8': '0b9f0c3f', 'after': drop}))
        self.assert_refused_before_anything(r, calls, 'erasure-ledger-20261028T110000Z-0b9f0c3f.jsonl.gpg.sig is here but its decrypted batch')

    def test_an_unsigned_copy_of_entries_a_signed_batch_holds_is_set_aside(self):
        # The shipper's batch whose signature never reached the bucket: the next run shipped the same entries, signed.
        r, calls = self.restore_with('--ledger-from', self.ledger({'stamp': '20261028T100000Z', 'id8': '0b9f0c3e', 'signed': False},
                                                                   {'stamp': '20261028T100100Z', 'id8': '0b9f0c3e'}))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('erasure-ledger-20261028T100000Z-0b9f0c3e has no signature; every entry in it is also in a verified batch: set aside', r.stderr)
        self.assertIn('off-site ledger : 1 signed batch(es) verified, 2 entr(ies)', r.stdout)
        self.assertIn('RESTORE OK', r.stdout)

    def test_the_legacy_flag_takes_an_unsigned_batch_only_from_before_signing_began(self):
        legacy = {'stamp': '20261021T120000Z', 'id8': '0b9f0c3e', 'signed': False}
        later = {'stamp': '20261028T110000Z', 'id8': '0b9f0c3f', 'signed': False,
                 'lines': [{**OFFSITE[0], 'id': '0b9f0c3e-1111-4a2b-8c3d-00000000000b', 'createdAt': '2026-10-28T10:59:00.000'}]}
        record = self.keys / 'first-signed-erasure-ledger'
        record.write_text('20261028T100000Z\n')
        # Older than the shipper's record: replayed, loudly.
        r, calls = self.restore_with('--allow-unsigned-legacy', '--ledger-from', self.ledger(legacy), BACKUP_FIRST_SIGNED_LEDGER_FILE=str(record))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('legacy check: erasure-ledger-20261021T120000Z-0b9f0c3e is from 20261021T120001Z, before the first signed batch (20261028T100000Z)', r.stderr)
        self.assertIn('REPLAYING AN UNSIGNED ERASURE LEDGER BATCH', r.stderr)
        self.assertIn('RESTORE OK', r.stdout)
        # After it: refused even with the flag (the record, the owner's stamp, or the oldest signed batch here).
        for env, extra in (({'BACKUP_FIRST_SIGNED_LEDGER_FILE': str(record)}, ()),
                           ({'BACKUP_FIRST_SIGNED_LEDGER_FILE': str(self.keys / 'none'), 'BACKUP_LEDGER_SIGNED_SINCE': '20261028T100000Z'}, ()),
                           ({'BACKUP_FIRST_SIGNED_LEDGER_FILE': str(self.keys / 'none')}, ({'stamp': '20261028T100000Z', 'id8': '0b9f0c3d'},))):
            with self.subTest(env=env):
                r, calls = self.restore_with('--allow-unsigned-legacy', '--ledger-from', self.ledger(later, *extra), **env)
                self.assert_refused_before_anything(r, calls, 'is from after signing began', 'Refused even with --allow-unsigned-legacy')
        # An entry newer than the cut-over in an old-looking batch is not legacy either.
        forged = {**legacy, 'lines': [{**OFFSITE[0], 'createdAt': '2026-10-28T10:30:00.000'}]}
        r, calls = self.restore_with('--allow-unsigned-legacy', '--ledger-from', self.ledger(forged), BACKUP_FIRST_SIGNED_LEDGER_FILE=str(record))
        self.assert_refused_before_anything(r, calls, 'is from after signing began')

    def test_with_no_record_of_when_signing_began_the_owner_must_say_so_twice(self):
        legacy = {'stamp': '20261021T120000Z', 'id8': '0b9f0c3e', 'signed': False}
        env = {'BACKUP_FIRST_SIGNED_LEDGER_FILE': str(self.keys / 'none')}
        r, calls = self.restore_with('--allow-unsigned-legacy', '--ledger-from', self.ledger(legacy), **env)
        self.assert_refused_before_anything(r, calls, 'there is no record of the first signed batch')
        r, calls = self.restore_with('--allow-unsigned-legacy', '--legacy-without-signing-record', '--ledger-from', self.ledger(legacy), **env)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn('--legacy-without-signing-record: no record of when erasure ledger signing began', r.stderr)
        self.assertIn('RESTORE OK', r.stdout)


class TheOffsiteLedgerChain(unittest.TestCase):
    """[BACKUP-FU · COORD] A batch missing from the folder must never pass unnoticed: its erasures would be
    skipped and a disaster-recovery restore would still say erasure-complete. The signed batches form one
    chain (each names the one before it inside its signature); the bucket, when it can be listed, must hold
    no batch that is not here."""
    DR = ('--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection')
    run_restore = RestoreQuarantineAndReplay.run_restore
    first = staticmethod(RestoreQuarantineAndReplay.first)
    setUp = TheOffsiteLedger.setUp
    make_key = TheOffsiteLedger.make_key
    ledger = TheOffsiteLedger.ledger
    restore_with = TheOffsiteLedger.restore_with
    assert_refused_before_anything = TheOffsiteLedger.assert_refused_before_anything

    def batch(self, n, **extra):
        e = [{**OFFSITE[0], 'id': f'0b9f0c3e-1111-4a2b-8c3d-00000000010{n}', 'createdAt': f'2026-10-28T10:0{n}:00.000'}]
        return {'stamp': f'20261028T10{n}000Z', 'id8': f'0b9f0c4{n}', 'lines': e, **extra}

    def names(self, *ns):
        return [f'db/erasure-ledger/erasure-ledger-20261028T10{n}000Z-0b9f0c4{n}.jsonl.gpg{s}' for n in ns for s in ('', '.sig')]

    def test_a_complete_chain_passes_and_says_so(self):
        r, calls = self.restore_with(*self.DR, '--ledger-from', self.ledger(self.batch(1), self.batch(2), self.batch(3)))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn('off-site ledger : 3 signed batch(es) verified, 3 entr(ies)', r.stdout)
        self.assertIn('erasure-complete up to 2026-10-28T10:03:00.000 (the newest entry of the off-site ledger; the signed batches form one unbroken chain; the bucket was NOT listed', r.stdout)

    def test_a_missing_middle_batch_is_refused_before_anything(self):
        drop = lambda d, base: [p.unlink() for p in d.glob(f'{base}.*')]
        r, calls = self.restore_with(*self.DR, '--ledger-from', self.ledger(self.batch(1), self.batch(2, after=drop), self.batch(3)))
        self.assert_refused_before_anything(r, calls, 'CHAIN_BROKEN: erasure-ledger-20261028T103000Z-0b9f0c43 follows erasure-ledger-20261028T102000Z-0b9f0c42.jsonl.gpg, which is not here')
        self.assertNotIn('erasure-complete', r.stdout + r.stderr.replace('NOT erasure-complete', ''))

    def test_a_missing_first_batch_is_refused(self):
        drop = lambda d, base: [p.unlink() for p in d.glob(f'{base}.*')]
        r, calls = self.restore_with(*self.DR, '--ledger-from', self.ledger(self.batch(1, after=drop), self.batch(2)))
        self.assert_refused_before_anything(r, calls, 'CHAIN_BROKEN', 'say they are the first signed batch')

    def test_a_reordered_chain_is_refused(self):
        # 1 <- 3 <- 2: the batch named for 10:20 says it came after the one named for 10:30.
        r, calls = self.restore_with(*self.DR, '--ledger-from', self.ledger(self.batch(1), self.batch(3), self.batch(2)))
        self.assert_refused_before_anything(r, calls, 'CHAIN_BROKEN', 'which is not older: the chain is out of order')

    def test_a_link_to_another_signature_of_the_batch_before_is_refused(self):
        r, calls = self.restore_with(*self.DR, '--ledger-from', self.ledger(self.batch(1), self.batch(2, prev_sha='f' * 64)))
        self.assert_refused_before_anything(r, calls, 'CHAIN_BROKEN', 'is not the one it was signed after')

    def test_two_chain_starts_or_a_batch_without_a_link_are_refused(self):
        for second, says in ((self.batch(2, prev='none'), '2 batches here say they are the first signed batch'),
                             (self.batch(2, prev=None), 'is signed without a link to the batch before it')):
            with self.subTest(prev=second['prev']):
                r, calls = self.restore_with(*self.DR, '--ledger-from', self.ledger(self.batch(1), second))
                self.assert_refused_before_anything(r, calls, 'CHAIN_BROKEN', says)

    def bucket_env(self, keys, **extra):
        return dict(BACKUP_BUCKET='swift-backups', BACKUP_AWS_ACCESS_KEY_ID='test-id', BACKUP_AWS_SECRET_ACCESS_KEY='test-secret',
                    BACKUP_KEY_SOURCE='dedicated', AWS_CLI_IMAGE='amazon/aws-cli@sha256:' + 'a' * 64,
                    FAKE_LEDGER_KEYS='\t'.join(keys) or 'None', **extra)

    def test_the_bucket_is_listed_and_a_newest_batch_missing_here_is_refused(self):
        folder = self.ledger(self.batch(1), self.batch(2))
        r, calls = self.restore_with(*self.DR, '--ledger-from', folder, **self.bucket_env(self.names(1, 2, 3)))
        self.assert_refused_before_anything(r, calls, 'the bucket holds erasure-ledger-20261028T103000Z-0b9f0c43.jsonl.gpg')
        self.assertIn('LIST db/erasure-ledger/', calls)
        r, calls = self.restore_with(*self.DR, '--ledger-from', folder, **self.bucket_env(self.names(1, 2)))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn('off-site ledger : the bucket lists 2 batch(es); every one is here', r.stdout)
        self.assertIn('the signed batches form one unbroken chain; every batch the bucket lists is here; versioning is not on', r.stdout)

    # ── [REVIEW-M S4-2] no fork ──────────────────────────────────────────────
    def test_a_fork_is_refused_naming_both_batches(self):
        first = self.batch(1)
        folder = self.ledger(first, self.batch(2))
        # a third batch that also follows batch 1
        d = Path(folder); d.chmod(0o700)
        base = 'erasure-ledger-20261028T103000Z-0b9f0c43'
        (d / f'{base}.jsonl').write_text(json.dumps({**OFFSITE[0], 'id': '0b9f0c3e-1111-4a2b-8c3d-000000000109', 'createdAt': '2026-10-28T10:03:00.000'}) + '\n')
        (d / f'{base}.jsonl').chmod(0o600)
        enc = d / f'{base}.jsonl.gpg'
        enc.write_bytes(b'synthetic ciphertext')
        one = d / 'erasure-ledger-20261028T101000Z-0b9f0c41.jsonl.gpg.sig'
        subprocess.run([sys.executable, '-I', str(DEPLOY / 'backup-signature.py'), 'sign', '--key', str(self.key), '--object', str(enc), '--out', f'{enc}.sig',
                        '--plain-sha256', hashlib.sha256((d / f'{base}.jsonl').read_bytes()).hexdigest(), '--created', '20261028T103000Z',
                        '--prev', 'erasure-ledger-20261028T101000Z-0b9f0c41.jsonl.gpg', '--prev-sha256', hashlib.sha256(one.read_bytes()).hexdigest()],
                       check=True, capture_output=True)
        enc.unlink()
        r, calls = self.restore_with(*self.DR, '--ledger-from', folder)
        self.assert_refused_before_anything(r, calls, 'CHAIN_BROKEN: erasure-ledger-20261028T102000Z-0b9f0c42 and erasure-ledger-20261028T103000Z-0b9f0c43 both follow erasure-ledger-20261028T101000Z-0b9f0c41.jsonl.gpg: the chain forks')

    # ── [REVIEW-M S4-1] a batch deleted from a versioned bucket ──────────────
    def versions(self, *items):
        """list-object-versions JSON: (key, kind, latest) with kind V (a version) or D (a delete marker)."""
        doc = {'Versions': [], 'DeleteMarkers': []}
        for key, kind, latest in items:
            doc['Versions' if kind == 'V' else 'DeleteMarkers'].append({'Key': key, 'IsLatest': latest})
        return json.dumps(doc)

    def test_with_versioning_on_a_deleted_or_only_old_batch_is_refused_named(self):
        folder = self.ledger(self.batch(1), self.batch(2))
        here = [(k, 'V', True) for k in self.names(1, 2)]
        gone = 'db/erasure-ledger/erasure-ledger-20261028T103000Z-0b9f0c43.jsonl.gpg'
        for extra, says in (([(gone, 'V', False), (gone, 'D', True), (gone + '.sig', 'V', False), (gone + '.sig', 'D', True)], 'erasure-ledger-20261028T103000Z-0b9f0c43.jsonl.gpg was deleted from the bucket'),
                            ([(gone + '.sig', 'V', False)], 'erasure-ledger-20261028T103000Z-0b9f0c43.jsonl.gpg.sig has only old versions')):
            with self.subTest(says=says):
                r, calls = self.restore_with(*self.DR, '--ledger-from', folder, **self.bucket_env(self.names(1, 2), FAKE_VERSIONING='Enabled',
                                                                                                 FAKE_LEDGER_VERSIONS=self.versions(*here, *extra)))
                self.assert_refused_before_anything(r, calls, says, 'a batch was DELETED from the off-site bucket')
                self.assertIn('VERSIONS db/erasure-ledger/', calls)
        r, calls = self.restore_with(*self.DR, '--ledger-from', folder, **self.bucket_env(self.names(1, 2), FAKE_VERSIONING='Enabled',
                                                                                         FAKE_LEDGER_VERSIONS=self.versions(*here, (self.names(1)[0], 'V', False))))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn('every batch the bucket lists is here, and none was deleted (versioning on)', r.stdout)

    def test_with_versioning_off_or_unreadable_the_result_says_a_deletion_would_not_be_noticed(self):
        folder = self.ledger(self.batch(1))
        for state in ('None', 'Suspended', 'fail'):
            with self.subTest(state=state):
                r, calls = self.restore_with(*self.DR, '--ledger-from', folder, **self.bucket_env(self.names(1), FAKE_VERSIONING=state))
                self.assertEqual(r.returncode, 3, r.stderr)
                self.assertIn('a batch deleted from the bucket together with its signature cannot be noticed', r.stderr)
                self.assertIn('versioning is not on, so a batch DELETED from the bucket would not be noticed', r.stdout)
                self.assertNotIn('VERSIONS db/erasure-ledger/', calls)

    def test_with_versioning_on_a_versions_listing_failure_refuses(self):
        r, calls = self.run_restore('versions', (*self.DR, '--ledger-from', self.ledger(self.batch(1))), trust=self.trust,
                                    **self.bucket_env(self.names(1), FAKE_VERSIONING='Enabled'))
        self.assert_refused_before_anything(r, calls, 'could not list the versions')

    def test_a_bucket_that_cannot_be_listed_refuses_unless_the_owner_says_it_is_gone(self):
        folder = self.ledger(self.batch(1))
        r, calls = self.run_restore('list', (*self.DR, '--ledger-from', folder), trust=self.trust, **self.bucket_env(self.names(1)))
        self.assert_refused_before_anything(r, calls, 'could not list')
        r, calls = self.run_restore('list', (*self.DR, '--ledger-no-bucket-check', '--ledger-from', folder), trust=self.trust, **self.bucket_env(self.names(1)))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertIn('--ledger-no-bucket-check: the off-site bucket is not listed', r.stderr)
        self.assertNotIn('LIST db/erasure-ledger/', calls)


class TheDeidentificationGap(unittest.TestCase):
    """[#1984 COORD ruling 14:11Z] Until the follow-up re-runs the app's own erasure passes on the copy,
    no restore claims to cover the #1905/#1945 de-identifications."""
    run_restore = RestoreQuarantineAndReplay.run_restore
    first = staticmethod(RestoreQuarantineAndReplay.first)
    LINE = 'NOT erasure-complete for #1905/#1945 de-identifications'

    def test_every_restore_says_so(self):
        # (--compare-source takes the same closing path; the stand-in has no tables to compare)
        for args, code in (((), 0), (('--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection'), 3)):
            with self.subTest(args=args):
                r, _ = self.run_restore('', args)
                self.assertEqual(r.returncode, code, r.stderr)
                out = r.stdout + r.stderr
                self.assertIn(self.LINE, out)
                if 'RESTORE OK' in r.stdout:
                    self.assertLess(r.stdout.index(self.LINE), r.stdout.index('RESTORE OK'))

    def test_the_runbook_says_so(self):
        self.assertIn(self.LINE, (DEPLOY / 'PILOT-RUNBOOK.md').read_text())


class RunsUnderAnyStderr(unittest.TestCase):
    """[#1977 CI] A CI runner's stderr can be a socket: `tee /dev/stderr` fails there ("No such device or
    address"). And `printf ... | grep -q` under pipefail can fail on a large snapshot (SIGPIPE when grep
    stops reading early). Neither may appear in restore.sh."""
    def test_no_dev_stderr_and_no_early_closing_pipe(self):
        src = (DEPLOY / 'restore.sh').read_text()
        self.assertNotIn('/dev/stderr', src)
        self.assertEqual([l for l in src.splitlines() if '| grep -q' in l], [])


if __name__ == '__main__':
    unittest.main()
