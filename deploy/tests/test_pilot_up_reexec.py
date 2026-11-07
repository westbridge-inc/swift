"""[DEPLOY-FIX · staging #14, 23 Oct] pilot-up.sh runs the REQUESTED revision's
own steps once the checkout has moved to it.

Bash reads a script while it runs. On staging #14 pilot-up.sh switched the
checkout to the new SHA, git replaced deploy/pilot-up.sh, and bash went on
executing the PREVIOUS revision's steps: the new upload-scanner start and its
EICAR proof never ran. The fix restarts the checked-out script (once, same
arguments) when it differs from the running one.

These tests run the real pilot-up.sh inside a real git fixture (a bare
"origin" and a clone at an older commit), with shims for docker, curl, sudo,
systemctl, the secret store and sleep (git is the real one). Nothing is
deployed; nothing needs root, a network, Docker or systemd.

    python3 -m unittest discover -s deploy/tests -v
"""

import os
import re
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path

from test_stg_ops import API_HOST, DEPLOY, FAKE_PILOT_DOCKER, sh_shim


FILES = ("pilot-up.sh", "secret-names.sh", "wait-for-migration.sh", "verify-journeys-isolation.py",
         "check-upload-storage.py", "Caddyfile", "docker-compose.yml", "docker-compose.routing.yml")
RESTART_NOTICE = "has its own pilot-up.sh; restarting it"
# A step only the given revision has: right after the checkout, so it runs in
# every mode (the database-only stage exits before the end of the script).
ANCHOR = 'export SWIFT_TAG="$SHA"\n'
# The fake Docker answers `compose ps -q <service>` with an id, except for the
# services named in NOT_RUNNING (the database-only stage refuses a running API,
# the production first boot a running Caddy); on production it also says the
# context is this host's own and counts no least-privilege logins.
DOCKER = FAKE_PILOT_DOCKER.replace(
    '    print(argv[-1] + "-id")',
    '    if argv[-1] not in os.environ.get("NOT_RUNNING", "").split():\n        print(argv[-1] + "-id")').replace(
    'if argv[:1] == ["network"]:',
    'if argv[:2] == ["context", "show"]:\n    print("default")\n    sys.exit(0)\n'
    'if "pg_roles" in line:\n    print("0")\n    sys.exit(0)\n'
    'if argv[:1] == ["network"]:')
assert DOCKER.count("NOT_RUNNING") == 1 and DOCKER.count("pg_roles") == 1
PROD_API = "api.swift.example.com"
APP_CONFIG = "apps/mobile/app.config.ts"
LINK_DOMAIN_LINE = "const linkDomain = process.env['SWIFT_LINK_DOMAIN'] ?? 'swiftgy.com';\n"
# Every production refusal satisfied, for the first boot before DNS moves (no
# real value: synthetic names, a made-up fingerprint).
PRODUCTION_ENV = (
    f"PILOT_ENV=production\nNODE_ENV=production\nAPI_HOST={PROD_API}\nAPI_PUBLIC_URL=https://{PROD_API}\n"
    "APP_PUBLIC_URL=https://swiftgy.com\nCORS_ORIGIN=https://app.swift.example.com\n"
    "MAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\nBACKUP_BUCKET=test-backups\nSTORAGE_PROVIDER=s3\n"
    f"BACKUP_GPG_FINGERPRINT={'A' * 40}\nBACKUP_GPG_RECIPIENT_FILE=/nonexistent/owner-backup.pub\n"
    "BACKUP_MAX_AGE_HOURS=1\nBILLING_TOPUP_HOLD=1\nPAYMENT_PROVIDER=disabled\nCARD_RAIL_KILL=1\n"
    "PLACES_PROVIDER=google\nGOOGLE_MAPS_API_KEY_BACKEND_FILE=/run/secrets/GOOGLE_MAPS_API_KEY_BACKEND\n")


def with_step(marker: str) -> str:
    text = (DEPLOY / "pilot-up.sh").read_text()
    assert text.count(ANCHOR) == 1
    return text.replace(ANCHOR, f'{ANCHOR}echo "{marker}"\n')


class PilotUpRunsTheRequestedRevisionsSteps(unittest.TestCase):

    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="swift-pilot-reexec-test-"))
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = self.tmp / "bin"
        self.bin.mkdir()
        self.log = self.tmp / "calls"
        self.log.write_text("")
        docker = self.bin / "docker"
        docker.write_text(DOCKER)
        docker.chmod(0o755)
        sh_shim(self.bin, "curl", 'echo "curl $*" >> "$CALL_LOG"\nexit 0')
        sh_shim(self.bin, "id", 'if [ "$1" = "-u" ]; then echo 1000; else exec /usr/bin/id "$@"; fi')
        sh_shim(self.bin, "sudo", '[ "$1" = -n ] && shift\nexec "$@"')
        sh_shim(self.bin, "swift-secrets", '[ "$1" = list ] && printf "%s\\n" $STORE_NAMES\nexit 0')
        sh_shim(self.bin, "systemctl", 'echo "systemctl $*" >> "$CALL_LOG"\nexit 0')
        sh_shim(self.bin, "sleep", "exit 0")
        compose = (DEPLOY / "docker-compose.yml").read_text()
        self.store = " ".join(sorted(set(re.findall(r"_FILE: /run/secrets/([A-Z][A-Z0-9_]*)", compose))
                                     | {"AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"}))
        self.work = self.tmp / "work"
        self.repo = self.tmp / "repo"

    def git(self, cwd: Path, *args: str) -> str:
        return subprocess.run(
            ["git", "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid",
             "-c", "commit.gpgsign=false", "-c", "core.hooksPath=/dev/null", *args],
            cwd=cwd, check=True, text=True, capture_output=True, timeout=30).stdout.strip()

    def commit(self, script: str, extra=None) -> str:
        deploy = self.work / "deploy"
        if not deploy.exists():
            deploy.mkdir(parents=True)
            self.git(self.work, "init", "-q")
            self.git(self.work, "symbolic-ref", "HEAD", "refs/heads/main")
            for name in FILES:
                shutil.copy(DEPLOY / name, deploy / name)
            utils = self.work / "apps" / "api" / "src" / "utils"
            utils.mkdir(parents=True)
            shutil.copy(DEPLOY.parent / "apps" / "api" / "src" / "utils" / "secret-files.ts", utils / "secret-files.ts")
            # [DEPLOY-GUARD] production checks APP_PUBLIC_URL against the app's link domain.
            (self.work / "apps" / "mobile").mkdir(parents=True)
            shutil.copy(DEPLOY.parent / "apps" / "mobile" / "app.config.ts", self.work / APP_CONFIG)
            (self.work / ".gitignore").write_text("deploy/.env\ndeploy/routing-data/\n")
            # backup.sh's own key proof is tested in test_backup_encryption.py;
            # here production's `backup.sh --check-key` is a stub that passes.
            (deploy / "backup.sh").write_text("#!/bin/sh\nexit 0\n")
            (deploy / "backup.sh").chmod(0o755)
        (deploy / "pilot-up.sh").write_text(script)
        (deploy / "pilot-up.sh").chmod(0o755)
        for name, body in (extra or {}).items():
            (self.work / name).write_text(body)
        self.git(self.work, "add", "-A")
        self.git(self.work, "commit", "-q", "-m", "fixture")
        return self.git(self.work, "rev-parse", "HEAD")

    def host_at(self, running: str, settings: str = "") -> Path:
        """origin = the fixture's history; the host's checkout sits at `running`."""
        origin = self.tmp / "origin.git"
        self.git(self.tmp, "clone", "-q", "--bare", str(self.work), str(origin))
        self.git(self.tmp, "clone", "-q", str(origin), str(self.repo))
        self.git(self.repo, "switch", "-q", "--detach", running)
        here = self.repo / "deploy"
        (here / "routing-data" / "osrm").mkdir(parents=True)
        (here / "routing-data" / "osrm" / "guyana-latest.osrm").write_text("")
        (here / ".env").write_text(settings or
            f"PILOT_ENV=staging\nAPI_HOST={API_HOST}\nMAPS_PROVIDER=osrm\nOSRM_URL=http://osrm:5000\n"
            "BACKUP_BUCKET=test-backups\nNODE_ENV=development\nCORS_ORIGIN=https://staging.example.com\n")
        self.assertEqual(self.git(self.repo, "status", "--porcelain", "--untracked-files=normal"), "")
        return here

    def run_pilot(self, *args: str, **extra):
        env = os.environ.copy()
        env.pop("PILOT_UP_REEXEC", None)
        env.update({"PATH": f"{self.bin}:{env['PATH']}", "CALL_LOG": str(self.log),
                    "STORE_NAMES": f"{self.store} GOOGLE_MAPS_API_KEY_BACKEND"})
        env.update(extra)
        result = subprocess.run(["bash", str(self.repo / "deploy" / "pilot-up.sh"), *args],
                                env=env, text=True, capture_output=True, timeout=180, stdin=subprocess.DEVNULL)
        return result, self.log.read_text().splitlines()

    @staticmethod
    def count(calls, fragment):
        return sum(1 for call in calls if fragment in call)

    def test_a_newer_checked_out_script_runs_its_own_steps_and_every_change_happens_once(self):
        old = self.commit(with_step("OLD-REVISION-STEP"))
        new = self.commit(with_step("NEW-REVISION-STEP"))
        self.host_at(old)
        result, calls = self.run_pilot(new)
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), new)
        # The steps after the checkout are the requested revision's, never the old one's.
        self.assertIn("NEW-REVISION-STEP", result.stdout)
        self.assertNotIn("OLD-REVISION-STEP", result.stdout)
        self.assertEqual(result.stdout.count(RESTART_NOTICE), 1, result.stdout)
        self.assertEqual(result.stdout.count(f"STAGING READY at exact SHA {new}"), 1)
        # Restarted before anything changed: each change on the host happens once.
        for fragment in ("systemctl restart swift-secrets.service", " pull postgres redis meilisearch clamd caddy",
                         " build api", " up -d --wait --wait-timeout 900 clamd", " stop api worker",
                         " up -d --force-recreate migrate", " up -d --no-deps --force-recreate api worker",
                         " up -d --no-deps --force-recreate caddy"):
            with self.subTest(change=fragment):
                self.assertEqual(self.count(calls, fragment), 1, calls)
        restarted = calls.index(next(c for c in calls if "systemctl restart swift-secrets.service" in c))
        self.assertFalse([c for c in calls[:restarted] if c.startswith("docker ")],
                         "nothing touches Docker before the requested revision's script runs")

    def test_the_database_only_stage_survives_the_restart(self):
        old = self.commit(with_step("OLD-REVISION-STEP"))
        new = self.commit(with_step("NEW-REVISION-STEP"))
        self.host_at(old)
        result, calls = self.run_pilot("--data-only", new, NOT_RUNNING="api worker")
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])
        self.assertIn(RESTART_NOTICE, result.stdout)
        self.assertIn("NEW-REVISION-STEP", result.stdout)
        self.assertNotIn("OLD-REVISION-STEP", result.stdout)
        self.assertIn(f"DATABASE READY at exact SHA {new}", result.stdout)
        # Still the database-only stage: the API, worker and Caddy are never touched.
        self.assertEqual(self.count(calls, " stop api worker"), 0, calls)
        self.assertEqual(self.count(calls, "--force-recreate api worker"), 0, calls)
        self.assertEqual(self.count(calls, "--force-recreate caddy"), 0, calls)
        self.assertEqual(self.count(calls, " up -d --force-recreate migrate"), 1, calls)

    def test_the_production_first_boot_survives_the_restart_and_nothing_public_starts(self):
        old = self.commit(with_step("OLD-REVISION-STEP"))
        new = self.commit(with_step("NEW-REVISION-STEP"))
        self.host_at(old, PRODUCTION_ENV)
        result, calls = self.run_pilot("--no-public", new, NOT_RUNNING="caddy")
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])
        self.assertEqual(result.stdout.count(RESTART_NOTICE), 1, result.stdout)
        self.assertIn("(no-public;", result.stdout)
        self.assertIn("NEW-REVISION-STEP", result.stdout)
        self.assertNotIn("OLD-REVISION-STEP", result.stdout)
        self.assertIn(f"API READY at exact SHA {new} (production, no public address", result.stdout)
        self.assertNotIn("PRODUCTION READY", result.stdout)
        # Caddy, the website and the console are never started; nothing is public.
        for fragment in ("--force-recreate caddy", "--force-recreate web", "--force-recreate admin", "curl "):
            with self.subTest(never=fragment):
                self.assertEqual(self.count(calls, fragment), 0, calls)
        self.assertEqual(self.count(calls, " up -d --no-deps --force-recreate api worker"), 1, calls)
        self.assertEqual(self.count(calls, " stop api worker"), 1, calls)

    def test_production_checks_app_public_url_against_the_requested_revisions_app_config(self):
        """[DEPLOY-GUARD] The link domain is read from the checkout: after the
        switch, the restarted run reads the requested revision's app config, so
        a revision whose app claims another domain refuses before Docker is
        touched, though the running revision's app config agreed."""
        config = (DEPLOY.parent / APP_CONFIG).read_text()
        self.assertEqual(config.count(LINK_DOMAIN_LINE), 1)
        old = self.commit(with_step("OLD-REVISION-STEP"))
        moved = config.replace(LINK_DOMAIN_LINE, LINK_DOMAIN_LINE.replace("'swiftgy.com'", "'swift-fixture.com'"))
        new = self.commit(with_step("NEW-REVISION-STEP"), {APP_CONFIG: moved})
        self.host_at(old, PRODUCTION_ENV)
        result, calls = self.run_pilot("--no-public", new, NOT_RUNNING="caddy")
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(result.stdout.count(RESTART_NOTICE), 1, result.stdout)
        self.assertIn("needs APP_PUBLIC_URL=https://swift-fixture.com exactly", result.stderr)
        self.assertNotIn("NEW-REVISION-STEP", result.stdout)
        self.assertEqual([c for c in calls if re.search(r"docker compose .* (up|stop|pull|build|run)\b", c)], [], calls)
        self.assertEqual(self.count(calls, "systemctl restart"), 0, calls)

    def test_a_marker_naming_another_stage_or_sha_refuses_before_anything(self):
        old = self.commit(with_step("OLD-REVISION-STEP"))
        new = self.commit(with_step("NEW-REVISION-STEP"))
        self.host_at(old)
        for marker in (f"no-public {new}", f"data-only {new}", f"full {old}", new, ""):
            with self.subTest(marker=marker):
                self.log.write_text("")
                result, calls = self.run_pilot(new, PILOT_UP_REEXEC=marker)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("does not name this stage and SHA", result.stderr)
                self.assertEqual(calls, [])
                self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), old, "the checkout never moved")

    def test_an_unchanged_script_runs_straight_through_without_a_restart(self):
        old = self.commit(with_step("SAME-REVISION-STEP"))
        new = self.commit(with_step("SAME-REVISION-STEP"), extra={"NOTES.txt": "another file changed\n"})
        self.assertNotEqual(old, new)
        self.host_at(old)
        result, calls = self.run_pilot(new)
        self.assertEqual(result.returncode, 0, result.stderr[-1500:])
        self.assertNotIn(RESTART_NOTICE, result.stdout)
        self.assertEqual(result.stdout.count("SAME-REVISION-STEP"), 1)
        self.assertEqual(self.count(calls, "systemctl restart swift-secrets.service"), 1)
        self.assertEqual(self.git(self.repo, "rev-parse", "HEAD"), new)

    def test_a_restart_that_still_differs_refuses_instead_of_looping_and_changes_nothing(self):
        old = self.commit(with_step("OLD-REVISION-STEP"))
        new = self.commit(with_step("NEW-REVISION-STEP"))
        self.host_at(old)
        # The marker already names this stage and SHA, as in a restarted script.
        result, calls = self.run_pilot(new, PILOT_UP_REEXEC=f"full {new}")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("still differs from the checked-out one", result.stderr)
        self.assertNotIn(RESTART_NOTICE, result.stdout)
        self.assertNotIn("OLD-REVISION-STEP", result.stdout)
        self.assertNotIn("NEW-REVISION-STEP", result.stdout)
        self.assertEqual(calls, [], "nothing on the host may change")

    def test_the_restart_sits_after_the_checkout_and_before_the_first_change(self):
        text = (DEPLOY / "pilot-up.sh").read_text()
        restart = text.index('exec "$BASH" "$PILOT_UP_SELF"')
        self.assertLess(text.index('git switch --detach "$SHA"'), restart)
        self.assertLess(text.index('[ "$(git rev-parse HEAD)" = "$SHA" ]'), restart)
        self.assertLess(restart, text.index('. "$HERE/secret-names.sh"'))
        self.assertLess(restart, text.index("sudo -n systemctl restart swift-secrets.service"))
        self.assertLess(restart, text.index('"${COMPOSE[@]}" config --quiet'))
        # The arguments and the running script's own text are kept before the
        # options are shifted off and before anything moves.
        self.assertLess(text.index('PILOT_UP_ARGS=("$@")'), text.index('DATA_ONLY=1; shift'))
        self.assertLess(text.index('PILOT_UP_SELF_TEXT="$(< "$PILOT_UP_SELF")"'), text.index('cd "$ROOT"'))

    def test_the_runbook_names_the_fix_and_the_manual_check(self):
        runbook = (DEPLOY / "PILOT-RUNBOOK.md").read_text()
        for phrase in ("own pilot-up.sh", "clamd healthy + EICAR proof after pilot-up",
                       'git switch --detach "$APPROVED_SHA"'):
            self.assertTrue(phrase in runbook, f"PILOT-RUNBOOK.md must say: {phrase}")


if __name__ == "__main__":
    unittest.main()
