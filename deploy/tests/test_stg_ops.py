"""Regression contracts for the STG-OPS deploy fixes (STG-A/B/C/D + seed),
the optional staging website (Q11: apps/web behind WEB_HOST), and the optional
admin console (ADMIN-CONSOLE: apps/admin behind ADMIN_HOST).

Offline and service-free: reads deploy files as text and runs the real bash
scripts against shims for docker/git/curl/sudo, exactly like the other deploy
test files. Nothing here needs root, a network, Docker or systemd.

    python3 -m unittest discover -s deploy/tests -v
"""

import base64
import json
import os
import re
import secrets
import shutil
import subprocess
import tempfile
import time
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
        # [PROD-PATH] the script reads the Compose files it runs (the shell-override guard).
        shutil.copy(DEPLOY / "docker-compose.yml", self.deploy / "docker-compose.yml")
        shutil.copy(DEPLOY / "docker-compose.seed.yml", self.deploy / "docker-compose.seed.yml")
        (self.deploy / ".env").write_text("PILOT_ENV=staging\n")
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls"
        self.log.write_text("")
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        sh_shim(self.bin, "git", 'echo "git $*" >> "$CALL_LOG"\ncase "$*" in *"rev-parse HEAD"*) echo "$GIT_HEAD";; esac\nexit 0')
        sh_shim(self.bin, "docker", 'echo "docker $*" >> "$CALL_LOG"\ncase "$*" in *"exec -T postgres"*) [ "$IDENTITY" = 1 ] && echo "1:staging"; exit "${POSTGRES_FAIL:-0}";; *config*) exit "${CONFIG_FAIL:-0}";; *build*) exit "${BUILD_FAIL:-0}";; *"run --rm --no-TTY seed"*) exit "${RUN_FAIL:-0}";; *) exit 0;; esac')

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
    """The two-person ceremony (runbook §6b): approvals are signatures by the
    approvers' OWN keys; the server only pins their public keys
    (SEED_APPROVER_KEYS), which reach the one-off container only as a FILE.
    [PROD-PATH] There is no server-side signing mode and no shared key."""

    def setUp(self):
        super().setUp()
        sh_shim(self.bin, "swift-secrets", 'echo "swift-secrets $*" >> "$CALL_LOG"\n[ "$1" = list ] && echo "$STORE_NAMES"\nexit 0')
        sh_shim(self.bin, "sudo", '[ "$1" = -n ] && shift\nexec "$@"')
        sh_shim(self.bin, "systemctl", 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0')
        sh_shim(self.bin, "docker", 'echo "docker $*" >> "$CALL_LOG"\ncase "$*" in *"exec -T postgres"*) [ "$IDENTITY" = 1 ] && echo "1:staging"; exit 0;; *"run --rm --no-TTY seed"*) echo "ENV keys=[$SEED_APPROVER_KEYS_FILE] promotion=[$SEED_PROMOTION_APPROVALS] plan=[$SEED_PLAN_APPROVALS]" >> "$CALL_LOG"; exit 0;; *) exit 0;; esac')

    def test_approvals_refuse_without_the_pinned_keys_in_the_store(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", SEED_PROMOTION_APPROVALS="[]", STORE_NAMES="JWT_SECRET OTP_HASH_SECRET")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("SEED_APPROVER_KEYS", result.stderr)
        self.assertNotIn("run --rm", self.log.read_text())

    def test_the_promotion_carries_both_lines_and_the_keys_file(self):
        approvals = '[{"approver":"owner","request":"cg==","signature":"ab"},{"approver":"coordinator","request":"cg==","signature":"cd"}]'
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", SEED_PROMOTION_APPROVALS=approvals, STORE_NAMES="SEED_APPROVER_KEYS")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("systemctl restart swift-secrets.service", calls)
        self.assertIn("ENV keys=[/run/secrets/SEED_APPROVER_KEYS]", calls)
        self.assertIn('"approver":"coordinator"', calls)

    def test_an_ordinary_seed_leaves_the_ceremony_off(self):
        result = self.run_script(SEED_ADMIN_PHONE="+5920400001", STORE_NAMES="SEED_APPROVER_KEYS")
        self.assertEqual(result.returncode, 0, result.stderr)
        calls = self.log.read_text()
        self.assertIn("ENV keys=[] promotion=[] plan=[]", calls)
        self.assertNotIn("swift-secrets", calls)
        self.assertNotIn("systemctl", calls)

    def test_the_compose_override_wires_the_ceremony_with_empty_defaults(self):
        override = (DEPLOY / "docker-compose.seed.yml").read_text()
        for line in ("SEED_APPROVER_KEYS_FILE: ${SEED_APPROVER_KEYS_FILE:-}",
                     "SEED_PROMOTION_APPROVALS: ${SEED_PROMOTION_APPROVALS:-}",
                     "SEED_PLAN_APPROVALS: ${SEED_PLAN_APPROVALS:-}"):
            self.assertIn(line, override)
        self.assertIsNone(re.search(r"SEED_PLAN_SECRET|SEED_SIGN_", override))

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
        self.assertNotIn("SEED_APPROVER_KEYS=", (DEPLOY / "seed-production.sh").read_text())



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
        self.assertIn("SWIFT_WEB_CHANNEL: ${SWIFT_WEB_CHANNEL:-staging}", web)
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
        # [STORE-1] The optional API alias sits with the API host, before the website.
        # [Item 8] The optional website aliases follow the website's own name.
        # [ADMIN-CONSOLE] The optional admin console's name follows them.
        self.assertEqual([line for line in code if "$WEB_HOST" in line],
                         ["{$API_HOST} {$API_ALIAS_HOST} {$WEB_HOST} {$WEB_ALIAS_HOSTS} {$ADMIN_HOST} {"])
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

    def run_pilot(self, web_host=None, alias=None, web_aliases=None, web_ordering=None, **extra):
        settings = (f"PILOT_ENV=staging\nAPI_HOST={API_HOST}\nMAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\n"
                    "BACKUP_BUCKET=test-backups\nNODE_ENV=development\nCORS_ORIGIN=https://staging.example.com\n")
        if web_host is not None:
            settings += f"WEB_HOST={web_host}\n"
        if alias is not None:
            settings += f"API_ALIAS_HOST={alias}\n"
        if web_aliases is not None:
            settings += f"WEB_ALIAS_HOSTS={web_aliases}\n"
        if web_ordering is not None:
            settings += f"WEB_ORDERING={web_ordering}\n"
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

    def test_a_valid_api_alias_deploys_like_the_primary_name(self):
        result, calls = self.run_pilot(WEB_HOST, alias=ALIAS_HOST)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertIn(f"STAGING READY at exact SHA {self.SHA}", result.stdout)

    def test_a_malformed_api_alias_is_refused_before_anything_changes(self):
        for bad in ("https://api.example.com", "api.example.com/", "api.example.com:443", "localhost", "api", "-api.example.com", "api example.com"):
            with self.subTest(alias=bad):
                self.log.write_text("")
                result, calls = self.run_pilot(None, alias=bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("API_ALIAS_HOST", result.stderr)
                self.assertEqual(calls, [], "nothing may run before the settings are accepted")

    def test_api_alias_must_differ_from_the_api_and_website_names(self):
        for same, web, message in ((API_HOST, None, "must differ from API_HOST"), (API_HOST.upper(), None, "must differ from API_HOST"),
                                   (WEB_HOST, WEB_HOST, "must differ from WEB_HOST"), (WEB_HOST.upper(), WEB_HOST, "must differ from WEB_HOST")):
            with self.subTest(alias=same, web_host=web):
                self.log.write_text("")
                result, calls = self.run_pilot(web, alias=same)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"API_ALIAS_HOST {message}", result.stderr)
                self.assertEqual(calls, [])

    # [Item 8] WEB_ALIAS_HOSTS: the public names for the website on this stack.
    def test_valid_website_aliases_deploy_like_the_website_name(self):
        for aliases in (PUBLIC_ALIASES, "example.com"):
            with self.subTest(aliases=aliases):
                self.log.write_text("")
                result, calls = self.run_pilot(WEB_HOST, alias=ALIAS_HOST, web_aliases=aliases)
                self.assertEqual(result.returncode, 0, result.stderr[-800:])
                self.assertIn(f"STAGING READY at exact SHA {self.SHA}", result.stdout)

    def test_malformed_website_aliases_are_refused_before_anything_changes(self):
        for bad in ("https://example.com", "example.com/", "example.com:443", "localhost", "example", "-example.com",
                    "example.com,www.example.com", "example.com www.example.com/"):
            with self.subTest(aliases=bad):
                self.log.write_text("")
                result, calls = self.run_pilot(WEB_HOST, web_aliases=bad)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("WEB_ALIAS_HOSTS must be DNS hostnames", result.stderr)
                self.assertEqual(calls, [], "nothing may run before the settings are accepted")

    def test_website_aliases_must_differ_from_the_api_names_and_the_website_name(self):
        cases = (
            (API_HOST, None, "must differ from API_HOST"),
            (f"example.com {API_HOST.upper()}", None, "must differ from API_HOST"),
            (ALIAS_HOST, ALIAS_HOST, "must differ from API_ALIAS_HOST"),
            (ALIAS_HOST.upper(), ALIAS_HOST, "must differ from API_ALIAS_HOST"),
            (WEB_HOST, None, "must differ from WEB_HOST"),
            (f"www.example.com {WEB_HOST.upper()}", None, "must differ from WEB_HOST"),
            ("example.com EXAMPLE.com", None, "must not repeat a name"),
        )
        for aliases, api_alias, message in cases:
            with self.subTest(aliases=aliases, api_alias=api_alias):
                self.log.write_text("")
                result, calls = self.run_pilot(WEB_HOST, alias=api_alias, web_aliases=aliases)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"WEB_ALIAS_HOSTS {message}", result.stderr)
                self.assertEqual(calls, [])

    def test_website_aliases_need_the_website(self):
        for web_host in (None, ""):
            with self.subTest(web_host=web_host):
                self.log.write_text("")
                result, calls = self.run_pilot(web_host, web_aliases="example.com")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("WEB_ALIAS_HOSTS needs WEB_HOST", result.stderr)
                self.assertEqual(calls, [])

    # [Item 7] The pre-launch switch is baked into the website build.
    def test_the_pre_launch_switch_is_live_or_nothing(self):
        for value in ("", "live"):
            with self.subTest(web_ordering=value):
                self.log.write_text("")
                result, calls = self.run_pilot(WEB_HOST, web_ordering=value)
                self.assertEqual(result.returncode, 0, result.stderr[-800:])
        for value in ("Live", "LIVE", "true", "1", "yes", "soon"):
            with self.subTest(web_ordering=value):
                self.log.write_text("")
                result, calls = self.run_pilot(WEB_HOST, web_ordering=value)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("WEB_ORDERING must be live or empty", result.stderr)
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

    def test_the_runbook_says_how_to_serve_the_public_names_and_what_the_front_door_is(self):
        # [Item 8 · DS628] Serving swiftgy.com and www from this stack, whether they are indexed,
        # the pre-launch switch, and the plain fact that the front door is presentation-only.
        runbook = (DEPLOY / "PILOT-RUNBOOK.md").read_text()
        start = runbook.index("Serving the public site from this stack")
        end = runbook.find("\n## ", start)
        section = runbook[start:end if end != -1 else len(runbook)]
        for needle in ("WEB_ALIAS_HOSTS=swiftgy.com www.swiftgy.com", "WEB_ORDERING=live", "presentation-only",
                       "open to the apps", "CORS_ORIGIN", "does not open ordering", "x-robots-tag",
                       "301", ".well-known"):
            self.assertIn(needle, section)
        # Section 3b no longer claims the image marks every name noindex.
        start_3b = runbook.index("Serving the website on staging")
        section_3b = runbook[start_3b:runbook.find("\n## ", start_3b)]
        self.assertIn("only on the staging name", section_3b)


# ===========================================================================
# [ADMIN-CONSOLE] The admin console (apps/admin), optional behind ADMIN_HOST,
# so partner documents can be approved and rejected on staging. A stack
# without ADMIN_HOST is exactly the stack it was: the service is
# profile-gated, no request can reach its route, and pilot-up.sh runs nothing
# new. Set, the console joins the API's Caddy site under its own name and its
# own route, behind an OPTIONAL second gate (HTTP basic authentication from
# ADMIN_BASIC_AUTH_HASH, a bcrypt hash: the password never reaches the host)
# in front of its own sign-in (a staff phone and a one-time code, ADMIN or
# SUPER_ADMIN only, decided by the API).
# ===========================================================================

ADMIN_HOST = "admin-staging.example.com"
ADMIN_DOCKERFILE = DEPLOY.parent / "apps" / "admin" / "Dockerfile"
# The SHAPE of a bcrypt hash, as deploy/.env carries it: single-quoted, so
# Compose never reads its `$` signs as variables. No password produces it.
SHAPE_ONLY_HASH = "$2y$12$" + "a" * 53
GATE_SETTING = f"'{SHAPE_ONLY_HASH}'"


def code_lines(text: str) -> list:
    """Non-empty Caddyfile lines without comments, whitespace collapsed."""
    lines = (" ".join(raw.split("#", 1)[0].split()) for raw in text.splitlines())
    return [line for line in lines if line]


def block_from(lines: list, opener: str) -> list:
    """The lines of one block, from its opening line to its closing brace."""
    start = lines.index(opener)
    depth = 0
    for end in range(start, len(lines)):
        depth += lines[end].count("{") - lines[end].count("}")
        if depth == 0:
            return lines[start:end + 1]
    raise AssertionError(f"unterminated block: {opener}")


class AdminConsoleCompose(unittest.TestCase):
    def admin(self) -> str:
        return service_block(DEPLOY / "docker-compose.yml", "admin")

    def test_the_console_is_profile_gated_private_and_portless(self):
        admin = self.admin()
        self.assertIn('profiles: ["admin"]', admin)
        self.assertNotRegex(admin, r"(?m)^    (ports|expose|network_mode|privileged|extra_hosts|cap_add|devices):")
        self.assertIn("networks: [private]", admin)

    def test_the_console_waits_on_nothing_and_reads_no_settings_file_secret_or_gate(self):
        admin = self.admin()
        self.assertNotRegex(admin, r"(?m)^    (depends_on|env_file|volumes|secrets):")
        self.assertNotIn("/run/secrets", admin)
        self.assertNotIn("_FILE:", admin)
        # The gate is Caddy's: the console never holds its hash.
        self.assertNotIn("ADMIN_BASIC_AUTH", admin)

    def test_the_image_is_built_for_this_stacks_public_api_and_takes_no_other_input(self):
        admin = self.admin()
        self.assertIn("dockerfile: apps/admin/Dockerfile", admin)
        self.assertIn("image: swift-admin:${SWIFT_TAG:-local}", admin)
        self.assertEqual(re.findall(r"(?m)^        ([A-Z][A-Z0-9_]*): (.*)$", admin),
                         [("NEXT_PUBLIC_API_URL", "https://${API_HOST:-localhost}")])

    def test_the_console_has_a_memory_ceiling_that_v8_collects_below(self):
        admin = self.admin()
        limit = re.search(r"(?m)^    mem_limit: (\d+)m$", admin)
        heap = re.search(r"--max-old-space-size=(\d+)", admin)
        self.assertIsNotNone(limit, "the admin service needs a mem_limit")
        self.assertIsNotNone(heap, "the admin service must cap the V8 heap under its mem_limit")
        self.assertLess(int(heap.group(1)), int(limit.group(1)))

    def test_caddy_gets_the_console_name_and_the_gate_with_empty_defaults_and_never_waits_on_it(self):
        caddy = service_block(DEPLOY / "docker-compose.yml", "caddy")
        self.assertIn("ADMIN_HOST: ${ADMIN_HOST:-}", caddy)
        self.assertIn("ADMIN_BASIC_AUTH_HASH: ${ADMIN_BASIC_AUTH_HASH:-}", caddy)
        # The gate's user exists exactly when the hash does, from the ONE
        # setting: the Caddyfile keys the gate on it and cannot parse one
        # without the other.
        self.assertIn("ADMIN_BASIC_AUTH_USER: ${ADMIN_BASIC_AUTH_HASH:+admin}", caddy)
        self.assertNotRegex(caddy, r"(?m)^      admin:")


@unittest.skipUnless(shutil.which("docker"), "Docker CLI not installed")
class AdminConsoleRenderedByCompose(unittest.TestCase):
    """The real file, rendered by `docker compose config` (client-side; no daemon)."""

    BASE = ("NODE_ENV=development\nPILOT_ENV=staging\nAPI_HOST=api-staging.example.invalid\n"
            "ADMIN_HOST=admin-staging.example.invalid\n")

    def render(self, extra="", *profile):
        with tempfile.TemporaryDirectory() as tmp:
            here = Path(tmp) / "deploy"
            here.mkdir()
            shutil.copy(DEPLOY / "docker-compose.yml", here / "docker-compose.yml")
            (here / ".env").write_text(self.BASE + extra)
            result = subprocess.run(
                ["docker", "compose", "--project-directory", str(here), "-f", str(here / "docker-compose.yml"),
                 *profile, "config", "--format", "json"],
                text=True, capture_output=True, timeout=60,
            )
            if result.returncode != 0 and "unknown" in result.stderr.lower():
                self.skipTest(f"docker compose cannot render here: {result.stderr.strip()[:120]}")
            self.assertEqual(result.returncode, 0, result.stderr[:400])
            return json.loads(result.stdout)

    def test_without_the_profile_the_stack_has_no_console(self):
        self.assertNotIn("admin", self.render()["services"])

    def test_with_the_profile_the_console_is_private_and_built_for_this_api(self):
        model = self.render("", "--profile", "admin")
        admin = model["services"]["admin"]
        self.assertNotIn("ports", admin)
        self.assertEqual(list((admin.get("networks") or {}).keys()), ["private"])
        self.assertEqual(sorted((admin.get("environment") or {}).keys()), ["NODE_OPTIONS"])
        self.assertEqual(admin["build"]["args"], {"NEXT_PUBLIC_API_URL": "https://api-staging.example.invalid"})
        self.assertEqual(model["services"]["caddy"]["environment"]["ADMIN_HOST"], "admin-staging.example.invalid")
        # pilot-up's isolation check passes with the console in the model.
        check = subprocess.run(
            ["python3", str(DEPLOY / "verify-journeys-isolation.py"), str(DEPLOY / "Caddyfile")],
            input=json.dumps(model), text=True, capture_output=True, timeout=10,
        )
        self.assertEqual(check.returncode, 0, check.stderr)

    def test_the_gate_user_exists_exactly_when_the_hash_does(self):
        for extra, user, hashed in (("", "", ""), ("ADMIN_BASIC_AUTH_HASH=\n", "", ""),
                                    (f"ADMIN_BASIC_AUTH_HASH={GATE_SETTING}\n", "admin", SHAPE_ONLY_HASH)):
            with self.subTest(extra=extra):
                env = self.render(extra)["services"]["caddy"]["environment"]
                self.assertEqual(env["ADMIN_BASIC_AUTH_USER"], user)
                # `compose config` prints a literal `$` as `$$`, so its model reads back unchanged.
                self.assertEqual(env["ADMIN_BASIC_AUTH_HASH"].replace("$$", "$"), hashed)


class AdminConsoleCaddyfile(unittest.TestCase):
    TEXT = (DEPLOY / "Caddyfile").read_text()

    def site(self, **env):
        [[addresses, body]] = top_level_blocks(caddy_render(self.TEXT, env))
        return addresses, [" ".join(line.split()) for line in body]

    def test_an_unset_or_empty_admin_host_leaves_the_site_exactly_as_it_was(self):
        for env in ({"API_HOST": API_HOST}, {"API_HOST": API_HOST, "ADMIN_HOST": ""},
                    {"API_HOST": API_HOST, "WEB_HOST": WEB_HOST, "ADMIN_HOST": ""}):
            with self.subTest(env=env):
                addresses, body = self.site(**env)
                self.assertEqual(addresses, [name for name in (API_HOST, env.get("WEB_HOST")) if name])
                # The console's route keys on a reserved name that is never an
                # address of this site, so no request reaches it.
                self.assertIn("@admin host admin.invalid", body)

    def test_a_set_admin_host_joins_the_site_and_its_route_comes_first(self):
        addresses, body = self.site(API_HOST=API_HOST, WEB_HOST=WEB_HOST, ADMIN_HOST=ADMIN_HOST)
        self.assertEqual(addresses, [API_HOST, WEB_HOST, ADMIN_HOST])
        self.assertEqual(body[:2], ["encode zstd gzip", f"@admin host {ADMIN_HOST} admin.invalid"])
        self.assertIn("reverse_proxy admin:3000 {", block_from(body, "handle @admin {"))
        # The console's name is no API name, and the website stays the catch-all.
        self.assertEqual([line for line in body if line.startswith("@api host")], [f"@api host {API_HOST}"])
        self.assertEqual(body[-3:], ["handle {", "reverse_proxy web:3000", "}"])

    def test_the_console_matcher_always_has_an_argument(self):
        # A host matcher with no argument parses, then stops Caddy loading the
        # WHOLE configuration, the API included ("module value cannot be null").
        code = code_lines(self.TEXT)
        self.assertEqual([line for line in code if line.startswith("@admin host")],
                         ["@admin host {$ADMIN_HOST} admin.invalid"])
        site = [line for line in code if line.startswith("{$API_HOST}")]
        self.assertEqual(len(site), 1)
        self.assertNotIn("admin.invalid", site[0])

    def test_the_gate_and_the_credential_strip_belong_to_the_console_route_alone(self):
        code = code_lines(self.TEXT)
        self.assertEqual(block_from(code, "handle @admin {"), [
            "handle @admin {",
            '@admin_gate expression `"{$ADMIN_BASIC_AUTH_USER}" != ""`',
            "basic_auth @admin_gate {",
            "{$ADMIN_BASIC_AUTH_USER} {$ADMIN_BASIC_AUTH_HASH}",
            "}",
            "reverse_proxy admin:3000 {",
            "header_up -Authorization",
            "}",
            "}",
        ])
        # Nowhere else: the API and the website never sit behind the console's gate.
        self.assertEqual(sum(line.startswith("basic_auth") for line in code), 1)
        self.assertEqual(sum("ADMIN_BASIC_AUTH" in line for line in code), 2)

    def test_no_password_hash_is_written_into_the_repository(self):
        for name in ("Caddyfile", "docker-compose.yml", ".env.deploy.example", "pilot-up.sh", "PILOT-RUNBOOK.md"):
            with self.subTest(file=name):
                self.assertNotRegex((DEPLOY / name).read_text(), r"\$2[aby]?\$\d\d\$[./A-Za-z0-9]{53}")


@unittest.skipUnless(caddy_image_present(), "docker or the caddy:2.10 image is not available locally")
class AdminConsoleCaddyfileRenderedByCaddy(unittest.TestCase):
    """The real Caddyfile through the stack's pinned Caddy (no network, no pull)."""

    # Live runs only: a test-only global block swaps ACME for Caddy's own local
    # CA (nothing leaves the container), and a stand-in on :3000 answers for
    # the console and echoes any Authorization header that reaches it.
    LIVE_PREFIX = "{\n    local_certs\n    skip_install_trust\n    admin off\n}\n"
    STAND_IN = '\nhttp://:3000 {\n    respond "authorization=[{http.request.header.Authorization}]" 200\n}\n'

    @classmethod
    def setUpClass(cls):
        # A real bcrypt hash of a password that exists only in this process.
        cls.password = secrets.token_urlsafe(18)
        made = subprocess.run(["docker", "run", "--rm", "--network", "none", "caddy:2.10",
                               "caddy", "hash-password", "--plaintext", cls.password],
                              text=True, capture_output=True, timeout=60)
        if made.returncode != 0:
            raise AssertionError(made.stderr[-300:])
        cls.hash = made.stdout.strip()

    def gate(self, on: bool) -> dict:
        return {"API_HOST": API_HOST, "ADMIN_HOST": ADMIN_HOST,
                "ADMIN_BASIC_AUTH_USER": "admin" if on else "", "ADMIN_BASIC_AUTH_HASH": self.hash if on else ""}

    def caddy(self, command, env):
        args = ["docker", "run", "--rm", "--network", "none"]
        for name, value in env.items():
            args += ["-e", f"{name}={value}"]
        args += ["-v", f"{DEPLOY / 'Caddyfile'}:/etc/caddy/Caddyfile:ro", "caddy:2.10",
                 "caddy", command, "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
        return subprocess.run(args, text=True, capture_output=True, timeout=60)

    def site_routes(self, env):
        validated = self.caddy("validate", env)
        self.assertEqual(validated.returncode, 0, validated.stderr[-600:])
        adapted = self.caddy("adapt", env)
        self.assertEqual(adapted.returncode, 0, adapted.stderr[-600:])
        routes = json.loads(adapted.stdout)["apps"]["http"]["servers"]["srv0"]["routes"]
        hosts = [m["host"] for route in routes for m in route.get("match", []) if "host" in m]
        inner = routes[0]["handle"][0]["routes"]
        [console] = [r for r in inner if any("admin.invalid" in m.get("host", []) for m in r.get("match", []))]
        return hosts, console

    def accounts(self, console) -> list:
        found = re.findall(r'"accounts": (\[.*?\])', json.dumps(console))
        return [account["username"] for listing in found for account in json.loads(listing)]

    def test_without_admin_host_it_validates_and_serves_exactly_what_it_did(self):
        for env in ({"API_HOST": API_HOST},
                    {"API_HOST": API_HOST, "ADMIN_HOST": "", "ADMIN_BASIC_AUTH_USER": "", "ADMIN_BASIC_AUTH_HASH": ""}):
            with self.subTest(env=env):
                hosts, console = self.site_routes(env)
                self.assertEqual(hosts, [[API_HOST]])
                self.assertEqual(console["match"], [{"host": ["admin.invalid"]}])

    def test_a_set_admin_host_is_served_beside_the_api_with_the_gate_on_or_off(self):
        for on in (False, True):
            with self.subTest(gate=on):
                hosts, console = self.site_routes(self.gate(on))
                self.assertEqual(hosts, [[API_HOST, ADMIN_HOST]])
                self.assertEqual(console["match"], [{"host": [ADMIN_HOST, "admin.invalid"]}])
                self.assertIn('"dial": "admin:3000"', json.dumps(console))
                self.assertEqual(self.accounts(console), ["admin"] if on else [])

    def test_a_half_configured_gate_refuses_to_load_rather_than_serve_the_console_ungated(self):
        for user, hashed in (("", self.hash), ("admin", "")):
            with self.subTest(user=user):
                env = {**self.gate(False), "ADMIN_BASIC_AUTH_USER": user, "ADMIN_BASIC_AUTH_HASH": hashed}
                result = self.caddy("validate", env)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("username and password cannot be empty or missing", result.stderr)

    def serve(self, env) -> str:
        tmp = Path(tempfile.mkdtemp(prefix="swift-admin-caddy-test-"))
        self.addCleanup(shutil.rmtree, tmp, True)
        (tmp / "Caddyfile").write_text(self.LIVE_PREFIX + (DEPLOY / "Caddyfile").read_text() + self.STAND_IN)
        name = f"swift-admin-caddy-test-{secrets.token_hex(4)}"
        args = ["docker", "run", "-d", "--name", name, "--network", "none"]
        for host in (API_HOST, ADMIN_HOST, "admin"):
            args += ["--add-host", f"{host}:127.0.0.1"]
        for key, value in env.items():
            args += ["-e", f"{key}={value}"]
        args += ["-v", f"{tmp / 'Caddyfile'}:/etc/caddy/Caddyfile:ro", "caddy:2.10",
                 "caddy", "run", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"]
        started = subprocess.run(args, text=True, capture_output=True, timeout=60)
        self.assertEqual(started.returncode, 0, started.stderr[-400:])
        self.addCleanup(subprocess.run, ["docker", "rm", "-f", name], capture_output=True, timeout=60)
        for _ in range(60):
            if self.fetch(name, f"https://{API_HOST}/metrics")[0] == 403:
                return name
            time.sleep(0.5)
        self.fail("the test Caddy never answered")

    @staticmethod
    def fetch(name, url, credential=None):
        """(status, output) of one HTTPS request made inside the container."""
        header = ""
        if credential:
            header = f" --header 'Authorization: Basic {base64.b64encode(credential.encode()).decode()}'"
        out = subprocess.run(["docker", "exec", name, "sh", "-c", f"wget -S -O - --no-check-certificate{header} '{url}' 2>&1"],
                             text=True, capture_output=True, timeout=30).stdout
        status = re.search(r"HTTP/1\.1 (\d{3})", out)
        return (int(status.group(1)) if status else 0), out

    def test_live_the_gate_keeps_a_stranger_out_and_the_api_where_it_was(self):
        name = self.serve(self.gate(True))
        console = f"https://{ADMIN_HOST}/login"
        self.assertEqual(self.fetch(name, console)[0], 401)
        self.assertEqual(self.fetch(name, console, "admin:not-the-password")[0], 401)
        self.assertEqual(self.fetch(name, console, f"someone-else:{self.password}")[0], 401)
        status, out = self.fetch(name, console, f"admin:{self.password}")
        self.assertEqual(status, 200, out[-300:])
        # The gate's credential stops at the gate: the console never receives it.
        self.assertIn("authorization=[]", out)
        # The API keeps its route and its guard; the console's name never reaches it.
        self.assertEqual(self.fetch(name, f"https://{API_HOST}/metrics")[0], 403)
        self.assertEqual(self.fetch(name, f"https://{ADMIN_HOST}/metrics")[0], 401)

    def test_live_without_the_gate_the_console_answers_and_never_sees_an_authorization_header(self):
        name = self.serve(self.gate(False))
        status, out = self.fetch(name, f"https://{ADMIN_HOST}/login", "anyone:anything")
        self.assertEqual(status, 200, out[-300:])
        self.assertIn("authorization=[]", out)
        # The console's own route, never the API's guard.
        self.assertEqual(self.fetch(name, f"https://{ADMIN_HOST}/metrics")[0], 200)


class AdminConsoleDockerfile(unittest.TestCase):
    def setUp(self):
        self.assertTrue(ADMIN_DOCKERFILE.is_file(), "apps/admin/Dockerfile is missing")
        self.text = ADMIN_DOCKERFILE.read_text()
        self.stages = dockerfile_stages(ADMIN_DOCKERFILE)

    def test_the_final_stage_is_the_runtime_and_runs_as_non_root(self):
        self.assertEqual(list(self.stages)[-1], "runtime")
        runtime = self.stages["runtime"]
        self.assertRegex(runtime, r"(?m)^USER node$")
        after_user = runtime[runtime.index("USER node") + len("USER node"):]
        self.assertNotRegex(after_user, r"(?m)^USER ")
        self.assertIn("CMD ", after_user)

    def test_the_public_api_origin_is_the_only_build_input(self):
        build = self.stages["build"]
        declared = re.search(r"(?m)^ARG NEXT_PUBLIC_API_URL$", build)
        self.assertIsNotNone(declared, "NEXT_PUBLIC_API_URL must be a build ARG with no baked-in default")
        self.assertLess(declared.start(), build.index("RUN pnpm run build"))
        self.assertEqual(re.findall(r"(?m)^ARG (\S+)", self.text), ["NEXT_PUBLIC_API_URL"])
        self.assertIn("ENV SWIFT_ADMIN_IMAGE_BUILD=1", build)
        # A public variable in the runtime would claim a setting the bundle cannot change.
        self.assertNotIn("NEXT_PUBLIC_", self.stages["runtime"])

    def test_no_secret_is_an_argument_or_a_baked_setting(self):
        names = re.findall(r"(?m)^ARG (\S+)", self.text)
        for line in re.findall(r"(?m)^ENV (.*)$", self.text):
            names += re.findall(r"([A-Z][A-Z0-9_]*)=", line)
        self.assertTrue(names)
        for name in names:
            self.assertNotRegex(name, r"SECRET|TOKEN|PASSWORD|PASSWD|KEY|HASH|CREDENTIAL|AUTH", name)
        # The build context never carries a settings file: every .env stays out.
        ignored = (DEPLOY.parent / ".dockerignore").read_text().splitlines()
        for pattern in (".env", ".env.*", "**/.env", "**/.env.*"):
            self.assertIn(pattern, ignored)

    def test_it_installs_the_workspace_like_the_api_image(self):
        deps = self.stages["deps"]
        self.assertIn("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./", deps)
        self.assertIn("COPY apps/admin/package.json apps/admin/", deps)
        self.assertIn("COPY packages/ packages/", deps)
        self.assertIn("pnpm install --frozen-lockfile", deps)
        self.assertIn("--mount=type=cache,id=pnpm,target=/pnpm/store", deps)
        for other in ("api", "web", "mobile", "desktop"):
            self.assertNotIn(f"apps/{other}/", self.text)

    def test_it_runs_the_standalone_server_and_probes_it(self):
        runtime = self.stages["runtime"]
        self.assertIn("COPY --from=build --chown=node:node /app/apps/admin/.next/standalone ./", runtime)
        self.assertIn("/app/apps/admin/.next/static ./apps/admin/.next/static", runtime)
        self.assertIn("ENV HOSTNAME=0.0.0.0 PORT=3000", runtime)
        self.assertRegex(runtime, r"(?m)^HEALTHCHECK .*\\\n.*/login")
        self.assertIn('CMD ["node", "server.js"]', runtime)


FAKE_ADMIN_PILOT_DOCKER = r"""#!/usr/bin/env python3
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
        print(os.environ.get("ADMIN_HEALTH", "healthy") if target == "admin-id" else "healthy")
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
        for i, arg in enumerate(argv[:-1]):
            if arg == "--profile":
                services[argv[i + 1]] = {}
        print(json.dumps({"services": services}))
    sys.exit(0)
if argv[:1] == ["compose"] and "ps" in argv and "-q" in argv:
    print(argv[-1] + "-id")
sys.exit(0)
"""


class AdminConsolePilotUp(unittest.TestCase):
    """The real pilot-up.sh, end to end, against shims for docker, git, curl,
    sudo, systemctl, the secret store and sleep. Nothing is deployed. The
    fake curl answers the console's sign-in page with $ADMIN_CODE."""

    SHA = "d" * 40

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-pilot-admin-test-"))
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
        docker.write_text(FAKE_ADMIN_PILOT_DOCKER)
        docker.chmod(0o755)
        sh_shim(self.bin, "git", 'echo "git $*" >> "$CALL_LOG"\n[ "$*" = "rev-parse HEAD" ] && echo "$GIT_HEAD"\nexit 0')
        sh_shim(self.bin, "curl", 'echo "curl $*" >> "$CALL_LOG"\n'
                'case "$*" in *"https://$ADMIN_SITE/login"*) printf "%s" "${ADMIN_CODE:-200}";; esac\nexit 0')
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        sh_shim(self.bin, "sudo", '[ "$1" = -n ] && shift\nexec "$@"')
        sh_shim(self.bin, "swift-secrets", '[ "$1" = list ] && printf "%s\\n" $STORE_NAMES\nexit 0')
        sh_shim(self.bin, "systemctl", 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0')
        sh_shim(self.bin, "sleep", "exit 0")
        compose = (DEPLOY / "docker-compose.yml").read_text()
        self.store = " ".join(sorted(set(re.findall(r"_FILE: /run/secrets/([A-Z][A-Z0-9_]*)", compose))
                                     | {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}))

    def run_pilot(self, admin_host=None, *, web_host=None, alias=None, web_aliases=None, cors=None, gate=None, **extra):
        site = admin_host or ADMIN_HOST
        settings = (f"PILOT_ENV=staging\nAPI_HOST={API_HOST}\nMAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\n"
                    "BACKUP_BUCKET=test-backups\nNODE_ENV=development\n")
        settings += f"CORS_ORIGIN={cors if cors is not None else f'https://{WEB_HOST},https://{site}'}\n"
        for name, value in (("WEB_HOST", web_host), ("API_ALIAS_HOST", alias), ("WEB_ALIAS_HOSTS", web_aliases),
                            ("ADMIN_HOST", admin_host), ("ADMIN_BASIC_AUTH_HASH", gate)):
            if value is not None:
                settings += f"{name}={value}\n"
        (self.here / ".env").write_text(settings)
        env = os.environ.copy()
        env.update({"PATH": f"{self.bin}:{env['PATH']}", "CALL_LOG": str(self.log), "GIT_HEAD": self.SHA,
                    "STORE_NAMES": self.store, "ADMIN_SITE": site})
        env.update(extra)
        self.log.write_text("")
        result = subprocess.run(["bash", str(self.here / "pilot-up.sh"), self.SHA],
                                env=env, text=True, capture_output=True, timeout=120, stdin=subprocess.DEVNULL)
        return result, self.log.read_text().splitlines()

    @staticmethod
    def first(calls, fragment):
        return next(i for i, call in enumerate(calls) if fragment in call)

    def refused_before_anything_changes(self, result, calls, message):
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
        self.assertEqual(calls, [], "nothing may run before the settings are accepted")

    def test_without_admin_host_nothing_about_the_console_runs(self):
        for admin_host in (None, ""):
            with self.subTest(admin_host=admin_host):
                result, calls = self.run_pilot(admin_host)
                self.assertEqual(result.returncode, 0, result.stderr[-800:])
                self.assertIn(f"STAGING READY at exact SHA {self.SHA}", result.stdout)
                self.assertNotIn("ADMIN CONSOLE", result.stdout)
                self.assertFalse([c for c in calls if "--profile admin" in c or c.endswith(" admin") or "/login" in c], calls)

    def test_with_admin_host_the_console_builds_before_anything_stops_and_starts_after_the_api_is_ready(self):
        result, calls = self.run_pilot(ADMIN_HOST)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        # Every compose call sees the console, so the port and isolation checks cover it.
        compose = [c for c in calls if c.startswith("docker compose") and "docker-compose.routing.yml" not in c]
        self.assertTrue(compose)
        self.assertEqual([c for c in compose if "--profile admin" not in c], [])
        built = self.first(calls, " build admin")
        self.assertLess(self.first(calls, " build api"), built)
        self.assertLess(built, self.first(calls, " stop api worker"))
        api_ready = self.first(calls, f"https://{API_HOST}/ready")
        started = self.first(calls, "up -d --no-deps --force-recreate admin")
        self.assertLess(api_ready, started)
        probe = self.first(calls, f"--resolve {ADMIN_HOST}:443:127.0.0.1")
        self.assertLess(started, probe)
        self.assertIn(f"https://{ADMIN_HOST}/login", calls[probe])
        self.assertIn(f"ADMIN CONSOLE READY at https://{ADMIN_HOST} (exact SHA {self.SHA}; extra sign-in gate off)",
                      result.stdout)
        self.assertIn(f"STAGING READY at exact SHA {self.SHA}", result.stdout)

    def test_with_the_website_too_both_profiles_ride_every_compose_call(self):
        result, calls = self.run_pilot(ADMIN_HOST, web_host=WEB_HOST)
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        compose = [c for c in calls if c.startswith("docker compose") and "docker-compose.routing.yml" not in c]
        self.assertEqual([c for c in compose if "--profile web" not in c or "--profile admin" not in c], [])
        self.assertIn(f"WEBSITE READY at https://{WEB_HOST}", result.stdout)
        self.assertIn(f"ADMIN CONSOLE READY at https://{ADMIN_HOST}", result.stdout)

    def test_with_the_gate_the_deploy_succeeds_only_once_the_console_refuses_a_stranger(self):
        result, _ = self.run_pilot(ADMIN_HOST, gate=GATE_SETTING, ADMIN_CODE="401")
        self.assertEqual(result.returncode, 0, result.stderr[-800:])
        self.assertIn(f"ADMIN CONSOLE READY at https://{ADMIN_HOST} (exact SHA {self.SHA}; extra sign-in gate on)",
                      result.stdout)
        for code in ("200", "302", "502", "000"):
            with self.subTest(code=code):
                result, calls = self.run_pilot(ADMIN_HOST, gate=GATE_SETTING, ADMIN_CODE=code)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"https://{ADMIN_HOST}/login answered {code}, not 401", result.stderr)
                self.assertIn(f"the API is serving {self.SHA}", result.stderr)
                self.assertNotIn("ADMIN CONSOLE READY", result.stdout)
                self.assertNotIn(SHAPE_ONLY_HASH, result.stdout + result.stderr)

    def test_without_the_gate_the_console_must_answer_its_sign_in_page(self):
        for code in ("401", "502", "000"):
            with self.subTest(code=code):
                result, _ = self.run_pilot(ADMIN_HOST, ADMIN_CODE=code)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(f"https://{ADMIN_HOST}/login answered {code}, not 200", result.stderr)
                self.assertNotIn("ADMIN CONSOLE READY", result.stdout)

    def test_a_malformed_admin_host_is_refused_before_anything_changes(self):
        for bad in ("https://admin.example.com", "admin.example.com/", "admin.example.com:443", "localhost",
                    "admin", "-admin.example.com", "admin example.com"):
            with self.subTest(admin_host=bad):
                result, calls = self.run_pilot(bad)
                self.refused_before_anything_changes(result, calls, "ADMIN_HOST must be a DNS hostname")

    def test_admin_host_must_differ_from_every_other_name_on_this_stack(self):
        cases = (
            (API_HOST, {}, "API_HOST"),
            (API_HOST.upper(), {}, "API_HOST"),
            (ALIAS_HOST.upper(), {"alias": ALIAS_HOST}, "API_ALIAS_HOST"),
            (WEB_HOST.upper(), {"web_host": WEB_HOST}, "WEB_HOST"),
            ("WWW.example.com", {"web_host": WEB_HOST, "web_aliases": "example.com www.example.com"}, "WEB_ALIAS_HOSTS"),
        )
        for admin_host, others, name in cases:
            with self.subTest(admin_host=admin_host, others=others):
                result, calls = self.run_pilot(admin_host, **others)
                self.refused_before_anything_changes(result, calls, f"ADMIN_HOST must differ from {name}")

    def test_the_api_must_admit_the_console_origin(self):
        message = f"CORS_ORIGIN must include https://{ADMIN_HOST}"
        for cors in ("", f"https://{WEB_HOST}", f"http://{ADMIN_HOST}", f"https://{ADMIN_HOST}.example.net",
                     f"https://x{ADMIN_HOST}", f"https://{ADMIN_HOST}:8443"):
            with self.subTest(cors=cors):
                result, calls = self.run_pilot(ADMIN_HOST, cors=cors)
                self.refused_before_anything_changes(result, calls, message)
        for cors in (f"https://{ADMIN_HOST}", f"https://{WEB_HOST}, https://{ADMIN_HOST.upper()}",
                     f"https://{ADMIN_HOST}/", f'"https://{WEB_HOST},https://{ADMIN_HOST}"'):
            with self.subTest(cors=cors):
                result, _ = self.run_pilot(ADMIN_HOST, cors=cors)
                self.assertEqual(result.returncode, 0, result.stderr[-800:])

    def test_the_gate_setting_is_a_single_quoted_bcrypt_hash_of_real_cost_or_nothing(self):
        for good in (GATE_SETTING, "'$2a$14$" + "B" * 53 + "'", "'$2b$10$" + "./" * 26 + "c'"):
            with self.subTest(gate=good):
                result, _ = self.run_pilot(ADMIN_HOST, gate=good, ADMIN_CODE="401")
                self.assertEqual(result.returncode, 0, result.stderr[-800:])
        for bad in (SHAPE_ONLY_HASH, f'"{SHAPE_ONLY_HASH}"', f"'{SHAPE_ONLY_HASH}", "'$2y$09$" + "a" * 53 + "'",
                    "'$2y$04$" + "a" * 53 + "'", "'$2y$12$" + "a" * 52 + "'", "'$2y$12$" + "a" * 54 + "'",
                    "'$1$salt$" + "a" * 22 + "'", "'a-plain-password-here'"):
            with self.subTest(gate=bad):
                result, calls = self.run_pilot(ADMIN_HOST, gate=bad, ADMIN_CODE="401")
                self.refused_before_anything_changes(result, calls, "ADMIN_BASIC_AUTH_HASH must be a bcrypt hash")
                # The refusal names the setting, never its value.
                self.assertNotIn(bad.strip("'\""), result.stdout + result.stderr)
        result, _ = self.run_pilot(ADMIN_HOST, gate="")
        self.assertEqual(result.returncode, 0, result.stderr[-800:])

    def test_a_gate_without_the_console_is_refused(self):
        for admin_host in (None, ""):
            with self.subTest(admin_host=admin_host):
                result, calls = self.run_pilot(admin_host, gate=GATE_SETTING)
                self.refused_before_anything_changes(result, calls, "ADMIN_BASIC_AUTH_HASH needs ADMIN_HOST")

    def test_a_console_that_does_not_build_leaves_the_running_stack_untouched(self):
        result, calls = self.run_pilot(ADMIN_HOST, FAIL_ON="build admin")
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse([c for c in calls if " stop " in c or " up " in c], calls)

    def test_a_console_that_never_becomes_healthy_fails_the_deploy_and_says_the_api_is_serving(self):
        result, calls = self.run_pilot(ADMIN_HOST, ADMIN_HEALTH="unhealthy")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(f"https://{ADMIN_HOST}", result.stderr)
        self.assertIn(f"the API is serving {self.SHA}", result.stderr)
        self.assertNotIn("STAGING READY", result.stdout)
        self.assertTrue(any(c.endswith("up -d --no-deps --force-recreate api worker") for c in calls))


class AdminConsoleDocs(unittest.TestCase):
    def section(self) -> str:
        runbook = (DEPLOY / "PILOT-RUNBOOK.md").read_text()
        start = runbook.index("Serving the admin console on staging")
        end = runbook.find("\n## ", start)
        return runbook[start:end if end != -1 else len(runbook)]

    def test_the_runbook_says_how_to_serve_gate_and_verify_the_console(self):
        section = self.section()
        for needle in ("A record", "DNS only", "ADMIN_HOST=admin-staging.swiftgy.com", "CORS_ORIGIN",
                       "https://admin-staging.swiftgy.com", "ADMIN_BASIC_AUTH_HASH", "htpasswd -nBC 12",
                       "single quotes", "./deploy/pilot-up.sh", '--resolve "$ADMIN_HOST:443:127.0.0.1"',
                       "X-Robots-Tag", "ADMIN or SUPER_ADMIN", "separate browser profile"):
            self.assertIn(needle, section)

    def test_the_runbook_says_how_the_owner_becomes_an_admin_without_skipping_the_two_person_rule(self):
        section = self.section()
        # Each approver signs the printed request with their own key on their
        # own machine (deploy/seed-approve.sh); no private key reaches the server.
        for needle in ("6b", "deploy/seed-approve.sh", "with their own key", "SEED_PROMOTION_APPROVALS",
                       "two different people", "no private key"):
            self.assertIn(needle, section)

    def test_the_example_settings_document_both_and_leave_them_empty(self):
        example = (DEPLOY / ".env.deploy.example").read_text()
        self.assertRegex(example, r"(?m)^ADMIN_HOST=$")
        self.assertRegex(example, r"(?m)^ADMIN_BASIC_AUTH_HASH=$")


# ===========================================================================
# [STORE-1] API_ALIAS_HOST: an optional SECOND DNS name for the same API. The
# store build of the app is fixed to the production name (api.swiftgy.com);
# until a production stack exists, that name points at this one. The alias must
# reach the API, never the website, and an unset alias changes nothing.
# ===========================================================================

ALIAS_HOST = "api.example.com"


class StoreApiAliasHost(unittest.TestCase):
    def blocks(self, env: dict):
        return top_level_blocks(caddy_render((DEPLOY / "Caddyfile").read_text(), env))

    def test_an_unset_alias_leaves_the_api_and_website_exactly_as_before(self):
        for env in ({"API_HOST": API_HOST}, {"API_HOST": API_HOST, "API_ALIAS_HOST": ""}):
            [[addresses, body]] = self.blocks(env)
            self.assertEqual(addresses, [API_HOST])
            self.assertIn(f"@api host {API_HOST}", body)

    def test_the_alias_is_served_with_its_own_certificate_and_routed_to_the_api(self):
        [[addresses, body]] = self.blocks({"API_HOST": API_HOST, "API_ALIAS_HOST": ALIAS_HOST, "WEB_HOST": WEB_HOST})
        self.assertEqual(addresses, [API_HOST, ALIAS_HOST, WEB_HOST])
        # Requests are split on the matcher: a host missing from it would be
        # served the WEBSITE. The alias must be an API host.
        self.assertIn(f"@api host {API_HOST} {ALIAS_HOST}", body)
        self.assertNotIn(f"@api host {API_HOST} {ALIAS_HOST} {WEB_HOST}", body)

    def test_caddy_gets_the_alias_with_an_empty_default(self):
        caddy = service_block(DEPLOY / "docker-compose.yml", "caddy")
        self.assertIn("API_ALIAS_HOST: ${API_ALIAS_HOST:-}", caddy)


# ===========================================================================
# [Item 8] WEB_ALIAS_HOSTS: optional extra DNS names for the WEBSITE — the
# public swiftgy.com and www.swiftgy.com while no production stack exists,
# mirroring API_ALIAS_HOST. Each name gets its own certificate and reaches the
# website, never the API. www is redirected to the apex by the website itself
# (apps/web/next.config.ts), which keeps the app-link files on www unredirected;
# a proxy-level redirect would move those too. Unset, nothing changes.
# ===========================================================================

PUBLIC_ALIASES = "example.com www.example.com"


class PublicSiteWebAliasHosts(unittest.TestCase):
    def blocks(self, env: dict):
        return top_level_blocks(caddy_render((DEPLOY / "Caddyfile").read_text(), env))

    def test_unset_website_aliases_leave_the_api_and_website_exactly_as_before(self):
        for env in ({"API_HOST": API_HOST, "WEB_HOST": WEB_HOST}, {"API_HOST": API_HOST, "WEB_HOST": WEB_HOST, "WEB_ALIAS_HOSTS": ""}):
            with self.subTest(env=env):
                [[addresses, body]] = self.blocks(env)
                self.assertEqual(addresses, [API_HOST, WEB_HOST])
                self.assertIn(f"@api host {API_HOST}", body)

    def test_each_alias_is_served_with_its_own_certificate_and_reaches_the_website_never_the_api(self):
        env = {"API_HOST": API_HOST, "API_ALIAS_HOST": ALIAS_HOST, "WEB_HOST": WEB_HOST, "WEB_ALIAS_HOSTS": PUBLIC_ALIASES}
        [[addresses, body]] = self.blocks(env)
        self.assertEqual(addresses, [API_HOST, ALIAS_HOST, WEB_HOST, "example.com", "www.example.com"])
        # Requests are split on the API matcher; every other host is the website.
        matchers = [line for line in body if line.startswith("@api host")]
        self.assertEqual(matchers, [f"@api host {API_HOST} {ALIAS_HOST}"])
        self.assertEqual(body[-3:], ["handle {", "reverse_proxy web:3000", "}"])

    def test_www_reaches_the_website_which_redirects_it_to_the_apex(self):
        # No proxy-level redirect: it would also move the app-link files the
        # phone apps fetch from www (they refuse to follow a redirect).
        self.assertNotRegex((DEPLOY / "Caddyfile").read_text(), r"(?m)^\s*redir\b")
        next_config = (DEPLOY.parent / "apps" / "web" / "next.config.ts").read_text()
        self.assertIn(r"source: '/:path((?!\\.well-known/).*)'", next_config)
        self.assertIn("has: [{ type: 'host', value: `www.${SITE_DOMAIN}` }]", next_config)
        self.assertIn("destination: `https://${SITE_DOMAIN}/:path*`", next_config)

    def test_caddy_gets_the_website_aliases_with_an_empty_default(self):
        caddy = service_block(DEPLOY / "docker-compose.yml", "caddy")
        self.assertIn("WEB_ALIAS_HOSTS: ${WEB_ALIAS_HOSTS:-}", caddy)

    def test_the_website_build_takes_the_pre_launch_switch_closed_by_default(self):
        web = service_block(DEPLOY / "docker-compose.yml", "web")
        self.assertIn("NEXT_PUBLIC_WEB_ORDERING: ${WEB_ORDERING:-}", web)
        self.assertIn("ARG NEXT_PUBLIC_WEB_ORDERING", dockerfile_stages(WEB_DOCKERFILE)["build"])

    def test_the_example_settings_document_both_and_leave_them_empty(self):
        example = (DEPLOY / ".env.deploy.example").read_text()
        self.assertRegex(example, r"(?m)^WEB_ALIAS_HOSTS=$")
        self.assertRegex(example, r"(?m)^WEB_ORDERING=$")


if __name__ == "__main__":
    unittest.main()
