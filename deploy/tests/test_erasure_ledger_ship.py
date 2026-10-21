"""[Off-site erasure ledger] deploy/erasure-ledger-ship.sh ships every unshipped erasure ledger entry,
encrypted to the owner's pinned backup key, to the off-site bucket, and records the shipment ONLY once
the object is verified there. Real GnuPG with the owner's own key script; Docker (compose psql and the
pinned AWS CLI) is a stand-in over a fake bucket directory."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

from test_backup_encryption import IMAGE, PASSPHRASE, decrypt, make_owner_key, shim

DEPLOY = Path(__file__).resolve().parents[1]

FAKE_DOCKER = r'''
import os, shutil, sys
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("docker " + " ".join(args).replace("\n", " ") + "\n")
bucket = os.environ["FAKE_BUCKET"]
if args[:1] == ["compose"]:
    joined = " ".join(args)
    last_c = len(args) - 1 - args[::-1].index("-c") if "-c" in args else -1
    sql = args[last_c + 1] if last_c >= 0 else ""
    ro = "default_transaction_read_only=on" in joined
    if "to_regclass('public.erasure_ledger_entry')" in sql:
        print("t"); sys.exit(0)
    if "json_build_object" in sql:
        if not ro: sys.exit(42)
        sys.stdout.write(open(os.environ["FAKE_LEDGER"]).read()); sys.exit(0)
    if "INSERT INTO erasure_ledger_shipment" in sql:
        with open(os.environ["SHIP_LOG"], "a") as ship:
            ship.write(sql + "\n")
        sys.exit(0)
    sys.exit(0)
if args[:1] == ["run"]:
    mount = args[args.index("-v") + 1]
    host, inner = mount.split(":")[0], mount.split(":")[1]
    if "cp" in args:
        i = args.index("cp")
        src, dst = args[i + 1], args[i + 2]
        if os.environ.get("UPLOAD_FAIL") == "1": sys.exit(1)
        target = os.path.join(bucket, dst[len("s3://"):].split("/", 1)[1])
        os.makedirs(os.path.dirname(target), exist_ok=True)
        shutil.copyfile(src.replace(inner, host, 1), target)
        sys.exit(0)
    if "head-object" in args:
        key = args[args.index("--key") + 1]
        size = os.path.getsize(os.path.join(bucket, key))
        print(size + (1 if os.environ.get("SIZE_LIES") == "1" else 0)); sys.exit(0)
sys.exit(0)
'''

ENTRIES = [
    {"id": "0b9f0c3e-1111-4a2b-8c3d-000000000001", "kind": "closed_accounts", "entry": {"id": "synthetic-closed-account", "phone": "deleted:synthetic-closed-account", "kept": []}, "createdAt": "2026-10-21T12:00:00.000"},
    {"id": "0b9f0c3e-1111-4a2b-8c3d-000000000002", "kind": "destroyed_keys", "entry": {"fileKey": "verification/synthetic/doc.enc", "createdBy": "synthetic-closed-account", "shreddedAt": None}, "createdAt": "2026-10-21T12:00:01.000"},
]


@unittest.skipUnless(shutil.which("gpg") and shutil.which("gpgconf"), "GnuPG is not installed")
class ErasureLedgerShip(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = Path(tempfile.mkdtemp(prefix="swift-ledger-keys-"))
        cls.fpr, cls.public, cls.private = make_owner_key(cls.keys / "owner")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.keys, True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-ledger-ship-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.deploy.mkdir()
        for name in ("erasure-ledger-ship.sh", "backup.sh", "secret-env.sh"):
            shutil.copy2(DEPLOY / name, self.deploy / name)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        shim(self.bin, "docker", FAKE_DOCKER, python=True)
        self.bucket = self.tmp / "bucket"
        self.bucket.mkdir()
        self.calls = self.tmp / "calls"
        self.calls.write_text("")
        self.ships = self.tmp / "ships"
        self.ledger = self.tmp / "ledger.jsonl"
        self.ledger.write_text("".join(json.dumps(e) + "\n" for e in ENTRIES))

    def run_ship(self, *args, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_", "PILOT_ENV"))}
        env.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.calls), "FAKE_BUCKET": str(self.bucket),
            "FAKE_LEDGER": str(self.ledger), "SHIP_LOG": str(self.ships),
            "BACKUP_BUCKET": "swift-backups", "AWS_ACCESS_KEY_ID": "test-id", "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_CLI_IMAGE": IMAGE, "AWS_S3_ENDPOINT": "https://storage.example.invalid", "PILOT_ENV": "production",
            "BACKUP_GPG_FINGERPRINT": self.fpr, "BACKUP_GPG_RECIPIENT_FILE": str(self.public),
        })
        env.update(extra)
        env = {k: v for k, v in env.items() if v is not None}
        return subprocess.run(["bash", str(self.deploy / "erasure-ledger-ship.sh"), *args], env=env,
                              capture_output=True, text=True, timeout=120)

    def objects(self):
        return sorted(p for p in self.bucket.rglob("*") if p.is_file())

    def test_the_compose_project_is_named_or_nothing_runs(self):
        for args in ((), ("--project", "Swift"), ("--project",)):
            r = self.run_ship(*args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn("--project", r.stderr)
            self.assertEqual(self.calls.read_text(), "", args)

    def test_production_ships_every_entry_encrypted_to_the_owner_key_and_records_it_after_the_check(self):
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [obj] = self.objects()
        rel = obj.relative_to(self.bucket).as_posix()
        self.assertRegex(rel, r"^db/erasure-ledger/erasure-ledger-\d{8}T\d{6}Z-0b9f0c3e\.jsonl\.gpg$")
        # Only ciphertext left; the owner's private key opens exactly the entries.
        self.assertNotIn(b"synthetic-closed-account", obj.read_bytes())
        lines = [json.loads(l) for l in decrypt(obj, self.private).decode().splitlines() if l.strip()]
        self.assertEqual(lines, ENTRIES)
        # Recorded, both entries, with the object key, after the upload.
        ship = self.ships.read_text()
        for e in ENTRIES:
            self.assertIn(e["id"], ship)
        self.assertIn(f"'{rel}'", ship)
        log = self.calls.read_text().splitlines()
        upload = next(i for i, l in enumerate(log) if " cp " in l)
        record = next(i for i, l in enumerate(log) if "INSERT INTO erasure_ledger_shipment" in l)
        self.assertLess(upload, record)
        # Nothing an entry holds is printed.
        self.assertNotIn("synthetic-closed-account", r.stdout + r.stderr)

    def test_nothing_to_ship_uploads_nothing(self):
        self.ledger.write_text("")
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("nothing to ship", r.stdout)
        self.assertEqual(self.objects(), [])
        self.assertFalse(self.ships.exists())

    def test_a_failed_or_unverified_upload_records_nothing(self):
        for flag in ("UPLOAD_FAIL", "SIZE_LIES"):
            with self.subTest(flag=flag):
                if self.ships.exists(): self.ships.unlink()
                r = self.run_ship("--project", "swift", **{flag: "1"})
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("nothing was recorded as shipped", r.stderr)
                self.assertFalse(self.ships.exists())

    def test_production_without_the_owner_key_ships_nothing(self):
        r = self.run_ship("--project", "swift", BACKUP_GPG_FINGERPRINT=None, BACKUP_GPG_RECIPIENT_FILE=None)
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.objects(), [])
        self.assertFalse(self.ships.exists())

    def test_outside_production_without_the_owner_key_nothing_leaves_in_clear(self):
        # [#1984 REVIEW-F S4-1] staging serves real people until the cutover: no batch ever leaves unencrypted.
        r = self.run_ship("--project", "swift", PILOT_ENV="staging", BACKUP_GPG_FINGERPRINT=None, BACKUP_GPG_RECIPIENT_FILE=None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("owner's backup key", r.stderr)
        self.assertEqual(self.objects(), [])
        self.assertFalse(self.ships.exists())

    def test_without_an_offsite_bucket_nothing_is_recorded(self):
        r = self.run_ship("--project", "swift", BACKUP_BUCKET=None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("BACKUP_BUCKET", r.stderr)
        self.assertFalse(self.ships.exists())

    def test_the_live_reads_are_read_only(self):
        # The stand-in refuses the batch read unless it runs read-only (exit 42).
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)


class ShipperUnits(unittest.TestCase):
    def test_the_timer_runs_every_minute_and_the_unit_names_the_project(self):
        timer = (DEPLOY / "swift-erasure-ledger.timer").read_text()
        self.assertIn("OnUnitActiveSec=1min", timer)
        self.assertIn("Unit=swift-erasure-ledger.service", timer)
        unit = (DEPLOY / "swift-erasure-ledger.service").read_text()
        self.assertIn("ExecStart=/opt/swift/deploy/erasure-ledger-ship.sh --project swift", unit)
        self.assertIn("UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE", unit)

    def test_production_pilot_up_needs_the_ledger_timer_before_the_api_starts(self):
        # [#1984 REVIEW-G S3-1] the watch pages production; the shipper must exist before the API does.
        pilot = (DEPLOY / "pilot-up.sh").read_text()
        block = pilot[pilot.index('if [ "$PILOT_ENV" = production ]; then\n  env -u BACKUP_GPG_RECIPIENT_FILE'):]
        block = block[:block.index("\nfi\n")]
        self.assertIn('if [ "$DATA_ONLY" -eq 0 ]; then', block)
        self.assertIn("systemctl is-enabled --quiet swift-erasure-ledger.timer && systemctl is-active --quiet swift-erasure-ledger.timer ||", block)

    def test_the_doctor_fails_on_an_unshipped_entry_and_a_missing_production_timer(self):
        doctor = (DEPLOY / "doctor.sh").read_text()
        self.assertIn("interval '10 minutes'", doctor)
        self.assertIn('bad "$LATE erasure ledger entr(ies) older than 10 minutes have not reached the off-site ledger', doctor)
        self.assertIn("swift-erasure-ledger.timer", doctor)


if __name__ == "__main__":
    unittest.main()
