"""Service-free contracts for the staging journey override (TASK-057).

The journey suite needs an API that accepts the dev OTP code and answers
/test-control. That API must be PRIVATE: api-journeys and the one-shot runner
publish no port, sit only on swift-pilot-private and have no Caddy route, and
the public api never carries DEV_OTP_BYPASS or TEST_CONTROL_ENABLED.

These tests drive the real checker (deploy/verify-journeys-isolation.py) over
rendered-model fixtures, run pilot-up's verify_private_ports against a fake
`docker`, and read the Compose files as text. When a Docker CLI is present they
also render the real files with `docker compose config` (no daemon needed).
"""

import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY = Path(__file__).resolve().parents[1]
CHECKER = DEPLOY / "verify-journeys-isolation.py"
OVERRIDE = DEPLOY / "docker-compose.journeys.yml"
CADDYFILE = DEPLOY / "Caddyfile"
SENTINEL = "sentinel-value-never-printed"


def service_block(path: Path, service: str) -> str:
    text = path.read_text()
    match = re.search(rf"(?m)^  {re.escape(service)}:\n(.*?)(?=^  [\w-]+:|^volumes:|^networks:|\Z)", text, re.S | re.M)
    if not match:
        raise AssertionError(f"{service} missing in {path.name}")
    return match.group(1)


def rendered_model():
    """The shape `docker compose config --format json` renders for base + override."""
    image = "swift-api:journeys-fixture"
    public_env = {"NODE_ENV": "loadtest", "PORT": "3000", "RUN_WORKERS": "0", "POSTGRES_PASSWORD": SENTINEL}
    net = {"private": None}
    return {
        "name": "swift",
        "networks": {"private": {"name": "swift-pilot-private", "external": True}},
        "services": {
            "postgres": {"image": "postgis/postgis:16-3.4", "networks": net},
            "redis": {"image": "redis:7-alpine", "networks": net},
            "api": {"image": image, "environment": dict(public_env), "networks": net},
            "worker": {"image": image, "environment": {**public_env, "RUN_WORKERS": "1"}, "networks": net},
            "caddy": {
                "image": "caddy:2.10",
                "networks": net,
                "ports": [
                    {"mode": "ingress", "target": 80, "published": "80", "protocol": "tcp"},
                    {"mode": "ingress", "target": 443, "published": "443", "protocol": "tcp"},
                ],
            },
            "api-journeys": {
                "image": image,
                "profiles": ["journeys"],
                "environment": {
                    **public_env,
                    "DEV_OTP_BYPASS": "1",
                    "TEST_CONTROL_ENABLED": "1",
                    "TEST_CONTROL_SECRET_FILE": "/run/secrets/TEST_CONTROL_SECRET",
                    "NOTIFICATION_PROVIDER": "dev",
                    "EMAIL_PROVIDER": "dev",
                    "PUSH_PROVIDER": "dev",
                },
                "volumes": [{"type": "bind", "source": "/run/swift-secrets", "target": "/run/secrets", "read_only": True}],
                "networks": net,
            },
            "journeys": {
                "image": image,
                "profiles": ["journeys"],
                "environment": {
                    "LIVETEST_BASE_URL": "http://api-journeys:3000",
                    "LIVETEST_PUBLIC_HOST": "api-staging.example.invalid",
                    "LIVETEST_ADMIN_PHONE": "",
                    "LIVETEST_RUN_ID": "",
                    "LIVETEST_OUT_DIR": "/results",
                },
                "volumes": [
                    {"type": "bind", "source": "/opt/swift/scripts/livetest", "target": "/app/scripts/livetest", "read_only": True},
                    {"type": "bind", "source": "/home/swift-deploy/swift-journeys/run", "target": "/results"},
                ],
                "read_only": True,
                "networks": net,
            },
        },
    }


def check(model, *flags, caddyfile=None):
    with tempfile.NamedTemporaryFile("w", suffix="Caddyfile", delete=False) as fh:
        fh.write(caddyfile if caddyfile is not None else CADDYFILE.read_text())
        path = fh.name
    try:
        return subprocess.run(
            ["python3", str(CHECKER), path, *flags],
            input=json.dumps(model), text=True, capture_output=True, timeout=10,
        )
    finally:
        os.unlink(path)


class JourneysIsolationChecker(unittest.TestCase):
    def assert_refused(self, model, fragment, *flags, caddyfile=None):
        result = check(model, *flags, caddyfile=caddyfile)
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn(fragment, result.stderr)
        # The rendered model inlines deploy/.env: a refusal names, never prints, values.
        self.assertNotIn(SENTINEL, result.stdout + result.stderr)

    def test_the_intended_model_passes(self):
        result = check(rendered_model(), "--require-journeys")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("private, portless", result.stdout)

    def test_a_public_only_model_passes_unless_journeys_are_required(self):
        model = rendered_model()
        for name in ("api-journeys", "journeys"):
            del model["services"][name]
        self.assertEqual(check(model).returncode, 0)
        self.assert_refused(model, "api-journeys is missing", "--require-journeys")

    def test_refuses_a_published_port_on_either_journey_service(self):
        for name in ("api-journeys", "journeys"):
            model = rendered_model()
            model["services"][name]["ports"] = [{"target": 3000, "published": "3001", "protocol": "tcp"}]
            self.assert_refused(model, f"{name} publishes a host port", "--require-journeys")

    def test_refuses_any_non_proxy_port_and_a_widened_proxy(self):
        model = rendered_model()
        model["services"]["api"]["ports"] = [{"target": 3000, "published": "3000", "protocol": "tcp"}]
        self.assert_refused(model, "api publishes a host port")
        model = rendered_model()
        model["services"]["caddy"]["ports"].append({"target": 2019, "published": "2019", "protocol": "tcp"})
        self.assert_refused(model, "caddy must publish exactly 80/tcp and 443/tcp")

    def test_refuses_a_second_network_or_the_host_network(self):
        model = rendered_model()
        model["networks"]["public"] = {"name": "swift-public"}
        model["services"]["api-journeys"]["networks"] = {"private": None, "public": None}
        self.assert_refused(model, "api-journeys must be attached to swift-pilot-private only", "--require-journeys")
        model = rendered_model()
        model["services"]["journeys"]["network_mode"] = "host"
        self.assert_refused(model, "journeys uses the host network", "--require-journeys")

    def test_refuses_a_non_external_private_network(self):
        model = rendered_model()
        model["networks"]["private"] = {"name": "swift-pilot-private"}
        self.assert_refused(model, "must be the external swift-pilot-private bridge", "--require-journeys")

    def test_the_public_api_never_carries_the_switches(self):
        for service in ("api", "worker"):
            for switch in ("DEV_OTP_BYPASS", "TEST_CONTROL_ENABLED"):
                model = rendered_model()
                model["services"][service]["environment"][switch] = "1"
                self.assert_refused(model, f"{service} carries {switch}")
        model = rendered_model()
        model["services"]["api"]["environment"]["DEV_OTP_BYPASS"] = "0"
        self.assertEqual(check(model, "--require-journeys").returncode, 0)

    def test_the_private_instance_is_the_public_image_in_loadtest(self):
        model = rendered_model()
        model["services"]["api-journeys"]["image"] = "swift-api:other"
        self.assert_refused(model, "exact image", "--require-journeys")
        model = rendered_model()
        model["services"]["api-journeys"]["environment"]["NODE_ENV"] = "production"
        self.assert_refused(model, "NODE_ENV=loadtest", "--require-journeys")
        model = rendered_model()
        model["services"]["api-journeys"]["environment"]["DEV_OTP_BYPASS"] = "0"
        self.assert_refused(model, "must set DEV_OTP_BYPASS=1", "--require-journeys")

    def test_the_private_instance_sends_nothing_out(self):
        for name, live in (("NOTIFICATION_PROVIDER", "twilio"), ("EMAIL_PROVIDER", "smtp"), ("PUSH_PROVIDER", "expo")):
            model = rendered_model()
            model["services"]["api-journeys"]["environment"][name] = live
            self.assert_refused(model, f"must pin {name}=dev", "--require-journeys")
            model = rendered_model()
            del model["services"]["api-journeys"]["environment"][name]
            self.assert_refused(model, f"must pin {name}=dev", "--require-journeys")

    def test_the_test_control_secret_is_a_file_never_a_value(self):
        model = rendered_model()
        model["services"]["api-journeys"]["environment"]["TEST_CONTROL_SECRET"] = SENTINEL
        self.assert_refused(model, "TEST_CONTROL_SECRET as a value", "--require-journeys")
        model = rendered_model()
        del model["services"]["api-journeys"]["environment"]["TEST_CONTROL_SECRET_FILE"]
        self.assert_refused(model, "TEST_CONTROL_SECRET_FILE", "--require-journeys")

    def test_the_runner_holds_no_secret_and_targets_only_the_private_instance(self):
        model = rendered_model()
        model["services"]["journeys"]["environment"]["EXTRA_SETTING"] = SENTINEL
        self.assert_refused(model, "LIVETEST_* settings only", "--require-journeys")
        model = rendered_model()
        model["services"]["journeys"]["environment"]["LIVETEST_BASE_URL"] = "https://api-staging.example.invalid"
        self.assert_refused(model, "must target http://api-journeys:<port>", "--require-journeys")
        model = rendered_model()
        model["services"]["journeys"]["volumes"].append({"type": "bind", "source": "/run/swift-secrets", "target": "/run/secrets"})
        self.assert_refused(model, "mounts the secret directory", "--require-journeys")
        model = rendered_model()
        model["services"]["journeys"]["volumes"].append({"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"})
        self.assert_refused(model, "Docker socket", "--require-journeys")
        model = rendered_model()
        model["services"]["journeys"]["privileged"] = True
        self.assert_refused(model, "journeys is privileged", "--require-journeys")

    def test_no_caddy_route_reaches_a_journey_service(self):
        routed = CADDYFILE.read_text().replace("reverse_proxy api:3000", "reverse_proxy api-journeys:3000")
        self.assert_refused(rendered_model(), "routes to a journey service", "--require-journeys", caddyfile=routed)

    def test_unreadable_input_is_a_refusal(self):
        result = subprocess.run(["python3", str(CHECKER), str(CADDYFILE)], input="not json", text=True, capture_output=True, timeout=10)
        self.assertEqual(result.returncode, 1)
        self.assertIn("unreadable input", result.stderr)


class PilotUpRefusesAnUnsafeOverride(unittest.TestCase):
    """verify_private_ports, extracted from pilot-up.sh and run against a fake `docker`."""

    def run_verify(self, base_model, journeys_model, with_override=True):
        source = (DEPLOY / "pilot-up.sh").read_text()
        body = source[source.index("verify_private_ports() {"):source.index("\nverify_private_ports\n")]
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            here = tmp / "deploy"
            here.mkdir()
            shutil.copy(CHECKER, here / CHECKER.name)
            shutil.copy(CADDYFILE, here / "Caddyfile")
            if with_override:
                (here / "docker-compose.journeys.yml").write_text("# fixture\n")
            (tmp / "base.json").write_text(json.dumps(base_model))
            (tmp / "journeys.json").write_text(json.dumps(journeys_model))
            routing = {"services": {"osrm": {"image": "osrm"}}}
            (tmp / "routing.json").write_text(json.dumps(routing))
            fake = tmp / "docker"
            fake.write_text(
                "#!/bin/sh\n"
                f'case "$*" in *docker-compose.journeys.yml*) cat "{tmp}/journeys.json";;\n'
                f'  *docker-compose.routing.yml*) cat "{tmp}/routing.json";;\n'
                f'  *) cat "{tmp}/base.json";; esac\n'
            )
            fake.chmod(0o755)
            script = (
                "set -euo pipefail\n"
                f'HERE="{here}"\n'
                'COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")\n'
                'ROUTING=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.routing.yml")\n'
                'die() { echo "FATAL: $*" >&2; exit 1; }\n'
                f"{body}\nverify_private_ports\necho VERIFIED\n"
            )
            env = {**os.environ, "PATH": f"{tmp}:{os.environ['PATH']}"}
            return subprocess.run(["bash", "-c", script], env=env, text=True, capture_output=True, timeout=20)

    def public_only(self):
        model = rendered_model()
        for name in ("api-journeys", "journeys"):
            del model["services"][name]
        return model

    def test_a_clean_stack_and_override_pass(self):
        result = self.run_verify(self.public_only(), rendered_model())
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("VERIFIED", result.stdout)

    def test_an_override_service_with_a_port_is_refused(self):
        for name in ("api-journeys", "journeys"):
            journeys = rendered_model()
            journeys["services"][name]["ports"] = [{"target": 3000, "published": "8080", "protocol": "tcp"}]
            result = self.run_verify(self.public_only(), journeys)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("journeys override isolation failed", result.stderr)

    def test_a_public_api_with_the_bypass_is_refused_even_without_the_override(self):
        base = self.public_only()
        base["services"]["api"]["environment"]["DEV_OTP_BYPASS"] = "1"
        result = self.run_verify(base, rendered_model(), with_override=False)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("public API isolation failed", result.stderr)


class JourneysComposeText(unittest.TestCase):
    def test_override_services_publish_nothing_and_stay_private(self):
        for name in ("api-journeys", "journeys"):
            block = service_block(OVERRIDE, name)
            self.assertNotRegex(block, r"(?m)^    (ports|expose|network_mode|privileged):", name)
            self.assertIn("networks: [private]", block, name)
            self.assertIn("profiles: [journeys]", block, name)
            self.assertIn('restart: "no"', block, name)

    def test_private_instance_extends_the_public_api(self):
        block = service_block(OVERRIDE, "api-journeys")
        self.assertRegex(block, r"extends:\n\s+file: docker-compose\.yml\n\s+service: api\n")
        self.assertIn('DEV_OTP_BYPASS: "1"', block)
        self.assertIn('TEST_CONTROL_ENABLED: "1"', block)
        self.assertIn("TEST_CONTROL_SECRET_FILE: /run/secrets/TEST_CONTROL_SECRET", block)
        self.assertNotRegex(OVERRIDE.read_text(), r"(?m)^\s+TEST_CONTROL_SECRET:")
        for name in ("NOTIFICATION_PROVIDER", "EMAIL_PROVIDER", "PUSH_PROVIDER"):
            self.assertIn(f"{name}: dev", block, name)

    def test_runner_targets_the_private_instance_and_holds_no_secret(self):
        block = service_block(OVERRIDE, "journeys")
        self.assertIn("LIVETEST_BASE_URL: http://api-journeys:3000", block)
        self.assertNotIn("env_file", block)
        self.assertNotIn("/run/secrets", block)
        self.assertIn("../scripts/livetest:/app/scripts/livetest:ro", block)
        self.assertIn("read_only: true", block)

    def test_public_services_never_declare_the_switches(self):
        base = DEPLOY / "docker-compose.yml"
        for name in ("api", "worker", "migrate", "caddy"):
            block = service_block(base, name)
            self.assertNotIn("DEV_OTP_BYPASS", block, name)
            self.assertNotIn("TEST_CONTROL_ENABLED", block, name)
        self.assertNotIn("journeys", CADDYFILE.read_text())

    def test_run_script_proves_the_public_route_and_removes_the_private_instance(self):
        script = (DEPLOY / "journeys-run.sh").read_text()
        self.assertIn('[ "$(id -u)" -ne 0 ]', script)
        self.assertIn("PILOT_ENV=staging", script)
        self.assertIn("NODE_ENV=loadtest", script)
        self.assertIn("/api/v1/test-control/identity", script)
        self.assertIn('"INVALID_OTP"', script)
        self.assertIn("--require-journeys", script)
        self.assertIn("up -d --no-deps --no-build --pull never api-journeys", script)
        self.assertIn("rm --stop --force api-journeys", script)
        self.assertIn("trap cleanup EXIT", script)
        self.assertIn('docker port "$PRIVATE_ID"', script)


@unittest.skipUnless(shutil.which("docker"), "Docker CLI not installed")
class RenderedByCompose(unittest.TestCase):
    """The real files, rendered by `docker compose config` (client-side; no daemon)."""

    def test_real_files_render_and_pass(self):
        with tempfile.TemporaryDirectory() as tmp:
            here = Path(tmp) / "deploy"
            here.mkdir()
            for name in ("docker-compose.yml", "docker-compose.journeys.yml", "Caddyfile"):
                shutil.copy(DEPLOY / name, here / name)
            # A throwaway settings file: names only matter here, never values.
            (here / ".env").write_text(
                "NODE_ENV=loadtest\nPILOT_ENV=staging\nAPI_HOST=api-staging.example.invalid\n"
                f"POSTGRES_PASSWORD={SENTINEL}\nMEILISEARCH_KEY={SENTINEL}\n"
            )
            render = subprocess.run(
                ["docker", "compose", "--project-directory", str(here), "-f", str(here / "docker-compose.yml"),
                 "-f", str(here / "docker-compose.journeys.yml"), "--profile", "journeys", "config", "--format", "json"],
                text=True, capture_output=True, timeout=60,
            )
            if render.returncode != 0 and "unknown" in render.stderr.lower():
                self.skipTest(f"docker compose cannot render here: {render.stderr.strip()[:120]}")
            self.assertEqual(render.returncode, 0, render.stderr[:400])
            model = json.loads(render.stdout)
            result = check(model, "--require-journeys")
            self.assertEqual(result.returncode, 0, result.stderr)
            private, runner = model["services"]["api-journeys"], model["services"]["journeys"]
            self.assertNotIn("ports", private)
            self.assertNotIn("ports", runner)
            self.assertEqual(private["image"], model["services"]["api"]["image"])
            self.assertNotIn("DEV_OTP_BYPASS", model["services"]["api"]["environment"])
            self.assertNotIn("TEST_CONTROL_ENABLED", model["services"]["api"]["environment"])
            for name in ("NOTIFICATION_PROVIDER", "EMAIL_PROVIDER", "PUSH_PROVIDER"):
                self.assertEqual(private["environment"].get(name), "dev", name)


if __name__ == "__main__":
    unittest.main()
