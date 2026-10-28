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

    def test_the_backup_unit_holds_the_signing_key_and_the_ledger_unit_does_not_need_it(self):
        self.assertIn("BACKUP_SIGNING_KEY", dict(load_credentials((DEPLOY / "swift-backup.service").read_text())))

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
class BackupStore(StoreHarness):
    def setUp(self):
        super().setUp()
        self.backup_store = self.tmp / "credstore-backup"
        self.allowed = self.tmp / "etc-swift" / "backup-allowed-signers"

    def env(self, **extra):
        return super().env(SWIFT_SECRETS_BACKUP_STORE_DIR=str(self.backup_store),
                           SWIFT_SECRETS_ALLOWED_SIGNERS=str(self.allowed), **extra)

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
        print(os.path.getsize(os.path.join(bucket, args[args.index("--key") + 1])))
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
    sys.exit(0)
if args[:1] in (["container"], ["volume"]) and "inspect" in args: sys.exit(1)
if args[:1] == ["volume"]: note("INSTANCE volume " + " ".join(args[1:])); sys.exit(0)
if args[:1] == ["run"]: note("INSTANCE run " + " ".join(args[1:])); print("ctr"); sys.exit(0)
if args[:1] == ["rm"]: note("INSTANCE rm " + " ".join(args[1:])); sys.exit(0)
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
        note(f"INSTANCE {ctr} pg_restore as={user} {' '.join(cmd)}"); sys.exit(0)
    note(f"INSTANCE {ctr} psql as={user} {(' '.join(cmd[-2:]) + ' ' + fed).replace(chr(10), ' ')[:600]}")
    if "rolsuper FROM pg_roles WHERE rolname = current_user" in text:
        print(os.environ.get("RESTORE_LOGIN_SUPER", "f"))
    elif "pg_depend" in text: print("rel public spatial_ref_sys")
    elif "deployment_identity" in text: print("f")
    elif "count(*)" in text: print("1")
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
        r = self.restore("--allow-unsigned-legacy")
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

    def drill(self, *pre, bundle=None):
        env = dict(os.environ, PATH=f"{self.bin}:{os.environ['PATH']}", SSH_LOG=str(self.log), SWIFT_RESTORE_PROJECT="swift")
        if bundle is not None:
            env["BUNDLE"] = bundle
        armored = "-----BEGIN PGP PRIVATE KEY BLOCK-----\nx\n-----END PGP PRIVATE KEY BLOCK-----\n"
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
        self.assertIn("--allow-unsigned-legacy --compare-source -", drill)
        self.assertIn("--signature-b64 '$SIGNATURE_B64' --signed-object '${OBJECT##*/}' --compare-source -", drill)


if __name__ == "__main__":
    unittest.main()
