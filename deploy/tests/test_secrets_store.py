"""Service-free contracts for the encrypted host secret store.

Runs the real bash scripts (deploy/swift-secrets, gen-secrets.sh, the owner
entry tool, backup.sh and the pilot-up preflight fragment) against shims for
the host tools they call: a fake `systemd-creds` that records every argument
and round-trips values through a marker envelope, a fake `findmnt`, `sudo`,
`id`, `ssh`, `docker`, `aws` and `systemctl`. Nothing here needs root, a
network, Docker or systemd.

    python3 -m unittest discover -s deploy/tests -v
"""

import base64
import hashlib
import os
import re
import shutil
import stat
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY = Path(__file__).resolve().parents[1]
STORE = DEPLOY / "swift-secrets"
OWNER_TOOL = DEPLOY / "owner" / "swift-secrets-prompt.command"

FAKE_CREDS = r'''#!/usr/bin/env python3
"""Fake systemd-creds. Envelope: b"FAKECRED\n" + name + b"\n" + base64(plaintext)."""
import base64, os, sys
argv = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("systemd-creds " + " ".join(argv) + "\n")
cmd, rest, name = argv[0], [], None
for a in argv[1:]:
    if a.startswith("--name="):
        name = a[len("--name="):]
    elif a.startswith("--with-key="):
        pass
    else:
        rest.append(a)
if cmd == "encrypt":
    src, dst = rest
    if src != "-":
        sys.stderr.write("fake systemd-creds: encrypt input must be stdin\n"); sys.exit(3)
    data = sys.stdin.buffer.read()
    with open(dst, "wb") as f:
        f.write(b"FAKECRED\n" + (name or "").encode() + b"\n" + base64.b64encode(data))
    sys.exit(0)
if cmd == "decrypt":
    src, dst = rest
    with open(src, "rb") as f:
        head, embedded, payload = f.read().split(b"\n", 2)
    if head != b"FAKECRED":
        sys.stderr.write("fake systemd-creds: not a credential\n"); sys.exit(1)
    if name is not None and embedded.decode() != name:
        sys.stderr.write("fake systemd-creds: credential name mismatch\n"); sys.exit(1)
    out = sys.stdout.buffer if dst == "-" else open(dst, "wb")
    out.write(base64.b64decode(payload)); out.flush()
    sys.exit(0)
sys.stderr.write("fake systemd-creds: unknown command\n"); sys.exit(2)
'''

FAKE_SWIFT_SECRETS = r'''#!/usr/bin/env python3
"""Fake swift-secrets for callers: records `set NAME` with stdin into SHIM_STORE."""
import os, sys
store = os.environ["SHIM_STORE"]
argv = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("swift-secrets " + " ".join(argv) + "\n")
if argv[:1] == ["list"]:
    for n in sorted(os.listdir(store)):
        print(n)
    sys.exit(0)
if argv[:1] == ["set"]:
    if len(argv) != 2:
        sys.stderr.write("fake swift-secrets: set takes exactly one argument\n"); sys.exit(2)
    data = sys.stdin.buffer.read()
    if not data:
        sys.stderr.write("fake swift-secrets: empty stdin\n"); sys.exit(1)
    with open(os.path.join(store, argv[1]), "wb") as f:
        f.write(data)
    print("stored " + argv[1]); sys.exit(0)
sys.exit(2)
'''

FAKE_SSH = r'''#!/usr/bin/env python3
"""Fake ssh: records argv and everything it received on stdin."""
import os, sys
argv = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("ssh " + " ".join(argv) + "\n")
data = b"" if "-n" in argv else sys.stdin.buffer.read()
if data:
    with open(os.environ["SSH_STDIN_LOG"], "ab") as f:
        f.write(b"<<" + data + b">>\n")
if os.environ.get("SSH_FAIL") and "true" not in argv:
    sys.exit(255)
sys.exit(0)
'''


def write_shim(bin_dir: Path, name: str, body: str) -> Path:
    path = bin_dir / name
    path.write_text(body)
    path.chmod(0o755)
    return path


def sh_shim(bin_dir: Path, name: str, script: str) -> Path:
    return write_shim(bin_dir, name, "#!/bin/sh\n" + script + "\n")


class StoreHarness(unittest.TestCase):
    """Shared temp layout: shims on PATH, a store dir, a tmpfs stand-in run dir."""

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-secrets-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.store = self.tmp / "credstore"
        self.run_dir = self.tmp / "run" / "swift-secrets"
        (self.tmp / "run").mkdir()
        self.log = self.tmp / "calls.log"
        self.log.write_text("")
        write_shim(self.bin, "systemd-creds", FAKE_CREDS)
        sh_shim(self.bin, "findmnt", 'echo "${FAKE_FSTYPE:-tmpfs}"')
        # `id -u` answers 0 so the script's root check passes without root; the
        # files it creates are still owned by the real user, which is why the
        # owner uid/gid below are the real ones.
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 0; else exec /usr/bin/id "$@"; fi')

    def env(self, **extra):
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin}:{env['PATH']}",
            "CALL_LOG": str(self.log),
            "SWIFT_SECRETS_STORE_DIR": str(self.store),
            "SWIFT_SECRETS_RUN_DIR": str(self.run_dir),
            "SWIFT_SECRETS_OWNER_UID": str(os.getuid()),
            "SWIFT_SECRETS_OWNER_GID": str(os.getgid()),
        })
        env.update(extra)
        return env

    def run_store(self, *args, stdin=None, **extra):
        return subprocess.run(
            ["bash", str(STORE), *args], input=stdin, env=self.env(**extra),
            text=False, capture_output=True, timeout=15,
        )

    def calls(self) -> str:
        return self.log.read_text()

    def set_ok(self, name: str, value: bytes) -> subprocess.CompletedProcess:
        result = self.run_store("set", name, stdin=value)
        self.assertEqual(result.returncode, 0, result.stderr)
        return result


class SwiftSecretsSet(StoreHarness):
    def test_set_reads_the_value_from_stdin_and_never_argv(self):
        value = b"s3cret-value-with spaces\t$and\"quotes'\n"
        result = self.set_ok("JWT_SECRET", value)
        self.assertEqual(result.stdout, b"stored JWT_SECRET\n")
        self.assertEqual(result.stderr, b"")
        cred = self.store / "JWT_SECRET.cred"
        self.assertTrue(cred.exists())
        self.assertEqual(stat.S_IMODE(cred.stat().st_mode), 0o600)
        head, name, payload = cred.read_bytes().split(b"\n", 2)
        self.assertEqual((head, name), (b"FAKECRED", b"JWT_SECRET"))
        # One trailing newline is stripped at storage time so `echo value |` and
        # `printf '%s' value |` store identical bytes.
        self.assertEqual(base64.b64decode(payload), value[:-1])
        self.assertNotIn(value[:-1], cred.read_bytes())
        encrypt_line = [l for l in self.calls().splitlines() if "encrypt" in l][0]
        self.assertIn("--name=JWT_SECRET", encrypt_line)
        self.assertIn("--with-key=host", encrypt_line)
        self.assertRegex(encrypt_line, r" - \S+JWT_SECRET\.")
        self.assertNotIn("s3cret", encrypt_line)
        # No leftover temporary file next to the credential.
        self.assertEqual(sorted(p.name for p in self.store.iterdir()), ["JWT_SECRET.cred"])

    def test_set_strips_exactly_one_trailing_newline(self):
        self.set_ok("MMG_MSECRET", b"line1\nline2\n\n")
        _, _, payload = (self.store / "MMG_MSECRET.cred").read_bytes().split(b"\n", 2)
        self.assertEqual(base64.b64decode(payload), b"line1\nline2\n")

    def test_set_normalizes_one_trailing_crlf_exactly_like_the_loader(self):
        # [R2 F7] A value piped with a Windows line ending must round-trip to
        # the same bytes the app's loader would keep: one "\r\n" or "\n" goes,
        # a lone trailing "\r" (no newline) stays, and only ONE ending goes.
        cases = {
            "SMTP_PASS": (b"pass\r\n", b"pass"),
            "MMG_MKEY": (b"pass\r", b"pass\r"),
            "MMG_PASSWORD": (b"pass\r\n\r\n", b"pass\r\n"),
            "AWS_SECRET_ACCESS_KEY": (b"pa\r\nss\n", b"pa\r\nss"),
        }
        for name, (given, stored) in cases.items():
            with self.subTest(name=name, given=given):
                self.set_ok(name, given)
                _, _, payload = (self.store / f"{name}.cred").read_bytes().split(b"\n", 2)
                self.assertEqual(base64.b64decode(payload), stored)

    def test_overwrite_keeps_the_previous_encrypted_version(self):
        self.set_ok("TWILIO_API_KEY_SECRET", b"first")
        self.set_ok("TWILIO_API_KEY_SECRET", b"second")
        names = sorted(p.name for p in self.store.iterdir())
        self.assertEqual(names, ["TWILIO_API_KEY_SECRET.cred", "TWILIO_API_KEY_SECRET.cred.prev"])
        for n in names:
            self.assertEqual(stat.S_IMODE((self.store / n).stat().st_mode), 0o600)
        _, _, payload = (self.store / "TWILIO_API_KEY_SECRET.cred").read_bytes().split(b"\n", 2)
        self.assertEqual(base64.b64decode(payload), b"second")
        _, _, prev = (self.store / "TWILIO_API_KEY_SECRET.cred.prev").read_bytes().split(b"\n", 2)
        self.assertEqual(base64.b64decode(prev), b"first")

    def test_overwrite_is_a_single_rename_so_the_live_credential_never_disappears(self):
        # [R2 F3] With two renames (cred → cred.prev, tmp → cred) a materialize
        # running in between sees no credential and deletes the live tmpfs file.
        # The previous version is kept by COPY, and the swap is one rename.
        sh_shim(self.bin, "mv", 'echo "mv $*" >> "$CALL_LOG"; exec /bin/mv "$@"')
        self.set_ok("JWT_SECRET", b"first")
        self.set_ok("JWT_SECRET", b"second")
        cred = str(self.store / "JWT_SECRET.cred")
        moves = [l for l in self.calls().splitlines() if l.startswith("mv ")]
        self.assertEqual(len(moves), 2, moves)  # one per `set`
        for m in moves:
            self.assertTrue(m.endswith(" " + cred), m)
            self.assertNotIn(cred + " ", m)  # the live credential is never a rename SOURCE
        _, _, prev = (self.store / "JWT_SECRET.cred.prev").read_bytes().split(b"\n", 2)
        self.assertEqual(base64.b64decode(prev), b"first")
        self.assertEqual(stat.S_IMODE((self.store / "JWT_SECRET.cred.prev").stat().st_mode), 0o600)

    def test_set_refuses_a_value_in_argv(self):
        result = self.run_store("set", "JWT_SECRET", "leaked-value", stdin=b"x")
        self.assertEqual(result.returncode, 2)
        self.assertNotIn(b"leaked-value", result.stderr)
        self.assertFalse((self.store / "JWT_SECRET.cred").exists())
        self.assertNotIn("encrypt", self.calls())

    def test_set_refuses_bad_names(self):
        for bad in ("jwt_secret", "../JWT_SECRET", "JWT SECRET", "JWT_SECRET_FILE", "1ABC", ""):
            with self.subTest(name=bad):
                result = self.run_store("set", bad, stdin=b"value")
                self.assertNotEqual(result.returncode, 0)
                self.assertNotIn("encrypt", self.calls())
        self.assertEqual(list(self.store.glob("*")) if self.store.exists() else [], [])

    def test_set_refuses_an_empty_value(self):
        for empty in (b"", b"\n"):
            with self.subTest(value=empty):
                result = self.run_store("set", "JWT_SECRET", stdin=empty)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(b"empty", result.stderr)
        self.assertFalse((self.store / "JWT_SECRET.cred").exists())

    def test_set_requires_root(self):
        os.remove(self.bin / "id")  # the real uid shows through
        if os.getuid() == 0:
            self.skipTest("running as root")
        result = self.run_store("set", "JWT_SECRET", stdin=b"value")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"root", result.stderr)
        self.assertNotIn("encrypt", self.calls())


class SwiftSecretsList(StoreHarness):
    def test_list_prints_names_only_and_needs_no_root(self):
        os.remove(self.bin / "id")
        self.store.mkdir()
        for n in ("ZEBRA_KEY", "ALPHA_SECRET"):
            (self.store / f"{n}.cred").write_bytes(b"FAKECRED\n" + n.encode() + b"\n" + base64.b64encode(b"hidden-" + n.encode()))
        (self.store / "ALPHA_SECRET.cred.prev").write_bytes(b"FAKECRED\nALPHA_SECRET\n" + base64.b64encode(b"older"))
        (self.store / ".ignored.tmp").write_bytes(b"x")
        result = self.run_store("list")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, b"ALPHA_SECRET\nZEBRA_KEY\n")
        self.assertNotIn(b"hidden", result.stdout + result.stderr)
        self.assertNotIn("decrypt", self.calls())

    def test_list_on_an_empty_or_missing_store_prints_nothing(self):
        result = self.run_store("list")
        self.assertEqual((result.returncode, result.stdout), (0, b""))
        self.store.mkdir()
        result = self.run_store("list")
        self.assertEqual((result.returncode, result.stdout), (0, b""))


class SwiftSecretsMaterialize(StoreHarness):
    def test_materialize_decrypts_every_credential_onto_tmpfs_with_tight_modes(self):
        self.set_ok("JWT_SECRET", b"jwt-plain")
        self.set_ok("POSTGRES_PASSWORD", b"pg-plain")
        self.run_dir.mkdir(parents=True)
        (self.run_dir / "STALE_NAME").write_bytes(b"old")
        (self.run_dir / ".JWT_SECRET.tmp").write_bytes(b"crashed")
        result = self.run_store("materialize")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.decode().strip(), f"materialized 2 secret(s) into {self.run_dir}")
        self.assertEqual(sorted(p.name for p in self.run_dir.iterdir()), ["JWT_SECRET", "POSTGRES_PASSWORD"])
        self.assertEqual((self.run_dir / "JWT_SECRET").read_bytes(), b"jwt-plain")
        self.assertEqual((self.run_dir / "POSTGRES_PASSWORD").read_bytes(), b"pg-plain")
        for n in ("JWT_SECRET", "POSTGRES_PASSWORD"):
            st = (self.run_dir / n).stat()
            self.assertEqual(stat.S_IMODE(st.st_mode), 0o400)
            self.assertEqual((st.st_uid, st.st_gid), (os.getuid(), os.getgid()))
        self.assertEqual(stat.S_IMODE(self.run_dir.stat().st_mode), 0o500)
        decrypt_lines = [l for l in self.calls().splitlines() if "decrypt" in l]
        self.assertEqual(len(decrypt_lines), 2)
        for l in decrypt_lines:
            self.assertRegex(l, r"--name=(JWT_SECRET|POSTGRES_PASSWORD) \S+\.cred -$")
        self.assertNotIn("plain", result.stdout.decode() + result.stderr.decode())

    def test_materialize_picks_up_a_rotated_value(self):
        self.set_ok("JWT_SECRET", b"one")
        self.assertEqual(self.run_store("materialize").returncode, 0)
        self.set_ok("JWT_SECRET", b"two")
        self.assertEqual(self.run_store("materialize").returncode, 0)
        self.assertEqual((self.run_dir / "JWT_SECRET").read_bytes(), b"two")
        self.assertEqual(stat.S_IMODE((self.run_dir / "JWT_SECRET").stat().st_mode), 0o400)

    def test_materialize_refuses_a_directory_that_is_not_tmpfs(self):
        self.set_ok("JWT_SECRET", b"x")
        result = self.run_store("materialize", FAKE_FSTYPE="ext4")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"tmpfs", result.stderr)
        self.assertFalse((self.run_dir / "JWT_SECRET").exists())
        self.assertNotIn("decrypt", self.calls())

    def test_materialize_refuses_a_credential_that_does_not_decrypt_and_leaves_no_partial_file(self):
        self.set_ok("JWT_SECRET", b"good")
        self.store.mkdir(exist_ok=True)
        (self.store / "MASTER_KEK.cred").write_bytes(b"FAKECRED\nOTHER_NAME\n" + base64.b64encode(b"mismatched"))
        result = self.run_store("materialize")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(b"MASTER_KEK", result.stderr)
        self.assertNotIn(b"mismatched", result.stderr + result.stdout)
        self.assertFalse((self.run_dir / "MASTER_KEK").exists())
        self.assertEqual([p.name for p in self.run_dir.glob(".*")], [])
        self.assertEqual([p.name for p in self.run_dir.parent.iterdir() if p.name.startswith(".")], [], "no staging leftovers")

    def test_materialize_with_an_empty_store_leaves_an_empty_directory(self):
        result = self.run_store("materialize")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(self.run_dir.is_dir())
        self.assertEqual(list(self.run_dir.iterdir()), [])

    def test_materialize_never_writes_through_anything_planted_in_the_run_directory(self):
        # [R2 F2] The run directory is owned by the container uid, which could
        # plant a symlink where the plaintext is about to be written. Plaintext
        # is therefore decrypted in a root-only staging directory and renamed
        # into place; a planted symlink, a planted directory and a planted tmp
        # link are all replaced, never followed, and the staging area is gone.
        self.set_ok("JWT_SECRET", b"jwt-plain")
        self.set_ok("MASTER_KEK", b"kek-plain")
        self.set_ok("SMTP_PASS", b"smtp-plain")
        victim = self.tmp / "victim"
        victim.write_bytes(b"untouched")
        self.run_dir.mkdir(parents=True)
        (self.run_dir / ".JWT_SECRET.tmp").symlink_to(victim)   # the R1 write target
        (self.run_dir / "MASTER_KEK").symlink_to(victim)        # the final name
        (self.run_dir / "SMTP_PASS").mkdir()                    # a directory in the way
        result = self.run_store("materialize")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(victim.read_bytes(), b"untouched")
        for name, plain in (("JWT_SECRET", b"jwt-plain"), ("MASTER_KEK", b"kek-plain"), ("SMTP_PASS", b"smtp-plain")):
            path = self.run_dir / name
            self.assertFalse(path.is_symlink(), name)
            self.assertTrue(path.is_file(), name)
            self.assertEqual(path.read_bytes(), plain)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
        self.assertEqual(sorted(p.name for p in self.run_dir.iterdir()), ["JWT_SECRET", "MASTER_KEK", "SMTP_PASS"])
        self.assertEqual([p.name for p in self.run_dir.parent.iterdir() if p.name.startswith(".")], [])
        decrypt_lines = [l for l in self.calls().splitlines() if "decrypt" in l]
        self.assertEqual(len(decrypt_lines), 3)


class SwiftSecretsUsage(StoreHarness):
    def test_unknown_or_missing_command_prints_usage(self):
        for args in ((), ("frobnicate",), ("set",), ("list", "extra"), ("materialize", "extra")):
            with self.subTest(args=args):
                result = self.run_store(*args, stdin=b"")
                self.assertEqual(result.returncode, 2)
                self.assertIn(b"usage", result.stderr.lower())

    def test_the_script_is_executable_and_bash(self):
        self.assertTrue(os.access(STORE, os.X_OK))
        self.assertTrue(STORE.read_text().startswith("#!/usr/bin/env bash\n"))


class GenSecrets(StoreHarness):
    """gen-secrets.sh generates locally and pipes each value into the store."""

    GENERATED = ("MASTER_KEK", "JWT_SECRET", "OTP_HASH_SECRET", "STORAGE_SIGNING_SECRET",
                 "CONSENT_IP_PEPPER", "POSTGRES_PASSWORD", "MEILISEARCH_KEY",
                 # [R2 C1] the other random-value secrets production requires
                 "TEST_CONTROL_SECRET", "METRICS_TOKEN", "HEALTH_DETAIL_TOKEN",
                 "ATTRIB_SALT", "IDENTITY_SALT", "SCAN_IP_SALT", "ADS_EVENT_SECRET")

    def setUp(self):
        super().setUp()
        self.shim_store = self.tmp / "shim-store"
        self.shim_store.mkdir()
        write_shim(self.bin, "swift-secrets", FAKE_SWIFT_SECRETS)
        # sudo -n CMD ARGS → CMD ARGS, recorded.
        sh_shim(self.bin, "sudo", 'echo "sudo $*" >> "$CALL_LOG"; [ "$1" = "-n" ] && shift; exec "$@"')
        self.work = self.tmp / "deploy"
        self.work.mkdir()
        shutil.copy(DEPLOY / "gen-secrets.sh", self.work / "gen-secrets.sh")
        shutil.copy(DEPLOY / ".env.deploy.example", self.work / ".env.deploy.example")
        shutil.copy(DEPLOY / "secret-names.sh", self.work / "secret-names.sh")
        (self.tmp / "apps" / "api" / "src" / "utils").mkdir(parents=True)
        shutil.copy(DEPLOY.parent / "apps" / "api" / "src" / "utils" / "secret-files.ts",
                    self.tmp / "apps" / "api" / "src" / "utils" / "secret-files.ts")

    def run_gen(self, *args, **extra):
        return subprocess.run(
            ["bash", str(self.work / "gen-secrets.sh"), *args],
            env=self.env(SHIM_STORE=str(self.shim_store), **extra), text=True, capture_output=True, timeout=30,
        )

    def test_generated_secrets_go_to_the_store_and_only_settings_go_to_env(self):
        result = self.run_gen()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(sorted(p.name for p in self.shim_store.iterdir()), sorted(self.GENERATED))
        values = {n: (self.shim_store / n).read_bytes() for n in self.GENERATED}
        for n, v in values.items():
            self.assertGreaterEqual(len(v), 32, n)
            self.assertNotIn(b"\n", v, f"{n} must be piped without a trailing newline")
        kek = base64.b64decode(values["MASTER_KEK"])
        self.assertEqual(len(kek), 32)
        self.assertRegex(values["POSTGRES_PASSWORD"].decode(), r"^[0-9a-f]{64}$")
        # Every value went through sudo -n swift-secrets set NAME with NO value in argv.
        for line in self.calls().splitlines():
            if line.startswith("swift-secrets set"):
                self.assertRegex(line, r"^swift-secrets set [A-Z_]+$")
        self.assertEqual(sum(1 for l in self.calls().splitlines() if l.startswith("swift-secrets set")), len(self.GENERATED))
        # The env file holds settings and the escrow fingerprint, never a secret.
        env_file = self.work / ".env"
        self.assertTrue(env_file.exists())
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)
        text = env_file.read_text()
        for n in self.GENERATED:
            self.assertNotRegex(text, rf"(?m)^{n}=")
        self.assertIn(f"MASTER_KEK_ESCROW_FINGERPRINT={hashlib.sha256(kek).hexdigest()}\n", text)
        self.assertIn("PILOT_ENV=", text)
        for v in values.values():
            self.assertNotIn(v.decode(), text)
            self.assertNotIn(v.decode(), result.stdout + result.stderr)
        for n in self.GENERATED:
            self.assertIn(n, result.stdout)

    def test_refuses_to_replace_an_existing_master_kek_without_force(self):
        (self.shim_store / "MASTER_KEK").write_bytes(b"existing")
        result = self.run_gen()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MASTER_KEK", result.stderr)
        self.assertEqual((self.shim_store / "MASTER_KEK").read_bytes(), b"existing")
        self.assertFalse((self.work / ".env").exists())
        forced = self.run_gen("--force")
        self.assertEqual(forced.returncode, 0, forced.stderr)
        self.assertNotEqual((self.shim_store / "MASTER_KEK").read_bytes(), b"existing")

    def test_an_existing_env_file_keeps_its_settings_and_gets_the_new_fingerprint(self):
        env_file = self.work / ".env"
        env_file.write_text("PILOT_ENV=staging\nAPI_HOST=api.example.test\nMASTER_KEK_ESCROW_FINGERPRINT=stale\nCUSTOM=kept\n")
        env_file.chmod(0o600)
        result = self.run_gen()
        self.assertEqual(result.returncode, 0, result.stderr)
        text = env_file.read_text()
        kek = base64.b64decode((self.shim_store / "MASTER_KEK").read_bytes())
        self.assertIn(f"MASTER_KEK_ESCROW_FINGERPRINT={hashlib.sha256(kek).hexdigest()}\n", text)
        self.assertNotIn("stale", text)
        self.assertIn("API_HOST=api.example.test\n", text)
        self.assertIn("CUSTOM=kept\n", text)
        self.assertEqual(text.count("MASTER_KEK_ESCROW_FINGERPRINT="), 1)
        self.assertEqual(stat.S_IMODE(env_file.stat().st_mode), 0o600)

    def test_update_strips_every_old_plaintext_secret_line(self):
        # [R2 F6] An env file from before the store may still carry secrets in
        # any spelling Compose would load: bare, indented, `export`-prefixed,
        # a bare pass-through name, or a consumer alias. All go; settings stay;
        # wiring lines and comments stay.
        env_file = self.work / ".env"
        env_file.write_bytes((
            "﻿JWT_SECRET=old-jwt\n"            # [R4 R3-3] a file-leading BOM still declares
            "PILOT_ENV=staging\n"
            "export SMTP_PASS=old-smtp\n"
            "  MMG_MSECRET=old-mmg\n"
            "\texport   AWS_SECRET_ACCESS_KEY=old-aws\n"
            "TWILIO_API_KEY_SECRET\n"
            "PGPASSWORD=old-pg\n"
            "MEILI_MASTER_KEY=old-meili\n"
            " SYSTEM_DATABASE_URL=postgresql://sys:old-sys@db/x\n"
            "  MMG_MKEY=old-mkey\n"          # [R4 R3-1] mixed Unicode whitespace
            "STRIPE_SECRET_KEY: old-stripe\n"         # [R4] a colon separator
            "exportOTP_HASH_SECRET=old-otp\n"         # [R4 R3-2] mangled export prefix
            "TWILIO_API_KEY_SECRET_FILE=/run/secrets/TWILIO_API_KEY_SECRET\n"
            "# JWT_SECRET=commented-out-example\n"
            "MYJWT_SECRET_NOTE=not-a-secret-name\n"
            "exportFOO=kept\n"
            "API_HOST=api.example.test\n"
        ).encode("utf-8"))
        env_file.chmod(0o600)
        result = self.run_gen(LC_ALL="C", LANG="C")  # the server's default locale, where a locale space class is ASCII-only
        self.assertEqual(result.returncode, 0, result.stderr)
        text = env_file.read_bytes().decode("utf-8")
        for gone in ("old-jwt", "old-smtp", "old-mmg", "old-aws", "old-pg", "old-meili", "old-sys", "old-mkey", "old-stripe", "old-otp",
                     "PGPASSWORD", "MEILI_MASTER_KEY", "SYSTEM_DATABASE_URL=", "﻿"):
            self.assertNotIn(gone, text)
        self.assertNotRegex(text, r"(?m)^TWILIO_API_KEY_SECRET$")
        for kept in ("PILOT_ENV=staging\n", "API_HOST=api.example.test\n",
                     "TWILIO_API_KEY_SECRET_FILE=/run/secrets/TWILIO_API_KEY_SECRET\n",
                     "# JWT_SECRET=commented-out-example\n", "MYJWT_SECRET_NOTE=not-a-secret-name\n", "exportFOO=kept\n"):
            self.assertIn(kept, text)
        self.assertIn("MASTER_KEK_ESCROW_FINGERPRINT=", text)
        self.assertIn("removed 11 secret line(s)", result.stdout)
        for v in ("old-jwt", "old-smtp", "old-mmg", "old-aws", "old-pg", "old-meili", "old-sys", "old-mkey", "old-stripe", "old-otp"):
            self.assertNotIn(v, result.stdout + result.stderr)

    def test_missing_mode_fills_only_the_absent_names_and_keeps_master_kek(self):
        # A host set up before a generated name existed gets the new ones only;
        # nothing stored is replaced, and no --force is needed.
        (self.shim_store / "MASTER_KEK").write_bytes(b"existing-kek")
        (self.shim_store / "JWT_SECRET").write_bytes(b"existing-jwt")
        (self.work / ".env").write_text("PILOT_ENV=staging\nMASTER_KEK_ESCROW_FINGERPRINT=recorded\n")
        (self.work / ".env").chmod(0o600)
        result = self.run_gen("--missing")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual((self.shim_store / "MASTER_KEK").read_bytes(), b"existing-kek")
        self.assertEqual((self.shim_store / "JWT_SECRET").read_bytes(), b"existing-jwt")
        self.assertEqual(sorted(p.name for p in self.shim_store.iterdir()), sorted(self.GENERATED))
        sets = [l for l in self.calls().splitlines() if l.startswith("swift-secrets set")]
        self.assertEqual(len(sets), len(self.GENERATED) - 2)
        self.assertNotIn("swift-secrets set MASTER_KEK", self.calls())
        # The recorded fingerprint belongs to the kept key and is left alone.
        self.assertIn("MASTER_KEK_ESCROW_FINGERPRINT=recorded\n", (self.work / ".env").read_text())
        self.assertIn("kept", result.stdout)
        self.assertIn("METRICS_TOKEN", result.stdout)

    def test_refuses_an_unreadable_allowlist_rather_than_guessing(self):
        (self.tmp / "apps" / "api" / "src" / "utils" / "secret-files.ts").unlink()
        (self.work / ".env").write_text("PILOT_ENV=staging\nJWT_SECRET=old\n")
        result = self.run_gen()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("allowlist", result.stderr)
        self.assertIn("JWT_SECRET=old", (self.work / ".env").read_text())  # untouched


class OwnerPromptTool(StoreHarness):
    """The owner's double-click tool: hidden input, stdin over SSH, names only."""

    def setUp(self):
        super().setUp()
        write_shim(self.bin, "ssh", FAKE_SSH)
        self.ssh_stdin = self.tmp / "ssh-stdin.log"
        self.key = self.tmp / "deploy_key"
        self.key.write_text("not a real key\n")
        self.key.chmod(0o600)
        self.tmpdir = self.tmp / "tmpdir"
        self.tmpdir.mkdir()

    def run_tool(self, args, stdin: str, **extra):
        env = self.env(SSH_STDIN_LOG=str(self.ssh_stdin), TMPDIR=str(self.tmpdir), HOME=str(self.tmp), **extra)
        return subprocess.run(
            ["bash", str(OWNER_TOOL), *args], input=stdin, env=env, text=True, capture_output=True, timeout=15,
        )

    def test_value_travels_on_stdin_only_and_stdout_says_only_saved(self):
        value = 'p@ss w"rd$`with\\odd chars'
        result = self.run_tool(["swift-deploy@staging.example.test", str(self.key), "JWT_SECRET"], f"{value}\n{value}\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "saved JWT_SECRET\n")
        self.assertNotIn(value, result.stderr)
        self.assertNotIn(value, self.calls())
        ssh_calls = [l for l in self.calls().splitlines() if l.startswith("ssh ")]
        self.assertTrue(any(l.endswith("sudo -n swift-secrets set JWT_SECRET") for l in ssh_calls), ssh_calls)
        for l in ssh_calls:
            self.assertIn("-i " + str(self.key), l)
            self.assertIn("swift-deploy@staging.example.test", l)
            self.assertIn("PasswordAuthentication=no", l)
        self.assertEqual(self.ssh_stdin.read_bytes(), b"<<" + value.encode() + b">>\n")
        self.assertEqual(list(self.tmpdir.iterdir()), [])

    def test_a_mismatched_confirmation_sends_nothing_until_it_matches(self):
        result = self.run_tool(["swift-deploy@h.example", str(self.key), "SMTP_PASS"], "first\nsecond\nagreed\nagreed\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "saved SMTP_PASS\n")
        self.assertEqual(self.ssh_stdin.read_bytes(), b"<<agreed>>\n")
        self.assertNotIn("first", self.calls())

    def test_an_invalid_name_or_target_is_refused_before_any_prompt(self):
        for args in (["swift-deploy@h.example", str(self.key), "jwt-secret"],
                     ["swift-deploy@h.example", str(self.key), "JWT_SECRET_FILE"],
                     ["not a target", str(self.key), "JWT_SECRET"],
                     ["swift-deploy@h.example", str(self.tmp / "missing-key"), "JWT_SECRET"]):
            with self.subTest(args=args):
                result = self.run_tool(args, "value\nvalue\n")
                self.assertNotEqual(result.returncode, 0)
                self.assertEqual(result.stdout, "")
        self.assertFalse(self.ssh_stdin.exists())
        self.assertNotIn("swift-secrets set", self.calls())

    def test_names_can_be_entered_interactively_and_a_blank_name_ends_the_session(self):
        result = self.run_tool([], "swift-deploy@h.example\n" + str(self.key) + "\nMMG_MSECRET\nv1\nv1\nAWS_SECRET_ACCESS_KEY\nv2\nv2\n\n")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, "saved MMG_MSECRET\nsaved AWS_SECRET_ACCESS_KEY\n")
        self.assertEqual(self.ssh_stdin.read_bytes(), b"<<v1>>\n<<v2>>\n")

    def test_a_failed_transfer_is_reported_by_name_only(self):
        result = self.run_tool(["swift-deploy@h.example", str(self.key), "JWT_SECRET"], "distinct-entry-77\ndistinct-entry-77\n", SSH_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout, "")
        self.assertIn("JWT_SECRET", result.stderr)
        self.assertNotIn("distinct-entry-77", result.stderr)


class BackupCredentials(unittest.TestCase):
    def test_backup_takes_storage_keys_from_systemd_credentials_and_the_db_password_from_the_container_file(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            creds = tmp / "creds"
            creds.mkdir()
            (creds / "AWS_ACCESS_KEY_ID").write_text("AKIDFROMCREDS")
            (creds / "AWS_SECRET_ACCESS_KEY").write_text("secretfromcreds\n")
            dump_dir = tmp / "dumps"
            log = tmp / "calls"
            sh_shim(bin_dir, "docker", 'echo "docker $*" >> "$CALL_LOG"\ncase "$*" in *pg_dump*) printf "mock custom dump";; esac')
            sh_shim(bin_dir, "pg_restore", '[ "$1" = "--list" ]')
            sh_shim(bin_dir, "aws", 'echo "aws $* key=${AWS_ACCESS_KEY_ID:-unset} secret=$( [ -n "${AWS_SECRET_ACCESS_KEY:-}" ] && echo set || echo unset )" >> "$CALL_LOG"\ncase "$*" in *head-object*) printf "16\\n";; esac')
            env = os.environ.copy()
            for name in ("DATABASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"):
                env.pop(name, None)
            env.update({
                "PATH": f"{bin_dir}:{env['PATH']}",
                "CALL_LOG": str(log),
                "CREDENTIALS_DIRECTORY": str(creds),
                "BACKUP_BUCKET": "test-bucket",
                "BACKUP_REQUIRED": "1",
                "AWS_S3_ENDPOINT": "https://storage.example.invalid",
                "BACKUP_RETAIN_DAYS": "0",
            })
            result = subprocess.run(
                ["bash", str(DEPLOY / "backup.sh"), str(dump_dir)],
                env=env, text=True, capture_output=True, timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = log.read_text()
            self.assertIn("key=AKIDFROMCREDS secret=set", calls)
            dump_call = [l for l in calls.splitlines() if "pg_dump" in l][0]
            self.assertIn("POSTGRES_PASSWORD_FILE", dump_call)
            self.assertNotIn('PGPASSWORD="$POSTGRES_PASSWORD"', dump_call)
            self.assertNotIn("secretfromcreds", result.stdout + result.stderr)

    def test_backup_never_reads_storage_keys_from_the_env_file(self):
        backup = (DEPLOY / "backup.sh").read_text()
        env_fallback = re.search(r"for var in ([^;]*); do\n\s*if \[ -z \"\$\{!var:-\}\" \]; then export \"\$var=\$\(env_value", backup)
        self.assertIsNotNone(env_fallback, "the non-secret .env fallback loop must still exist")
        self.assertNotIn("AWS_ACCESS_KEY_ID", env_fallback.group(1))
        self.assertNotIn("AWS_SECRET_ACCESS_KEY", env_fallback.group(1))


class PilotUpSecretsPreflight(StoreHarness):
    """The preflight fragment refuses secrets in deploy/.env and unstored wired names."""

    ENV_OK = "PILOT_ENV=staging\nAPI_HOST=api.example.test\nBACKUP_BUCKET=b\nTWILIO_API_KEY_SECRET_FILE=/run/secrets/TWILIO_API_KEY_SECRET\n"

    def setUp(self):
        super().setUp()
        self.work = self.tmp / "deploy"
        self.work.mkdir()
        shutil.copy(DEPLOY / "docker-compose.yml", self.work / "docker-compose.yml")
        shutil.copy(DEPLOY / "secret-names.sh", self.work / "secret-names.sh")
        (self.tmp / "apps" / "api" / "src" / "utils").mkdir(parents=True)
        shutil.copy(DEPLOY.parent / "apps" / "api" / "src" / "utils" / "secret-files.ts",
                    self.tmp / "apps" / "api" / "src" / "utils" / "secret-files.ts")
        self.listed = self.tmp / "listed"
        self.listed.write_text("")
        sh_shim(self.bin, "swift-secrets", 'echo "swift-secrets $*" >> "$CALL_LOG"; [ "$1" = list ] && cat "$LISTED"; exit 0')
        sh_shim(self.bin, "sudo", 'echo "sudo $*" >> "$CALL_LOG"; [ "$1" = "-n" ] && shift; exec "$@"')
        sh_shim(self.bin, "systemctl", 'echo "systemctl $*" >> "$CALL_LOG"; exit "${SYSTEMCTL_STATUS:-0}"')
        source = (DEPLOY / "pilot-up.sh").read_text()
        begin = source.index("# ── secrets store checks (begin)")
        end = source.index("# ── secrets store checks (end)")
        self.fragment = source[begin:end]

    def run_fragment(self, env_text: str, listed: str, **extra):
        (self.work / ".env").write_bytes(env_text.encode("utf-8"))
        self.listed.write_text(listed)
        shell = 'set -euo pipefail\ndie() { echo "FATAL: $*" >&2; exit 1; }\n' \
                'env_value() { grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true; }\n' \
                f'HERE="{self.work}"\nROOT="{self.tmp}"\n'
        return subprocess.run(
            ["bash", "-c", shell + self.fragment], env=self.env(LISTED=str(self.listed), **extra),
            text=True, capture_output=True, timeout=15,
        )

    ALL_WIRED = ("POSTGRES_PASSWORD\nMEILISEARCH_KEY\nJWT_SECRET\nOTP_HASH_SECRET\nMASTER_KEK\nSTORAGE_SIGNING_SECRET\n"
                 "CONSENT_IP_PEPPER\nTEST_CONTROL_SECRET\nMETRICS_TOKEN\nHEALTH_DETAIL_TOKEN\nATTRIB_SALT\nIDENTITY_SALT\n"
                 "SCAN_IP_SALT\nADS_EVENT_SECRET\nTWILIO_API_KEY_SECRET\nAWS_ACCESS_KEY_ID\nAWS_SECRET_ACCESS_KEY\n"
                 "SYSTEM_DATABASE_URL\n")

    def test_passes_when_env_is_clean_and_every_wired_secret_is_stored(self):
        result = self.run_fragment(self.ENV_OK, self.ALL_WIRED)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("systemctl restart swift-secrets.service", self.calls())

    def test_refuses_a_secret_declared_in_the_env_file(self):
        # [R2 F1] Every spelling Compose's env-file parser loads: bare, empty,
        # indented, `export`-prefixed, a bare pass-through name, the newly
        # allowlisted names, and the consumer aliases the images read.
        cases = ("JWT_SECRET=abc", "POSTGRES_PASSWORD=", "AWS_SECRET_ACCESS_KEY=x", "MMG_MSECRET=y",
                 "export TWILIO_API_KEY_SECRET=abc", "  SMTP_PASS=abc", "\tMMG_PASSWORD=abc",
                 "export   METRICS_TOKEN=abc", "  export\tJWT_SECRET =abc", "STRIPE_SECRET_KEY",
                 "SENTRY_DSN=https://abc@host/1", "SWIFT_BOOTSTRAP_PASSWORD=abc", "GOOGLE_MAPS_API_KEY_BACKEND=abc",
                 "PGPASSWORD=abc", "MEILI_MASTER_KEY=abc", "SYSTEM_DATABASE_URL=postgresql://x:abc@h/d",
                 # [R3 R2-B] Compose skips U+00A0 (NBSP) and U+0085 (NEL) before a key.
                 " TWILIO_API_KEY_SECRET=abc", "\u0085JWT_SECRET=abc", "\u0085export MMG_MSECRET=abc",
                 # [R4 R3-1] ...and every other Unicode White_Space character, mixed at will
                 # (probed against Docker Compose v2.40.3: each of these loads the key).
                 "  JWT_SECRET=abc", "  SMTP_PASS=abc", " MMG_MKEY=abc", "　JWT_SECRET=abc",
                 " AWS_SECRET_ACCESS_KEY=abc", "    JWT_SECRET=abc", "\t\x0b\x0cSTRIPE_SECRET_KEY=abc",
                 # [R4 R3-3] a UTF-8 BOM at the very start of the file (this case is written as line 1).
                 "﻿JWT_SECRET=abc",
                 # [R4] a colon is a separator to Compose (probed: `JWT_SECRET: abc` loads JWT_SECRET),
                 # trailing NBSP before the separator is trimmed, and `export ` may be followed by NBSP.
                 "JWT_SECRET: abc", "MMG_MSECRET:abc", "JWT_SECRET =abc", "export  SMTP_PASS=abc",
                 # [R4 R3-2] `export` glued to the name loads the VALUE under a garbage key — still
                 # plaintext in the container config — so it is refused as a mangled declaration.
                 "exportJWT_SECRET=abc", "export SMTP_PASS=abc", "  export SMTP_PASS=abc",
                 "export MMG_MKEY=abc")
        # The matcher must not depend on the host locale: the server default is
        # C.UTF-8 / C, where a locale space class does not cover those bytes.
        for locale in ("C", "en_US.UTF-8", "POSIX"):
            for line in cases:
                with self.subTest(line=line, locale=locale):
                    text = (line + "\n" + self.ENV_OK) if line.startswith("﻿") else (self.ENV_OK + line + "\n")
                    result = self.run_fragment(text, self.ALL_WIRED, LC_ALL=locale, LANG=locale)
                    self.assertNotEqual(result.returncode, 0, f"{line!r} under LC_ALL={locale}")
                    name = re.sub(r"^[\s \u0085 -     　 ﻿]*(export[\s \u0085 ]*)?", "", line)
                    name = re.split(r"[=:\s ]", name)[0]
                    self.assertIn(name, result.stderr)
                    self.assertNotIn("abc", result.stderr)
                    self.assertIn("swift-secrets", result.stderr)

    def test_allows_wiring_lines_comments_and_other_names(self):
        # Lines Compose loads under their OWN, non-secret name, lines it ignores,
        # and lines it refuses outright (fail closed at `compose config`), none
        # of which declares an allowlisted name. Probed against Docker Compose
        # v2.40.3: a later-line BOM, an interior ASCII space, an uppercase
        # EXPORT and an EM SPACE before `=` all fail the whole file; `:` alone
        # declares the empty key; `exportFOO=` is the key exportFOO.
        cases = ("JWT_SECRET_FILE=/run/secrets/JWT_SECRET", "# JWT_SECRET=example", "  # export JWT_SECRET=example",
                 " # JWT_SECRET=example", " # JWT_SECRET=example", "MYJWT_SECRET_NOTE=1",
                 "JWT_SECRET_ROTATED_AT=2026-09-23", "TWILIO_API_KEY_SID=SKabc",
                 "SYSTEM_DATABASE_URL_FILE=/run/secrets/SYSTEM_DATABASE_URL",
                 "MMG_API_URL=https://api.example.test/x", "OSRM_URL=http://osrm:5000",
                 ":", ": x", "PILOT_ENV_2=staging\n﻿JWT_SECRET=abc", "exportFOO=1", "exportED_JWT_SECRET_NOTE=1",
                 "EXPORT JWT_SECRET=abc", "JWT SECRET=abc", "JWT_SECRET =abc")
        for line in cases:
            for locale in ("C", "en_US.UTF-8"):
                with self.subTest(line=line, locale=locale):
                    result = self.run_fragment(self.ENV_OK + line + "\n", self.ALL_WIRED, LC_ALL=locale, LANG=locale)
                    self.assertEqual(result.returncode, 0, f"{line!r} under LC_ALL={locale}: {result.stderr}")

    def test_the_env_file_has_one_reader_that_works_on_bytes(self):
        # The helper is the single reader of the env file for both scripts; it
        # runs in python3 over bytes and never consults the host locale. A
        # file whose first line carries a BOM but declares no secret passes.
        source = (DEPLOY / "secret-names.sh").read_text()
        code = "\n".join(l for l in source.split("\n") if not l.strip().startswith("#"))
        self.assertIn("python3 -", code)
        self.assertNotIn("[[:space:]]", code)
        self.assertNotIn("LC_ALL", code)
        for locale in ("C", "en_US.UTF-8"):
            result = self.run_fragment("﻿PILOT_ENV=staging\nAPI_HOST=api.example.test\nBACKUP_BUCKET=b\n", self.ALL_WIRED,
                                       LC_ALL=locale, LANG=locale)
            self.assertEqual(result.returncode, 0, result.stderr)

    def test_the_first_declared_name_is_reported_and_no_value_ever_is(self):
        result = self.run_fragment(self.ENV_OK + " MMG_MKEY=first-value\nJWT_SECRET: second-value\n", self.ALL_WIRED)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MMG_MKEY is declared in deploy/.env", result.stderr)
        self.assertNotIn("first-value", result.stderr + result.stdout)
        self.assertNotIn("second-value", result.stderr + result.stdout)

    def test_refuses_a_wired_secret_that_is_not_in_the_store(self):
        missing_core = self.ALL_WIRED.replace("MASTER_KEK\n", "")
        result = self.run_fragment(self.ENV_OK, missing_core)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MASTER_KEK", result.stderr)
        missing_optional = self.ALL_WIRED.replace("TWILIO_API_KEY_SECRET\n", "")
        result = self.run_fragment(self.ENV_OK, missing_optional)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("TWILIO_API_KEY_SECRET", result.stderr)

    def test_refuses_when_materialize_fails(self):
        result = self.run_fragment(self.ENV_OK, self.ALL_WIRED, SYSTEMCTL_STATUS="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("swift-secrets.service", result.stderr)

    def test_warns_but_continues_without_backup_storage_keys(self):
        result = self.run_fragment(self.ENV_OK, self.ALL_WIRED.replace("AWS_ACCESS_KEY_ID\nAWS_SECRET_ACCESS_KEY\n", ""))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("AWS_SECRET_ACCESS_KEY", result.stderr)


class DeployShStoreGate(StoreHarness):
    """[R2 F5] The local convenience wrapper is honest about needing the Linux store."""

    REQUIRED = "POSTGRES_PASSWORD\nMEILISEARCH_KEY\nJWT_SECRET\nOTP_HASH_SECRET\nMASTER_KEK\nSTORAGE_SIGNING_SECRET\nCONSENT_IP_PEPPER\n"

    def setUp(self):
        super().setUp()
        self.listed = self.tmp / "listed"
        self.listed.write_text("")
        sh_shim(self.bin, "swift-secrets", '[ "$1" = list ] && cat "$LISTED"; exit 0')
        sh_shim(self.bin, "uname", 'echo "${FAKE_UNAME:-Linux}"')
        source = (DEPLOY / "deploy.sh").read_text()
        begin = source.index("# ── secrets store check (begin)")
        end = source.index("# ── secrets store check (end)")
        self.fragment = source[begin:end]

    def run_gate(self, action: str, listed: str, **extra):
        self.listed.write_text(listed)
        shell = "set -euo pipefail\nset -- " + action + "\n"
        return subprocess.run(
            ["bash", "-c", shell + self.fragment], cwd=DEPLOY, env=self.env(LISTED=str(self.listed), **extra),
            text=True, capture_output=True, timeout=15,
        )

    def test_linux_with_the_store_passes(self):
        result = self.run_gate("up", self.REQUIRED)
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_linux_without_a_required_secret_refuses_by_name(self):
        result = self.run_gate("up", self.REQUIRED.replace("MASTER_KEK\n", ""))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("MASTER_KEK", result.stderr)
        self.assertIn("gen-secrets.sh", result.stderr)

    def test_macos_refuses_with_an_explanation_instead_of_failing_later(self):
        result = self.run_gate("up", self.REQUIRED, FAKE_UNAME="Darwin")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Linux", result.stderr)
        self.assertIn("SWIFT_DEV_NO_STORE=1", result.stderr)

    def test_explicit_dev_fallback_skips_the_store_with_a_loud_warning(self):
        result = self.run_gate("up", "", FAKE_UNAME="Darwin", SWIFT_DEV_NO_STORE="1")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("WARNING", result.stderr)
        self.assertIn("never", result.stderr)

    def test_stopping_the_stack_needs_no_store_on_any_os(self):
        for action in ("down", "nuke", "logs"):
            with self.subTest(action=action):
                result = self.run_gate(action, "", FAKE_UNAME="Darwin")
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
