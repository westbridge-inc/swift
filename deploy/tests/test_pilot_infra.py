"""Service-free contracts for the staging pilot deployment scripts."""

import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path


DEPLOY = Path(__file__).resolve().parents[1]


def service_block(path: Path, service: str) -> str:
    text = path.read_text()
    match = re.search(rf"(?m)^  {re.escape(service)}:\n(.*?)(?=^  [\w-]+:|^volumes:|^networks:|\Z)", text, re.S | re.M)
    if not match:
        raise AssertionError(f"{service} missing in {path.name}")
    return match.group(1)


class PilotInfraContract(unittest.TestCase):
    def test_only_proxy_publishes_ports(self):
        app = DEPLOY / "docker-compose.yml"
        routing = DEPLOY / "docker-compose.routing.yml"
        for name in ("postgres", "redis", "meilisearch", "api", "worker"):
            self.assertNotRegex(service_block(app, name), r"(?m)^    ports:", name)
        for name in ("osrm", "vroom", "photon", "nominatim"):
            self.assertNotRegex(service_block(routing, name), r"(?m)^    ports:", name)
        proxy = service_block(app, "caddy")
        self.assertIn('"80:80"', proxy)
        self.assertIn('"443:443"', proxy)

    def test_backup_timer_requires_offsite(self):
        unit = (DEPLOY / "swift-backup.service").read_text()
        self.assertIn("BACKUP_REQUIRED=1", unit)

    def test_backup_succeeds_without_host_database_url(self):
        with tempfile.TemporaryDirectory() as tmp:
            tmp = Path(tmp)
            bin_dir = tmp / "bin"
            bin_dir.mkdir()
            dump_dir = tmp / "dumps"
            log = tmp / "calls"
            for name, body in {
                # The AWS CLI now runs inside a pinned container (STG-B), so
                # the docker shim stands in for `docker compose exec` (pg_dump)
                # AND `docker run` (aws s3 cp / s3api head-object).
                "docker": '#!/bin/sh\necho "docker $*" >> "$CALL_LOG"\ncase "$*" in *pg_dump*) printf "mock custom dump";; *head-object*) printf "16\\n";; esac\n',
                "pg_restore": '#!/bin/sh\n[ "$1" = "--list" ]\n',
            }.items():
                path = bin_dir / name
                path.write_text(body)
                path.chmod(0o755)
            env = os.environ.copy()
            env.pop("DATABASE_URL", None)
            env.update({
                "PATH": f"{bin_dir}:{env['PATH']}",
                "CALL_LOG": str(log),
                "BACKUP_BUCKET": "test-bucket",
                "BACKUP_REQUIRED": "1",
                "AWS_ACCESS_KEY_ID": "test",
                "AWS_SECRET_ACCESS_KEY": "test",
                "AWS_CLI_IMAGE": "amazon/aws-cli:2.29.12@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                "AWS_S3_ENDPOINT": "https://storage.example.invalid",
                "BACKUP_RETAIN_DAYS": "0",
            })
            result = subprocess.run(
                ["bash", str(DEPLOY / "backup.sh"), str(dump_dir)],
                env=env, text=True, capture_output=True, timeout=15,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            calls = log.read_text()
            self.assertIn("pg_dump", calls)
            self.assertIn("s3 cp", calls)
            self.assertEqual(len(list(dump_dir.glob("swift-*.dump"))), 1)

    def test_required_offsite_backup_rejects_missing_bucket(self):
        env = os.environ.copy()
        env.pop("BACKUP_BUCKET", None)
        env["BACKUP_REQUIRED"] = "1"
        result = subprocess.run(
            ["bash", str(DEPLOY / "backup.sh")],
            env=env, text=True, capture_output=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BACKUP_BUCKET", result.stderr)

    def test_restore_refuses_live_database_even_with_override(self):
        with tempfile.TemporaryDirectory() as tmp:
            dump = Path(tmp) / "sample.dump"
            dump.write_bytes(b"not a real archive")
            result = subprocess.run(
                ["bash", str(DEPLOY / "restore.sh"), str(dump), "swift"],
                env={**os.environ, "ALLOW_EXISTING": "1"},
                text=True, capture_output=True, timeout=5,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("may not be the live database", result.stderr)

    def test_pilot_up_rejects_non_commit_revision(self):
        script = DEPLOY / "pilot-up.sh"
        result = subprocess.run(
            ["bash", str(script), "main"],
            env={**os.environ, "PILOT_ENV": "staging"},
            text=True, capture_output=True, timeout=5,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, r"(?i)(full|sha|commit)")

    def test_operator_checks_use_private_compose_services(self):
        doctor = (DEPLOY / "doctor.sh").read_text()
        deploy = (DEPLOY / "deploy.sh").read_text()
        self.assertNotIn("swift-postgres", doctor)
        self.assertIn("ps -q postgres", doctor)
        self.assertNotIn('localhost:${API_PORT}', deploy)
        self.assertIn("/ready", deploy)

    def test_generated_database_password_is_url_safe(self):
        generator = (DEPLOY / "gen-secrets.sh").read_text()
        self.assertIn('POSTGRES_PASSWORD=$(openssl rand -hex 32)', generator)

    def test_backup_rejects_shared_document_bucket(self):
        backup = (DEPLOY / "backup.sh").read_text()
        self.assertIn('BACKUP_BUCKET must differ from AWS_S3_BUCKET', backup)

    def test_existing_swap_does_not_create_bogus_fstab_entry(self):
        provision = (DEPLOY / "provision-ubuntu.sh").read_text()
        self.assertIn('if [ -f "$SWAPFILE" ] && swapon --noheadings --show=NAME', provision)

    def test_pilot_refuses_old_revision_with_public_ports(self):
        pilot = (DEPLOY / "pilot-up.sh").read_text()
        self.assertIn("verify_private_ports", pilot)

    def test_readiness_checks_this_hosts_proxy(self):
        pilot = (DEPLOY / "pilot-up.sh").read_text()
        self.assertIn('--resolve "$API_HOST:443:127.0.0.1"', pilot)

    def test_preflight_does_not_overstate_upload_verification(self):
        preflight = (DEPLOY / "preflight.ts").read_text()
        self.assertNotIn("byte-for-byte", preflight)

    def test_root_ssh_effective_configuration_is_checked(self):
        provision = (DEPLOY / "provision-ubuntu.sh").read_text()
        self.assertIn('user=root,host=localhost,addr=127.0.0.1', provision)

    def test_provision_installs_ssh_tools_before_key_validation(self):
        provision = (DEPLOY / "provision-ubuntu.sh").read_text()
        self.assertLess(provision.index("apt-get install -y"), provision.index("ssh-keygen -lf"))


if __name__ == "__main__":
    unittest.main()
