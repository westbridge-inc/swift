"""Regression contracts for the STG-OPS deploy fixes (STG-A/B/C/D + seed).

Offline and service-free: reads deploy files as text and runs the real bash
scripts against shims for docker/git/curl/sudo, exactly like the other deploy
test files. Nothing here needs root, a network, Docker or systemd.

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


def service_block(path: Path, service: str) -> str:
    text = path.read_text()
    match = re.search(rf"(?m)^  {re.escape(service)}:\n(.*?)(?=^  [\w-]+:|^volumes:|^networks:|\Z)", text, re.S | re.M)
    if not match:
        raise AssertionError(f"{service} missing in {path.name}")
    return match.group(1)


def sh_shim(bin_dir: Path, name: str, script: str) -> Path:
    path = bin_dir / name
    path.write_text("#!/bin/sh\n" + script + "\n")
    path.chmod(0o755)
    return path


class StgABackupUnitSecrets(unittest.TestCase):
    def test_backup_unit_unsets_every_credential_file_var(self):
        # [STG-A] deploy/.env wires the *_FILE container paths; the unit loads
        # deploy/.env, so those must be unset or secret-env.sh follows NAME_FILE
        # and never reaches the LoadCredentialEncrypted credentials.
        unit = (DEPLOY / "swift-backup.service").read_text()
        names = re.findall(r"^LoadCredentialEncrypted=([A-Z0-9_]+):", unit, re.M)
        self.assertTrue(names, "the unit must still declare its encrypted credentials")
        unset = "\n".join(
            line.split("=", 1)[1] for line in unit.splitlines() if line.startswith("UnsetEnvironment=")
        )
        self.assertTrue(unset, "the unit must contain an UnsetEnvironment= line")
        for name in names:
            self.assertIn(f"{name}_FILE", unset, f"{name}_FILE must be unset in the unit")

    def test_restore_runbook_transient_unit_unsets_the_same_file_vars(self):
        # The runbook's restore systemd-run must not let an operator's
        # environment (e.g. a sourced deploy/.env) shadow the credential
        # directory — the exact trap that broke swift-backup.service.
        runbook = (DEPLOY / "PILOT-RUNBOOK.md").read_text()
        fragment = runbook[runbook.index("systemd-run --pipe"):runbook.index("/opt/swift/deploy/restore.sh")]
        self.assertIn('UnsetEnvironment=AWS_ACCESS_KEY_ID_FILE AWS_SECRET_ACCESS_KEY_FILE', fragment)


class StgBAwsCliNeverASnap(unittest.TestCase):
    def test_backup_and_restore_never_resolve_aws_to_a_snap(self):
        # [STG-B] The snap-packaged CLI cannot start under the unit's
        # NoNewPrivileges=true. Every aws consumer now runs a pinned container
        # image instead, and the provisioner installs no snap at all.
        for name in ("backup.sh", "restore.sh", "provision-ubuntu.sh"):
            text = (DEPLOY / name).read_text()
            self.assertNotIn("snap install aws-cli", text, name)
            self.assertNotIn("/snap/bin/aws", text, name)
            self.assertNotIn("command -v aws", text, name)
        backup = (DEPLOY / "backup.sh").read_text()
        restore = (DEPLOY / "restore.sh").read_text()
        for text in (backup, restore):
            self.assertIn("docker run", text)
            self.assertIn("AWS_CLI_IMAGE", text)
        self.assertIn("NoNewPrivileges=true", (DEPLOY / "swift-backup.service").read_text())

    def test_preflight_asks_versioning_through_the_pinned_image_not_host_aws(self):
        # preflight.ts used to spawn the host `aws` for its bucket-versioning
        # probe; with no host CLI that check must ride the same pinned image.
        preflight = (DEPLOY / "preflight.ts").read_text()
        self.assertNotIn("spawnSync('aws'", preflight)
        self.assertIn("AWS_CLI_IMAGE", preflight)
        self.assertIn("spawnSync('docker'", preflight)
        # Same anchored digest gate as backup.sh/restore.sh (D3).
        self.assertRegex(preflight, r"@sha256:\[0-9a-f\]\{64\}\$")

    def run_backup(self, env_update):
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
            sh_shim(bin_dir, "docker", 'echo "docker $*" >> "$CALL_LOG"\ncase "$*" in *pg_dump*) printf "mock custom dump";; *head-object*) printf "16\\n";; esac')
            sh_shim(bin_dir, "pg_restore", '[ "$1" = "--list" ]')
            env = os.environ.copy()
            for name in ("DATABASE_URL", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_CLI_IMAGE"):
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
            env.update(env_update)
            result = subprocess.run(
                ["bash", str(DEPLOY / "backup.sh"), str(dump_dir)],
                env=env, text=True, capture_output=True, timeout=15,
            )
            return result, (log.read_text() if log.exists() else "")

    def test_backup_fails_closed_while_the_image_is_unpinned(self):
        # [D3] The gate must refuse a missing value, a placeholder, and every
        # non-digest form a substring `*@sha256:*` test would wrongly accept:
        # an empty digest, a short non-hex digest, and a tag with a digest
        # suffix followed by trailing junk.
        unpinned_cases = (
            {"AWS_CLI_IMAGE": ""},
            {"AWS_CLI_IMAGE": "amazon/aws-cli:2@sha256:PLACEHOLDER"},
            {"AWS_CLI_IMAGE": "amazon/aws-cli:2@sha256:zzz"},
            {"AWS_CLI_IMAGE": "ubuntu@sha256:"},
            {"AWS_CLI_IMAGE": "amazon/aws-cli:2@sha256:" + "a" * 64 + "extra"},
        )
        for unpinned in unpinned_cases:
            with self.subTest(unpinned=unpinned):
                result, log = self.run_backup(unpinned)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("AWS_CLI_IMAGE", result.stderr)
                self.assertNotIn("s3 cp", log)

    def test_the_pinned_digest_gate_is_anchored_in_both_scripts(self):
        # [D3] `@sha256:` alone is not a pin; only an anchored
        # `<image>@sha256:<64 hex chars>` tail is.
        for name in ("backup.sh", "restore.sh"):
            text = (DEPLOY / name).read_text()
            self.assertRegex(text, r"@sha256:\[0-9a-f\]\{64\}\$", name)


FAKE_CURL = r'''#!/usr/bin/env python3
import os, sys
argv = sys.argv[1:]
stdin = sys.stdin.buffer.read()
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("curl " + " ".join(argv) + "\n")
if stdin:
    with open(os.environ["STDIN_LOG"], "ab") as f:
        f.write(b"<<" + stdin + b">>\n")
if any(a.endswith("/api/v1/customer/home") for a in argv):
    print("200")
    sys.exit(0)
mode = os.environ["CURL_MODE"]
if mode == "healthy-hidden":
    print('{"status":"healthy","timestamp":"2026-09-23T00:00:00.000Z"}')
elif mode == "detail-ok":
    print('{"status":"healthy","checks":{"api":"ok","database":"ok","redis":"ok","worker":"ok"},"timestamp":"2026-09-23T00:00:00.000Z"}')
elif mode == "detail-db-error":
    print('{"status":"degraded","checks":{"api":"ok","database":"error","redis":"ok","worker":"ok"}}')
sys.exit(0)
'''


class StgCDoctorHealthDetail(unittest.TestCase):
    # The value piped as the x-health-detail header. Deliberately named and
    # valued without a secret-word pattern so the repo's secret scan stays clean.
    HEADER_VALUE = "hdt-marker-value-77"

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-doctor-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls"
        self.log.write_text("")
        self.stdin_log = self.tmp / "stdin"
        curl = self.bin / "curl"
        curl.write_text(FAKE_CURL)
        curl.chmod(0o755)
        sh_shim(self.bin, "sudo", 'exit 1')
        # A docker that looks healthy-but-empty: `ps` works, both data
        # containers are running with a restart policy, and the db queries
        # fail (warn, not FAIL). Keeps the doctor's container section from
        # failing on a test host that merely has no stack running.
        sh_shim(self.bin, "docker", 'case "$*" in *"ps -q postgres"*|*"ps -q redis"*) echo "c0";; *" ps"*) exit 0;; *"{{.State.Status}}"*) echo "running";; *"{{.HostConfig.RestartPolicy.Name}}"*) echo "unless-stopped";; *"exec -T postgres"*) exit 1;; esac\nexit 0')
        # Pin the disk check at 57% so the doctor tests do not depend on the
        # host's free space.
        sh_shim(self.bin, "df", 'echo "Filesystem Size Used Avail Capacity Mounted"\necho "/dev/disk1 100Gi 43Gi 57Gi 57% /"')

    def run_doctor(self, mode, **extra):
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin}:{env['PATH']}",
            "CALL_LOG": str(self.log),
            "STDIN_LOG": str(self.stdin_log),
            "CURL_MODE": mode,
            "API_URL": "http://health.example",
        })
        env.update(extra)
        return subprocess.run(
            ["bash", str(DEPLOY / "doctor.sh")],
            env=env, text=True, capture_output=True, timeout=30,
        )

    def test_hidden_detail_healthy_is_a_warning_not_a_failure(self):
        # [STG-C] With no token, /health says only {"status":"healthy"}; that
        # used to be two false FAILs. It must be a WARN plus an aggregate ok.
        result = self.run_doctor("healthy-hidden")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("detail hidden", result.stdout)
        self.assertIn("aggregate /health says healthy", result.stdout)
        self.assertNotIn("FAIL", result.stdout)

    def test_a_rejected_token_warns_about_the_token_not_a_missing_file(self):
        # [D2] A readable token file means the header WAS sent; a hidden body
        # then means the token was rejected or rotated. The operator must get
        # that signal, not the misleading "no readable HEALTH_DETAIL_TOKEN".
        token_file = self.tmp / "HEALTH_DETAIL_TOKEN"
        token_file.write_text(self.HEADER_VALUE)
        result = self.run_doctor("healthy-hidden", HEALTH_DETAIL_TOKEN_FILE=str(token_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("token rejected or rotated", result.stdout)
        self.assertNotIn("no readable HEALTH_DETAIL_TOKEN", result.stdout)
        self.assertIn("aggregate /health says healthy", result.stdout)
        self.assertNotIn("FAIL", result.stdout)

    def test_token_file_sends_the_header_via_stdin_and_never_prints_it(self):
        token_file = self.tmp / "HEALTH_DETAIL_TOKEN"
        token_file.write_text(self.HEADER_VALUE)
        result = self.run_doctor("detail-ok", HEALTH_DETAIL_TOKEN_FILE=str(token_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("API + database answering", result.stdout)
        self.assertIn("redis answering", result.stdout)
        self.assertIn("-H @-", self.log.read_text())
        self.assertIn(f"x-health-detail: {self.HEADER_VALUE}", self.stdin_log.read_text())
        # The token travels on stdin only: never in argv, never in the report.
        self.assertNotIn(self.HEADER_VALUE, self.log.read_text())
        self.assertNotIn(self.HEADER_VALUE, result.stdout + result.stderr)

    def test_a_sudo_readable_token_file_sends_the_same_header(self):
        token_file = self.tmp / "HEALTH_DETAIL_TOKEN"
        token_file.write_text(self.HEADER_VALUE)
        token_file.chmod(0o000)
        # A stand-in for passwordless sudo: make the file readable (as root
        # could) and then run the real command.
        sh_shim(self.bin, "sudo", '[ "$1" = "-n" ] && shift\nchmod u+r "$2" 2>/dev/null\nexec "$@"')
        result = self.run_doctor("detail-ok", HEALTH_DETAIL_TOKEN_FILE=str(token_file))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("API + database answering", result.stdout)
        self.assertIn(f"x-health-detail: {self.HEADER_VALUE}", self.stdin_log.read_text())
        self.assertNotIn(self.HEADER_VALUE, self.log.read_text())

    def test_visible_detail_still_fails_on_a_database_error(self):
        token_file = self.tmp / "HEALTH_DETAIL_TOKEN"
        token_file.write_text(self.HEADER_VALUE)
        result = self.run_doctor("detail-db-error", HEALTH_DETAIL_TOKEN_FILE=str(token_file))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("database check not ok", result.stdout)


class StgDWorkerProbe(unittest.TestCase):
    def test_worker_healthcheck_probes_the_heartbeat_not_an_http_ready(self):
        # [STG-D] The worker serves no HTTP, so the image's GET /ready probe
        # could never succeed. The compose override must probe the heartbeat
        # signal /health and /ready use instead.
        worker = service_block(DEPLOY / "docker-compose.yml", "worker")
        self.assertIn("healthcheck:", worker)
        self.assertIn("dist/boot/worker-probe.js", worker)
        self.assertIn("start_period: 120s", worker)
        self.assertNotIn("/ready", worker)

    def test_api_image_healthcheck_still_probes_ready(self):
        dockerfile = (DEPLOY.parent / "apps" / "api" / "Dockerfile").read_text()
        self.assertIn("HEALTHCHECK", dockerfile)
        self.assertIn("/ready", dockerfile)


class SeedProductionScript(unittest.TestCase):
    SHA = "a" * 40

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-seed-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.deploy = self.tmp / "deploy"
        self.deploy.mkdir()
        shutil.copy(DEPLOY / "seed-production.sh", self.deploy / "seed-production.sh")
        (self.deploy / ".env").write_text("PILOT_ENV=staging\n")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls"
        self.log.write_text("")
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        sh_shim(self.bin, "git", 'echo "git $*" >> "$CALL_LOG"\ncase "$*" in *"rev-parse HEAD"*) echo "$GIT_HEAD";; esac\nexit 0')
        sh_shim(self.bin, "docker", 'echo "docker $*" >> "$CALL_LOG"\ncase "$*" in *"exec -T postgres"*) [ "$IDENTITY" = 1 ] && echo "1"; exit "${POSTGRES_FAIL:-0}";; *config*) exit "${CONFIG_FAIL:-0}";; *build*) exit "${BUILD_FAIL:-0}";; *"run --rm --no-TTY seed"*) exit "${RUN_FAIL:-0}";; *) exit 0;; esac')

    def run_script(self, argv=None, **extra):
        env = os.environ.copy()
        env.update({
            "PATH": f"{self.bin}:{env['PATH']}",
            "CALL_LOG": str(self.log),
            "GIT_HEAD": self.SHA,
            "IDENTITY": "1",
        })
        env.update(extra)
        return subprocess.run(
            ["bash", str(self.deploy / "seed-production.sh"), *(argv or [self.SHA])],
            env=env, text=True, capture_output=True, timeout=20,
        )

    def test_refuses_without_a_full_sha(self):
        result = self.run_script(["main"])
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stderr, r"(?i)(sha|commit)")
        self.assertEqual(self.log.read_text(), "")

    def test_refuses_without_a_deployment_identity_row(self):
        result = self.run_script(IDENTITY="", SEED_ADMIN_PHONE="+5925559001")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("deployment_identity", result.stderr)
        self.assertNotIn("git", self.log.read_text())

    def test_requires_seed_admin_phone(self):
        result = self.run_script()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SEED_ADMIN_PHONE", result.stderr)
        self.assertNotIn("docker", self.log.read_text())

    def test_refuses_a_phone_inside_the_demo_purge_range(self):
        # [D1] +592600 is DEMO_PHONE_PREFIX: every demo seed mints numbers in
        # it and the demo purge classifies on it. A real SUPER_ADMIN inside it
        # would be entangled with the demo classification, so the ceremony
        # refuses it before anything runs.
        result = self.run_script(SEED_ADMIN_PHONE="+5926000000")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("592600", result.stderr)
        self.assertNotIn("docker", self.log.read_text())

    def test_runs_the_seed_once_and_removes_the_container(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5925559001")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("build seed", calls)
        self.assertEqual(calls.count("run --rm --no-TTY seed"), 1)
        # DATABASE_URL is assembled in the container's memory only.
        self.assertNotIn("DATABASE_URL", result.stdout + result.stderr)
        self.assertNotIn("DATABASE_URL", calls)

    def test_the_script_and_its_compose_override_never_carry_database_url(self):
        script = (DEPLOY / "seed-production.sh").read_text()
        override = (DEPLOY / "docker-compose.seed.yml").read_text()
        self.assertNotIn("DATABASE_URL=", script)
        self.assertIsNone(re.search(r"(?m)^\s*DATABASE_URL\s*[:=]", override))
        self.assertIn("dist/boot/secret-files.js", override)
        self.assertIn("tsx/cli", override)
        self.assertIn("prisma/seed-production.ts", override)
        self.assertIn("target: build", override)



class SeedBreakGlassCeremony(SeedProductionScript):
    """The two-person promotion (runbook §6): SEED_SIGN_APPROVER signs one
    approver's half and seeds nothing; SEED_PROMOTION_APPROVALS carries both
    halves. Either needs SEED_PLAN_SECRET in the encrypted store, and the key
    reaches the one-off container only as a FILE path — never as a value."""

    def setUp(self):
        super().setUp()
        # The store lists names only; sudo -n runs the named tool; systemctl is logged.
        sh_shim(self.bin, "swift-secrets", 'echo "swift-secrets $*" >> "$CALL_LOG"\n[ "$1" = list ] && echo "$STORE_NAMES"\nexit 0')
        sh_shim(self.bin, "sudo", '[ "$1" = -n ] && shift\nexec "$@"')
        sh_shim(self.bin, "systemctl", 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0')
        # The container run records which ceremony variables reached it.
        sh_shim(self.bin, "docker", 'echo "docker $*" >> "$CALL_LOG"\ncase "$*" in *"exec -T postgres"*) [ "$IDENTITY" = 1 ] && echo "1"; exit 0;; *"run --rm --no-TTY seed"*) echo "ENV file=[$SEED_PLAN_SECRET_FILE] signer=[$SEED_SIGN_APPROVER] approvals=[$SEED_PROMOTION_APPROVALS]" >> "$CALL_LOG"; exit 0;; *) exit 0;; esac')

    def test_sign_mode_refuses_without_the_key_in_the_store(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", SEED_SIGN_APPROVER="owner", STORE_NAMES="JWT_SECRET OTP_HASH_SECRET")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SEED_PLAN_SECRET", result.stderr)
        self.assertNotIn("run --rm", self.log.read_text())

    def test_sign_mode_refuses_a_malformed_approver_name(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", SEED_SIGN_APPROVER="Owner Name", STORE_NAMES="SEED_PLAN_SECRET")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SEED_SIGN_APPROVER", result.stderr)
        self.assertNotIn("run --rm", self.log.read_text())

    def test_sign_mode_passes_the_key_only_as_a_file_and_materializes_the_store(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", SEED_SIGN_APPROVER="owner", STORE_NAMES="JWT_SECRET SEED_PLAN_SECRET")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("systemctl restart swift-secrets.service", calls)
        self.assertIn("ENV file=[/run/secrets/SEED_PLAN_SECRET] signer=[owner]", calls)
        self.assertEqual(calls.count("run --rm --no-TTY seed"), 1)

    def test_the_promotion_carries_both_halves_and_the_key_file(self):
        approvals = '[{"approver":"owner","signature":"ab"},{"approver":"coordinator","signature":"cd"}]'
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", SEED_PROMOTION_APPROVALS=approvals, STORE_NAMES="SEED_PLAN_SECRET")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("ENV file=[/run/secrets/SEED_PLAN_SECRET] signer=[]", calls)
        self.assertIn('"approver":"coordinator"', calls)

    def test_an_ordinary_seed_leaves_the_ceremony_off(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", STORE_NAMES="SEED_PLAN_SECRET")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("ENV file=[] signer=[] approvals=[]", calls)
        self.assertNotIn("swift-secrets", calls)
        self.assertNotIn("systemctl", calls)

    def test_the_compose_override_wires_the_ceremony_with_empty_defaults(self):
        override = (DEPLOY / "docker-compose.seed.yml").read_text()
        for line in ("SEED_PLAN_SECRET_FILE: ${SEED_PLAN_SECRET_FILE:-}",
                     "SEED_PROMOTION_APPROVALS: ${SEED_PROMOTION_APPROVALS:-}",
                     "SEED_SIGN_APPROVER: ${SEED_SIGN_APPROVER:-}"):
            self.assertIn(line, override)
        # The key is never a plain value anywhere in the ceremony's files.
        self.assertIsNone(re.search(r"(?m)^\s*SEED_PLAN_SECRET\s*[:=]", override))
        self.assertNotIn("SEED_PLAN_SECRET=", (DEPLOY / "seed-production.sh").read_text())


if __name__ == "__main__":
    unittest.main()
