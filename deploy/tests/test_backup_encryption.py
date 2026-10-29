"""[BACKUP-ENC] Production backups are encrypted to the OWNER's key (owner
ruling, 13 Oct 2026: hourly encrypted off-site dumps, the decryption key held
by the owner only, two copies, never on a server).

Real GnuPG for every cryptographic step (the key pair is made by the owner's
own script, deploy/backup-keygen.sh); shims only for Docker (pg_dump, the
pinned AWS CLI, Compose), pg_restore and SSH. What is proven:
  - backup.sh on production refuses to dump without the pinned owner key,
    refuses a key file that holds a private key, another key, or two keys;
    encrypts every dump to exactly that key, keeps and uploads only the .gpg,
    leaves no plain dump behind (also when encryption fails), and keeps two
    days locally by default;
  - restore.sh never decrypts: a .gpg source is refused; --fetch-encrypted
    streams only ciphertext out; source `-` restores a dump piped in;
  - backup-drill.sh (the owner's computer) takes the private key and the
    passphrase at hidden prompts, decrypts on the way through, sends neither
    to the host, and the host receives exactly the plain dump;
  - production runs the hourly timer; staging keeps the nightly one.
[SEC-BACKUP F2] Off-site objects here are signed as backup.sh signs them (a
signing key of the tests' own); deploy/tests/test_backup_separation.py proves
the signature rules themselves. Objects planted to test the encryption checks
are signed with the trusted key too, so those checks stay what refuses them.
"""

import base64
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path


DEPLOY = Path(__file__).resolve().parents[1]
PASSPHRASE = "correct horse battery staple"
IMAGE = "amazon/aws-cli:2.29.12@sha256:" + "f" * 64

# A stand-in for docker: `compose exec` (pg_dump prints the fixture dump; psql
# swallows the heartbeat) and `docker run <pinned aws cli>` against a fake
# bucket directory ($FAKE_BUCKET), mapping the container's /data mount.
FAKE_DOCKER = r'''
import os, shutil, sys
args = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("docker " + " ".join(args) + "\n")
bucket = os.environ["FAKE_BUCKET"]
if args[:1] == ["compose"]:
    joined = " ".join(args)
    if "config" in args:
        print('{"services":{"postgres":{"image":"postgis/postgis:16-3.4"}}}')
        sys.exit(0)
    if "pg_dump" in joined:
        sys.stdout.buffer.write(open(os.environ["FIXTURE_DUMP"], "rb").read())
    else:
        sys.stdin.read() if not sys.stdin.isatty() else None
    sys.exit(0)
if args[:1] == ["run"]:
    mount = args[args.index("-v") + 1]
    host, inner = mount.split(":")[0], mount.split(":")[1]
    def local(path):
        return path.replace(inner, host, 1) if path.startswith(inner) else path
    if "cp" in args:
        i = args.index("cp")
        src, dst = args[i + 1], args[i + 2]
        if dst.startswith("s3://"):
            if os.environ.get("UPLOAD_FAIL") == "1":
                sys.exit(1)
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
        key = args[args.index("--key") + 1]
        print(os.path.getsize(os.path.join(bucket, key)))
        sys.exit(0)
# [SEC-BACKUP F2] the throwaway restore instance: ready at once, never already there
if args[:1] == ["logs"]:
    print("PostgreSQL init process complete; ready for start up.")
if args[:2] in (["container", "inspect"], ["volume", "inspect"]):
    sys.exit(1)
sys.exit(0)
'''
# pg_restore --list reads only a real custom archive (magic PGDMP); a
# ciphertext or anything else is refused, as the real tool does.
FAKE_PG_RESTORE = r'''
import sys
args = sys.argv[1:]
if args[:1] == ["--list"]:
    data = open(args[1], "rb").read()
    sys.exit(0 if data.startswith(b"PGDMP") else 1)
sys.exit(0)
'''


def shim(bin_dir: Path, name: str, body: str, python: bool = False) -> None:
    path = bin_dir / name
    path.write_text(("#!/usr/bin/env python3\n" if python else "#!/bin/sh\n") + body)
    path.chmod(0o755)


def gpg_home() -> str:
    home = tempfile.mkdtemp()
    os.chmod(home, 0o700)
    return home


def kill_agent(home: str) -> None:
    subprocess.run(["gpgconf", "--homedir", home, "--kill", "gpg-agent"], capture_output=True)
    shutil.rmtree(home, True)


def decrypt(ciphertext: Path, private_key: Path) -> bytes:
    home = gpg_home()
    try:
        subprocess.run(["gpg", "--homedir", home, "--batch", "--quiet", "--import", str(private_key)], check=True, capture_output=True)
        r = subprocess.run(["gpg", "--homedir", home, "--batch", "--quiet", "--pinentry-mode", "loopback",
                            "--passphrase", PASSPHRASE, "--decrypt", str(ciphertext)], capture_output=True, check=True)
        return r.stdout
    finally:
        kill_agent(home)


def make_owner_key(folder: Path):
    """The owner's key pair, made by the owner's own script."""
    r = subprocess.run(["bash", str(DEPLOY / "backup-keygen.sh"), str(folder)],
                       input=f"{PASSPHRASE}\n{PASSPHRASE}\n", text=True, capture_output=True, timeout=120)
    assert r.returncode == 0, r.stderr
    return r.stdout.strip(), folder / "swift-backup-public.asc", folder / "swift-backup-PRIVATE.asc"


@unittest.skipUnless(shutil.which("gpg") and shutil.which("gpgconf"), "GnuPG is not installed")
class BackupEncryption(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.keys = Path(tempfile.mkdtemp(prefix="swift-backup-keys-"))
        cls.fpr, cls.public, cls.private = make_owner_key(cls.keys / "owner")
        cls.other_fpr, cls.other_public, cls.other_private = make_owner_key(cls.keys / "other")
        # [SEC-BACKUP F2] the host's backup signing key, and the allowed-signers file restores trust
        cls.signing = cls.keys / "signing"
        subprocess.run(["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", "swift-backup-signing", "-f", str(cls.signing)], check=True)
        cls.allowed = cls.keys / "allowed_signers"
        cls.allowed.write_text('swift-backup namespaces="swift-backup" ' + " ".join((cls.keys / "signing.pub").read_text().split()[:2]) + "\n")
        cls.allowed.chmod(0o644)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.keys, True)

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-backup-enc-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.bucket = self.tmp / "bucket"
        self.bucket.mkdir()
        self.dumps = self.tmp / "dumps"
        self.log = self.tmp / "calls"
        self.log.write_text("")
        self.fixture = self.tmp / "fixture.dump"
        self.fixture.write_bytes(b"PGDMP" + os.urandom(4096))
        shim(self.bin, "docker", FAKE_DOCKER, python=True)
        shim(self.bin, "pg_restore", FAKE_PG_RESTORE, python=True)

    def env(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("BACKUP_", "AWS_", "PILOT_ENV", "DATABASE_URL"))}
        env.update({
            "PATH": f"{self.bin}:{os.environ['PATH']}",
            "CALL_LOG": str(self.log), "FAKE_BUCKET": str(self.bucket), "FIXTURE_DUMP": str(self.fixture),
            "BACKUP_BUCKET": "swift-backups", "BACKUP_REQUIRED": "1", "AWS_ACCESS_KEY_ID": "test-id",
            "AWS_SECRET_ACCESS_KEY": "test-secret", "AWS_CLI_IMAGE": IMAGE, "AWS_S3_ENDPOINT": "https://storage.example.invalid",
            "PILOT_ENV": "production", "BACKUP_GPG_FINGERPRINT": self.fpr, "BACKUP_GPG_RECIPIENT_FILE": str(self.public),
        })
        env.update(extra)
        return {k: v for k, v in env.items() if v is not None}

    def backup(self, **extra):
        return subprocess.run(["bash", str(DEPLOY / "backup.sh"), str(self.dumps)], env=self.env(**extra),
                              text=True, capture_output=True, timeout=60)

    def dumped(self):
        return "pg_dump" in self.log.read_text()

    def local_files(self):
        return sorted(p.name for p in self.dumps.iterdir()) if self.dumps.exists() else []

    def test_production_encrypts_to_the_owner_key_and_keeps_and_uploads_only_the_gpg(self):
        r = self.backup()
        self.assertEqual(r.returncode, 0, r.stderr)
        files = self.local_files()
        self.assertEqual(len(files), 1, files)
        self.assertRegex(files[0], r"^swift-\d{8}T\d{6}Z\.dump\.gpg$")
        kept = self.dumps / files[0]
        self.assertEqual(stat.S_IMODE(kept.stat().st_mode), 0o600)
        uploaded = list(self.bucket.rglob("*"))
        uploaded = [p for p in uploaded if p.is_file()]
        self.assertEqual([p.name for p in uploaded], [files[0]])
        self.assertIn(f"s3://swift-backups/db/{files[0]}", self.log.read_text())
        # The plain dump never left: neither the bucket nor the kept copy is it.
        self.assertNotEqual(uploaded[0].read_bytes()[:5], b"PGDMP")
        self.assertEqual(decrypt(uploaded[0], self.private), self.fixture.read_bytes())
        self.assertEqual(decrypt(kept, self.private), self.fixture.read_bytes())
        # Another person's key cannot open it.
        with self.assertRaises(subprocess.CalledProcessError):
            decrypt(uploaded[0], self.other_private)
        self.assertIn(f"to the owner's key {self.fpr} only", r.stdout)

    # ── backup.sh --check-key: the proof pilot-up runs before it changes anything ──
    def check_key(self, **extra):
        env = self.env(**extra)
        for name in ("AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
            env.pop(name, None)   # the check needs no storage keys
        return subprocess.run(["bash", str(DEPLOY / "backup.sh"), "--check-key"], env=env, text=True, capture_output=True, timeout=60)

    def test_check_key_accepts_exactly_the_pinned_public_key_and_dumps_nothing(self):
        r = self.check_key()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn(f"backup key OK: BACKUP_GPG_RECIPIENT_FILE holds exactly the pinned public key {self.fpr}", r.stdout)
        self.assertEqual(self.log.read_text(), "", "no dump, no upload, no docker call")
        self.assertFalse(self.dumps.exists())

    def test_check_key_refuses_every_wrong_key_file_and_dumps_nothing(self):
        two = self.tmp / "two.asc"
        two.write_text(self.public.read_text() + self.other_public.read_text())
        for over, said in (
            ({"BACKUP_GPG_RECIPIENT_FILE": str(self.tmp / "missing.asc")}, "must be an absolute path to the owner's exported PUBLIC key"),
            ({"BACKUP_GPG_RECIPIENT_FILE": f"{self.public}  # the owner's key"}, "must be an absolute path to the owner's exported PUBLIC key"),
            ({"BACKUP_GPG_RECIPIENT_FILE": str(self.private)}, "holds a PRIVATE key"),
            ({"BACKUP_GPG_RECIPIENT_FILE": str(self.other_public)}, "is not the pinned owner key"),
            ({"BACKUP_GPG_RECIPIENT_FILE": str(two)}, "exactly one public key"),
            ({"BACKUP_GPG_FINGERPRINT": f"{self.fpr} # pinned"}, "40-character fingerprint"),
            ({"BACKUP_GPG_FINGERPRINT": None, "BACKUP_GPG_RECIPIENT_FILE": None}, "set BACKUP_GPG_RECIPIENT_FILE and BACKUP_GPG_FINGERPRINT"),
        ):
            with self.subTest(over=sorted(over)):
                r = self.check_key(**over)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(said, r.stderr)
                self.assertNotIn("backup key OK", r.stdout)
                self.assertEqual(self.log.read_text(), "")
        # Off production, with no key configured, there is nothing to prove: refused, never a false OK.
        r = self.check_key(PILOT_ENV="staging", BACKUP_GPG_FINGERPRINT=None, BACKUP_GPG_RECIPIENT_FILE=None)
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("--check-key: no backup key is configured", r.stderr)

    def test_production_refuses_without_the_pinned_key_before_dumping(self):
        for over in ({"BACKUP_GPG_FINGERPRINT": None}, {"BACKUP_GPG_RECIPIENT_FILE": None},
                     {"BACKUP_GPG_FINGERPRINT": self.fpr.lower()}, {"BACKUP_GPG_RECIPIENT_FILE": "relative.asc"},
                     {"BACKUP_GPG_RECIPIENT_FILE": str(self.tmp / "missing.asc")}):
            with self.subTest(over=sorted(over)):
                self.log.write_text("")
                r = self.backup(**over)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("BACKUP_GPG_", r.stderr)
                self.assertFalse(self.dumped())
                self.assertEqual(self.local_files(), [])

    def test_a_private_key_on_the_server_is_refused_and_never_printed(self):
        r = self.backup(BACKUP_GPG_RECIPIENT_FILE=str(self.private))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("PRIVATE key", r.stderr)
        body = self.private.read_text().splitlines()[3]
        self.assertNotIn(body, r.stdout + r.stderr)
        self.assertFalse(self.dumped())

    def test_another_key_or_two_keys_are_refused_before_dumping(self):
        r = self.backup(BACKUP_GPG_RECIPIENT_FILE=str(self.other_public))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not the pinned owner key", r.stderr)
        self.assertFalse(self.dumped())
        both = self.tmp / "both.asc"
        both.write_text(self.public.read_text() + self.other_public.read_text())
        r = self.backup(BACKUP_GPG_RECIPIENT_FILE=str(both))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("exactly one public key", r.stderr)
        self.assertFalse(self.dumped())

    def test_a_failed_encryption_uploads_nothing_and_leaves_no_plain_dump(self):
        real_gpg = shutil.which("gpg")
        shim(self.bin, "gpg", f'case " $* " in *" --encrypt "*) exit 2;; esac\nexec "{real_gpg}" "$@"')
        r = self.backup()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("encrypting the dump to the owner's key failed", r.stderr)
        self.assertTrue(self.dumped())
        self.assertEqual(self.local_files(), [])
        self.assertEqual([p for p in self.bucket.rglob("*") if p.is_file()], [])

    def test_a_dump_that_would_also_open_for_another_key_is_refused(self):
        # As if the host's gpg were configured to add a recipient (encrypt-to):
        # the encrypted file must name the owner's key and nothing else.
        real_gpg = shutil.which("gpg")
        shim(self.bin, "gpg", f'case " $* " in *" --encrypt "*) exec "{real_gpg}" --recipient-file "{self.other_public}" "$@";; esac\nexec "{real_gpg}" "$@"')
        r = self.backup()
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("names a recipient that is not the owner's key", r.stderr)
        self.assertEqual(self.local_files(), [])
        self.assertEqual([p for p in self.bucket.rglob("*") if p.is_file()], [])

    def test_a_failed_upload_leaves_only_the_encrypted_copy(self):
        r = self.backup(UPLOAD_FAIL="1")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("offsite upload failed", r.stderr)
        files = self.local_files()
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith(".dump.gpg"), files)

    def test_production_keeps_two_days_locally_by_default(self):
        self.dumps.mkdir(mode=0o700)
        old = self.dumps / "swift-20261001T000000Z.dump.gpg"
        recent = self.dumps / "swift-20261012T000000Z.dump.gpg"
        for path, days in ((old, 3), (recent, 1)):
            path.write_bytes(b"x")
            stamp = time.time() - days * 86400 - 3600
            os.utime(path, (stamp, stamp))
        r = self.backup()
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertFalse(old.exists())
        self.assertTrue(recent.exists())

    def test_staging_without_the_settings_keeps_plain_dumps(self):
        r = self.backup(PILOT_ENV="staging", BACKUP_GPG_FINGERPRINT=None, BACKUP_GPG_RECIPIENT_FILE=None)
        self.assertEqual(r.returncode, 0, r.stderr)
        files = self.local_files()
        self.assertEqual(len(files), 1)
        self.assertTrue(files[0].endswith(".dump"), files)

    # ── restore.sh never decrypts ──────────────────────────────────────────
    def restore(self, *args, stdin=None, **extra):
        env = self.env(BACKUP_SIGNING_ALLOWED_SIGNERS=str(self.allowed), **extra)
        return subprocess.run(["bash", str(DEPLOY / "restore.sh"), *args], env=env,
                              **({"input": stdin} if stdin is not None else {"stdin": subprocess.DEVNULL}),
                              capture_output=True, timeout=60)

    def signed_backup(self):
        """A production backup signed on the host, as the current unit runs it."""
        return self.backup(BACKUP_SIGNING_KEY_FILE=str(self.signing), BACKUP_SIGNING_ALLOWED_SIGNERS=str(self.allowed))

    def sign_planted(self, obj: Path):
        """Sign an object planted in the bucket with the TRUSTED key, so a check after the signature is what refuses it."""
        subprocess.run([sys.executable, "-I", str(DEPLOY / "backup-signature.py"), "sign", "--key", str(self.signing),
                        "--object", str(obj), "--out", f"{obj}.sig", "--created", "20261028T000000Z"], check=True, capture_output=True)

    def test_restore_refuses_an_encrypted_dump_and_points_at_the_drill(self):
        enc = self.tmp / "swift-20261013T010000Z.dump.gpg"
        enc.write_bytes(b"ciphertext")
        for source in (str(enc), "s3://swift-backups/db/swift-20261013T010000Z.dump.gpg"):
            with self.subTest(source=source):
                self.log.write_text("")
                r = self.restore(source, "swift_restore_x")
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(b"backup-drill.sh", r.stderr)
                self.assertNotIn("docker", self.log.read_text())

    def test_fetch_encrypted_streams_only_ciphertext(self):
        ok = self.signed_backup()
        self.assertEqual(ok.returncode, 0, ok.stderr)
        [obj] = [p for p in self.bucket.rglob("*.dump.gpg")]
        key = f"s3://swift-backups/{obj.relative_to(self.bucket)}"
        r = self.restore("--fetch-encrypted", key)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout, obj.read_bytes())
        # Not an encrypted name, or a plain object under an encrypted name: refused.
        r = self.restore("--fetch-encrypted", "s3://swift-backups/db/swift-20261013T010000Z.dump")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"only an encrypted off-site dump", r.stderr)
        plain = self.bucket / "db" / "swift-20261013T020000Z.dump.gpg"
        plain.write_bytes(self.fixture.read_bytes())
        # [SEC-BACKUP F2] unsigned, it is refused for that first
        r = self.restore("--fetch-encrypted", "s3://swift-backups/db/swift-20261013T020000Z.dump.gpg")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"has NO signature", r.stderr)
        self.assertEqual(r.stdout, b"")
        self.sign_planted(plain)
        r = self.restore("--fetch-encrypted", "s3://swift-backups/db/swift-20261013T020000Z.dump.gpg")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"PLAIN dump", r.stderr)
        self.assertEqual(r.stdout, b"")

    # ── objects that are not a backup encrypted to the owner's key ─────────
    def not_encrypted_to_a_key(self, kind: str) -> Path:
        """A .dump.gpg object holding the fixture dump WITHOUT public-key
        encryption (Opus review 14 Oct, S3-1: gpg --decrypt exits 0 on these):
        'stored' is an OpenPGP message with no encryption at all (gpg --store),
        'symmetric' is encrypted to a passphrase instead of a key, 'spliced' is a
        real backup's public-key packet glued in front of a 'stored' message,
        'other-key' is properly encrypted, but to another key."""
        home = gpg_home()
        out = self.tmp / f"{kind}.gpg"
        try:
            how = {"stored": ["--store"], "spliced": ["--store"],
                   "symmetric": ["--pinentry-mode", "loopback", "--passphrase", "not-a-key", "--symmetric"],
                   "other-key": ["--trust-model", "always", "--recipient-file", str(self.other_public), "--encrypt"]}[kind]
            subprocess.run(["gpg", "--homedir", home, "--batch", "--yes", "--output", str(out), *how, str(self.fixture)],
                           check=True, capture_output=True)
        finally:
            kill_agent(home)
        if kind == "spliced":
            before = set(self.bucket.rglob("*.dump.gpg"))
            ok = self.signed_backup()
            self.assertEqual(ok.returncode, 0, ok.stderr)
            [real] = [q for q in self.bucket.rglob("*.dump.gpg") if q not in before]
            data = real.read_bytes()
            self.assertEqual(data[0] & 0xC0, 0x80, "an old-format first packet, as GnuPG writes it")
            length_bytes = {0: 1, 1: 2, 2: 4}[data[0] & 3]
            first = 1 + length_bytes + int.from_bytes(data[1:1 + length_bytes], "big")
            self.assertEqual((data[0] >> 2) & 0x0F, 1, "the first packet is a public-key session key")
            out.write_bytes(data[:first] + out.read_bytes())
            real.unlink()
            Path(f"{real}.sig").unlink()
        return out

    def test_fetch_encrypted_refuses_an_object_that_is_not_encrypted_to_a_key(self):
        for kind in ("stored", "symmetric", "spliced"):
            with self.subTest(kind=kind):
                obj = self.not_encrypted_to_a_key(kind)
                target = self.bucket / "db" / f"swift-20261014T0{len(kind)}0000Z.dump.gpg"
                target.parent.mkdir(exist_ok=True)
                shutil.copyfile(obj, target)
                self.sign_planted(target)
                r = self.restore("--fetch-encrypted", f"s3://swift-backups/db/{target.name}")
                self.assertNotEqual(r.returncode, 0)
                self.assertIn(b"not encrypted to a key", r.stderr)
                self.assertEqual(r.stdout, b"")

    def test_source_dash_restores_the_dump_piped_in(self):
        # The fake pg_restore refuses anything but a custom archive: what came in
        # on stdin is what it was given. A ciphertext piped in is refused there.
        # (unsigned on purpose: the owner's legacy flag; the drill's signed path is proven below)
        r = self.restore("--allow-unsigned-legacy", "-", "swift_restore_y", stdin=b"not an archive")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"pg_restore cannot read this archive", r.stderr)
        r = self.restore("-", "swift_restore_y", stdin=b"")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn(b"nothing arrived on stdin", r.stderr)
        r = self.restore("--project", "swift", "--allow-unsigned-legacy", "-", "swift_restore_y", stdin=self.fixture.read_bytes())
        self.assertNotIn(b"pg_restore cannot read this archive", r.stderr)
        log = self.log.read_text()
        self.assertIn("CREATE DATABASE", log)
        # [SEC-BACKUP F2] in the throwaway instance, not through the live stack's postgres
        self.assertIn("--network none", log)
        self.assertFalse([l for l in log.splitlines() if l.startswith("docker compose") and "CREATE DATABASE" in l])

    # ── the drill, on the owner's computer ─────────────────────────────────
    def drill(self, key_text: str, passphrase: str, obj: str, scratch="swift_drill_t", project="swift"):
        received = self.tmp / "received.dump"
        ssh_log = self.tmp / "ssh.log"
        # The host: a fetch streams the object from the fake bucket; the restore
        # takes stdin. Every argv the host sees is logged.
        shim(self.bin, "ssh", f'''printf '%s\\n' "$*" >> "{ssh_log}"
for last; do :; done
case "$last" in
  *--fetch-signature*) key="${{last##*--fetch-signature \\'}}"; key="${{key%\\'}}"; sig="{self.bucket}/${{key#s3://swift-backups/}}.sig"; if [ -f "$sig" ]; then cat "$sig"; else echo "swift-backup-signature none"; fi;;
  *--fetch-encrypted*) key="${{last##*--fetch-encrypted \\'}}"; key="${{key%\\'}}"; cat "{self.bucket}/${{key#s3://swift-backups/}}";;
  *"--compare-source - "*) cat > "{received}"; echo "compare-source: equal"; echo "RESTORE OK";;
  *) exit 9;;
esac
''')
        r = subprocess.run(["bash", str(DEPLOY / "backup-drill.sh"), "swift-deploy@prod.example.invalid", str(self.private), obj, scratch],
                           input=key_text + passphrase + "\n", text=True, capture_output=True, timeout=120,
                           env={**os.environ, "PATH": f"{self.bin}:{os.environ['PATH']}", **({"SWIFT_RESTORE_PROJECT": project} if project else {})})
        return r, received, ssh_log

    def test_the_drill_names_the_compose_project_or_refuses_before_reaching_the_host(self):
        # [#1977 · copy run #5c] restore.sh never guesses the stack; neither does the drill.
        r, _, ssh_log = self.drill("", PASSPHRASE, "s3://swift-backups/db/swift-20261013T010000Z.dump.gpg", project="")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("SWIFT_RESTORE_PROJECT", r.stderr)
        self.assertFalse(ssh_log.exists() and ssh_log.read_text())

    def test_the_drill_decrypts_on_the_owner_side_and_the_host_receives_the_plain_dump(self):
        ok = self.signed_backup()
        self.assertEqual(ok.returncode, 0, ok.stderr)
        [obj] = [p for p in self.bucket.rglob("*.dump.gpg")]
        key = f"s3://swift-backups/{obj.relative_to(self.bucket)}"
        key_text = self.private.read_text()
        r, received, ssh_log = self.drill(key_text, PASSPHRASE, key)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("DRILL OK", r.stdout)
        self.assertIn("RESTORE OK", r.stdout)
        self.assertEqual(received.read_bytes(), self.fixture.read_bytes())
        host_saw = ssh_log.read_text()
        self.assertIn("restore.sh --fetch-encrypted", host_saw)
        # [SEC-BACKUP F2] the host verified the signature first, and the restore gets exactly that bundle
        self.assertIn(f"restore.sh --fetch-signature '{key}'", host_saw)
        bundle = base64.b64encode(Path(f"{obj}.sig").read_bytes()).decode()
        self.assertIn(f"restore.sh --project 'swift' --signature-b64 '{bundle}' --signed-object '{obj.name}' --compare-source - 'swift_drill_t'", host_saw)
        # Neither the key nor the passphrase ever reaches the host or a log.
        for secret in (PASSPHRASE, key_text.splitlines()[3]):
            self.assertNotIn(secret, host_saw)
            self.assertNotIn(secret, r.stdout + r.stderr)

    def test_the_drill_refuses_a_wrong_passphrase_or_another_key_and_the_host_gets_nothing(self):
        ok = self.signed_backup()
        self.assertEqual(ok.returncode, 0, ok.stderr)
        [obj] = [p for p in self.bucket.rglob("*.dump.gpg")]
        key = f"s3://swift-backups/{obj.relative_to(self.bucket)}"
        for key_text, passphrase in ((self.private.read_text(), "wrong passphrase"), (self.other_private.read_text(), PASSPHRASE)):
            with self.subTest(other=key_text != self.private.read_text()):
                r, received, _ = self.drill(key_text, passphrase, key)
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("could not decrypt the backup", r.stderr)
                self.assertFalse(received.exists() and received.read_bytes() == self.fixture.read_bytes())

    def test_the_drill_refuses_an_object_not_encrypted_to_this_key_before_decrypting_and_the_host_gets_nothing(self):
        # Opus review 14 Oct, S3-1: gpg --decrypt "decrypts" a message with no
        # encryption (exit 0), so DRILL OK did not prove the object was encrypted.
        # A real backup encrypted to someone else's key is named for what it is too.
        for kind in ("stored", "symmetric", "spliced", "other-key"):
            with self.subTest(kind=kind):
                obj = self.not_encrypted_to_a_key(kind)
                target = self.bucket / "db" / f"swift-20261014T1{len(kind)}0000Z.dump.gpg"
                target.parent.mkdir(exist_ok=True)
                shutil.copyfile(obj, target)
                self.sign_planted(target)
                r, received, _ = self.drill(self.private.read_text(), PASSPHRASE, f"s3://swift-backups/db/{target.name}")
                self.assertNotEqual(r.returncode, 0)
                self.assertIn("is not a backup encrypted to this key", r.stderr)
                self.assertNotIn("DRILL OK", r.stdout)
                self.assertEqual(received.read_bytes() if received.exists() else b"", b"")

    def test_the_drill_refuses_shapes_that_could_reach_the_remote_shell(self):
        for obj, scratch in (("s3://swift-backups/db/x.dump.gpg'; rm -rf /'", "swift_drill_t"),
                             ("s3://swift-backups/db/swift.dump", "swift_drill_t"),
                             ("s3://swift-backups/db/swift.dump.gpg", "x; reboot")):
            with self.subTest(obj=obj, scratch=scratch):
                r, _, ssh_log = self.drill(self.private.read_text(), PASSPHRASE, obj, scratch)
                self.assertNotEqual(r.returncode, 0)
                self.assertFalse(ssh_log.exists())

    def test_the_drill_takes_only_an_armored_private_key(self):
        r, _, ssh_log = self.drill(self.public.read_text(), PASSPHRASE, "s3://swift-backups/db/swift.dump.gpg")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("not an armored PGP private key block", r.stderr)
        self.assertFalse(ssh_log.exists())


@unittest.skipUnless(shutil.which("gpg") and shutil.which("gpgconf"), "GnuPG is not installed")
class BackupKeygen(unittest.TestCase):
    def test_makes_one_key_pair_public_to_give_private_to_keep(self):
        with tempfile.TemporaryDirectory() as tmp:
            fpr, public, private = make_owner_key(Path(tmp) / "keys")
            self.assertRegex(fpr, r"^[0-9A-F]{40}$")
            self.assertIn("BEGIN PGP PUBLIC KEY BLOCK", public.read_text())
            self.assertNotIn("PRIVATE KEY", public.read_text())
            self.assertIn("BEGIN PGP PRIVATE KEY BLOCK", private.read_text())
            self.assertEqual(stat.S_IMODE(private.stat().st_mode), 0o600)
            shown = subprocess.run(["gpg", "--homedir", gpg_home(), "--batch", "--with-colons", "--show-keys", str(public)],
                                   capture_output=True, text=True).stdout
            self.assertIn(f"fpr:::::::::{fpr}:", shown)
            # A second run into the same folder is refused (a second key would not open the first one's backups).
            r = subprocess.run(["bash", str(DEPLOY / "backup-keygen.sh"), str(Path(tmp) / "keys")],
                               input=f"{PASSPHRASE}\n{PASSPHRASE}\n", text=True, capture_output=True, timeout=60)
            self.assertNotEqual(r.returncode, 0)
            self.assertIn("already holds", r.stderr)

    def test_refuses_mismatched_or_short_passphrases_and_makes_nothing(self):
        for typed in (f"{PASSPHRASE}\nsomething else entirely\n", "short\nshort\n"):
            with self.subTest(typed=typed.split()[0]), tempfile.TemporaryDirectory() as tmp:
                r = subprocess.run(["bash", str(DEPLOY / "backup-keygen.sh"), str(Path(tmp) / "keys")],
                                   input=typed, text=True, capture_output=True, timeout=60)
                self.assertNotEqual(r.returncode, 0)
                self.assertEqual(list((Path(tmp) / "keys").glob("*.asc")), [])


class BackupTimers(unittest.TestCase):
    def test_production_runs_hourly_and_staging_keeps_nightly(self):
        hourly = (DEPLOY / "swift-backup-hourly.timer").read_text()
        nightly = (DEPLOY / "swift-backup.timer").read_text()
        self.assertIn("OnCalendar=*-*-* *:15:00", hourly)
        self.assertIn("Unit=swift-backup.service", hourly)
        self.assertIn("Persistent=true", hourly)
        self.assertIn("OnCalendar=*-*-* 02:15:00", nightly)


class BackupUnitTimeout(unittest.TestCase):
    """Opus review 14 Oct, S3-2: a oneshot unit has no start timeout by default,
    so one hung run kept the unit active and every later hourly trigger was
    skipped in silence."""

    def test_a_hung_backup_run_ends_before_the_next_hourly_start(self):
        unit = (DEPLOY / "swift-backup.service").read_text()
        [value] = [l.split("=", 1)[1].strip() for l in unit.splitlines() if l.startswith("TimeoutStartSec=")]
        minutes = int(value[:-3]) if value.endswith("min") else int(value) / 60
        self.assertGreater(minutes, 10, "a real dump needs time")
        self.assertLess(minutes, 60, "it must end before the next hourly run")
        self.assertIn("Type=oneshot", unit)


class BackupHostTools(unittest.TestCase):
    """DS1095 S3: every production backup needs gpg on the host; a freshly
    provisioned host must have it, not wait for a hand install."""

    def test_the_provisioner_installs_gpg_in_its_one_package_step(self):
        provision = (DEPLOY / "provision-ubuntu.sh").read_text()
        step = provision[provision.index("apt-get install -y"):]
        step = step[:step.index("\n#")]
        self.assertRegex(step, r"(?m)(^|\s)gpg(\s|$)")

    def doctor(self, pilot_env: str, timer: str):
        """doctor.sh in a scratch deploy folder; systemctl answers `timer`
        (ok / off / inactive); curl, docker, gh and sudo find nothing."""
        with tempfile.TemporaryDirectory() as tmp:
            here = Path(tmp) / "deploy"
            here.mkdir()
            shutil.copy(DEPLOY / "doctor.sh", here / "doctor.sh")
            (here / ".env").write_text(f"PILOT_ENV={pilot_env}\nAPI_HOST=api.example.invalid\n")
            bin_dir = Path(tmp) / "bin"
            bin_dir.mkdir()
            calls = Path(tmp) / "calls"
            shim(bin_dir, "systemctl", f'''echo "systemctl $*" >> "{calls}"
case "$1:{timer}" in is-enabled:off|is-active:inactive) exit 1;; esac
exit 0
''')
            for tool in ("curl", "docker", "gh", "sudo"):
                shim(bin_dir, tool, "exit 7\n")
            r = subprocess.run(["bash", str(here / "doctor.sh")], env={"PATH": f"{bin_dir}:/usr/bin:/bin", "HOME": tmp},
                               text=True, capture_output=True, timeout=60)
            return r.stdout, (calls.read_text() if calls.exists() else "")

    def test_the_doctor_fails_production_without_the_hourly_timer_enabled_and_active(self):
        for timer in ("off", "inactive"):
            with self.subTest(timer=timer):
                out, calls = self.doctor("production", timer)
                self.assertIn("FAIL  production's hourly backup timer (swift-backup-hourly.timer) is not enabled and active", out)
                self.assertIn("swift-backup-hourly.timer", calls)
        out, _ = self.doctor("production", "ok")
        self.assertIn("ok    the hourly backup timer is enabled and active", out)
        # Staging keeps its nightly timer; the doctor does not ask there.
        out, calls = self.doctor("staging", "off")
        self.assertNotIn("hourly backup timer", out)
        self.assertEqual(calls, "")

    def test_the_doctor_points_production_at_the_owner_side_drill(self):
        doctor = (DEPLOY / "doctor.sh").read_text()
        line = next(l for l in doctor.splitlines() if "restore never rehearsed" in l)
        self.assertIn("deploy/backup-drill.sh", line)


if __name__ == "__main__":
    unittest.main()
