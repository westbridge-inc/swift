"""[item 196] restore.sh quarantines the scratch copy and replays the live
erasure ledger onto it BEFORE it reports a restore. Drives the real script with
command stand-ins (no services): every docker call is logged with the database
it targets and what it was fed. The SQL itself is proven on real databases by
apps/api/src/__tests__/restore-erasure-replay.test.ts.

[SEC-BACKUP F2] The scratch copy lives in a throwaway instance (`docker run`,
then `docker exec <instance>`), the live database stays behind `docker compose
exec postgres`: the stand-in logs both in the same shape, and every dump here is
signed as backup.sh signs it."""
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
    def run_restore(self, fail='', extra_args=(), project=('--project', 'swift-restore-test'), **env_extra):
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
        allowed.write_text('swift-backup namespaces="swift-backup" ' + ' '.join((root / 'signing.pub').read_text().split()[:2]) + '\n')
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
    """[Off-site erasure ledger] restore.sh --ledger-from <file>: the entries the host unit shipped (the
    owner decrypts them on his own computer). They join the live ledger, or stand alone when the live
    database is gone."""
    run_restore = RestoreQuarantineAndReplay.run_restore
    first = staticmethod(RestoreQuarantineAndReplay.first)

    def ledger(self, lines, mode=0o600):
        d = Path(tempfile.mkdtemp(prefix='swift-offsite-ledger-'))
        self.addCleanup(shutil.rmtree, d, True)
        f = d / 'ledger.jsonl'
        f.write_text(''.join((l if isinstance(l, str) else json.dumps(l)) + '\n' for l in lines))
        f.chmod(mode)
        return str(f)

    def test_a_ledger_others_can_read_or_a_malformed_one_is_refused_before_anything(self):
        for path in (self.ledger(OFFSITE, 0o644), self.ledger(['not json']), self.ledger([{**OFFSITE[0], 'kind': 'something_else'}]),
                     self.ledger([{**OFFSITE[0], 'id': 'not-a-uuid'}]), '/nonexistent/ledger.jsonl'):
            with self.subTest(path=path):
                r, calls = self.run_restore('', ('--ledger-from', path))
                self.assertNotEqual(r.returncode, 0)
                self.assertIn('--ledger-from', r.stderr)
                self.assertFalse(any('CREATE DATABASE' in l for l in calls))

    def test_with_the_live_database_the_offsite_entries_join_the_live_ledger(self):
        r, calls = self.run_restore('', ('--ledger-from', self.ledger(OFFSITE)))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertTrue(any(':: COPY (' in l and l.startswith('psql db=swift_live_fixture') for l in calls))
        script = self.replay_script
        self.assertIn('CREATE TEMP TABLE restore_offsite', script)
        self.assertIn('"kind": "destroyed_keys"', script.replace('""', '"'))
        self.assertLess(script.index('INSERT INTO restore_ledger_closed_account_rows'), script.index('REPLAY THE LIVE ERASURE LEDGER'))
        self.assertIn('RESTORE OK', r.stdout)

    def test_without_the_live_database_the_offsite_ledger_makes_the_copy_erasure_complete_up_to_its_newest_entry(self):
        r, calls = self.run_restore('', ('--no-live-ledger', '--i-know-live-is-gone', '--keep-for-inspection', '--ledger-from', self.ledger(OFFSITE)))
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertEqual([l for l in calls if 'db=swift_live_fixture' in l], [])
        self.assertIn('CREATE TEMP TABLE restore_ledger_closed_accounts', self.replay_script)
        self.assertIn('CREATE TEMP TABLE restore_offsite', self.replay_script)
        out = r.stdout + r.stderr
        self.assertIn('erasure-complete up to 2026-10-21T12:00:01.000', out)
        self.assertNotIn('NOT erasure-complete: replay the off-site ledger', out)
        self.assertNotIn('RESTORE OK', out)



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
