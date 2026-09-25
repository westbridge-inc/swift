"""Regression contracts for the STG-OPS deploy fixes (STG-A/B/C/D + seed),
and the optional staging website (Q11: apps/web behind WEB_HOST).

Offline and service-free: reads deploy files as text and runs the real bash
scripts against shims for docker/git/curl/sudo, exactly like the other deploy
test files. Nothing here needs root, a network, Docker or systemd.

    python3 -m unittest discover -s deploy/tests -v
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
site = os.environ.get("FAKE_SITE_URL")
if site and any(a.rstrip("/") == site for a in argv):
    print(os.environ.get("FAKE_SITE_CODE", "200"))
    sys.exit(0)
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

    def test_the_seed_runs_in_the_stacks_posture_never_an_unset_one(self):
        # The promotion calls isProduction() (seedFxRate); runtime-mode refuses
        # an unset NODE_ENV. The seed must take the SAME required NODE_ENV as
        # the api/worker, and pass the operator's FX rate through.
        override = (DEPLOY / "docker-compose.seed.yml").read_text()
        stack = (DEPLOY / "docker-compose.yml").read_text()
        required = re.search(r"(?m)^\s*NODE_ENV: (\$\{NODE_ENV:\?[^\n]*\})\s*$", override)
        self.assertIsNotNone(required, "the seed service must require NODE_ENV, never default it")
        self.assertIn("NODE_ENV: ${NODE_ENV:?", stack)
        self.assertNotIn("${NODE_ENV:-", override)
        self.assertIn("SEED_FX_GYD_PER_USD: ${SEED_FX_GYD_PER_USD:-}", override)
        self.assertNotIn("SEED_PLAN_SECRET=", (DEPLOY / "seed-production.sh").read_text())



# ===========================================================================
# [Q11] The staging website (apps/web), optional behind WEB_HOST. A stack
# without WEB_HOST is exactly the API stack: the web service is profile-gated,
# the Caddyfile serves no website host, and pilot-up.sh runs nothing new.
# ===========================================================================

API_HOST = "api-staging.example.com"
WEB_HOST = "staging.example.com"
WEB_DOCKERFILE = DEPLOY.parent / "apps" / "web" / "Dockerfile"


def caddy_render(text: str, env: dict) -> str:
    """Caddy's parse-time substitution: {$NAME} is the variable's value, and an
    unset or empty one expands to nothing (probed against caddy:2.10)."""
    def value(match):
        name, _, default = match.group(1).partition(":")
        return env.get(name, default)
    return re.sub(r"\{\$([A-Za-z_][A-Za-z0-9_]*(?::[^}]*)?)\}", value, text)


def top_level_blocks(rendered: str):
    """[addresses, body lines] for every top-level block of a rendered Caddyfile."""
    blocks, depth = [], 0
    for raw in rendered.splitlines():
        line = raw.split("#", 1)[0].strip()
        if not line:
            continue
        if depth == 0:
            if not line.endswith("{"):
                raise AssertionError(f"unexpected top-level line: {line!r}")
            blocks.append([line[:-1].split(), []])
            depth = 1
            continue
        depth += line.count("{") - line.count("}")
        if depth > 0:
            blocks[-1][1].append(line)
    return blocks


def dockerfile_stages(path: Path) -> dict:
    """Stage name -> its instructions, from `FROM ... AS name` to the next FROM."""
    stages = {}
    for chunk in re.split(r"(?m)^(?=FROM )", path.read_text()):
        head = re.match(r"FROM \S+ AS (\S+)", chunk)
        if head:
            stages[head.group(1)] = chunk
    return stages


class Q11WebsiteCompose(unittest.TestCase):
    def web(self) -> str:
        return service_block(DEPLOY / "docker-compose.yml", "web")

    def test_the_website_is_profile_gated_private_and_portless(self):
        web = self.web()
        self.assertIn('profiles: ["web"]', web)
        self.assertNotRegex(web, r"(?m)^    (ports|expose|network_mode|privileged|extra_hosts):")
        self.assertIn("networks: [private]", web)

    def test_the_website_depends_on_nothing_and_reads_no_settings_file_or_secret(self):
        web = self.web()
        self.assertNotRegex(web, r"(?m)^    (depends_on|env_file|volumes|secrets):")
        self.assertNotIn("/run/secrets", web)
        self.assertNotIn("_FILE:", web)

    def test_the_image_is_built_for_this_stacks_public_api_on_the_staging_channel(self):
        web = self.web()
        self.assertIn("dockerfile: apps/web/Dockerfile", web)
        self.assertIn("image: swift-web:${SWIFT_TAG:-local}", web)
        self.assertIn("NEXT_PUBLIC_API_URL: https://${API_HOST:-localhost}", web)
        self.assertIn("SWIFT_WEB_CHANNEL: staging", web)
        # Unfilled company details stay refused unless the operator says otherwise.
        self.assertIn("NEXT_PUBLIC_ALLOW_SITE_TOKENS: ${WEB_ALLOW_SITE_TOKENS:-}", web)

    def test_the_website_has_a_memory_ceiling_that_v8_collects_below(self):
        web = self.web()
        limit = re.search(r"(?m)^    mem_limit: (\d+)m$", web)
        heap = re.search(r"--max-old-space-size=(\d+)", web)
        self.assertIsNotNone(limit, "the web service needs a mem_limit")
        self.assertIsNotNone(heap, "the web service must cap the V8 heap under its mem_limit")
        self.assertLess(int(heap.group(1)), int(limit.group(1)))

    def test_caddy_gets_web_host_with_an_empty_default_and_never_waits_on_the_website(self):
        caddy = service_block(DEPLOY / "docker-compose.yml", "caddy")
        self.assertIn("WEB_HOST: ${WEB_HOST:-}", caddy)
        self.assertNotRegex(caddy, r"(?m)^      web:")


@unittest.skipUnless(shutil.which("docker"), "Docker CLI not installed")
class Q11WebsiteRenderedByCompose(unittest.TestCase):
    """The real file, rendered by `docker compose config` (client-side; no daemon)."""

    def render(self, *profile):
        with tempfile.TemporaryDirectory() as tmp:
            here = Path(tmp) / "deploy"
            here.mkdir()
            shutil.copy(DEPLOY / "docker-compose.yml", here / "docker-compose.yml")
            (here / ".env").write_text(
                "NODE_ENV=development\nPILOT_ENV=staging\nAPI_HOST=api-staging.example.invalid\n"
                "WEB_HOST=staging.example.invalid\nWEB_ALLOW_SITE_TOKENS=1\n"
            )
            result = subprocess.run(
                ["docker", "compose", "--project-directory", str(here), "-f", str(here / "docker-compose.yml"),
                 *profile, "config", "--format", "json"],
                text=True, capture_output=True, timeout=60,
            )
            if result.returncode != 0 and "unknown" in result.stderr.lower():
                self.skipTest(f"docker compose cannot render here: {result.stderr.strip()[:120]}")
            self.assertEqual(result.returncode, 0, result.stderr[:400])
            return json.loads(result.stdout)

    def test_without_the_profile_the_stack_has_no_website(self):
        self.assertNotIn("web", self.render()["services"])

    def test_with_the_profile_the_website_is_private_and_built_for_this_api(self):
        model = self.render("--profile", "web")
        web = model["services"]["web"]
        self.assertNotIn("ports", web)
        self.assertEqual(list((web.get("networks") or {}).keys()), ["private"])
        self.assertEqual(sorted((web.get("environment") or {}).keys()), ["NODE_OPTIONS"])
        self.assertEqual(web["build"]["args"]["NEXT_PUBLIC_API_URL"], "https://api-staging.example.invalid")
        self.assertEqual(web["build"]["args"]["SWIFT_WEB_CHANNEL"], "staging")
        self.assertEqual(web["build"]["args"]["NEXT_PUBLIC_ALLOW_SITE_TOKENS"], "1")
        self.assertEqual(model["services"]["caddy"]["environment"]["WEB_HOST"], "staging.example.invalid")
        # pilot-up's isolation check passes with the website in the model.
        check = subprocess.run(
            ["python3", str(DEPLOY / "verify-journeys-isolation.py"), str(DEPLOY / "Caddyfile")],
            input=json.dumps(model), text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(check.returncode, 0, check.stderr)


class Q11WebsiteCaddyfile(unittest.TestCase):
    TEXT = (DEPLOY / "Caddyfile").read_text()

    def blocks(self, **env):
        return top_level_blocks(caddy_render(self.TEXT, env))

    def test_an_unset_or_empty_web_host_leaves_exactly_the_api_site(self):
        # A separate `{$WEB_HOST} { ... }` block loses its only address when the
        # variable is empty; Caddy then reads it as a misplaced global-options
        # block and refuses the WHOLE file, the API site included.
        for env in ({"API_HOST": API_HOST}, {"API_HOST": API_HOST, "WEB_HOST": ""}):
            with self.subTest(env=env):
                blocks = self.blocks(**env)
                self.assertEqual([addresses for addresses, _ in blocks], [[API_HOST]])
                body = "\n".join(blocks[0][1])
                self.assertIn("respond @metrics 403", body)
                self.assertIn("reverse_proxy api:3000", body)

    def test_a_set_web_host_joins_the_api_site_and_reaches_the_website(self):
        blocks = self.blocks(API_HOST=API_HOST, WEB_HOST=WEB_HOST)
        self.assertEqual([addresses for addresses, _ in blocks], [[API_HOST, WEB_HOST]])
        self.assertIn("reverse_proxy web:3000", "\n".join(blocks[0][1]))

    def test_routes_key_on_the_api_host_and_the_api_keeps_its_guard(self):
        # Matching on WEB_HOST would become an argument-less host matcher when it
        # is unset; the API host is always set, so the split keys on it.
        code = [line.split("#", 1)[0].strip() for line in self.TEXT.splitlines()]
        self.assertEqual([line for line in code if "$WEB_HOST" in line], ["{$API_HOST} {$WEB_HOST} {"])
        body = "\n".join(self.blocks(API_HOST=API_HOST, WEB_HOST=WEB_HOST)[0][1])
        self.assertRegex(
            body,
            re.escape(f"@api host {API_HOST}") + r"\nhandle @api \{\n@metrics path /metrics\nrespond @metrics 403\n"
            r"reverse_proxy api:3000\n\}\nhandle \{\nreverse_proxy web:3000\n\}",
        )

    def test_the_website_keeps_its_own_security_headers(self):
        # next.config.ts sets them; the proxy neither duplicates nor overrides any.
        self.assertNotRegex(self.TEXT, r"(?m)^\s*header\b")


def caddy_image_present() -> bool:
    if not shutil.which("docker"):
        return False
    probe = subprocess.run(["docker", "image", "inspect", "caddy:2.10"], capture_output=True, timeout=30)
    return probe.returncode == 0


@unittest.skipUnless(caddy_image_present(), "docker or the caddy:2.10 image is not available locally")
class Q11WebsiteCaddyfileRenderedByCaddy(unittest.TestCase):
    """The real Caddyfile through the stack's pinned Caddy (no network, no pull)."""

    def caddy(self, command, env):
        args = ["docker", "run", "--rm", "--network", "none"]
        for name, value in env.items():
            args += ["-e", f"{name}={value}"]
        args += ["-v", f"{DEPLOY / 'Caddyfile'}:/etc/caddy/Caddyfile:ro", "caddy:2.10",
                 "caddy", command, "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
        result = subprocess.run(args, text=True, capture_output=True, timeout=60)
        self.assertEqual(result.returncode, 0, result.stderr[-600:])
        return result.stdout

    def served_hosts(self, env):
        self.caddy("validate", env)
        config = json.loads(self.caddy("adapt", env))
        routes = config["apps"]["http"]["servers"]["srv0"]["routes"]
        return [m["host"] for route in routes for m in route.get("match", []) if "host" in m], json.dumps(config)

    def test_unset_and_empty_web_host_validate_and_serve_only_the_api(self):
        for env in ({"API_HOST": API_HOST}, {"API_HOST": API_HOST, "WEB_HOST": ""}):
            with self.subTest(env=env):
                hosts, config = self.served_hosts(env)
                self.assertEqual(hosts, [[API_HOST]])
                self.assertIn('"dial": "api:3000"', config)

    def test_a_set_web_host_validates_and_is_served_beside_the_api(self):
        hosts, config = self.served_hosts({"API_HOST": API_HOST, "WEB_HOST": WEB_HOST})
        self.assertEqual(hosts, [[API_HOST, WEB_HOST]])
        self.assertIn('"dial": "web:3000"', config)
        self.assertIn('"dial": "api:3000"', config)


class Q11WebsiteDockerfile(unittest.TestCase):
    def setUp(self):
        self.stages = dockerfile_stages(WEB_DOCKERFILE)
        self.runtime = self.stages["runtime"]
        self.build = self.stages["build"]

    def test_the_final_stage_is_the_runtime_and_runs_as_non_root(self):
        self.assertEqual(list(self.stages)[-1], "runtime")
        self.assertRegex(self.runtime, r"(?m)^USER node$")
        after_user = self.runtime[self.runtime.index("USER node") + len("USER node"):]
        self.assertNotRegex(after_user, r"(?m)^USER ")
        self.assertIn("CMD ", after_user)

    def test_the_api_origin_and_channel_are_build_args_of_the_building_stage(self):
        build_step = self.build.index("RUN pnpm run build")
        for arg in ("NEXT_PUBLIC_API_URL", "SWIFT_WEB_CHANNEL", "NEXT_PUBLIC_ALLOW_SITE_TOKENS"):
            declared = re.search(rf"(?m)^ARG {arg}$", self.build)
            self.assertIsNotNone(declared, f"{arg} must be a build ARG with no baked-in default")
            self.assertLess(declared.start(), build_step, arg)
        self.assertIn("ENV SWIFT_WEB_IMAGE_BUILD=1", self.build)
        # A public variable in the runtime would claim a setting the bundle cannot change.
        self.assertNotIn("NEXT_PUBLIC_", self.runtime)

    def test_it_installs_the_workspace_like_the_api_image(self):
        deps = self.stages["deps"]
        self.assertIn("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./", deps)
        self.assertIn("COPY apps/web/package.json apps/web/", deps)
        self.assertIn("COPY packages/ packages/", deps)
        self.assertIn("pnpm install --frozen-lockfile", deps)
        self.assertIn("--mount=type=cache,id=pnpm,target=/pnpm/store", deps)
        self.assertNotIn("apps/mobile/package.json", WEB_DOCKERFILE.read_text())

    def test_it_runs_the_standalone_server_and_probes_it(self):
        self.assertIn("COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./", self.runtime)
        self.assertIn("/app/apps/web/.next/static ./apps/web/.next/static", self.runtime)
        self.assertIn("/app/apps/web/public ./apps/web/public", self.runtime)
        self.assertIn("ENV HOSTNAME=0.0.0.0 PORT=3000", self.runtime)
        self.assertRegex(self.runtime, r"(?m)^HEALTHCHECK .*\\\n.*/robots\.txt")
        self.assertIn('CMD ["node", "server.js"]', self.runtime)


FAKE_PILOT_DOCKER = r"""#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
line = " ".join(argv)
with open(os.environ["CALL_LOG"], "a") as log:
    log.write("docker " + line + "\n")
if os.environ.get("FAIL_ON") and os.environ["FAIL_ON"] in line:
    sys.exit(1)
if argv[:1] == ["network"]:
    if "-f" in argv:
        print("bridge")
    sys.exit(0)
if argv[:1] == ["inspect"]:
    fmt, target = argv[2], argv[3]
    if "ExitCode" in fmt:
        print("exited 0")
    elif "Health" in fmt:
        print(os.environ.get("WEB_HEALTH", "healthy") if target == "web-id" else "healthy")
    else:
        print("running")
    sys.exit(0)
if argv[:1] == ["compose"] and "config" in argv and "--format" in argv:
    if any(a.endswith("docker-compose.routing.yml") for a in argv):
        print(json.dumps({"services": {"osrm": {}}}))
    else:
        services = {name: {} for name in ("postgres", "redis", "meilisearch", "migrate", "api", "worker")}
        services["caddy"] = {"ports": [{"published": "80", "target": 80, "protocol": "tcp"},
                                       {"published": "443", "target": 443, "protocol": "tcp"}]}
        if "--profile" in argv and argv[argv.index("--profile") + 1] == "web":
            services["web"] = {}
        print(json.dumps({"services": services}))
    sys.exit(0)
if argv[:1] == ["compose"] and "ps" in argv and "-q" in argv:
    print(argv[-1] + "-id")
sys.exit(0)
"""


class Q11PilotUpWebsite(unittest.TestCase):
    """The real pilot-up.sh, end to end, against shims for docker, git, curl,
    sudo, systemctl, the secret store and sleep. Nothing is deployed."""

    SHA = "c" * 40

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-pilot-web-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.here = self.tmp / "repo" / "deploy"
        (self.here / "routing-data" / "osrm").mkdir(parents=True)
        (self.here / "routing-data" / "osrm" / "guyana-latest.osrm").write_text("")
        for name in ("pilot-up.sh", "secret-names.sh", "wait-for-migration.sh", "verify-journeys-isolation.py",
                     "Caddyfile", "docker-compose.yml", "docker-compose.routing.yml"):
            shutil.copy(DEPLOY / name, self.here / name)
        utils = self.tmp / "repo" / "apps" / "api" / "src" / "utils"
        utils.mkdir(parents=True)
        shutil.copy(DEPLOY.parent / "apps" / "api" / "src" / "utils" / "secret-files.ts", utils / "secret-files.ts")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls"
        self.log.write_text("")
        docker = self.bin / "docker"
        docker.write_text(FAKE_PILOT_DOCKER)
        docker.chmod(0o755)
        sh_shim(self.bin, "git", 'echo "git $*" >> "$CALL_LOG"\n[ "$*" = "rev-parse HEAD" ] && echo "$GIT_HEAD"\nexit 0')
        sh_shim(self.bin, "curl", 'echo "curl $*" >> "$CALL_LOG"\ncase "$*" in *"https://$SITE/"*) [ -z "$SITE_DOWN" ] || exit 7;; esac\nexit 0')
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        sh_shim(self.bin, "sudo", '[ "$1" = -n ] && shift\nexec "$@"')
        sh_shim(self.bin, "swift-secrets", '[ "$1" = list ] && printf "%s\\n" $STORE_NAMES\nexit 0')
        sh_shim(self.bin, "systemctl", 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0')
        sh_shim(self.bin, "sleep", "exit 0")
        compose = (DEPLOY / "docker-compose.yml").read_text()
        self.store = " ".join(sorted(set(re.findall(r"_FILE: /run/secrets/([A-Z][A-Z0-9_]*)", compose))
                                     | {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}))

    def run_pilot(self, web_host=None, **extra):
        settings = (f"PILOT_ENV=staging\nAPI_HOST={API_HOST}\nMAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\n"
                    "BACKUP_BUCKET=test-backups\nNODE_ENV=development\nCORS_ORIGIN=https://staging.example.com\n")
        if web_host is not None:
            settings += f"WEB_HOST={web_host}\n"
        (self.here / ".env").write_text(settings)
        env = os.environ.copy()
        env.update({"PATH": f"{self.bin}:{env['PATH']}", "CALL_LOG": str(self.log), "GIT_HEAD": self.SHA,
                    "STORE_NAMES": self.store, "SITE": web_host or ""})
        env.update(extra)
        result = subprocess.run(["bash", str(self.here / "pilot-up.sh"), self.SHA],
                                env=env, text=True, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
        return result, self.log.read_text().splitlines()

    @staticmethod
    def first(calls, fragment):
        return next(i for i, call in enumerate(calls) if fragment in call)

    def test_without_web_host_nothing_about_the_website_runs(self):
        for web_host in (None, ""):
            with self.subTest(web_host=web_host):
                self.log.write_text("")
                result, calls = self.run_pilot(web_host)
                self.assertEqual(result.returncode, 0, result.stderr[-800:])
                self.assertIn(f"STAGING READY at exact SHA {self.SHA}", result.stdout)
                self.assertNotIn("WEBSITE", result.stdout)
                self.assertFalse([c for c in calls if "--profile web" in c or c.endswith(" web")], calls)
                self.assertTrue(any(c.endswith(" build api") for c in calls))
                self.assertTrue(any(c.endswith("/ready") for c in calls if c.startswith("curl ")))

    def test_with_web_host_the_site_builds_before_anything_stops_and_starts_after_the_api_is_ready(self):
        result, calls = self.run_pilot(WEB_HOST)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        # Every compose call sees the website, so the port and isolation checks cover it.
        compose = [c for c in calls if c.startswith("docker compose") and "docker-compose.routing.yml" not in c]
        self.assertTrue(compose)
        self.assertEqual([c for c in compose if "--profile web" not in c], [])
        built = self.first(calls, " build web")
        self.assertLess(self.first(calls, " build api"), built)
        self.assertLess(built, self.first(calls, " stop api worker"))
        api_ready = self.first(calls, f"https://{API_HOST}/ready")
        started = self.first(calls, "up -d --no-deps --force-recreate web")
        self.assertLess(api_ready, started)
        site_probe = self.first(calls, f"--resolve {WEB_HOST}:443:127.0.0.1")
        self.assertLess(started, site_probe)
        self.assertIn(f"https://{WEB_HOST}/", calls[site_probe])
        self.assertIn(f"WEBSITE READY at https://{WEB_HOST} (exact SHA {self.SHA})", result.stdout)
        self.assertIn(f"STAGING READY at exact SHA {self.SHA}", result.stdout)

    def test_a_malformed_web_host_is_refused_before_anything_changes(self):
        for bad in ("https://staging.example.com", "staging.example.com/", "staging.example.com:443",
                    "localhost", "staging", "-staging.example.com", "staging example.com"):
            with self.subTest(web_host=bad):
                self.log.write_text("")
                result, calls = self.run_pilot(bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("WEB_HOST", result.stderr)
                self.assertEqual(calls, [], "nothing may run before the settings are accepted")

    def test_web_host_must_not_be_the_api_host(self):
        for same in (API_HOST, API_HOST.upper()):
            with self.subTest(web_host=same):
                self.log.write_text("")
                result, calls = self.run_pilot(same)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("WEB_HOST must differ from API_HOST", result.stderr)
                self.assertEqual(calls, [])

    def test_a_site_that_does_not_build_leaves_the_running_stack_untouched(self):
        result, calls = self.run_pilot(WEB_HOST, FAIL_ON="build web")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([c for c in calls if " stop " in c or " up " in c], calls)

    def test_a_site_that_never_answers_fails_the_deploy_and_says_the_api_is_serving(self):
        for failure in ({"SITE_DOWN": "1"}, {"WEB_HEALTH": "unhealthy"}):
            with self.subTest(failure=failure):
                self.log.write_text("")
                result, calls = self.run_pilot(WEB_HOST, **failure)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"https://{WEB_HOST}", result.stderr)
                self.assertIn(f"the API is serving {self.SHA}", result.stderr)
                self.assertNotIn("STAGING READY", result.stdout)
                self.assertTrue(any(c.endswith("up -d --no-deps --force-recreate api worker") for c in calls))


class Q11DoctorWebsite(unittest.TestCase):
    SITE_URL = "https://site.example"

    def setUp(self):
        StgCDoctorHealthDetail.setUp(self)
        # Hermetic: the doctor's Dependabot section calls a real `gh` when one
        # is installed; unreadable alerts are only a WARN, never the verdict.
        sh_shim(self.bin, "gh", "exit 1")

    def run_doctor(self, mode, script=DEPLOY / "doctor.sh", **extra):
        env = os.environ.copy()
        env.update({"PATH": f"{self.bin}:{env['PATH']}", "CALL_LOG": str(self.log), "STDIN_LOG": str(self.stdin_log),
                    "CURL_MODE": mode, "API_URL": "http://health.example"})
        env.update(extra)
        # The fake curl reads stdin to its end: give it one that ends, whatever
        # the test runner's own stdin is.
        return subprocess.run(["bash", str(script)], env=env, text=True, capture_output=True, timeout=30,
                              stdin=subprocess.DEVNULL)

    def test_without_a_website_the_doctor_checks_none(self):
        result = self.run_doctor("healthy-hidden")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("website", result.stdout)

    def test_a_website_that_answers_is_ok(self):
        result = self.run_doctor("healthy-hidden", WEB_URL=self.SITE_URL, FAKE_SITE_URL=self.SITE_URL)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"ok    website {self.SITE_URL} → 200", result.stdout)

    def test_a_website_that_is_down_or_erroring_fails_the_doctor(self):
        for code in ("502", "500", "000"):
            with self.subTest(code=code):
                result = self.run_doctor("healthy-hidden", WEB_URL=self.SITE_URL, FAKE_SITE_URL=self.SITE_URL,
                                         FAKE_SITE_CODE=code)
                self.assertEqual(result.returncode, 1, result.stdout)
                self.assertRegex(result.stdout, r"FAIL  website")

    def test_the_website_address_comes_from_web_host_in_deploy_env(self):
        here = self.tmp / "deploy"
        here.mkdir()
        shutil.copy(DEPLOY / "doctor.sh", here / "doctor.sh")
        (here / ".env").write_text("WEB_HOST=site.example\n")
        result = self.run_doctor("healthy-hidden", script=here / "doctor.sh", FAKE_SITE_URL=self.SITE_URL)
        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertIn(f"ok    website {self.SITE_URL} → 200", result.stdout)


class Q11WebsiteDocs(unittest.TestCase):
    def test_the_runbook_says_how_to_serve_and_verify_the_website(self):
        runbook = (DEPLOY / "PILOT-RUNBOOK.md").read_text()
        start = runbook.index("Serving the website on staging")
        end = runbook.find("\n## ", start)
        section = runbook[start:end if end != -1 else len(runbook)]
        for needle in ("A record", "DNS only", "WEB_HOST=staging.swiftgy.com", "CORS_ORIGIN",
                       "APP_PUBLIC_URL", "WEB_ALLOW_SITE_TOKENS", "./deploy/pilot-up.sh",
                       '--resolve "$WEB_HOST:443:127.0.0.1"', "X-Robots-Tag"):
            self.assertIn(needle, section)


if __name__ == "__main__":
    unittest.main()
