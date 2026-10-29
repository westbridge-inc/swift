"""[Off-site erasure ledger] deploy/erasure-ledger-ship.sh ships every unshipped erasure ledger entry,
encrypted to the owner's pinned backup key, to the off-site bucket, and records the shipment ONLY once
the object is verified there. Real GnuPG with the owner's own key script; Docker (compose psql and the
pinned AWS CLI) is a stand-in over a fake bucket directory.

[BACKUP-FU] Every batch is signed with the backup signing key, as every dump is: <batch>.sig beside it,
proven against the allowed-signers file before anything leaves, uploaded and checked before the
shipment is recorded."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
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
    mounts = [args[i + 1].split(":")[:2] for i, a in enumerate(args) if a == "-v"]
    host, inner = mounts[0]
    def local(path):
        for h, c in mounts:
            if path == c or path.startswith(c + "/"):
                return h + path[len(c):]
        raise SystemExit("unmounted path " + path)
    if "list-objects-v2" in args:
        if os.environ.get("LIST_FAIL") == "1": sys.exit(255)
        prefix = args[args.index("--prefix") + 1]
        keys = sorted(os.path.relpath(os.path.join(r, f), bucket) for r, _, fs in os.walk(bucket) for f in fs)
        keys = [k for k in keys if k.startswith(prefix)]
        print("\t".join(keys) if keys else "None"); sys.exit(0)
    if "cp" in args and args[args.index("cp") + 1].startswith("s3://"):
        i = args.index("cp")
        src, dst = args[i + 1], args[i + 2]
        shutil.copyfile(os.path.join(bucket, src[len("s3://"):].split("/", 1)[1]), local(dst))
        sys.exit(0)
    if "cp" in args:
        i = args.index("cp")
        src, dst = args[i + 1], args[i + 2]
        if os.environ.get("UPLOAD_FAIL") == "1": sys.exit(1)
        if os.environ.get("SIG_UPLOAD_FAIL") == "1" and dst.endswith(".sig"): sys.exit(1)
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
        for name in ("erasure-ledger-ship.sh", "backup.sh", "secret-env.sh", "backup-signature.py"):
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
        # [BACKUP-FU] A backup signing key of the test's own, and the allowed-signers file restores trust.
        self.signing = self.tmp / "signing"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "swift-backup-signing", "-f", str(self.signing)], check=True)
        self.allowed = self.tmp / "allowed_signers"
        self.allowed.write_text('swift-backup namespaces="swift-backup" ' + " ".join((self.tmp / "signing.pub").read_text().split()[:2]) + "\n")
        self.allowed.chmod(0o644)
        self.first_signed = self.tmp / "first-signed-erasure-ledger"
        self.chain = self.tmp / "erasure-ledger-chain"

    def run_ship(self, *args, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_", "PILOT_ENV"))}
        env.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.calls), "FAKE_BUCKET": str(self.bucket),
            "FAKE_LEDGER": str(self.ledger), "SHIP_LOG": str(self.ships),
            "BACKUP_BUCKET": "swift-backups", "AWS_ACCESS_KEY_ID": "test-id", "AWS_SECRET_ACCESS_KEY": "test-secret",
            "AWS_CLI_IMAGE": IMAGE, "AWS_S3_ENDPOINT": "https://storage.example.invalid", "PILOT_ENV": "production",
            "BACKUP_GPG_FINGERPRINT": self.fpr, "BACKUP_GPG_RECIPIENT_FILE": str(self.public),
            "BACKUP_SIGNING_KEY_FILE": str(self.signing), "BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.allowed),
            "BACKUP_FIRST_SIGNED_LEDGER_FILE": str(self.first_signed), "BACKUP_LEDGER_CHAIN_FILE": str(self.chain),
        })
        env.update(extra)
        env = {k: v for k, v in env.items() if v is not None}
        return subprocess.run(["bash", str(self.deploy / "erasure-ledger-ship.sh"), *args], env=env,
                              capture_output=True, text=True, timeout=120)

    def objects(self):
        return sorted(p for p in self.bucket.rglob("*") if p.is_file())

    def batches(self):
        return [p for p in self.objects() if p.name.endswith(".jsonl.gpg")]

    def verify(self, sig, name, *args):
        return subprocess.run([sys.executable, "-I", str(DEPLOY / "backup-signature.py"), "verify", "--allowed-signers", str(self.allowed),
                               "--sig", str(sig), "--name", name, *args], capture_output=True, text=True)

    def test_the_compose_project_is_named_or_nothing_runs(self):
        for args in ((), ("--project", "Swift"), ("--project",)):
            r = self.run_ship(*args)
            self.assertNotEqual(r.returncode, 0, args)
            self.assertIn("--project", r.stderr)
            self.assertEqual(self.calls.read_text(), "", args)

    def test_production_ships_every_entry_encrypted_to_the_owner_key_and_records_it_after_the_check(self):
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [obj] = self.batches()
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

    def test_every_batch_is_signed_beside_it_and_the_signature_is_off_site_before_the_shipment_is_recorded(self):
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [obj] = self.batches()
        sig = Path(str(obj) + ".sig")
        self.assertEqual(sorted(self.objects()), sorted([obj, sig]))
        # What a restore checks: the trusted key signed this batch's name, its bytes, and the plain batch.
        plain = self.tmp / "plain.jsonl"
        plain.write_bytes(decrypt(obj, self.private))
        ok = self.verify(sig, obj.name, "--object", str(obj), "--plain", str(plain))
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn(f"plain-sha256 {hashlib.sha256(plain.read_bytes()).hexdigest()}\n", sig.read_text())
        self.assertNotIn("synthetic-closed-account", sig.read_text())
        # Uploaded after the batch, before the shipment is recorded.
        log = self.calls.read_text().splitlines()
        batch_up = next(i for i, l in enumerate(log) if " cp " in l and not l.split()[-3].endswith(".sig"))
        sig_up = next(i for i, l in enumerate(log) if " cp " in l and l.split()[-3].endswith(".sig"))
        record = next(i for i, l in enumerate(log) if "INSERT INTO erasure_ledger_shipment" in l)
        self.assertLess(batch_up, sig_up)
        self.assertLess(sig_up, record)
        self.assertIn(f"signed → {obj.name}.sig", r.stdout)
        # When signing began, recorded once.
        stamp = self.first_signed.read_text().strip()
        self.assertRegex(stamp, r"^\d{8}T\d{6}Z$")
        self.assertIn(stamp, obj.name)

    # ── [BACKUP-FU · COORD] the chain ─────────────────────────────────────────
    def manifest(self, sig):
        text = Path(sig).read_text()
        return dict(l.split(" ", 1) for l in text[:text.index("-----BEGIN")].splitlines()[1:])

    def next_batch(self, n):
        import time; time.sleep(1.1)  # a new second: the batch names carry the time
        self.ledger.write_text("".join(json.dumps({**e, "id": e["id"][:-1] + str(n)}) + "\n" for e in ENTRIES))

    def test_the_first_batch_starts_the_chain_and_each_next_one_names_the_one_before_it(self):
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [first] = self.batches()
        first_sig = Path(str(first) + ".sig")
        self.assertEqual(self.manifest(first_sig)["prev"], "none")
        self.assertNotIn("prev-sha256", self.manifest(first_sig))
        self.assertEqual(self.chain.read_text().split(), [first.name, hashlib.sha256(first_sig.read_bytes()).hexdigest()])
        self.next_batch(7)
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [second] = [b for b in self.batches() if b != first]
        m = self.manifest(Path(str(second) + ".sig"))
        self.assertEqual(m["prev"], first.name)
        self.assertEqual(m["prev-sha256"], hashlib.sha256(first_sig.read_bytes()).hexdigest())
        ok = self.verify(Path(str(second) + ".sig"), second.name, "--object", str(second))
        self.assertEqual(ok.returncode, 0, ok.stderr)

    def test_a_host_without_its_chain_record_links_to_the_newest_proven_batch_in_the_bucket(self):
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [first] = self.batches()
        self.chain.unlink()
        self.next_batch(8)
        r = self.run_ship("--project", "swift")
        self.assertEqual(r.returncode, 0, r.stderr)
        [second] = [b for b in self.batches() if b != first]
        self.assertEqual(self.manifest(Path(str(second) + ".sig"))["prev"], first.name)

    def test_a_planted_newest_signature_in_the_bucket_is_not_linked_to(self):
        other = self.tmp / "planter"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "planter", "-f", str(other)], check=True)
        planted = self.bucket / "db/erasure-ledger/erasure-ledger-20991231T000000Z-ffffffff.jsonl.gpg"
        planted.parent.mkdir(parents=True)
        planted.write_bytes(b"planted")
        subprocess.run([sys.executable, "-I", str(DEPLOY / "backup-signature.py"), "sign", "--key", str(other), "--object", str(planted),
                        "--out", f"{planted}.sig", "--created", "20991231T000000Z", "--prev", "none"], check=True, capture_output=True)
        r = self.run_ship("--project", "swift")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("does not verify", r.stderr)
        self.assertFalse(self.ships.exists())
        self.assertFalse(self.chain.exists())

    def test_a_chain_that_cannot_be_continued_ships_nothing(self):
        for extra, prep in (({"LIST_FAIL": "1"}, None), ({}, lambda: self.first_signed.write_text("20261028T091500Z\n")),
                            ({}, lambda: self.chain.write_text("not-a-batch 1234\n"))):
            with self.subTest(extra=extra, prep=prep is not None):
                for f in (self.first_signed, self.chain, self.ships):
                    if f.exists(): f.unlink()
                if prep: prep()
                r = self.run_ship("--project", "swift", **extra)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("nothing was shipped", r.stderr)
                self.assertEqual(self.objects(), [])
                self.assertFalse(self.ships.exists())

    def test_a_signature_that_does_not_upload_or_verify_records_nothing(self):
        for extra in ({"SIG_UPLOAD_FAIL": "1"}, {"BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.tmp / "missing-allowed-signers")}):
            with self.subTest(extra=extra):
                if self.ships.exists(): self.ships.unlink()
                r = self.run_ship("--project", "swift", **extra)
                self.assertNotEqual(r.returncode, 0)
                self.assertFalse(self.ships.exists())
                self.assertFalse(self.first_signed.exists())

    def test_a_key_that_is_not_the_trusted_one_ships_nothing(self):
        other = self.tmp / "other"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "other", "-f", str(other)], check=True)
        r = self.run_ship("--project", "swift", BACKUP_SIGNING_KEY_FILE=str(other))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("does NOT verify", r.stderr)
        self.assertEqual(self.objects(), [])
        self.assertFalse(self.ships.exists())

    def test_a_unit_without_the_signing_key_ships_unsigned_and_loudly_until_signing_begins(self):
        r = self.run_ship("--project", "swift", BACKUP_SIGNING_KEY_FILE=None)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("ERASURE LEDGER BATCH NOT SIGNED", r.stderr)
        self.assertIn("(UNSIGNED)", r.stdout)
        [obj] = self.objects()
        self.assertTrue(obj.name.endswith(".jsonl.gpg"))
        self.assertTrue(self.ships.exists())
        self.assertFalse(self.first_signed.exists())

    def test_once_a_signed_batch_has_shipped_a_run_without_the_key_ships_nothing(self):
        self.first_signed.write_text("20261028T091500Z\n")
        r = self.run_ship("--project", "swift", BACKUP_SIGNING_KEY_FILE=None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("Nothing was shipped", r.stderr)
        self.assertEqual(self.objects(), [])
        self.assertFalse(self.ships.exists())

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
        # [BACKUP-FU] the signing key from the backup store, and no *_FILE pointer that could shadow it
        self.assertIn("LoadCredentialEncrypted=BACKUP_SIGNING_KEY:/etc/credstore.encrypted/swift-backup/BACKUP_SIGNING_KEY.cred", unit)
        self.assertRegex(unit, r"(?m)^UnsetEnvironment=.* BACKUP_SIGNING_KEY_FILE( |$)")

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
