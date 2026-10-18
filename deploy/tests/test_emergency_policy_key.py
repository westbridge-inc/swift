"""[AUD-G7-023] The emergency-policy signing key is created ON the host.

Runs the real owner tool (deploy/owner/emergency-policy-key.command) against
shims: `ssh` executes the remote command locally (a stand-in host), `sudo`
drops `-n`, and `swift-secrets` keeps names in a directory. The real openssl
draws the value. Proves: the value is generated on the "host" and goes only
into the store; it is never an argument, never sent from the Mac, never
printed; an existing key is never replaced. Nothing here needs root, a
network, Docker or systemd.

    python3 -m unittest discover -s deploy/tests -v
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY = Path(__file__).resolve().parents[1]
TOOL = DEPLOY / "owner" / "emergency-policy-key.command"
NAME = "EMERGENCY_POLICY_SIGNING_KEY"

# Fake ssh: records argv and the bytes it got on stdin; `-n true` is the
# connectivity probe; anything else runs the remote command on this machine.
FAKE_SSH = r'''#!/usr/bin/env python3
import os, subprocess, sys
argv = sys.argv[1:]
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("ssh " + " ".join(argv) + "\n")
if os.environ.get("SSH_FAIL"):
    sys.exit(255)
i, no_stdin = 0, False
while i < len(argv):
    a = argv[i]
    if a in ("-i", "-o"):
        i += 2; continue
    if a == "-n":
        no_stdin = True; i += 1; continue
    break
remote = argv[i + 1:]
if remote[:1] == ["-n"]:
    no_stdin, remote = True, remote[1:]
data = b"" if no_stdin else sys.stdin.buffer.read()
with open(os.environ["SSH_STDIN_LOG"], "ab") as f:
    f.write(data)
if remote == ["true"]:
    sys.exit(0)
sys.exit(subprocess.run(remote, input=data).returncode)
'''

FAKE_STORE = r'''#!/bin/sh
echo "swift-secrets $*" >> "$CALL_LOG"
case "$1" in
  list) ls "$STORE_DIR" ;;
  set) [ $# -eq 2 ] || exit 9; cat > "$STORE_DIR/$2" ;;
  *) exit 8 ;;
esac
'''


class EmergencyPolicyKeyTool(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="ep-key-test-"))
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.store = self.tmp / "store"
        self.store.mkdir()
        self.calls = self.tmp / "calls.log"
        self.ssh_stdin = self.tmp / "ssh-stdin.log"
        for name, body in (("ssh", FAKE_SSH), ("swift-secrets", FAKE_STORE),
                           ("sudo", '#!/bin/sh\necho "sudo $*" >> "$CALL_LOG"\n[ "$1" = "-n" ] && shift\nexec "$@"\n')):
            p = self.bin / name
            p.write_text(body)
            p.chmod(0o755)
        self.key = self.tmp / "id_test"
        self.key.write_text("not a real key\n")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def run_tool(self, **extra):
        env = {"PATH": f"{self.bin}:{os.environ['PATH']}", "CALL_LOG": str(self.calls),
               "SSH_STDIN_LOG": str(self.ssh_stdin), "STORE_DIR": str(self.store), "HOME": str(self.tmp), **extra}
        return subprocess.run(["bash", str(TOOL), "swift-deploy@host.example", str(self.key)],
                              env=env, text=True, capture_output=True, timeout=30)

    def test_generates_on_the_host_into_the_store_and_prints_no_value(self):
        result = self.run_tool()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(f"saved {NAME} on swift-deploy@host.example", result.stdout)
        value = (self.store / NAME).read_text()
        # 48 random bytes, base64 without padding or newline: 64 characters, over the API's 32 minimum.
        self.assertRegex(value, r"^[A-Za-z0-9+/]{64}$")
        everything = result.stdout + result.stderr + self.calls.read_text() + self.ssh_stdin.read_bytes().decode()
        self.assertNotIn(value, everything)
        # The store was written through exactly one `set NAME` (the value on stdin, never in argv).
        sets = [l for l in self.calls.read_text().splitlines() if l.startswith("swift-secrets set")]
        self.assertEqual(sets, [f"swift-secrets set {NAME}"])
        # What crossed the ssh connection is the fixed host-side script: no value, no key material.
        sent = self.ssh_stdin.read_bytes().decode()
        self.assertIn("openssl rand -base64 48", sent)
        self.assertIn(f"sudo -n swift-secrets set {NAME}", sent)
        self.assertNotRegex(sent, r"[A-Za-z0-9+/]{40,}")

    def test_two_hosts_get_two_different_keys(self):
        self.assertEqual(self.run_tool().returncode, 0)
        first = (self.store / NAME).read_text()
        (self.store / NAME).unlink()
        self.assertEqual(self.run_tool().returncode, 0)
        self.assertNotEqual((self.store / NAME).read_text(), first)

    def test_never_replaces_a_key_the_host_already_holds(self):
        (self.store / NAME).write_text("the-existing-key-the-phones-pinned-aaaaaaaaaa")
        result = self.run_tool()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("already holds", result.stderr)
        self.assertNotIn("saved", result.stdout)
        self.assertEqual((self.store / NAME).read_text(), "the-existing-key-the-phones-pinned-aaaaaaaaaa")
        self.assertNotIn("swift-secrets set", self.calls.read_text())

    def test_a_dead_connection_stores_nothing(self):
        result = self.run_tool(SSH_FAIL="1")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("cannot connect", result.stderr)
        self.assertEqual(list(self.store.iterdir()), [])

    def test_the_tool_never_echoes_or_spools_a_value(self):
        text = TOOL.read_text()
        code = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith("#"))
        self.assertNotRegex(code, r"\bread\s+[^\n]*-s")  # nothing secret is ever typed
        self.assertNotRegex(code, r"mktemp|> ?/tmp|\btee\b|echo\s+\"?\$value")
        self.assertTrue(os.access(TOOL, os.X_OK))
        self.assertTrue(re.search(r"openssl rand -base64 48 \| tr -d '\\n=' \| sudo -n swift-secrets set " + NAME, code))


if __name__ == "__main__":
    unittest.main()
