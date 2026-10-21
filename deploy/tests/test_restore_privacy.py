"""[item 196] restore.sh quarantines the scratch copy and replays the live
erasure ledger onto it BEFORE it reports a restore. Drives the real script with
command stand-ins (no services): every docker call is logged with the database
it targets and what it was fed. The SQL itself is proven on real databases by
apps/api/src/__tests__/restore-erasure-replay.test.ts."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

DEPLOY = Path(__file__).resolve().parents[1]

FAKE_DOCKER = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
# compose ... exec -T postgres sh -c <script> sh <database> <psql args...>
i = args.index('postgres')
script = args[i + 3]
target = args[i + 5] if len(args) > i + 5 else ''
rest = args[i + 6:]
fed = '' if sys.stdin.isatty() else sys.stdin.read()
sql = rest[rest.index('-c') + 1] if '-c' in rest else (rest[rest.index('-tAc') + 1] if '-tAc' in rest else fed)
kind = 'pg_restore' if 'pg_restore' in script else 'psql'
with open(os.environ['CALL_LOG'], 'a') as log:
    log.write(f'{kind} db={target} :: {" ".join(sql.split())[:300]}\n')
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
    if fail == 'replay': sys.exit(9)
    print('erasure ledger replayed: 0 destroyed keys, 0 receipts, 0 retired documents, 0 closed accounts in the live ledger; changed in this copy: nothing (the copy already matched)')
    sys.exit(0)
if 'pg_database WHERE datname' in sql: sys.exit(0)
if 'count(*)' in sql: print('1')
'''


class RestoreQuarantineAndReplay(unittest.TestCase):
    def run_restore(self, fail='', extra_args=()):
        root = Path(tempfile.mkdtemp(prefix='swift-restore-privacy-'))
        self.addCleanup(shutil.rmtree, root, True)
        deploy = root / 'deploy'
        deploy.mkdir()
        for name in ('restore.sh', 'restore-erasure-ledger.sql', 'restore-replay-erasures.sql'):
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
        log = root / 'calls'
        log.write_text('')
        env = dict(os.environ, PATH=f'{bins}:{os.environ["PATH"]}', CALL_LOG=str(log), FAIL=fail)
        r = subprocess.run(['bash', str(deploy / 'restore.sh'), *extra_args, str(dump), 'swift_restore_privacy'],
                           env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)
        return r, log.read_text().splitlines()

    @staticmethod
    def first(lines, fragment):
        return next(i for i, l in enumerate(lines) if fragment in l)

    def test_quarantined_before_any_row_arrives_and_the_ledger_replayed_before_the_report(self):
        r, calls = self.run_restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        create = self.first(calls, 'CREATE DATABASE')
        revoke = self.first(calls, 'REVOKE CONNECT ON DATABASE "swift_restore_privacy" FROM PUBLIC')
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


if __name__ == '__main__':
    unittest.main()
