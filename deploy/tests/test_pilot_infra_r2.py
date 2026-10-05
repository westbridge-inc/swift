"""Offline process regressions for staging migration and firewall cutovers."""

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY = Path(__file__).resolve().parents[1]


def fragment(path: Path, start: str, end: str) -> str:
    source = path.read_text()
    first = source.index(start)
    return source[first:source.index(end, first)]


class PilotInfraR2Contract(unittest.TestCase):
    def run_migration(self, script: str, mode: str):
        if script == "pilot-up.sh":
            body = fragment(
                DEPLOY / script,
                '"${COMPOSE[@]}" stop api worker',
                'for _ in $(seq 1 90); do',
            )
        else:
            body = fragment(
                DEPLOY / script,
                '    docker compose stop api worker',
                '    wait_ready\n',
            )

        with tempfile.TemporaryDirectory() as tmp:
            calls = Path(tmp) / "calls"
            polls = Path(tmp) / "polls"
            polls.write_text("0")
            shell = r'''set -euo pipefail
COMPOSE=(docker compose)
die() { echo "REFUSED: $*" >&2; exit 1; }
sleep() { :; }
docker() {
  if [[ "$1" = compose ]]; then
    if [[ " $* " == *" ps -a -q migrate "* ]]; then echo migration-id; fi
    if [[ " $* " == *" up -d --no-deps "* ]]; then echo "STARTED: $*" >> "$CALLS"; fi
    return 0
  fi
  if [[ "$1" != inspect ]]; then return 1; fi
  local format="$3" count state code
  count="$(cat "$POLLS")"
  if [[ "$format" == *State.Status* ]]; then
    count=$((count + 1))
    echo "$count" > "$POLLS"
  fi
  case "$MODE" in
    immediate_failure) state=exited; code=1 ;;
    late_failure) if (( count <= 120 )); then state=running; else state=exited; fi; code=1 ;;
    timeout) state=running; code=0 ;;
    success) if (( count == 1 )); then state=running; else state=exited; fi; code=0 ;;
  esac
  if [[ "$format" == *State.ExitCode* ]]; then echo EXITCODE_CHECKED >> "$CALLS"; fi
  if [[ "$format" == *State.Status* && "$format" == *State.ExitCode* ]]; then
    echo "$state $code"
  elif [[ "$format" == *State.Status* ]]; then
    echo "$state"
  else
    echo "$code"
  fi
}
'''
            env = {**os.environ, "MODE": mode, "CALLS": str(calls),
                   "POLLS": str(polls), "HERE": str(DEPLOY)}
            result = subprocess.run(
                ["bash", "-c", shell + body], cwd=DEPLOY, env=env,
                text=True, capture_output=True, timeout=10,
            )
            return result, calls.read_text() if calls.exists() else "", int(polls.read_text())

    def test_no_service_restarts_until_migration_exits_zero(self):
        for script in ("pilot-up.sh", "deploy.sh"):
            for mode in ("immediate_failure", "late_failure", "timeout", "success"):
                with self.subTest(script=script, mode=mode):
                    result, calls, polls = self.run_migration(script, mode)
                    if mode == "success":
                        self.assertEqual(result.returncode, 0, result.stderr)
                        self.assertIn("STARTED:", calls)
                        self.assertIn("EXITCODE_CHECKED", calls)
                    else:
                        self.assertNotEqual(result.returncode, 0, f"{script} {mode}: {calls}")
                        self.assertNotIn("STARTED:", calls)
                    self.assertGreaterEqual(polls, 1)

    def run_firewall(self, active: str, stored: str, fail_command: str = ""):
        body = fragment(
            DEPLOY / "provision-ubuntu.sh",
            "# Do not remove unknown firewall rules automatically.",
            "ufw default deny incoming",
        )
        with tempfile.TemporaryDirectory() as tmp:
            active_file = Path(tmp) / "active"
            stored_file = Path(tmp) / "stored"
            active_file.write_text(active)
            stored_file.write_text(stored)
            shell = r'''set -euo pipefail
die() { echo "REFUSED: $*" >&2; exit 1; }
ufw() {
  if [[ "$*" = "$FAIL_COMMAND" ]]; then return 1; fi
  case "$*" in
    status) cat "$ACTIVE_FILE" ;;
    'show added') cat "$STORED_FILE" ;;
    *) return 1 ;;
  esac
}
'''
            return subprocess.run(
                ["bash", "-c", shell + body], cwd=DEPLOY,
                env={**os.environ, "ACTIVE_FILE": str(active_file),
                     "STORED_FILE": str(stored_file), "FAIL_COMMAND": fail_command},
                text=True, capture_output=True, timeout=10,
            )

    def test_firewall_reviews_active_and_inactive_stored_permits(self):
        allowed = """Status: active

To                         Action      From
--                         ------      ----
22/tcp                     ALLOW       Anywhere
80/tcp (v6)                ALLOW       Anywhere (v6)
443/tcp                    LIMIT       Anywhere
"""
        stored = """Added user rules (see 'ufw status' for running firewall):
ufw allow 22/tcp
ufw allow 80/tcp
ufw limit 443/tcp
"""
        cases = (
            ("allowed_dual_stack", allowed, stored, "", True),
            ("extra_ipv4", allowed + "5432/tcp ALLOW Anywhere\n", stored, "", False),
            ("extra_ipv6", allowed + "5432/tcp (v6) ALLOW Anywhere (v6)\n", stored, "", False),
            ("extra_limit", allowed + "5432/tcp LIMIT Anywhere\n", stored, "", False),
            ("inactive_stored_extra", "Status: inactive\n", stored + "ufw allow 5432/tcp\n", "", False),
            ("inactive_stored_ipv6", "Status: inactive\n", stored + "ufw allow 5432/tcp (v6)\n", "", False),
            ("stored_route_allow", allowed, stored + "ufw route allow 5432/tcp\n", "", False),
            ("unreadable_active", allowed, stored, "status", False),
            ("unreadable_stored", allowed, stored, "show added", False),
        )
        for name, active, added, failure, expected_success in cases:
            with self.subTest(name=name):
                result = self.run_firewall(active, added, failure)
                if expected_success:
                    self.assertEqual(result.returncode, 0, result.stderr)
                else:
                    self.assertNotEqual(result.returncode, 0, name)


if __name__ == "__main__":
    unittest.main()
