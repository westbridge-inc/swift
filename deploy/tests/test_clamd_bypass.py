"""[Row 312 · COORD ruling 21 Oct] The scanner's emergency bypass and its self-restart.

- MALWARE_SCAN_BYPASS reaches the API and the worker by name only (deploy/.env, empty = off);
  production accepts only unset, 0 or 1; every deploy, the doctor and the preflight shout while it
  is 1.
- clamd is the scanner container's main process: a SHUTDOWN sent by anything on the private
  network ends the container and Docker restarts it, instead of leaving a live container with a
  dead scanner (the review's residual: every container on the network can reach clamd).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path

from test_clamd_scanner import COMPOSE, DEPLOY, PILOT_UP, docker_daemon, render, service_block


def fragment(text: str, start: str, end: str) -> str:
    first = text.index(start)
    return text[first:text.index(end, first) + len(end)]


class BypassWiring(unittest.TestCase):
    def test_api_and_worker_read_the_switch_by_name_only(self):
        for name in ("api", "worker"):
            self.assertRegex(service_block(COMPOSE, name), r"(?m)^      MALWARE_SCAN_BYPASS: \$\{MALWARE_SCAN_BYPASS:-\}$", name)

    @unittest.skipUnless(shutil.which("docker"), "Docker CLI not installed")
    def test_rendered_off_by_default_on_only_from_deploy_env(self):
        self.assertEqual(render()["services"]["api"]["environment"]["MALWARE_SCAN_BYPASS"], "")
        on = render("MALWARE_SCAN_BYPASS=1\n")["services"]
        self.assertEqual(on["api"]["environment"]["MALWARE_SCAN_BYPASS"], "1")
        self.assertEqual(on["worker"]["environment"]["MALWARE_SCAN_BYPASS"], "1")

    def test_production_accepts_only_unset_0_or_1(self):
        text = PILOT_UP.read_text()
        case = fragment(text, '  case "$(env_setting MALWARE_SCAN_BYPASS)" in', "\n  esac\n")
        for value, refused in (("", False), ("0", False), ("1", False), ("yes", True), ("true", True), ("2", True), ("on", True)):
            script = f'set -euo pipefail\ndie() {{ echo "REFUSED: $*" >&2; exit 1; }}\nenv_setting() {{ printf %s "$VALUE"; }}\n{case}\necho PASSED\n'
            result = subprocess.run(["bash", "-c", script], env={**os.environ, "VALUE": value}, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode != 0, refused, (value, result.stderr))

    def test_every_deploy_shouts_while_it_is_on(self):
        text = PILOT_UP.read_text()
        shout = fragment(text, "# [COORD 21 Oct] MALWARE_SCAN_BYPASS_SHOUT", "\nfi\n")
        for value, loud in (("1", True), ("", False), ("0", False)):
            script = f'set -euo pipefail\nenv_setting() {{ printf %s "$VALUE"; }}\n{shout}'
            result = subprocess.run(["bash", "-c", script], env={**os.environ, "VALUE": value}, text=True, capture_output=True, timeout=20)
            self.assertEqual(result.returncode, 0)
            self.assertEqual("EMERGENCY BYPASS IS ON" in result.stderr, loud, value)

    def test_the_doctor_fails_while_it_is_on(self):
        text = (DEPLOY / "doctor.sh").read_text()
        helper = fragment(text, "env_line() {", "}\n")
        block = fragment(text, '# [COORD 21 Oct] The upload malware scan emergency bypass shouts while it is set.', "\nfi\n")
        for env_text, failed in (("MALWARE_SCAN_BYPASS=1\n", True), ("MALWARE_SCAN_BYPASS=\n", False), ("", False)):
            with tempfile.TemporaryDirectory() as tmp:
                Path(tmp, ".env").write_text(env_text)
                script = f'HERE="{tmp}"\nbad() {{ echo "FAIL $1"; }}\n{helper}{block}'
                result = subprocess.run(["bash", "-c", script], text=True, capture_output=True, timeout=20)
                self.assertEqual("EMERGENCY BYPASS IS ON" in result.stdout, failed, env_text)
        self.assertIn('"malwareScanBypass":true', text)

    def test_the_preflight_shouts_while_it_is_on(self):
        text = (DEPLOY / "preflight.ts").read_text()
        self.assertIn("fileEnv['MALWARE_SCAN_BYPASS'] === '1'", text)
        self.assertIn("THE EMERGENCY BYPASS IS ON", text)


class TheBypassSetIsPinned(unittest.TestCase):
    """[Security finding 2, COORD 21 Oct] The bypass covers EXACTLY what the code says, and every
    operator-facing text names exactly that set: never the profile picture (avatar), and never the
    evidence (it is never refused anyway, bypass or not)."""

    PHRASE = "liveness selfies, onboarding documents and vehicle photos"
    CODE = DEPLOY.parent / "apps" / "api" / "src" / "lib" / "malware-scan.ts"

    def test_the_code_set(self):
        text = self.CODE.read_text()
        body = re.search(r"export const BYPASS_SURFACES[^=]*=\s*new Set<UploadSurface>\(\[([^\]]*)\]\)", text).group(1)
        self.assertEqual(sorted(re.findall(r"'([a-z-]+)'", body)), ["liveness", "vehicle-photo", "verification"])

    def test_every_operator_text_names_exactly_that_set(self):
        texts = {
            "pilot-up warning": fragment(PILOT_UP.read_text(), "# [COORD 21 Oct] MALWARE_SCAN_BYPASS_SHOUT", "\nfi\n"),
            "doctor": fragment((DEPLOY / "doctor.sh").read_text(), "# [COORD 21 Oct] The upload malware scan emergency bypass shouts while it is set.", "\nfi\n"),
            "preflight": fragment((DEPLOY / "preflight.ts").read_text(), "if (fileEnv['MALWARE_SCAN_BYPASS'] === '1') {", "} else if"),
            "runbook": " ".join(fragment((DEPLOY / "PILOT-RUNBOOK.md").read_text(), "`MALWARE_SCAN_BYPASS=1` in deploy/.env", "Never a profile picture.").split()),
            "env example": " ".join(fragment((DEPLOY / ".env.deploy.example").read_text(), "# Emergency only (production): MALWARE_SCAN_BYPASS=1", "# MALWARE_SCAN_BYPASS=").replace("#", " ").split()),
            "compose": " ".join(fragment(COMPOSE.read_text(), "# [COORD 21 Oct] The production emergency switch", "MALWARE_SCAN_BYPASS: ").replace("#", " ").split()),
        }
        for name, text in texts.items():
            flat = " ".join(text.split())
            self.assertIn(self.PHRASE, flat, name)
            for wrong in ("avatar", "profile photo", "handover proof", "delivery proof", "courier"):
                self.assertNotIn(wrong, flat.lower().replace("never a profile picture", ""), (name, wrong))


class ClamdIsTheMainProcess(unittest.TestCase):
    def test_command_execs_clamd_and_freshclam_runs_beside_it(self):
        block = service_block(COMPOSE, "clamd")
        command = block[block.index("    command:"):block.index("    environment:")]
        self.assertIn("exec clamd --foreground", command)
        self.assertIn('"$${CLAMAV_NO_FRESHCLAMD:-false}" != true', command)
        self.assertIn("freshclam", command)
        self.assertRegex(block, r"(?m)^    restart: unless-stopped$")


@unittest.skipUnless(docker_daemon(), "no Docker daemon here")
class ShutdownRestartsTheScanner(unittest.TestCase):
    """The rendered clamd service on a throwaway internal network: a SHUTDOWN from another container
    ends it, Docker restarts it, and it is healthy (signatures loaded) again."""

    def test_shutdown_from_the_network_is_a_restart_not_an_outage(self):
        model = render()
        image = model["services"]["clamd"]["image"]
        have = subprocess.run(["docker", "image", "inspect", image], capture_output=True, timeout=60).returncode == 0
        if not have and os.environ.get("SWIFT_CLAMD_PULL") != "1":
            self.skipTest("the pinned clamd image is not on this machine (set SWIFT_CLAMD_PULL=1 to pull it)")
        project = f"swift-clamd-restart-{uuid.uuid4().hex[:8]}"
        service = dict(model["services"]["clamd"])
        service["environment"] = {**service.get("environment", {}), "CLAMAV_NO_FRESHCLAMD": "true"}
        service["networks"] = ["scan"]
        service["volumes"] = []
        service["platform"] = "linux/amd64"
        stack = {"name": project, "services": {"clamd": service}, "networks": {"scan": {"internal": True}}}
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "compose.json"
            path.write_text(json.dumps(stack))
            base = ["docker", "compose", "-p", project, "-f", str(path)]
            try:
                up = subprocess.run(base + ["up", "-d", "--wait", "--wait-timeout", "600"], text=True, capture_output=True, timeout=700)
                self.assertEqual(up.returncode, 0, up.stderr[-600:])
                cid = subprocess.run(base + ["ps", "-q", "clamd"], text=True, capture_output=True).stdout.strip()
                shutdown = subprocess.run(
                    ["docker", "run", "--rm", "--platform", "linux/amd64", "--network", f"{project}_scan", "--entrypoint", "sh", image, "-c",
                     "printf 'zSHUTDOWN\\0' | nc clamd 3310; true"], text=True, capture_output=True, timeout=120)
                self.assertEqual(shutdown.returncode, 0, shutdown.stderr)
                restarted = healthy = False
                for _ in range(120):
                    state = subprocess.run(["docker", "inspect", "-f", "{{.RestartCount}} {{.State.Health.Status}}", cid], text=True, capture_output=True).stdout.split()
                    if state and int(state[0]) >= 1:
                        restarted = True
                        if len(state) > 1 and state[1] == "healthy":
                            healthy = True
                            break
                    subprocess.run(["sleep", "2"])
                self.assertTrue(restarted, "a SHUTDOWN left the container running with a dead scanner")
                self.assertTrue(healthy, "the restarted scanner never became healthy again")
            finally:
                subprocess.run(base + ["down", "-v", "--remove-orphans"], capture_output=True, timeout=180)


if __name__ == "__main__":
    unittest.main()
