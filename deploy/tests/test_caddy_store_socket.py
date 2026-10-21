"""[PERF row 8] The website's store socket goes through the production Caddyfile.

The partner dashboard opens the API's store socket at /api/v1/socket.io/ (a
WebSocket upgrade), so the browser sends its HttpOnly access cookie
(Path=/api/v1). This holds that the REAL Caddyfile, served by the stack's
pinned Caddy, hands that upgrade to the API unchanged: the path, the Upgrade,
the Origin the API checks and the cookie it reads all reach api:3000, and the
API's 101 comes back to the browser. A stand-in on :3000 inside the test
container plays the API and says what reached it (the cookie only as
present/absent).

    python3 -m unittest discover -s deploy/tests -v
"""

import base64
import re
import secrets
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_stg_ops import (API_HOST, DEPLOY, WEB_HOST, caddy_image_present, wait_for_test_caddy,
                          with_global_options)

# The same test-only options as the other live Caddy tests (local CA, no admin
# endpoint, no storage cleaning while the first certificates are issued).
LIVE_OPTIONS = "    local_certs\n    skip_install_trust\n    admin off\n    storage_clean_interval off\n"

# Plays the API: answers any request with a WebSocket 101 and says what it was sent.
STAND_IN = r"""#!/bin/sh
read -r method path version
upgrade=""; origin=""; cookie="absent"
while IFS= read -r line; do
  line=$(printf '%s' "$line" | tr -d '\r')
  [ -z "$line" ] && break
  case "$line" in
    [Uu]pgrade:*) upgrade=$(printf '%s' "${line#*:}" | tr -d ' ');;
    [Oo]rigin:*) origin=$(printf '%s' "${line#*:}" | tr -d ' ');;
    [Cc]ookie:*swift_at=*) cookie="present";;
  esac
done
printf 'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: stand-in\r\nX-Upstream-Method: %s\r\nX-Upstream-Path: %s\r\nX-Upstream-Upgrade: %s\r\nX-Upstream-Origin: %s\r\nX-Upstream-Cookie: %s\r\n\r\n' "$method" "$path" "$upgrade" "$origin" "$cookie"
sleep 2
"""


@unittest.skipUnless(caddy_image_present(), "docker or the caddy:2.10 image is not available locally")
class WebsiteStoreSocketThroughCaddy(unittest.TestCase):

    def serve(self) -> str:
        tmp = Path(tempfile.mkdtemp(prefix="swift-socket-caddy-test-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "Caddyfile").write_text(with_global_options((DEPLOY / "Caddyfile").read_text(), LIVE_OPTIONS))
        (tmp / "stand-in.sh").write_text(STAND_IN)
        (tmp / "stand-in.sh").chmod(0o755)
        name = f"swift-socket-caddy-test-{secrets.token_hex(4)}"
        args = ["docker", "run", "-d", "--name", name, "--network", "none"]
        for host in (API_HOST, WEB_HOST, "api"):
            args += ["--add-host", f"{host}:127.0.0.1"]
        args += ["-e", f"API_HOST={API_HOST}",
                 "-v", f"{tmp / 'Caddyfile'}:/etc/caddy/Caddyfile:ro",
                 "-v", f"{tmp / 'stand-in.sh'}:/stand-in.sh:ro", "caddy:2.10",
                 "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
        started = subprocess.run(args, text=True, capture_output=True, timeout=60)
        self.assertEqual(started.returncode, 0, started.stderr[-400:])
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", name], capture_output=True, timeout=60)
        listen = subprocess.run(["docker", "exec", "-d", name, "nc", "-lk", "-p", "3000", "-e", "/stand-in.sh"],
                                text=True, capture_output=True, timeout=30)
        self.assertEqual(listen.returncode, 0, listen.stderr[-400:])
        wait_for_test_caddy(self, name, lambda: self.status(name, f"https://{API_HOST}/metrics") == 403)
        return name

    @staticmethod
    def status(name: str, url: str) -> int:
        out = subprocess.run(["docker", "exec", name, "sh", "-c", f"curl -sk -o /dev/null -w '%{{http_code}}' '{url}'"],
                             text=True, capture_output=True, timeout=30).stdout.strip()
        return int(out) if out.isdigit() else 0

    @staticmethod
    def upgrade(name: str, url: str) -> str:
        """The response head a browser's WebSocket upgrade gets (made inside the container)."""
        nonce = base64.b64encode(secrets.token_bytes(16)).decode()  # a fresh handshake nonce, as a browser makes
        command = ("curl -sk -i -N --http1.1 --max-time 3"
                   " -H 'Connection: Upgrade' -H 'Upgrade: websocket' -H 'Sec-WebSocket-Version: 13'"
                   f" -H 'Sec-WebSocket-Key: {nonce}'"
                   f" -H 'Origin: https://{WEB_HOST}' -H 'Cookie: swift_at=test-cookie'"
                   f" '{url}'; true")
        return subprocess.run(["docker", "exec", name, "sh", "-c", command],
                              text=True, capture_output=True, timeout=30).stdout.replace("\r", "")

    def test_live_the_websites_socket_upgrade_reaches_the_api_with_its_origin_and_cookie(self):
        name = self.serve()
        head = self.upgrade(name, f"https://{API_HOST}/api/v1/socket.io/?EIO=4&transport=websocket")
        self.assertRegex(head, r"^HTTP/1\.1 101 ", head[-600:])
        self.assertIn("X-Upstream-Method: GET", head)
        self.assertIn("X-Upstream-Path: /api/v1/socket.io/?EIO=4&transport=websocket", head)
        self.assertIn("X-Upstream-Upgrade: websocket", head)
        self.assertIn(f"X-Upstream-Origin: https://{WEB_HOST}", head)
        self.assertIn("X-Upstream-Cookie: present", head)

    def test_live_the_phones_socket_path_is_forwarded_as_before(self):
        name = self.serve()
        head = self.upgrade(name, f"https://{API_HOST}/socket.io/?EIO=4&transport=websocket")
        self.assertRegex(head, r"^HTTP/1\.1 101 ", head[-600:])
        self.assertIn("X-Upstream-Path: /socket.io/?EIO=4&transport=websocket", head)

    def test_the_api_route_has_no_path_rule_in_front_of_the_socket(self):
        # Text contract beside the live test: the API host's handle is the
        # /metrics refusal and one plain reverse_proxy, so no path matcher can
        # catch /api/v1/socket.io/ before it reaches api:3000.
        text = (DEPLOY / "Caddyfile").read_text()
        block = re.search(r"    handle @api \{\n(.*?)\n    \}\n", text, re.S)
        self.assertIsNotNone(block)
        lines = [line.strip() for line in block.group(1).splitlines() if line.strip() and not line.strip().startswith("#")]
        self.assertEqual(lines, ["@metrics path /metrics", "respond @metrics 403", "reverse_proxy api:3000"])


if __name__ == "__main__":
    unittest.main()
