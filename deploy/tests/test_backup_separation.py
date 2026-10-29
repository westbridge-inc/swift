"""[SEC-BACKUP] Backups are not the API's: their own storage key, signed dumps,
and restores that cannot run a planted archive as a superuser.

Scan 3 (28 Oct) found: F1, the backup bucket shared the API's storage keys
(whoever held the API's key could read, overwrite or delete every off-site
backup); F2, restore.sh ran any archive under the backup prefix with
pg_restore as the Postgres superuser inside the live cluster. What is proven
here, service-free (real bash scripts, real ssh-keygen signatures; shims for
systemd-creds, docker, pg_restore and ssh):

  F1  the backup, erasure-ledger and restore units load ONLY the backup
      store's credentials (/etc/credstore.encrypted/swift-backup), never the
      API's pair; `swift-secrets materialize` never copies a backup credential
      into /run/swift-secrets; `set` refuses one; `backup init` keeps backups
      running with a copy of the API pair until the owner stores the backup
      bucket's own pair (`backup set-keys`, which refuses the API's key); the
      scripts use the backup pair whenever it is present and the API's only as
      a loud fallback, recorded in the heartbeat for the API's page;
  F2  backup.sh signs every dump and uploads the signature beside it (and
      still backs up, loudly unsigned, without a key); restore.sh refuses an
      unsigned dump (unless --allow-unsigned-legacy, which warns), a tampered
      one, a renamed one and one signed by another key, before anything is
      created; it never restores into the live cluster or as its superuser:
      the archive goes into a throwaway instance with no network, as a login
      that is not a superuser there; the drill carries the host-verified
      signature to the restore.
"""

import base64
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from test_secrets_store import StoreHarness  # noqa: E402

DEPLOY = Path(__file__).resolve().parents[1]
SIGNER = DEPLOY / "backup-signature.py"
IMAGE = "amazon/aws-cli:2.29.12@sha256:" + "f" * 64
UNITS = ("swift-backup.service", "swift-erasure-ledger.service")


def load_credentials(unit_text):
    return re.findall(r"^LoadCredentialEncrypted=([A-Z0-9_]+):(\S+)$", unit_text, re.M)


def make_signing_key(folder: Path, name="signing"):
    key = folder / name
    subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "swift-backup-signing", "-f", str(key)], check=True)
    pub = " ".join((folder / f"{name}.pub").read_text().split()[:2])
    allowed = folder / f"{name}.allowed"
    allowed.write_text(f'swift-backup namespaces="swift-backup" {pub}\n')
    allowed.chmod(0o644)
    return key, allowed


def sign(key: Path, obj: Path, plain_sha=None, out=None):
    args = [sys.executable, "-I", str(SIGNER), "sign", "--key", str(key), "--object", str(obj),
            "--out", str(out or Path(str(obj) + ".sig")), "--created", "20261028T091500Z"]
    if plain_sha:
        args += ["--plain-sha256", plain_sha]
    subprocess.run(args, check=True, capture_output=True)


# ── F1: the units ─────────────────────────────────────────────────────────────
class UnitsLoadOnlyTheBackupStore(unittest.TestCase):
    def test_backup_and_ledger_units_never_load_the_api_storage_key(self):
        for unit in UNITS:
            text = (DEPLOY / unit).read_text()
            creds = load_credentials(text)
            self.assertTrue(creds, unit)
            for name, path in creds:
                self.assertTrue(name.startswith("BACKUP_"), f"{unit} loads {name}")
                self.assertEqual(path, f"/etc/credstore.encrypted/swift-backup/{name}.cred", unit)
            self.assertNotIn("/etc/credstore.encrypted/swift/", text, unit)
            names = {n for n, _ in creds}
            self.assertLessEqual({"BACKUP_AWS_ACCESS_KEY_ID", "BACKUP_AWS_SECRET_ACCESS_KEY", "BACKUP_KEY_SOURCE"}, names, unit)
            unset = " ".join(l.split("=", 1)[1] for l in text.splitlines() if l.startswith("UnsetEnvironment="))
            for name in names:
                self.assertIn(f"{name}_FILE", unset, unit)

    def test_the_backup_unit_and_the_ledger_unit_both_hold_the_signing_key(self):
        # [BACKUP-FU] erasure ledger batches are signed with the same key as the dumps
        for unit in UNITS:
            self.assertIn("BACKUP_SIGNING_KEY", dict(load_credentials((DEPLOY / unit).read_text())), unit)

    def test_the_drill_and_the_runbook_restore_use_the_backup_store_and_the_api_pair_only_as_the_fallback(self):
        drill = (DEPLOY / "backup-drill.sh").read_text()
        pick = drill[drill.index("PICK_KEYS="):drill.index("UNIT=")]
        then, otherwise = pick.split("else", 1)
        self.assertIn("/etc/credstore.encrypted/swift-backup/BACKUP_AWS_ACCESS_KEY_ID.cred", then)
        self.assertNotIn("/etc/credstore.encrypted/swift/", then)
        self.assertIn("WARNING", otherwise)
        self.assertIn("/etc/credstore.encrypted/swift/AWS_ACCESS_KEY_ID.cred", otherwise)
        runbook = (DEPLOY / "PILOT-RUNBOOK.md").read_text()
        fragment = runbook[runbook.index("systemd-run --pipe"):runbook.index("/opt/swift/deploy/restore.sh")]
        self.assertIn("/etc/credstore.encrypted/swift-backup/BACKUP_AWS_ACCESS_KEY_ID.cred", fragment)
        self.assertNotIn("/etc/credstore.encrypted/swift/AWS_", fragment)


# ── F1: the store ─────────────────────────────────────────────────────────────
# The pinned AWS CLI as `swift-secrets backup set-keys` runs it to prove a new key's scope:
# FAKE_KEY_SCOPE=limited (backup bucket only), full (every bucket), none (not even the backup bucket).
FAKE_SCOPE_DOCKER = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("docker " + " ".join(args) + "\n")
if args[:1] != ["run"] or "list-objects-v2" not in args:
    sys.exit(9)
bucket = args[args.index("--bucket") + 1]
scope = os.environ.get("FAKE_KEY_SCOPE", "limited")
key = os.environ.get("AWS_ACCESS_KEY_ID", "")
with open(os.environ["CALL_LOG"] + ".keys", "a") as keys:
    keys.write(f"{bucket}:{key}\n")
allowed = {"limited": {"swift-backups"}, "full": {"swift-backups", "swift-uploads"}, "none": set()}[scope]
if bucket in allowed:
    print("{}"); sys.exit(0)
sys.stderr.write("An error occurred (AccessDenied) when calling the ListObjectsV2 operation: Access Denied\n")
sys.exit(254)
'''


class BackupStore(StoreHarness):
    def setUp(self):
        super().setUp()
        self.backup_store = self.tmp / "credstore-backup"
        self.allowed = self.tmp / "etc-swift" / "backup-allowed-signers"
        self.deploy_env = self.tmp / "deploy.env"
        self.deploy_env.write_text("BACKUP_BUCKET=swift-backups\nAWS_S3_BUCKET=swift-uploads\n"
                                   "AWS_S3_ENDPOINT=https://storage.example.invalid\nAWS_CLI_IMAGE=" + IMAGE + "\n")
        (self.bin / "docker").write_text(FAKE_SCOPE_DOCKER)
        (self.bin / "docker").chmod(0o755)

    def env(self, **extra):
        return super().env(SWIFT_SECRETS_BACKUP_STORE_DIR=str(self.backup_store),
                           SWIFT_SECRETS_ALLOWED_SIGNERS=str(self.allowed),
                           SWIFT_SECRETS_DEPLOY_ENV=str(self.deploy_env), **extra)

    # [SEC-BACKUP · REVIEW-M S4-1] "dedicated" is proven, not a label.
    def test_set_keys_stores_only_a_key_the_uploads_bucket_refuses_and_the_backup_bucket_accepts(self):
        self.api_keys()
        for scope, why in (("full", b"can read the uploads bucket"), ("none", b"cannot read the backup bucket")):
            with self.subTest(scope=scope):
                r = self.run_store("backup", "set-keys", stdin=b"BACKUPKEYID01\nbackup-secret\n", FAKE_KEY_SCOPE=scope)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(why, r.stderr)
                self.assertIn(b"nothing stored", r.stderr)
                self.assertFalse((self.backup_store / "BACKUP_AWS_ACCESS_KEY_ID.cred").exists())
        r = self.run_store("backup", "set-keys", stdin=b"BACKUPKEYID01\nbackup-secret\n", FAKE_KEY_SCOPE="limited")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(b"refused on the uploads bucket", r.stdout)
        tried = Path(str(self.log) + ".keys").read_text().splitlines()
        self.assertIn("swift-uploads:BACKUPKEYID01", tried)
        self.assertIn("swift-backups:BACKUPKEYID01", tried)
        # the secret travels by environment NAME only: never in the docker argv
        self.assertNotIn("backup-secret", self.calls())

    def test_set_keys_without_the_settings_to_prove_the_scope_stores_nothing(self):
        self.api_keys()
        self.deploy_env.write_text("AWS_S3_BUCKET=swift-uploads\n")
        r = self.run_store("backup", "set-keys", stdin=b"BACKUPKEYID01\nbackup-secret\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"BACKUP_BUCKET", r.stderr)
        self.assertFalse((self.backup_store / "BACKUP_AWS_ACCESS_KEY_ID.cred").exists())

    def decrypt(self, store: Path, name: str) -> bytes:
        head, embedded, payload = (store / f"{name}.cred").read_bytes().split(b"\n", 2)
        self.assertEqual(embedded.decode(), name)
        return base64.b64decode(payload)

    def api_keys(self):
        self.set_ok("AWS_ACCESS_KEY_ID", b"APIKEYID0001")
        self.set_ok("AWS_SECRET_ACCESS_KEY", b"api-secret-value")

    def test_set_refuses_a_backup_name_and_writes_nothing(self):
        for name in ("BACKUP_AWS_ACCESS_KEY_ID", "BACKUP_SIGNING_KEY"):
            r = self.run_store("set", name, stdin=b"value")
            self.assertNotEqual(r.returncode, 0)
            self.assertIn(b"backup store", r.stderr)
            self.assertFalse((self.store / f"{name}.cred").exists())

    def test_init_keeps_backups_running_on_a_copy_of_the_api_pair_and_says_so(self):
        self.api_keys()
        r = self.run_store("backup", "init")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_AWS_ACCESS_KEY_ID"), b"APIKEYID0001")
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_AWS_SECRET_ACCESS_KEY"), b"api-secret-value")
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_KEY_SOURCE"), b"shared-api-key")
        self.assertIn(b"WARNING: backups still share the API's storage key", r.stderr)
        self.assertNotIn(b"api-secret-value", r.stdout + r.stderr)

    def test_init_makes_one_signing_key_whose_public_half_restores_trust_and_keeps_it(self):
        self.api_keys()
        self.assertEqual(self.run_store("backup", "init").returncode, 0)
        key = self.tmp / "signing.key"
        key.write_bytes(self.decrypt(self.backup_store, "BACKUP_SIGNING_KEY"))
        key.chmod(0o600)
        obj = self.tmp / "swift-x.dump"
        obj.write_bytes(b"PGDMP fixture")
        sign(key, obj)
        ok = subprocess.run([sys.executable, "-I", str(SIGNER), "verify", "--allowed-signers", str(self.allowed),
                             "--sig", f"{obj}.sig", "--name", obj.name, "--object", str(obj)], capture_output=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        first = self.allowed.read_text()
        before = (self.backup_store / "BACKUP_SIGNING_KEY.cred").read_bytes()
        self.assertEqual(self.run_store("backup", "init").returncode, 0)
        self.assertEqual((self.backup_store / "BACKUP_SIGNING_KEY.cred").read_bytes(), before)
        self.assertEqual(self.allowed.read_text(), first)
        self.assertEqual(len(first.splitlines()), 1)

    def test_materialize_never_copies_a_backup_credential_into_the_containers_directory(self):
        self.api_keys()
        self.set_ok("JWT_SECRET", b"jwt")
        self.assertEqual(self.run_store("backup", "init").returncode, 0)
        self.assertEqual(self.run_store("backup", "set-keys", stdin=b"BACKUPKEYID01\nbackup-secret\n").returncode, 0)
        # Planted by hand in the main store too: skipped, loudly, the rest still delivered.
        shutil.copy2(self.backup_store / "BACKUP_AWS_SECRET_ACCESS_KEY.cred", self.store / "BACKUP_AWS_SECRET_ACCESS_KEY.cred")
        before = len(self.calls())
        r = self.run_store("materialize")
        self.assertEqual(r.returncode, 0, r.stderr)
        delivered = sorted(p.name for p in self.run_dir.iterdir())
        self.assertEqual(delivered, ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "JWT_SECRET"])
        self.assertIn(b"BACKUP_AWS_SECRET_ACCESS_KEY is in the main store", r.stderr)
        for p in self.run_dir.iterdir():
            self.assertNotIn(b"backup-secret", p.read_bytes())
        # materialize never even opens the backup store, nor decrypts the planted copy
        self.assertNotIn(str(self.backup_store), self.calls()[before:])
        self.assertNotIn("--name=BACKUP_", self.calls()[before:])

    def test_set_keys_stores_the_owner_pair_as_dedicated_and_init_never_replaces_it(self):
        self.api_keys()
        r = self.run_store("backup", "set-keys", stdin=b"BACKUPKEYID01\nbackup-secret\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(b"backup-secret", r.stdout + r.stderr)
        self.assertNotIn("backup-secret", self.calls())
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_AWS_ACCESS_KEY_ID"), b"BACKUPKEYID01")
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_AWS_SECRET_ACCESS_KEY"), b"backup-secret")
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_KEY_SOURCE"), b"dedicated")
        r = self.run_store("backup", "init")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertNotIn(b"WARNING", r.stderr)
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_AWS_ACCESS_KEY_ID"), b"BACKUPKEYID01")
        self.assertEqual(self.decrypt(self.backup_store, "BACKUP_KEY_SOURCE"), b"dedicated")

    def test_set_keys_refuses_the_api_key_and_a_half_pair(self):
        self.api_keys()
        r = self.run_store("backup", "set-keys", stdin=b"APIKEYID0001\nwhatever\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"the API's own storage key", r.stderr)
        r = self.run_store("backup", "set-keys", stdin=b"BACKUPKEYID01\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse((self.backup_store / "BACKUP_AWS_ACCESS_KEY_ID.cred").exists())

    def test_list_names_only(self):
        self.api_keys()
        self.run_store("backup", "init")
        r = self.run_store("backup", "list")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.decode().splitlines(), [
            "BACKUP_AWS_ACCESS_KEY_ID", "BACKUP_AWS_SECRET_ACCESS_KEY", "BACKUP_KEY_SOURCE", "BACKUP_SIGNING_KEY",
            "storage key: shared-api-key"])


# ── F1 + F2: backup.sh and the ledger shipper ───────────────────────────────────
FAKE_DOCKER = r'''#!/usr/bin/env python3
import os, shutil, sys
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("docker " + " ".join(args) + "\n")
bucket = os.environ["FAKE_BUCKET"]
if args[:1] == ["compose"]:
    joined = " ".join(args)
    if "pg_dump" in joined:
        sys.stdout.buffer.write(open(os.environ["FIXTURE_DUMP"], "rb").read())
    elif not sys.stdin.isatty():
        data = sys.stdin.read()
        if "INSERT INTO platform_config" in data:
            open(os.environ["CALL_LOG"] + ".heartbeat", "w").write(data)
        if "to_regclass('public.erasure_ledger_entry')" in joined:
            print("t")
        elif "json_build_object" in joined:
            print('{"id":"00000000-0000-4000-8000-000000000001","kind":"receipts","entry":{},"createdAt":"2026-10-28T09:00:00.000"}')
    else:
        if "to_regclass('public.erasure_ledger_entry')" in joined:
            print("t")
        elif "json_build_object" in joined:
            print('{"id":"00000000-0000-4000-8000-000000000001","kind":"receipts","entry":{},"createdAt":"2026-10-28T09:00:00.000"}')
    sys.exit(0)
if args[:1] == ["run"]:
    with open(os.environ["CALL_LOG"] + ".keys", "a") as keys:
        keys.write(f'{os.environ.get("AWS_ACCESS_KEY_ID", "")}|{os.environ.get("AWS_SECRET_ACCESS_KEY", "")}\n')
    mount = args[args.index("-v") + 1]
    host, inner = mount.split(":")[0], mount.split(":")[1]
    local = lambda p: p.replace(inner, host, 1) if p.startswith(inner) else p
    if "cp" in args:
        i = args.index("cp")
        src, dst = args[i + 1], args[i + 2]
        if dst.startswith("s3://"):
            target = os.path.join(bucket, dst[len("s3://"):].split("/", 1)[1])
            os.makedirs(os.path.dirname(target), exist_ok=True)
            shutil.copyfile(local(src), target)
        else:
            source = os.path.join(bucket, src[len("s3://"):].split("/", 1)[1])
            if not os.path.exists(source):
                sys.stderr.write('fatal error: An error occurred (404) when calling the HeadObject operation: Key "x" does not exist\n')
                sys.exit(1)
            shutil.copyfile(source, local(dst))
        sys.exit(0)
    if "head-object" in args:
        path = os.path.join(bucket, args[args.index("--key") + 1])
        if not os.path.exists(path):  # as S3 answers for a missing key (or one whose newest version is a delete marker)
            sys.stderr.write("An error occurred (404) when calling the HeadObject operation: Not Found\n"); sys.exit(254)
        print(os.path.getsize(path))
        sys.exit(0)
sys.exit(0)
'''
FAKE_PG_RESTORE = '#!/bin/sh\n[ "$1" = "--list" ] && head -c 5 "$2" | grep -q PGDMP\n'


class BackupScripts(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-backup-sep-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text(FAKE_DOCKER)
        (self.bin / "pg_restore").write_text(FAKE_PG_RESTORE)
        for b in self.bin.iterdir():
            b.chmod(0o755)
        self.bucket = self.tmp / "bucket"
        self.bucket.mkdir()
        self.dumps = self.tmp / "dumps"
        self.log = self.tmp / "calls"
        self.log.write_text("")
        self.fixture = self.tmp / "fixture.dump"
        self.fixture.write_bytes(b"PGDMP" + os.urandom(2048))
        self.creds = self.tmp / "credentials"
        self.creds.mkdir()
        self.key, self.allowed = make_signing_key(self.tmp)

    def credential(self, name, value):
        (self.creds / name).write_bytes(value)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_", "PILOT_ENV", "CREDENTIALS_DIRECTORY"))}
        env.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.log), "FAKE_BUCKET": str(self.bucket),
            "FIXTURE_DUMP": str(self.fixture), "BACKUP_BUCKET": "swift-backups", "BACKUP_REQUIRED": "1",
            "AWS_CLI_IMAGE": IMAGE, "AWS_S3_ENDPOINT": "https://storage.example.invalid", "PILOT_ENV": "staging",
            "CREDENTIALS_DIRECTORY": str(self.creds), "BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.allowed),
        })
        env.update(extra)
        return {k: v for k, v in env.items() if v is not None}

    def backup(self, **extra):
        return subprocess.run(["bash", str(DEPLOY / "backup.sh"), str(self.dumps)], env=self.env(**extra),
                              text=True, capture_output=True, timeout=60, stdin=subprocess.DEVNULL)

    def keys_used(self):
        p = Path(str(self.log) + ".keys")
        return set(p.read_text().splitlines()) if p.exists() else set()

    def heartbeat(self):
        p = Path(str(self.log) + ".heartbeat")
        return p.read_text() if p.exists() else ""

    def api_and_backup_pairs(self, source=b"dedicated"):
        # What a unit sees: an old one hands the API pair; a current one the backup pair. Both here:
        # the backup pair must win and the API pair must never reach the AWS CLI.
        self.credential("AWS_ACCESS_KEY_ID", b"API-ID")
        self.credential("AWS_SECRET_ACCESS_KEY", b"API-SECRET")
        self.credential("BACKUP_AWS_ACCESS_KEY_ID", b"BACKUP-ID")
        self.credential("BACKUP_AWS_SECRET_ACCESS_KEY", b"BACKUP-SECRET")
        self.credential("BACKUP_KEY_SOURCE", source)

    def test_with_the_backup_pair_present_the_api_key_is_never_used(self):
        self.api_and_backup_pairs()
        self.credential("BACKUP_SIGNING_KEY", self.key.read_bytes())
        (self.creds / "BACKUP_SIGNING_KEY").chmod(0o600)
        r = self.backup()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.keys_used(), {"BACKUP-ID|BACKUP-SECRET"})
        self.assertNotIn("SHARE THE API", r.stderr)
        self.assertIn("to_jsonb('dedicated'::text)", self.heartbeat())

    def test_an_old_unit_with_only_the_api_pair_keeps_backing_up_and_warns_loudly(self):
        self.credential("AWS_ACCESS_KEY_ID", b"API-ID")
        self.credential("AWS_SECRET_ACCESS_KEY", b"API-SECRET")
        r = self.backup()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.keys_used(), {"API-ID|API-SECRET"})
        self.assertIn("WARNING: BACKUPS STILL SHARE THE API'S STORAGE KEY", r.stderr)
        self.assertIn("WARNING: BACKUP NOT SIGNED", r.stderr)
        self.assertIn("to_jsonb('shared'::text)", self.heartbeat())
        self.assertIn("to_jsonb(0 = 1)", self.heartbeat())
        self.assertTrue(any(p.name.endswith(".dump") for p in (self.bucket / "db").iterdir()))

    def test_the_fallback_copy_in_the_backup_store_still_warns(self):
        self.api_and_backup_pairs(source=b"shared-api-key")
        r = self.backup()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.keys_used(), {"BACKUP-ID|BACKUP-SECRET"})
        self.assertIn("BACKUPS STILL SHARE THE API'S STORAGE KEY (the backup store holds a copy of it)", r.stderr)
        self.assertIn("to_jsonb('shared'::text)", self.heartbeat())

    def test_every_dump_is_signed_and_the_signature_travels_beside_it(self):
        self.api_and_backup_pairs()
        self.credential("BACKUP_SIGNING_KEY", self.key.read_bytes())
        (self.creds / "BACKUP_SIGNING_KEY").chmod(0o600)
        r = self.backup()
        self.assertEqual(r.returncode, 0, r.stderr)
        uploaded = sorted(p.name for p in (self.bucket / "db").iterdir())
        self.assertEqual(len(uploaded), 2, uploaded)
        dump, sig = (self.bucket / "db" / uploaded[0]), (self.bucket / "db" / uploaded[1])
        self.assertEqual(sig.name, dump.name + ".sig")
        ok = subprocess.run([sys.executable, "-I", str(SIGNER), "verify", "--allowed-signers", str(self.allowed),
                             "--sig", str(sig), "--name", dump.name, "--object", str(dump)], capture_output=True)
        self.assertEqual(ok.returncode, 0, ok.stderr)
        self.assertIn("to_jsonb(1 = 1)", self.heartbeat().split("last_backup_signed", 1)[1])
        self.assertIn("signed →", r.stdout)

    # [SEC-BACKUP · REVIEW-M S4-3] uploaded (the data is off-site), paged, AND a failed unit
    def test_a_signature_that_does_not_verify_here_fails_the_run_after_the_upload(self):
        self.api_and_backup_pairs()
        self.credential("BACKUP_SIGNING_KEY", self.key.read_bytes())
        (self.creds / "BACKUP_SIGNING_KEY").chmod(0o600)
        _, other_allowed = make_signing_key(self.tmp, "other")
        r = self.backup(BACKUP_SIGNING_ALLOWED_SIGNERS=str(other_allowed))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("does NOT verify", r.stderr)
        self.assertIn("FATAL", r.stderr)
        self.assertEqual(len(list((self.bucket / "db").iterdir())), 2)
        self.assertIn("to_jsonb(0 = 1)", self.heartbeat().split("last_backup_signed", 1)[1])
        self.assertFalse((self.dumps / ".first-signed-backup").exists())

    # [SEC-BACKUP · REVIEW-G S4-1] the moment signing began, for --allow-unsigned-legacy
    def test_the_first_signed_backup_records_when_signing_began_and_later_ones_keep_it(self):
        self.api_and_backup_pairs()
        self.credential("BACKUP_SIGNING_KEY", self.key.read_bytes())
        (self.creds / "BACKUP_SIGNING_KEY").chmod(0o600)
        self.assertEqual(self.backup().returncode, 0)
        marker = self.dumps / ".first-signed-backup"
        first = marker.read_text().strip()
        self.assertRegex(first, r"^\d{8}T\d{6}Z$")
        import time
        time.sleep(1.1)
        self.assertEqual(self.backup().returncode, 0)
        self.assertEqual(marker.read_text().strip(), first)

    def test_the_erasure_ledger_shipper_uses_the_backup_pair_or_warns_on_the_api_pair(self):
        gpg_home = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, gpg_home, True)
        if not shutil.which("gpg"):
            self.skipTest("GnuPG is not installed")
        os.chmod(gpg_home, 0o700)
        subprocess.run(["gpg", "--homedir", str(gpg_home), "--batch", "--passphrase", "", "--quick-gen-key",
                        "ledger-test@example.invalid", "default", "default", "never"], check=True, capture_output=True)
        pub = self.tmp / "owner.asc"
        pub.write_bytes(subprocess.run(["gpg", "--homedir", str(gpg_home), "--armor", "--export"], check=True, capture_output=True).stdout)
        fpr = re.search(r"^fpr:+([0-9A-F]{40}):", subprocess.run(["gpg", "--homedir", str(gpg_home), "--with-colons", "--fingerprint"],
                        check=True, capture_output=True, text=True).stdout, re.M).group(1)
        subprocess.run(["gpgconf", "--homedir", str(gpg_home), "--kill", "gpg-agent"], capture_output=True)
        deploy = self.tmp / "deploy"
        deploy.mkdir()
        for f in ("erasure-ledger-ship.sh", "secret-env.sh", "backup.sh", "backup-signature.py"):
            shutil.copy2(DEPLOY / f, deploy / f)
        def ship():
            return subprocess.run(["bash", str(deploy / "erasure-ledger-ship.sh"), "--project", "swift"],
                                  env=self.env(BACKUP_GPG_RECIPIENT_FILE=str(pub), BACKUP_GPG_FINGERPRINT=fpr),
                                  text=True, capture_output=True, timeout=60, stdin=subprocess.DEVNULL)
        self.credential("AWS_ACCESS_KEY_ID", b"API-ID")
        self.credential("AWS_SECRET_ACCESS_KEY", b"API-SECRET")
        r = ship()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.keys_used(), {"API-ID|API-SECRET"})
        self.assertIn("BACKUPS STILL SHARE THE API'S STORAGE KEY", r.stderr)
        Path(str(self.log) + ".keys").unlink()
        self.api_and_backup_pairs()
        r = ship()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.keys_used(), {"BACKUP-ID|BACKUP-SECRET"})
        self.assertNotIn("SHARE THE API", r.stderr)


# ── F2: restore.sh ────────────────────────────────────────────────────────────
# A docker stand-in for restore.sh: the LIVE side (`compose ... exec -T postgres`) and the
# throwaway instance (`run`, `exec <instance>`, `logs`, `volume`, `rm`, `inspect`) are logged
# apart, with the login each psql/pg_restore uses.
FAKE_RESTORE_DOCKER = r'''#!/usr/bin/env python3
import os, sys
args = sys.argv[1:]
log = open(os.environ["CALL_LOG"], "a")
fed = ""
def note(line):
    log.write(line + "\n"); log.flush()
if args[:1] == ["compose"]:
    if "ps" in args: sys.exit(0)
    if "config" in args:
        print('{"services":{"postgres":{"image":"postgis/postgis:16-3.4"}}}'); sys.exit(0)
    i = args.index("postgres")
    script = args[i + 3]
    kind = "pg_restore" if "pg_restore" in script else "psql"
    note(f"LIVE {kind} {' '.join(args[i + 4:])[:200]}")
    joined = " ".join(args)
    if "to_regclass('public.deletion_receipt')" in joined: print("f")
    elif "deployment_identity" in joined: print("f")
    elif "posture-snapshot" in joined: print("rows|public.users|1|abc")
    sys.exit(0)
if args[:1] in (["container"], ["volume"]) and "inspect" in args: sys.exit(1)
if args[:1] == ["volume"]: note("INSTANCE volume " + " ".join(args[1:])); sys.exit(0)
if args[:1] == ["run"]: note("INSTANCE run " + " ".join(args[1:])); print("ctr"); sys.exit(0)
if args[:1] == ["rm"]: note("INSTANCE rm " + " ".join(args[1:])); sys.exit(5 if os.environ.get("RM_FAIL") else 0)
if args[:1] == ["logs"]: print("PostgreSQL init process complete; ready for start up."); sys.exit(0)
if args[:1] == ["exec"]:
    rest = [a for a in args[1:] if a != "-i"]
    ctr, cmd = rest[0], rest[1:]
    text = " ".join(cmd)
    if not sys.stdin.isatty():
        try: fed = sys.stdin.read()
        except Exception: fed = ""
    import re
    m = re.search(r"-U (\S+)", text)
    user = m.group(1) if m else ""
    if cmd[:1] == ["pg_isready"]: sys.exit(0)
    if cmd[:1] == ["pg_restore"]:
        if "--list" in cmd:
            print("4000; 3079 16385 EXTENSION - postgis "); print("4001; 0 0 COMMENT - EXTENSION postgis "); print("4002; 1259 16400 TABLE public users swift")
            sys.exit(0)
        if "-f" in cmd: sys.exit(0)
        note(f"INSTANCE {ctr} pg_restore as={user} {' '.join(cmd)}")
        if os.environ.get("RESTORE_HANGS"):
            import time; time.sleep(60)
        sys.exit(0)
    note(f"INSTANCE {ctr} psql as={user} {(' '.join(cmd[-2:]) + ' ' + fed).replace(chr(10), ' ')[:600]}")
    if "rolsuper FROM pg_roles WHERE rolname = current_user" in text:
        print(os.environ.get("RESTORE_LOGIN_SUPER", "f"))
    elif "pg_depend" in text: print("rel public spatial_ref_sys")
    elif "deployment_identity" in text: print("f")
    elif "posture-snapshot" in text: print(os.environ.get("COPY_POSTURE", "rows|public.users|1|abc"))
    elif "count(*)" in text: print("0" if os.environ.get("FAIL") == "sanity" and "users" in text else "1")
    sys.exit(0)
sys.exit(0)
'''


class RestoreRefusesWhatWasNotSigned(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-restore-sig-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.deploy.mkdir()
        for f in ("restore.sh", "restore-erasure-ledger.sql", "restore-replay-erasures.sql", "restore-offsite-ledger.sql",
                  "secret-env.sh", "backup-signature.py"):
            shutil.copy2(DEPLOY / f, self.deploy / f)
        (self.deploy / ".env").write_text("POSTGRES_DB=swift\n")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text(FAKE_RESTORE_DOCKER)
        (self.bin / "pg_restore").write_text(FAKE_PG_RESTORE)
        for b in self.bin.iterdir():
            b.chmod(0o755)
        self.log = self.tmp / "calls"
        self.log.write_text("")
        self.key, self.allowed = make_signing_key(self.tmp)
        self.dump = self.tmp / "swift-20261028T091500Z.dump"
        self.dump.write_bytes(b"PGDMP" + os.urandom(1024))

    def restore(self, *args, source=None, stdin=None, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_", "POSTGRES_"))}
        env.update({"PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.log),
                    "BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.allowed)})
        env.update(extra)
        return subprocess.run(["bash", str(self.deploy / "restore.sh"), "--project", "swift", *args,
                               str(source or self.dump), "swift_restore_sig"], env=env,
                              **({"input": stdin} if stdin is not None else {"stdin": subprocess.DEVNULL}),
                              capture_output=True, timeout=60, text=stdin is None or isinstance(stdin, str))

    def calls(self):
        return self.log.read_text().splitlines()

    def assert_nothing_created(self, r):
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse([c for c in self.calls() if c.startswith("INSTANCE")], self.calls())
        self.assertNotIn("RESTORE OK", r.stdout)

    def test_a_signed_dump_is_restored_into_a_throwaway_instance_never_the_live_cluster_never_as_a_superuser(self):
        sign(self.key, self.dump)
        r = self.restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("signature OK", r.stderr)
        self.assertIn("RESTORE OK", r.stdout)
        calls = self.calls()
        run = next(c for c in calls if c.startswith("INSTANCE run "))
        self.assertIn("--network none", run)
        self.assertIn("--name swift-restore-swift_restore_sig", run)
        self.assertNotIn("/run/swift-secrets", run)
        self.assertNotIn("swift-pgdata", run)
        restores = [c for c in calls if " pg_restore " in c]
        self.assertEqual(len(restores), 1, restores)
        self.assertTrue(restores[0].startswith("INSTANCE swift-restore-swift_restore_sig pg_restore as=swift "), restores[0])
        self.assertIn("-L /tmp/restore.toc", restores[0])
        # The live cluster is only read: never restored into, never given a scratch database.
        live = [c for c in calls if c.startswith("LIVE")]
        self.assertFalse([c for c in live if "pg_restore" in c or "CREATE DATABASE" in c or "CREATE ROLE" in c], live)
        # The restore login is created without superuser rights, checked before the archive is read.
        created = next(c for c in calls if "CREATE ROLE \"swift\"" in c)
        self.assertIn("as=swift_restore_admin", created)
        self.assertIn("NOSUPERUSER", created)
        check = next(i for i, c in enumerate(calls) if "rolsuper FROM pg_roles WHERE rolname = current_user" in c)
        self.assertIn("as=swift ", calls[check])
        self.assertLess(check, calls.index(restores[0]))
        # The extension the archive names is made by a short-lived superuser and handed to the login.
        ext = next(c for c in calls if "CREATE EXTENSION" in c)
        self.assertIn("REASSIGN OWNED BY swift_restore_ext TO \"swift\"", ext)
        self.assertIn("DROP ROLE swift_restore_ext", ext)

    def test_a_restore_login_that_turns_out_to_be_a_superuser_is_refused_and_the_instance_removed(self):
        sign(self.key, self.dump)
        r = self.restore(RESTORE_LOGIN_SUPER="t")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("the restore login is a superuser", r.stderr)
        self.assertFalse([c for c in self.calls() if " pg_restore " in c])
        self.assertTrue([c for c in self.calls() if c.startswith("INSTANCE rm -f swift-restore-swift_restore_sig")])

    def test_an_unsigned_dump_is_refused_before_anything_is_created(self):
        r = self.restore()
        self.assert_nothing_created(r)
        self.assertIn("has NO signature", r.stderr)
        self.assertIn("--allow-unsigned-legacy", r.stderr)

    def test_the_owner_flag_restores_an_unsigned_legacy_dump_with_a_loud_warning(self):
        # [COORD 12:20Z] no record of when signing began: the flag alone is not enough
        r = self.restore("--allow-unsigned-legacy", BACKUP_FIRST_SIGNED_FILE=str(self.tmp / "absent"))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no record of the first signed backup", r.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith("INSTANCE")])
        # the dump's name stamp (09:15Z) is before the owner's recorded cutover
        r = self.restore("--allow-unsigned-legacy", BACKUP_SIGNED_SINCE="20261029T000000Z")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("WARNING: RESTORING AN UNSIGNED DUMP", r.stderr)
        self.assertIn("RESTORE OK", r.stdout)

    def test_a_tampered_dump_is_refused_even_with_the_owner_flag(self):
        sign(self.key, self.dump)
        with open(self.dump, "ab") as f:
            f.write(b"planted")
        for args in ((), ("--allow-unsigned-legacy",)):
            self.log.write_text("")
            r = self.restore(*args)
            self.assert_nothing_created(r)
            self.assertIn("REFUSED", r.stderr)
            self.assertIn("differ from what was signed", r.stderr)

    def test_a_dump_signed_by_another_key_or_renamed_is_refused(self):
        other, _ = make_signing_key(self.tmp, "other")
        sign(other, self.dump)
        r = self.restore()
        self.assert_nothing_created(r)
        self.assertIn("does not verify against the trusted backup signing key", r.stderr)
        sign(self.key, self.dump)
        renamed = self.tmp / "swift-20261029T091500Z.dump"
        shutil.copy2(self.dump, renamed)
        shutil.copy2(Path(f"{self.dump}.sig"), Path(f"{renamed}.sig"))
        self.log.write_text("")
        r = self.restore(source=renamed)
        self.assert_nothing_created(r)
        self.assertIn("cannot be renamed", r.stderr)

    def test_an_untrusted_allowed_signers_file_is_refused(self):
        sign(self.key, self.dump)
        self.allowed.chmod(0o666)
        r = self.restore()
        self.assert_nothing_created(r)
        self.assertIn("writable by others", r.stderr)

    def test_the_drill_bundle_proves_the_plain_dump_on_stdin(self):
        cipher = self.tmp / "swift-20261028T091500Z.dump.gpg"
        cipher.write_bytes(os.urandom(512))
        import hashlib
        plain_sha = hashlib.sha256(self.dump.read_bytes()).hexdigest()
        sign(self.key, cipher, plain_sha=plain_sha)
        bundle = base64.b64encode(Path(f"{cipher}.sig").read_bytes()).decode()
        r = self.restore("--signature-b64", bundle, "--signed-object", cipher.name, source="-", stdin=self.dump.read_bytes())
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(b"RESTORE OK", r.stdout)
        self.log.write_text("")
        r = self.restore("--signature-b64", bundle, "--signed-object", cipher.name, source="-", stdin=self.dump.read_bytes() + b"x")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"REFUSED", r.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith("INSTANCE")])
        self.log.write_text("")
        r = self.restore(source="-", stdin=self.dump.read_bytes())
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"has NO signature", r.stderr)


class TheThrowawayInstanceIsThrownAway(unittest.TestCase):
    """[SEC-BACKUP · REVIEW-M S3-1] A restored copy holds everyone's data, and only up to the restore:
    it is removed with its volume after EVERY outcome unless the operator keeps it explicitly."""

    setUp = RestoreRefusesWhatWasNotSigned.setUp
    restore = RestoreRefusesWhatWasNotSigned.restore
    calls = RestoreRefusesWhatWasNotSigned.calls

    def removed(self):
        calls = self.calls()
        return (any(c.startswith("INSTANCE rm -f swift-restore-swift_restore_sig") for c in calls)
                and any(c.startswith("INSTANCE volume rm swift-restore-swift_restore_sig") for c in calls))

    def test_a_successful_restore_removes_the_instance_and_its_volume(self):
        sign(self.key, self.dump)
        r = self.restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("RESTORE OK", r.stdout)
        self.assertTrue(self.removed(), self.calls())
        self.assertIn("removed with its volume", r.stdout)
        restore_ok = r.stdout.index("RESTORE OK")
        self.assertLess(restore_ok, r.stdout.index("removed with its volume"))

    def test_a_removal_that_fails_is_a_failed_run_never_a_quiet_success(self):
        sign(self.key, self.dump)
        r = self.restore(RM_FAIL="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("removing the scratch instance swift-restore-swift_restore_sig FAILED", r.stderr)
        self.assertNotIn("was removed with its volume", r.stdout)

    def test_an_interrupted_restore_still_removes_the_copy(self):
        import signal, time
        sign(self.key, self.dump)
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_", "POSTGRES_"))}
        env.update({"PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.log),
                    "BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.allowed), "RESTORE_HANGS": "1"})
        proc = subprocess.Popen(["bash", str(self.deploy / "restore.sh"), "--project", "swift", str(self.dump), "swift_restore_sig"],
                                env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        try:
            deadline = time.time() + 30
            while time.time() < deadline and not any(" pg_restore " in c for c in self.calls()):
                time.sleep(0.2)
            self.assertTrue(any(" pg_restore " in c for c in self.calls()), self.calls())
            os.killpg(proc.pid, signal.SIGINT)
            proc.wait(timeout=30)
        finally:
            if proc.poll() is None:
                os.killpg(proc.pid, signal.SIGKILL)
        self.assertNotEqual(proc.returncode, 0)
        self.assertTrue(self.removed(), self.calls())

    def test_keep_for_inspection_keeps_it_and_says_how_and_by_when_to_remove_it(self):
        sign(self.key, self.dump)
        r = self.restore("--keep-for-inspection")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(self.removed())
        self.assertIn("docker rm -f swift-restore-swift_restore_sig && docker volume rm swift-restore-swift_restore_sig", r.stdout)
        self.assertIn("within 24 hours", r.stdout)

    def test_a_failed_comparison_or_sanity_check_removes_it_too(self):
        sign(self.key, self.dump)
        for args, extra in ((("--compare-source",), {"COPY_POSTURE": "rows|public.users|2|zzz"}), ((), {"FAIL": "sanity"})):
            with self.subTest(args=args):
                self.log.write_text("")
                r = self.restore(*args, **extra)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn("RESTORE OK", r.stdout)
                self.assertTrue(self.removed(), self.calls())
                self.assertNotIn("retained", r.stderr)

    def test_a_disaster_recovery_restore_must_say_it_keeps_the_copy_before_anything_starts(self):
        sign(self.key, self.dump)
        r = self.restore("--no-live-ledger", "--i-know-live-is-gone")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--keep-for-inspection", r.stderr)
        self.assertFalse([c for c in self.calls() if c.startswith("INSTANCE")])
        self.log.write_text("")
        r = self.restore("--no-live-ledger", "--i-know-live-is-gone", "--keep-for-inspection")
        self.assertEqual(r.returncode, 3, r.stderr)
        self.assertFalse(self.removed())


class TheReadinessDeadlineIsTime(unittest.TestCase):
    """[SEC-BACKUP · CI 28 Oct] The throwaway instance gets 180 SECONDS to become ready, whatever
    `sleep` does: a stand-in `sleep` that returns at once made 180 tries last 3 s on the CI runner."""

    setUp = RestoreRefusesWhatWasNotSigned.setUp
    restore = RestoreRefusesWhatWasNotSigned.restore

    def test_an_instance_that_takes_seconds_is_waited_for_even_when_sleep_returns_at_once(self):
        sign(self.key, self.dump)
        (self.bin / "sleep").write_text("#!/bin/sh\nexit 0\n")
        (self.bin / "sleep").chmod(0o755)
        # A fast front for the readiness questions (logs, pg_isready): ready only 6 s after `run`.
        (self.bin / "docker.py").write_text((self.bin / "docker").read_text())
        (self.bin / "docker.py").chmod(0o755)
        (self.bin / "docker").write_text(f'''#!/bin/sh
stamp="{self.tmp}/started"
case "$1" in
  run) date +%s > "$stamp" ;;
  logs|exec)
    if [ "$1" = logs ] || [ "$3" = pg_isready ]; then
      now=$(date +%s); start=$(cat "$stamp" 2>/dev/null || echo "$now")
      [ $((now - start)) -ge 6 ] || {{ [ "$1" = logs ] && echo "initdb running"; exit 2; }}
    fi ;;
esac
exec "{self.bin}/docker.py" "$@"
''')
        r = self.restore()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("RESTORE OK", r.stdout)


class TheLegacyFlagEndsWhereSigningBegan(unittest.TestCase):
    """[SEC-BACKUP · REVIEW-G S4-1 / REVIEW-M S4-2] --allow-unsigned-legacy accepts only an object the
    SERVER says was written before the first signed backup: an unsigned object written later (a
    plant, or a signature deleted from a new dump) is refused even with the flag."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-legacy-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.bucket = self.tmp / "bucket" / "db"
        self.bucket.mkdir(parents=True)
        self.log = self.tmp / "calls"
        self.log.write_text("")
        # head-object answers LastModified, VersionId and ETag; get-object serves the object and
        # refuses a changed ETag (PreconditionFailed), as the S3 API does.
        (self.bin / "docker").write_text(FAKE_DOCKER.replace(
            'if "head-object" in args:',
            'if "head-object" in args and "LastModified" in " ".join(args):\n'
            '        print(os.environ["OBJ_LAST_MODIFIED"] + "\\t" + os.environ.get("OBJ_VERSION", "v-checked") + "\\t" + os.environ.get("OBJ_ETAG", \'"etag-1"\')); sys.exit(0)\n'
            '    if "get-object" in args:\n'
            '        with open(os.environ["CALL_LOG"] + ".get", "a") as g: g.write(" ".join(args[args.index("get-object"):]) + "\\n")\n'
            '        if os.environ.get("ETAG_CHANGED"):\n'
            '            sys.stderr.write("An error occurred (PreconditionFailed) when calling the GetObject operation\\n"); sys.exit(254)\n'
            '        key = args[args.index("--key") + 1]\n'
            '        shutil.copyfile(os.path.join(bucket, key), local(args[-1])); sys.exit(0)\n'
            '    if "head-object" in args:'))
        (self.bin / "pg_restore").write_text(FAKE_PG_RESTORE)
        for b in self.bin.iterdir():
            b.chmod(0o755)
        self.marker = self.tmp / "first-signed-backup"
        self.marker.write_text("20261028T120000Z\n")
        _, self.allowed = make_signing_key(self.tmp)
        (self.bucket / "swift-20261020T010000Z.dump.gpg").write_bytes(os.urandom(256))

    def fetch(self, last_modified, *flags, marker=True, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_"))}
        env.update({"PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.log), "FAKE_BUCKET": str(self.tmp / "bucket"),
                    "BACKUP_BUCKET": "swift-backups", "AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "secret",
                    "AWS_CLI_IMAGE": IMAGE, "BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.allowed), "OBJ_LAST_MODIFIED": last_modified})
        env.update(extra)
        if marker:
            env["BACKUP_FIRST_SIGNED_FILE"] = str(self.marker)
        else:
            env["BACKUP_FIRST_SIGNED_FILE"] = str(self.tmp / "absent")
        return subprocess.run(["bash", str(DEPLOY / "restore.sh"), *flags, "--fetch-encrypted",
                               "s3://swift-backups/db/swift-20261020T010000Z.dump.gpg"], env=env, capture_output=True,
                              text=True, timeout=60, stdin=subprocess.DEVNULL)

    def test_an_unsigned_object_written_after_signing_began_is_refused_even_with_the_flag(self):
        r = self.fetch("2026-10-28T12:30:00+00:00", "--allow-unsigned-legacy")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("written after the first signed backup", r.stderr)
        self.assertNotIn("RESTORING AN UNSIGNED DUMP", r.stderr)

    def test_an_unsigned_object_written_before_signing_began_passes_the_flag_with_its_warning(self):
        r = self.fetch("2026-10-28T11:59:00+00:00", "--allow-unsigned-legacy")
        self.assertNotIn("written after the first signed backup", r.stderr)
        self.assertIn("WARNING: RESTORING AN UNSIGNED DUMP", r.stderr)
        self.assertIn("server time 2026-10-28T11:59:00", r.stderr)

    # [COORD 12:20Z (2)] a missing record never widens the legacy window
    def test_without_a_record_of_when_signing_began_the_flag_alone_is_refused(self):
        r = self.fetch("2026-10-20T01:00:00+00:00", "--allow-unsigned-legacy", marker=False)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no record of the first signed backup", r.stderr)
        self.assertIn("BACKUP_SIGNED_SINCE", r.stderr)
        self.assertIn("--legacy-without-signing-record", r.stderr)
        self.assertNotIn("RESTORING AN UNSIGNED DUMP", r.stderr)
        self.assertFalse(Path(str(self.log) + ".get").exists())

    def test_without_a_record_the_owner_names_the_cutover_or_takes_the_second_flag(self):
        r = self.fetch("2026-10-28T12:30:00+00:00", "--allow-unsigned-legacy", marker=False, BACKUP_SIGNED_SINCE="20261028T120000Z")
        self.assertIn("written after the first signed backup", r.stderr)
        r = self.fetch("2026-10-28T12:30:00+00:00", "--allow-unsigned-legacy", "--legacy-without-signing-record", marker=False)
        self.assertIn("--legacy-without-signing-record", r.stderr)
        self.assertIn("WARNING: RESTORING AN UNSIGNED DUMP", r.stderr)

    # [COORD 12:20Z (1)] the object checked is the object downloaded
    def test_the_unsigned_object_downloaded_is_exactly_the_version_whose_time_was_checked(self):
        r = self.fetch("2026-10-28T11:59:00+00:00", "--allow-unsigned-legacy")
        self.assertIn("WARNING: RESTORING AN UNSIGNED DUMP", r.stderr)
        [got] = Path(str(self.log) + ".get").read_text().splitlines()
        self.assertIn("--version-id v-checked", got)
        self.assertIn('--if-match "etag-1"', got)
        self.assertFalse([l for l in self.log.read_text().splitlines() if " s3 cp s3://swift-backups/db/swift-20261020T010000Z.dump.gpg " in l])

    def test_an_unversioned_bucket_pins_the_etag_and_a_changed_object_is_refused(self):
        r = self.fetch("2026-10-28T11:59:00+00:00", "--allow-unsigned-legacy", OBJ_VERSION="None")
        [got] = Path(str(self.log) + ".get").read_text().splitlines()
        self.assertNotIn("--version-id", got)
        self.assertIn('--if-match "etag-1"', got)
        r = self.fetch("2026-10-28T11:59:00+00:00", "--allow-unsigned-legacy", ETAG_CHANGED="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("changed between the check and the download", r.stderr)
        self.assertNotIn("RESTORING AN UNSIGNED DUMP", r.stderr)


class AnExpiredDumpIsNotAMissingSignature(unittest.TestCase):
    """[BACKUP-FU2 · owner 29 Oct] Hourly dumps are deleted by the bucket's lifecycle rule 30 days after they
    were made, each with its .sig. Asking for one that is gone says so: it is never mistaken for an
    UNSIGNED dump (the drill would then offer --allow-unsigned-legacy) and never ends in a bare AWS error."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-expired-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text(FAKE_DOCKER)
        (self.bin / "pg_restore").write_text(FAKE_PG_RESTORE)
        for b in self.bin.iterdir():
            b.chmod(0o755)
        self.bucket = self.tmp / "bucket" / "db"
        self.bucket.mkdir(parents=True)
        self.log = self.tmp / "calls"
        self.log.write_text("")
        self.key, self.allowed = make_signing_key(self.tmp)

    def restore(self, *flags, name="swift-20261001T010000Z.dump.gpg"):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_"))}
        env.update({"PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.log), "FAKE_BUCKET": str(self.tmp / "bucket"),
                    "BACKUP_BUCKET": "swift-backups", "AWS_ACCESS_KEY_ID": "id", "AWS_SECRET_ACCESS_KEY": "secret",
                    "AWS_CLI_IMAGE": IMAGE, "BACKUP_SIGNING_ALLOWED_SIGNERS": str(self.allowed),
                    "BACKUP_FIRST_SIGNED_FILE": str(self.tmp / "absent")})
        tail = [] if flags else ["swift_restore_expired"]
        return subprocess.run(["bash", str(DEPLOY / "restore.sh"), "--project", "swift", *flags, f"s3://swift-backups/db/{name}", *tail],
                              env=env, capture_output=True, text=True, timeout=60, stdin=subprocess.DEVNULL)

    def assert_gone(self, r, name):
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(f"{name} is not in the backup bucket", r.stderr)
        self.assertIn("deleted by the bucket's retention rule", r.stderr)
        self.assertNotIn("swift-backup-signature none", r.stdout)
        self.assertNotIn("has NO signature", r.stderr)
        self.assertNotIn("RESTORING AN UNSIGNED DUMP", r.stderr)

    def test_the_drill_is_told_the_dump_is_gone_not_that_it_is_unsigned(self):
        r = self.restore("--fetch-signature")
        self.assert_gone(r, "swift-20261001T010000Z.dump.gpg")

    def test_a_restore_or_fetch_of_an_expired_dump_says_it_is_gone_even_with_the_legacy_flags(self):
        for flags, name in ((("--fetch-encrypted",), "swift-20261001T010000Z.dump.gpg"),
                            (("--allow-unsigned-legacy", "--legacy-without-signing-record", "--fetch-encrypted"), "swift-20261001T010000Z.dump.gpg"),
                            ((), "swift-20261001T010000Z.dump")):
            with self.subTest(flags=flags, name=name):
                self.assert_gone(self.restore(*flags, name=name), name)

    def test_a_signature_left_without_its_dump_says_the_dump_is_gone(self):
        # The .sig is uploaded after its dump, so on a day boundary it can outlive the dump by a day.
        dump = self.tmp / "swift-20261001T010000Z.dump.gpg"
        dump.write_bytes(os.urandom(256))
        sign(self.key, dump)
        shutil.copyfile(f"{dump}.sig", self.bucket / f"{dump.name}.sig")
        self.assert_gone(self.restore("--fetch-encrypted"), dump.name)

    def test_a_dump_that_is_there_without_a_signature_is_still_unsigned(self):
        (self.bucket / "swift-20261001T010000Z.dump.gpg").write_bytes(os.urandom(256))
        r = self.restore("--fetch-signature")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.strip(), "swift-backup-signature none")


class DrillCarriesTheHostVerifiedSignature(unittest.TestCase):
    """backup-drill.sh asks the host for the verified signature first; no signature means no drill
    unless the owner passes --allow-unsigned-legacy."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-drill-sig-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "ssh.log"
        self.log.write_text("")
        (self.bin / "ssh").write_text(r'''#!/usr/bin/env python3
import os, sys
argv = sys.argv[1:]
cmd = argv[-1]
open(os.environ["SSH_LOG"], "a").write(cmd + "\n")
if "--fetch-signature" in cmd:
    sys.stdout.write(os.environ.get("BUNDLE", "swift-backup-signature none") + "\n"); sys.exit(0)
sys.exit(7)
''')
        (self.bin / "ssh").chmod(0o755)
        self.key = self.tmp / "id"
        self.key.write_text("k")

    def armored_private_key(self):
        """A throwaway owner key without a passphrase (the drill imports it before anything else)."""
        home = Path(tempfile.mkdtemp())
        os.chmod(home, 0o700)
        try:
            subprocess.run(["gpg", "--homedir", str(home), "--batch", "--passphrase", "", "--quick-gen-key",
                            "drill-test@example.invalid", "default", "default", "never"], check=True, capture_output=True)
            return subprocess.run(["gpg", "--homedir", str(home), "--batch", "--armor", "--export-secret-keys"],
                                  check=True, capture_output=True, text=True).stdout
        finally:
            subprocess.run(["gpgconf", "--homedir", str(home), "--kill", "gpg-agent"], capture_output=True)
            shutil.rmtree(home, True)

    def drill(self, *pre, bundle=None):
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", SSH_LOG=str(self.log), SWIFT_RESTORE_PROJECT="swift")
        if bundle is not None:
            env["BUNDLE"] = bundle
        armored = self.armored_private_key()
        return subprocess.run(["bash", str(DEPLOY / "backup-drill.sh"), *pre, "swift-deploy@host.example.invalid", str(self.key),
                               "s3://swift-backups/db/swift-20261028T091500Z.dump.gpg"], env=env, input=armored + "\n",
                              text=True, capture_output=True, timeout=60)

    @unittest.skipUnless(shutil.which("gpg"), "GnuPG is not installed")
    def test_no_signature_no_drill_and_the_host_is_asked_with_the_backup_key_choice(self):
        r = self.drill()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("NO signature", r.stderr)
        cmds = self.log.read_text().splitlines()
        self.assertEqual(len(cmds), 1, cmds)
        self.assertIn("swift-secrets backup list", cmds[0])
        self.assertIn("--fetch-signature 's3://swift-backups/db/swift-20261028T091500Z.dump.gpg'", cmds[0])

    def test_the_drill_takes_the_legacy_flag_first_and_passes_it_to_the_host(self):
        drill = (DEPLOY / "backup-drill.sh").read_text()
        self.assertIn('if [ "${1:-}" = --allow-unsigned-legacy ]; then ALLOW_UNSIGNED=1; shift; fi', drill)
        self.assertIn('if [ "$ALLOW_UNSIGNED" = 1 ] && [ "${1:-}" = --legacy-without-signing-record ]; then LEGACY_NO_RECORD=1; shift; fi', drill)
        self.assertIn('[ "$LEGACY_NO_RECORD" = 0 ] || LEGACY_ARG="$LEGACY_ARG --legacy-without-signing-record"', drill)
        self.assertIn("--allow-unsigned-legacy --compare-source -", drill)
        self.assertIn("--signature-b64 '$SIGNATURE_B64' --signed-object '${OBJECT##*/}' --compare-source -", drill)


class OwnerBackupKeyTool(unittest.TestCase):
    """deploy/owner/swift-backup-key.command: the owner's double-click helper. The key pair travels on
    stdin only, to `swift-secrets backup set-keys`; nothing secret is in argv or printed."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-owner-backup-key-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "ssh.log"
        self.stdin_log = self.tmp / "ssh.stdin"
        (self.bin / "ssh").write_text(r'''#!/usr/bin/env python3
import os, sys
argv = sys.argv[1:]
open(os.environ["SSH_LOG"], "a").write("ssh " + " ".join(argv).replace("\n", " ; ") + "\n")
data = b"" if "-n" in argv else sys.stdin.buffer.read()
if data:
    open(os.environ["SSH_STDIN"], "ab").write(b"<<" + data + b">>\n")
sys.exit(0)
''')
        (self.bin / "ssh").chmod(0o755)
        self.key = self.tmp / "id"
        self.key.write_text("k")

    def run_tool(self, answers):
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", SSH_LOG=str(self.log), SSH_STDIN=str(self.stdin_log))
        return subprocess.run(["bash", str(DEPLOY / "owner" / "swift-backup-key.command"), "swift-deploy@host.example.invalid", str(self.key)],
                              input=answers, env=env, text=True, capture_output=True, timeout=60)

    def test_the_pair_goes_on_stdin_only_to_set_keys_and_is_never_shown(self):
        r = self.run_tool("y\ny\nBACKUPKEYID01\nbackup-secret-value\nbackup-secret-value\nn\nn\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("saved the backup storage key pair", r.stdout)
        argv = self.log.read_text()
        self.assertNotIn("backup-secret-value", argv)
        self.assertNotIn("BACKUPKEYID01", argv)
        self.assertNotIn("backup-secret-value", r.stdout + r.stderr)
        self.assertEqual(self.stdin_log.read_bytes(), b"<<BACKUPKEYID01\nbackup-secret-value\n>>\n")
        set_keys = [l for l in argv.splitlines() if l.endswith("sudo -n swift-secrets backup set-keys")]
        self.assertEqual(len(set_keys), 1, argv)
        install = next(l for l in argv.splitlines() if "swift-secrets backup init" in l)
        for piece in ("install -m 0755 -o root -g root /opt/swift/deploy/swift-secrets /usr/local/sbin/swift-secrets",
                      "/etc/systemd/system/swift-backup.service", "/etc/systemd/system/swift-erasure-ledger.service",
                      "systemctl daemon-reload"):
            self.assertIn(piece, install)
        self.assertLess(install.index("/usr/local/sbin/swift-secrets"), install.index("swift-secrets backup init"))
        self.assertLess(install.index("swift-secrets backup init"), install.index("swift-backup.service"))

    def test_a_mistyped_secret_is_asked_again_and_nothing_is_sent_until_it_matches(self):
        r = self.run_tool("n\ny\nBACKUPKEYID01\nfirst\nsecond\nBACKUPKEYID01\nright\nright\nn\nn\n")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("differ", r.stderr)
        self.assertEqual(self.stdin_log.read_bytes(), b"<<BACKUPKEYID01\nright\n>>\n")


FAKE_BUCKET_ADMIN = r'''#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
state = os.environ["BUCKET_STATE"]
st = json.load(open(state)) if os.path.exists(state) else {}
with open(os.environ["CALL_LOG"], "a") as log:
    log.write(" ".join(a for a in args if a.startswith(("put-", "get-"))) + "\n")
mount = args[args.index("-v") + 1].split(":")
local = lambda p: p.replace(mount[1], mount[0], 1)
def save(): json.dump(st, open(state, "w"))
if "get-bucket-lifecycle-configuration" in args:
    if not st.get("rules"):
        sys.stderr.write("An error occurred (NoSuchLifecycleConfiguration) when calling the GetBucketLifecycleConfiguration operation\n"); sys.exit(254)
    print(json.dumps({"Rules": st["rules"]})); sys.exit(0)
if "put-bucket-lifecycle-configuration" in args:
    if os.environ.get("REFUSE_LIFECYCLE"): sys.stderr.write("AccessDenied\n"); sys.exit(254)
    src = args[args.index("--lifecycle-configuration") + 1][len("file://"):]
    st["rules"] = json.load(open(local(src)))["Rules"]; save(); sys.exit(0)
if "put-bucket-versioning" in args:
    st["versioning"] = "Enabled"; save(); sys.exit(0)
if "get-bucket-versioning" in args:
    print(st.get("versioning", "None")); sys.exit(0)
sys.exit(9)
'''


class VersioningIsBounded(unittest.TestCase):
    """[SEC-BACKUP · REVIEW-M S3-2] Versioning keeps each overwritten or deleted dump: bounded by a
    lifecycle rule that expires old versions, set BEFORE versioning is on, keeping the bucket's other
    rules; --status fails while versioning runs without that bound."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-versioning-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        (self.bin / "docker").write_text(FAKE_BUCKET_ADMIN)
        (self.bin / "docker").chmod(0o755)
        self.state = self.tmp / "bucket.json"
        self.log = self.tmp / "calls"
        self.log.write_text("")

    def run_it(self, *args, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_"))}
        env.update({"PATH": f"{self.bin}:{os.environ['PATH']}", "BUCKET_STATE": str(self.state), "CALL_LOG": str(self.log),
                    "BACKUP_BUCKET": "swift-backups", "AWS_CLI_IMAGE": IMAGE, "AWS_ACCESS_KEY_ID": "id",
                    "AWS_SECRET_ACCESS_KEY": "secret", **extra})
        return subprocess.run(["bash", str(DEPLOY / "backup-versioning.sh"), *args], env=env, text=True,
                              capture_output=True, timeout=60, stdin=subprocess.DEVNULL)

    def test_old_versions_expire_and_the_rule_comes_before_versioning_keeping_other_rules(self):
        import json
        # [BACKUP-FU2] the bucket's other rule stays (it leaves the erasure ledger alone; one that would
        # expire the ledger is refused: test_a_rule_that_would_expire_the_ledger_is_refused_nothing_changed)
        self.state.write_text(json.dumps({"rules": [{"ID": "scratch-90d", "Status": "Enabled", "Prefix": "scratch/", "Expiration": {"Days": 90}}]}))
        r = self.run_it(BACKUP_VERSION_RETAIN_DAYS="14")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("old versions: expire after 14 days", r.stdout)
        self.assertIn("versioning: Enabled", r.stdout)
        st = json.loads(self.state.read_text())
        ours = next(x for x in st["rules"] if x["ID"] == "swift-backup-noncurrent-versions")
        self.assertEqual(ours["NoncurrentVersionExpiration"], {"NoncurrentDays": 14})
        self.assertEqual(ours["Expiration"], {"ExpiredObjectDeleteMarker": True})
        self.assertTrue(any(x["ID"] == "scratch-90d" for x in st["rules"]))
        calls = self.log.read_text().splitlines()
        self.assertLess(calls.index("put-bucket-lifecycle-configuration"), calls.index("put-bucket-versioning"))

    def test_without_the_bound_versioning_is_not_turned_on(self):
        r = self.run_it(REFUSE_LIFECYCLE="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("versioning was NOT turned on", r.stderr)
        self.assertNotIn("put-bucket-versioning", self.log.read_text())

    def test_status_fails_while_versioning_runs_without_an_expiry(self):
        import json
        self.state.write_text(json.dumps({"versioning": "Enabled"}))
        r = self.run_it("--status")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("NO expiry rule", r.stdout)
        self.assertIn("kept forever", r.stderr)

    # ── [BACKUP-FU2 · owner 29 Oct 17:07Z] hourly dumps kept 30 days, the erasure ledger never ─────
    # Real key names, as backup.sh and erasure-ledger-ship.sh write them.
    @staticmethod
    def keys(prefix="db"):
        dumps = [f"{prefix}/swift-20261028T091500Z.dump.gpg", f"{prefix}/swift-20261028T091500Z.dump.gpg.sig",
                 f"{prefix}/swift-20261028T091500Z.dump", f"{prefix}/swift-20261028T091500Z.dump.sig"]
        ledger = [f"{prefix}/erasure-ledger/erasure-ledger-20261028T100000Z-0b9f0c3e.jsonl.gpg",
                  f"{prefix}/erasure-ledger/erasure-ledger-20261028T100000Z-0b9f0c3e.jsonl.gpg.sig"]
        return dumps, ledger

    @staticmethod
    def expiring(rules, key):
        """The Enabled rules that would expire the CURRENT object KEY (S3 prefix matching; a rule without a
        prefix covers every key). Noncurrent-version and delete-marker cleanup never expire a current object."""
        out = []
        for r in rules:
            if r.get("Status") != "Enabled":
                continue
            exp = r.get("Expiration") or {}
            if "Days" not in exp and "Date" not in exp:
                continue
            f = r.get("Filter") or {}
            prefix = r.get("Prefix", f.get("Prefix", (f.get("And") or {}).get("Prefix", "")))
            if key.startswith(prefix or ""):
                out.append(r["ID"])
        return out

    def test_current_dumps_expire_after_30_days_by_default_and_never_the_ledger(self):
        import json
        r = self.run_it()
        self.assertEqual(r.returncode, 0, r.stderr)
        rules = json.loads(self.state.read_text())["rules"]
        ours = next(x for x in rules if x["ID"] == "swift-backup-dump-retention")
        self.assertEqual(ours, {"ID": "swift-backup-dump-retention", "Status": "Enabled", "Prefix": "db/swift-",
                                "Expiration": {"Days": 30}})
        dumps, ledger = self.keys()
        for key in dumps:
            self.assertEqual(self.expiring(rules, key), ["swift-backup-dump-retention"], key)
        for key in ledger:
            self.assertEqual(self.expiring(rules, key), [], key)
        self.assertIn("hourly dumps: deleted 30 days after they were made (lifecycle rule swift-backup-dump-retention, prefix db/swift-; the erasure ledger is never expired)", r.stdout)
        # both rules land in ONE configuration, before versioning
        calls = self.log.read_text().splitlines()
        self.assertEqual(calls.count("put-bucket-lifecycle-configuration"), 1, calls)
        self.assertLess(calls.index("put-bucket-lifecycle-configuration"), calls.index("put-bucket-versioning"))

    def test_the_days_and_the_prefix_follow_the_settings(self):
        import json
        r = self.run_it(BACKUP_OFFSITE_RETAIN_DAYS="45", BACKUP_PREFIX="production")
        self.assertEqual(r.returncode, 0, r.stderr)
        rules = json.loads(self.state.read_text())["rules"]
        ours = next(x for x in rules if x["ID"] == "swift-backup-dump-retention")
        self.assertEqual((ours["Prefix"], ours["Expiration"]), ("production/swift-", {"Days": 45}))
        dumps, ledger = self.keys("production")
        self.assertTrue(all(self.expiring(rules, k) == ["swift-backup-dump-retention"] for k in dumps))
        self.assertFalse([k for k in ledger if self.expiring(rules, k)])
        self.assertIn("hourly dumps: deleted 45 days after they were made", r.stdout)

    def test_a_bad_retention_or_prefix_changes_nothing(self):
        for extra in ({"BACKUP_OFFSITE_RETAIN_DAYS": "0"}, {"BACKUP_OFFSITE_RETAIN_DAYS": "30d"}, {"BACKUP_OFFSITE_RETAIN_DAYS": "10000"},
                      {"BACKUP_PREFIX": "/db"}, {"BACKUP_PREFIX": "db/"}, {"BACKUP_PREFIX": "d b"}, {"BACKUP_PREFIX": "db/../x"}):
            with self.subTest(**extra):
                self.log.write_text("")
                r = self.run_it(**extra)
                self.assertNotEqual(r.returncode, 0)
                self.assertNotIn("put-", self.log.read_text())

    def test_a_rule_that_would_expire_the_ledger_is_refused_nothing_changed(self):
        import json
        for rule in ({"ID": "old-90d", "Status": "Enabled", "Prefix": "db/", "Expiration": {"Days": 90}},
                     {"ID": "everything", "Status": "Enabled", "Prefix": "", "Expiration": {"Days": 365}},
                     {"ID": "filtered", "Status": "Enabled", "Filter": {"Prefix": "db/erasure"}, "Expiration": {"Date": "2027-01-01T00:00:00Z"}},
                     {"ID": "no-prefix", "Status": "Enabled", "Filter": {}, "Expiration": {"Days": 7}}):
            with self.subTest(rule=rule["ID"]):
                self.state.write_text(json.dumps({"rules": [rule]}))
                self.log.write_text("")
                r = self.run_it()
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(f"lifecycle rule {rule['ID']} would delete the erasure ledger (db/erasure-ledger/)", r.stderr)
                self.assertIn("nothing was changed", r.stderr)
                self.assertNotIn("put-", self.log.read_text())
                self.assertEqual(json.loads(self.state.read_text())["rules"], [rule])
        # a disabled rule, or one that only cleans old versions, deletes no current batch
        harmless = [{"ID": "off", "Status": "Disabled", "Prefix": "", "Expiration": {"Days": 1}},
                    {"ID": "old-only", "Status": "Enabled", "Prefix": "", "NoncurrentVersionExpiration": {"NoncurrentDays": 9}}]
        self.state.write_text(json.dumps({"rules": harmless}))
        r = self.run_it()
        self.assertEqual(r.returncode, 0, r.stderr)

    def test_status_fails_without_the_dump_expiry_or_with_a_ledger_expiry(self):
        import json
        noncurrent = {"ID": "swift-backup-noncurrent-versions", "Status": "Enabled", "Prefix": "",
                      "NoncurrentVersionExpiration": {"NoncurrentDays": 30}, "Expiration": {"ExpiredObjectDeleteMarker": True}}
        self.state.write_text(json.dumps({"versioning": "Enabled", "rules": [noncurrent]}))
        r = self.run_it("--status")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("hourly dumps: NO expiry rule", r.stdout)
        dumps_rule = {"ID": "swift-backup-dump-retention", "Status": "Enabled", "Prefix": "db/swift-", "Expiration": {"Days": 30}}
        self.state.write_text(json.dumps({"versioning": "Enabled", "rules": [noncurrent, dumps_rule]}))
        r = self.run_it("--status")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("hourly dumps: deleted 30 days after they were made", r.stdout)
        self.assertNotIn("put-", self.log.read_text())
        self.state.write_text(json.dumps({"versioning": "Enabled", "rules": [noncurrent, dumps_rule,
                                          {"ID": "old-90d", "Status": "Enabled", "Prefix": "db/", "Expiration": {"Days": 90}}]}))
        r = self.run_it("--status")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("lifecycle rule old-90d would delete the erasure ledger", r.stderr)

    def test_the_runbook_says_one_shipper_per_prefix_and_how_to_take_a_fork(self):
        runbook = " ".join((DEPLOY / "PILOT-RUNBOOK.md").read_text().split())
        self.assertIn("One shipper per bucket prefix; stop the old host's timer before a new host ships; drills use their own prefix.", runbook)
        self.assertIn("is refused by default", runbook)
        self.assertIn("`--ledger-accept-fork`", runbook)
        self.assertIn("WARNING: LEDGER FORK ACCEPTED", runbook)
        self.assertIn("hourly dumps are kept 30 days.", runbook)
        self.assertIn("the ledger is never expired", runbook)
        self.assertNotIn("Never give the `erasure-ledger/` prefix a shorter lifecycle rule than the dumps", runbook)

    def test_the_owner_helper_says_what_step_3_sets(self):
        tool = (DEPLOY / "owner" / "swift-backup-key.command").read_text()
        self.assertIn("hourly backups deleted 30 days after they are made (never the erasure ledger)", tool)
        self.assertIn("/opt/swift/deploy/backup-versioning.sh", tool)


class DoctorSeesWhatBackupsLeaveBehind(unittest.TestCase):
    """[SEC-BACKUP · REVIEW-M S3-1 + REVIEW-G S4-2] doctor.sh lists every labelled restore volume (a
    container can be removed and leave its volume) and FAILS past 24 h; and it FAILS when an installed
    backup unit loads a credential the backup store does not hold (installed before `backup init`:
    the unit would not start, and backups would stop)."""

    def doctor(self, *, volumes="", ages="", unit_creds=(), present=()):
        tmp = Path(tempfile.mkdtemp(prefix="swift-doctor-sep-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        here = tmp / "deploy"
        here.mkdir()
        shutil.copy(DEPLOY / "doctor.sh", here / "doctor.sh")
        shutil.copy(DEPLOY / "swift-secrets", here / "swift-secrets")
        (here / ".env").write_text("PILOT_ENV=staging\nAPI_HOST=api.example.invalid\n")
        units = tmp / "systemd"
        units.mkdir()
        store = tmp / "store"
        store.mkdir()
        if unit_creds:
            (units / "swift-backup.service").write_text("[Service]\n" + "".join(
                f"LoadCredentialEncrypted={n}:{store}/{n}.cred\n" for n in unit_creds))
        for n in present:
            (store / f"{n}.cred").write_text("x")
        bin_dir = tmp / "bin"
        bin_dir.mkdir()
        for tool, body in (
            ("docker", f'''case "$*" in
  "ps -a --filter label=swift.restore=1 --format {{{{.Names}}}}") : ;;
  "volume ls -q --filter label=swift.restore=1") printf '%s\\n' {volumes or '""'} | grep . ;;
  "volume inspect -f {{{{.CreatedAt}}}} "*) printf '%s\\n' "{ages}" ;;
  *) exit 7 ;;
esac
'''),
            ("sudo", '[ "$1" = -n ] && shift; exec "$@"\n'),
            ("systemctl", "exit 0\n"), ("curl", "exit 7\n"), ("gh", "exit 7\n"),
        ):
            (bin_dir / tool).write_text("#!/bin/sh\n" + body)
            (bin_dir / tool).chmod(0o755)
        r = subprocess.run(["bash", str(here / "doctor.sh")], env={"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": str(tmp),
                           "SWIFT_SYSTEMD_DIR": str(units)}, text=True, capture_output=True, timeout=60)
        return r.stdout

    def test_a_left_volume_is_listed_and_fails_past_a_day(self):
        out = self.doctor(volumes="swift-restore-swift_restore_x", ages="2020-01-01T00:00:00Z")
        line = next(l.strip() for l in out.splitlines() if "swift-restore-swift_restore_x" in l)
        self.assertTrue(line.startswith("FAIL"), line)
        self.assertIn("docker volume rm swift-restore-swift_restore_x", out)
        fresh = __import__("datetime").datetime.now(__import__("datetime").timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        out = self.doctor(volumes="swift-restore-swift_restore_x", ages=fresh)
        line = next(l.strip() for l in out.splitlines() if "swift-restore-swift_restore_x" in l)
        self.assertTrue(line.startswith("WARN"), line)

    def test_a_backup_unit_installed_before_the_backup_store_fails_the_doctor(self):
        names = ("BACKUP_AWS_ACCESS_KEY_ID", "BACKUP_AWS_SECRET_ACCESS_KEY", "BACKUP_KEY_SOURCE", "BACKUP_SIGNING_KEY")
        out = self.doctor(unit_creds=names, present=names[:2])
        line = next(l.strip() for l in out.splitlines() if "swift-backup.service" in l and "BACKUP_KEY_SOURCE" in l)
        self.assertTrue(line.startswith("FAIL"), line)
        self.assertIn("swift-secrets backup init", line)
        out = self.doctor(unit_creds=names, present=names)
        self.assertFalse([l for l in out.splitlines() if l.strip().startswith("FAIL") and "swift-backup.service" in l], out)
        self.assertIn("ok    swift-backup.service: every credential it loads is in the backup store", out)


if __name__ == "__main__":
    unittest.main()
