"""[Row 312 · scanner deployment] The upload malware scanner (ClamAV clamd) in the deploy stack.

The API streams the PLAINTEXT of ID documents and selfies to clamd over plain TCP, so the scanner
lives on the private Docker network only (no published port, no Caddy route), pinned by exact tag
AND digest, with its signatures on a persistent volume kept fresh by freshclam, a healthcheck that
passes only once the signatures are loaded, and a memory ceiling with room for a signature reload.
The API and the worker are wired to it by NAME and wait for it; pilot-up.sh starts it, proves an
EICAR test string is refused through the API's own gate, and only then stops the running API.
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


DEPLOY = Path(__file__).resolve().parents[1]
COMPOSE = DEPLOY / "docker-compose.yml"
PILOT_UP = DEPLOY / "pilot-up.sh"
PINNED = re.compile(r"^clamav/clamav:(\d+\.\d+\.\d+)@sha256:[0-9a-f]{64}$")
# The EICAR anti-virus test string (harmless by design), assembled here so this file is not itself
# flagged by a scanner on a developer's machine.
EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$" + "EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*"


def service_block(path: Path, service: str) -> str:
    text = path.read_text()
    match = re.search(rf"(?m)^  {re.escape(service)}:\n(.*?)(?=^  [\w-]+:|^volumes:|^networks:|\Z)", text, re.S | re.M)
    if not match:
        raise AssertionError(f"{service} missing in {path.name}")
    return match.group(1)


def mem_mib(value: str) -> int:
    number, unit = re.fullmatch(r"(\d+)([mg])", value.strip().lower()).groups()
    return int(number) * (1024 if unit == "g" else 1)


def render(env_text: str = "", files=("docker-compose.yml",)):
    """`docker compose config --format json` of the real files (client-side; no daemon state)."""
    with tempfile.TemporaryDirectory() as tmp:
        here = Path(tmp) / "deploy"
        here.mkdir()
        for name in set(files) | {"docker-compose.yml"}:
            shutil.copy(DEPLOY / name, here / name)
        (here / ".env").write_text("NODE_ENV=production\nPILOT_ENV=staging\nAPI_HOST=api-staging.example.invalid\n" + env_text)
        args = ["docker", "compose", "--project-directory", str(here)]
        for name in files:
            args += ["-f", str(here / name)]
        result = subprocess.run(args + ["config", "--format", "json"], text=True, capture_output=True, timeout=60,
                                env={k: v for k, v in os.environ.items() if k not in ("MALWARE_SCAN", "NODE_ENV")})
        if result.returncode != 0 and "unknown" in result.stderr.lower():
            raise unittest.SkipTest(f"docker compose cannot render here: {result.stderr.strip()[:120]}")
        if result.returncode != 0:
            raise AssertionError(result.stderr[:400])
        return json.loads(result.stdout)


class ClamdServiceContract(unittest.TestCase):
    def test_pinned_by_exact_tag_and_digest(self):
        image = re.search(r"(?m)^    image: (\S+)$", service_block(COMPOSE, "clamd")).group(1)
        self.assertRegex(image, PINNED)

    def test_private_network_only_no_port_no_route(self):
        block = service_block(COMPOSE, "clamd")
        self.assertNotRegex(block, r"(?m)^    (ports|expose):")
        self.assertRegex(block, r"(?m)^    networks: \[private\]$")
        # Caddy, the only public entrance, never proxies to the scanner.
        self.assertNotIn("clamd", (DEPLOY / "Caddyfile").read_text())

    def test_reads_no_secret_and_no_settings_file(self):
        block = service_block(COMPOSE, "clamd")
        self.assertNotIn("/run/secrets", block)
        self.assertNotIn("env_file", block)

    def test_signatures_persist_and_stay_fresh(self):
        block = service_block(COMPOSE, "clamd")
        self.assertRegex(block, r"(?m)^      - swift-clamdb:/var/lib/clamav$")
        self.assertRegex(COMPOSE.read_text(), r"(?m)^  swift-clamdb:$")
        checks = int(re.search(r'FRESHCLAM_CHECKS: "(\d+)"', block).group(1))
        # More than daily, never more than hourly (the mirror's rate limit).
        self.assertTrue(2 <= checks <= 24, checks)
        self.assertNotIn("CLAMAV_NO_FRESHCLAMD", block)

    def test_healthcheck_passes_only_with_signatures_loaded(self):
        block = service_block(COMPOSE, "clamd")
        health = block[block.index("    healthcheck:"):]
        self.assertIn("PING", health)
        self.assertIn("PONG", health)
        # VERSION names the loaded daily database (ClamAV x.y.z/<daily>/<date>) only once it is loaded.
        self.assertIn("VERSION", health)
        self.assertIn("start_period:", health)

    def test_memory_ceiling_leaves_room_for_a_signature_reload(self):
        # Measured with 1.4.6 (21 Oct 2026): ~950 MiB with the signatures loaded, ~2.0 GiB at the
        # peak of a concurrent reload (old and new engine both in memory).
        limit = mem_mib(re.search(r"(?m)^    mem_limit: (\S+)$", service_block(COMPOSE, "clamd")).group(1))
        self.assertGreaterEqual(limit, 2304)
        self.assertLessEqual(limit, 3072)

    def test_api_and_worker_are_wired_by_name_and_wait_for_it(self):
        for name in ("api", "worker"):
            block = service_block(COMPOSE, name)
            self.assertRegex(block, r"(?m)^      MALWARE_SCAN: \$\{MALWARE_SCAN:-clamd\}$", name)
            self.assertRegex(block, r"(?m)^      CLAMD_HOST: clamd$", name)
            self.assertRegex(block, r'(?m)^      CLAMD_PORT: "3310"$', name)
            self.assertRegex(block, r"(?m)^      clamd:\n        condition: service_healthy$", name)

    def test_ci_pulls_the_same_pinned_image(self):
        image = re.search(r"(?m)^    image: (\S+)$", service_block(COMPOSE, "clamd")).group(1)
        ci = (DEPLOY.parent / ".github" / "workflows" / "ci.yml").read_text()
        self.assertIn(f"docker pull {image}", ci)

    def test_rehearsal_copy_scanner_stays_inside_and_never_updates(self):
        # The copy's network has no route out: its own clamd uses the image's signatures and never
        # tries the mirror; it publishes nothing.
        block = service_block(DEPLOY / "docker-compose.rehearsal.yml", "clamd")
        self.assertIn('CLAMAV_NO_FRESHCLAMD: "true"', block)
        self.assertNotIn("ports", block)


@unittest.skipUnless(shutil.which("docker"), "Docker CLI not installed")
class ClamdRenderedByCompose(unittest.TestCase):
    def test_rendered_stack(self):
        model = render()
        services = model["services"]
        clamd = services["clamd"]
        self.assertRegex(clamd["image"], PINNED)
        self.assertNotIn("ports", clamd)
        self.assertEqual(sorted(clamd["networks"]), ["private"])
        self.assertIn("test", clamd["healthcheck"])
        for name in ("api", "worker"):
            env = services[name]["environment"]
            self.assertEqual(env["MALWARE_SCAN"], "clamd", name)
            self.assertEqual(env["CLAMD_HOST"], "clamd", name)
            self.assertEqual(services[name]["depends_on"]["clamd"]["condition"], "service_healthy", name)
        # deploy/.env can take the gate dark (an operator decision, refused on production by pilot-up).
        dark = render("MALWARE_SCAN=off\n")
        self.assertEqual(dark["services"]["api"]["environment"]["MALWARE_SCAN"], "off")

    def test_rehearsal_renders_its_own_internal_scanner(self):
        model = render(files=("docker-compose.yml", "docker-compose.rehearsal.yml"))
        clamd = model["services"]["clamd"]
        self.assertEqual(clamd["environment"]["CLAMAV_NO_FRESHCLAMD"], "true")
        self.assertNotIn("ports", clamd)
        self.assertTrue(model["networks"]["private"].get("internal"))


class PilotUpOrdersTheScanner(unittest.TestCase):
    def setUp(self):
        self.text = PILOT_UP.read_text()

    def test_pulls_the_pinned_scanner(self):
        self.assertRegex(self.text, r'(?m)^"\$\{COMPOSE\[@\]\}" pull postgres redis meilisearch clamd caddy$')

    def test_scanner_healthy_and_proven_before_the_running_api_stops(self):
        up = self.text.index('"${COMPOSE[@]}" up -d --wait --wait-timeout 900 clamd')
        proof = self.text.index("SCANNER_PROOF")
        stop = self.text.index('"${COMPOSE[@]}" stop api worker')
        start = self.text.index('"${COMPOSE[@]}" up -d --no-deps --force-recreate api worker')
        self.assertLess(up, proof)
        self.assertLess(proof, stop)
        self.assertLess(stop, start)
        # The data-only stage starts no API and needs no scanner.
        self.assertRegex(self.text[up - 200:up], r'if \[ "\$DATA_ONLY" -eq 0 \]; then')

    def test_proof_uses_the_api_image_on_the_private_network(self):
        proof = self.text[self.text.index("SCANNER_PROOF"):]
        proof = proof[:proof.index("\nfi\n")]
        self.assertIn('--network swift-pilot-private --entrypoint node "swift-api:$SHA"', proof)
        self.assertIn("UPLOAD_REJECTED", proof)
        self.assertIn("dist/lib/malware-scan.js", proof)

    def test_production_refuses_a_dark_scanner(self):
        fragment = self.text[self.text.index("# [Row 312] MALWARE_SCAN"):]
        fragment = fragment[:fragment.index("\n  esac\n") + len("\n  esac\n")]
        for value, refused in (("", False), ("clamd", False), ("off", True), ("0", True), ("CLAMD", True)):
            with tempfile.TemporaryDirectory() as tmp:
                script = f'set -euo pipefail\ndie() {{ echo "REFUSED: $*" >&2; exit 1; }}\nenv_setting() {{ printf %s "$VALUE"; }}\n{fragment}\necho PASSED\n'
                result = subprocess.run(["bash", "-c", script], env={**os.environ, "VALUE": value}, text=True, capture_output=True, timeout=20)
                if refused:
                    self.assertNotEqual(result.returncode, 0, value)
                    self.assertIn("MALWARE_SCAN", result.stderr)
                else:
                    self.assertEqual(result.returncode, 0, (value, result.stderr))


class OtherScriptsKnowTheScanner(unittest.TestCase):
    def test_deploy_update_starts_the_scanner_before_the_api(self):
        text = (DEPLOY / "deploy.sh").read_text()
        update = text[text.index("  update)"):]
        self.assertLess(update.index("docker compose up -d --wait clamd"), update.index("docker compose stop api worker"))

    def test_doctor_reports_the_scanner(self):
        text = (DEPLOY / "doctor.sh").read_text()
        self.assertIn("for c in postgres redis clamd; do", text)
        self.assertIn("malware scanner", text)
        self.assertIn('"malwareScanner"', text)


def docker_daemon() -> bool:
    if not shutil.which("docker"):
        return False
    return subprocess.run(["docker", "info"], capture_output=True, timeout=30).returncode == 0


@unittest.skipUnless(docker_daemon(), "no Docker daemon here")
class EicarThroughTheRealScanner(unittest.TestCase):
    """The rendered clamd service, started under a throwaway project on an INTERNAL network with no
    published port: healthy only with signatures, refuses the EICAR test string, passes clean bytes.
    Runs when the pinned image is on this machine (CI pulls it), or with SWIFT_CLAMD_PULL=1."""

    def test_eicar_refused_clean_passes_nothing_published(self):
        model = render()
        image = model["services"]["clamd"]["image"]
        have = subprocess.run(["docker", "image", "inspect", image], capture_output=True, timeout=60).returncode == 0
        if not have and os.environ.get("SWIFT_CLAMD_PULL") != "1":
            self.skipTest("the pinned clamd image is not on this machine (set SWIFT_CLAMD_PULL=1 to pull it)")
        project = f"swift-clamd-test-{uuid.uuid4().hex[:8]}"
        service = dict(model["services"]["clamd"])
        service["environment"] = {**service.get("environment", {}), "CLAMAV_NO_FRESHCLAMD": "true"}
        service["networks"] = ["scan"]
        service["volumes"] = []
        service.pop("restart", None)
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
                self.assertEqual(subprocess.run(["docker", "port", cid], text=True, capture_output=True).stdout.strip(), "")
                network = f"{project}_scan"

                def scan(payload: str):
                    conf = "TCPSocket 3310\nTCPAddr clamd\n"
                    return subprocess.run(
                        ["docker", "run", "--rm", "-i", "--platform", "linux/amd64", "--network", network, "--entrypoint", "sh", image, "-c",
                         f"printf '{conf}' > /tmp/c.conf && clamdscan --config-file=/tmp/c.conf --stream --no-summary -"],
                        input=payload, text=True, capture_output=True, timeout=180)

                found = scan(EICAR)
                self.assertEqual(found.returncode, 1, found.stdout + found.stderr)
                self.assertIn("FOUND", found.stdout)
                clean = scan("an ordinary harmless file\n")
                self.assertEqual(clean.returncode, 0, clean.stdout + clean.stderr)
                self.assertIn("OK", clean.stdout)
            finally:
                subprocess.run(base + ["down", "-v", "--remove-orphans"], capture_output=True, timeout=180)


if __name__ == "__main__":
    unittest.main()
