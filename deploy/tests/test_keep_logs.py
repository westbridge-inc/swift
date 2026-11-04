"""[FIXES-4] A recreate keeps the logs, bounded, and nothing that names a person.

A container's log dies with the container, so every deploy lost the API and
worker logs, and Caddy had no access log at all. Held here:

  1. keep-logs.py keeps each service's log, gzip, 0600 in a 0700 directory, and
     a measured kept file holds no URI query, IP address, phone, token, email
     or location;
  2. if scrubbing or reading fails, NOTHING is kept for that service (never a raw
     line), the others are still kept, it warns, and it exits 0: it never stops a
     deploy;
  3. files older than 30 days go, then the oldest until the total fits 500 MB,
     and nothing but its own files is touched;
  4. pilot-up.sh calls it before it recreates anything that serves, and compose
     puts a ceiling on the live logs;
  5. the REAL Caddyfile, served by the stack's pinned Caddy, writes an access log
     with a status and a host, and no URI, query, IP, header or cookie.

    python3 -m unittest discover -s deploy/tests -v
"""

import base64
import gzip
import importlib.util
import io
import json
import os
import re
import shutil
import stat
import subprocess
import tempfile
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

from test_stg_ops import API_HOST, DEPLOY, caddy_image_present, wait_for_test_caddy, with_global_options

spec = importlib.util.spec_from_file_location('keep_logs', DEPLOY / 'keep-logs.py')
keep_logs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(keep_logs)

# Synthetic fixtures only. A phone is from the reserved fictional range. The token
# is built here, so the file itself holds nothing a secret scanner would stop on.
PHONE = '+5920712345'
PHONE_SPACED = '+592 071 2345'
PHONE_BARE = '592-061-2345'
PHONE_ABROAD = '+18785550100'
EMAIL = 'someone.fixture@example.com'
SEGMENT = base64.urlsafe_b64encode(b'{"alg":"none","typ":"fixture"}').decode().rstrip('=')
JWT = f'{SEGMENT}.{SEGMENT}.{SEGMENT}'
BEARER = 'Bearer abcDEF123.fixture-opaque'
IP4 = '203.0.113.77'
IP6_FULL = '2001:0db8:0000:0000:0000:ff00:0042:8329'
IP6_SHORT = '2001:db8::8a2e:370:7334'
LAT, LNG = 6.80456, -58.15512

RAW_LINES = [
    '{"level":30,"time":1762228000000,"route":"/api/v1/orders/:id","msg":"request completed","statusCode":200}',
    f'{{"level":50,"msg":"failed","to":"{PHONE}","email":"{EMAIL}"}}',
    f'{{"level":40,"msg":"sms","phone":"{PHONE_SPACED}"}} and {PHONE_BARE}',
    f'{{"level":30,"authorization":"{BEARER}"}} token {JWT}',
    f'{{"level":30,"url":"https://maps.example.com/x?key=fixturekey&sig=abc"}} GET /track/abc?token=def HTTP/1.1',
    f'{{"level":30,"remoteAddress":"{IP4}"}} from {IP6_FULL} and {IP6_SHORT}',
    f'{{"level":50,"lat":{LAT},"lng":{LNG},"deliveryLat":"{LAT}","msg":"SOS raised on active ride"}}',
    f'routing failed /route/v1/driving/{LNG},{LAT};{LNG},{LAT}',
]


def fake_docker(directory: Path, *, logs: str = 'printf "%s\\n" "$FIXTURE_LINES"', services=('api', 'worker')) -> dict:
    """A docker on PATH that knows these services' containers and prints the fixture."""
    binary = directory / 'bin'
    binary.mkdir()
    cases = ''.join(f'    *service={name}*) echo "id-{name}";;\n' for name in services)
    script = binary / 'docker'
    script.write_text(
        '#!/bin/sh\n'
        'case "$1" in\n'
        f'  ps) case "$*" in\n{cases}    esac;;\n'
        f'  logs) {logs};;\n'
        '  *) exit 2;;\n'
        'esac\n')
    script.chmod(0o755)
    return {**os.environ, 'PATH': f'{binary}{os.pathsep}{os.environ["PATH"]}', 'SWIFT_KEPT_LOGS_DIR': str(directory / 'kept'),
            'FIXTURE_LINES': '\n'.join(RAW_LINES)}


def run_script(env: dict) -> subprocess.CompletedProcess:
    return subprocess.run(['python3', str(DEPLOY / 'keep-logs.py')], env=env, capture_output=True, text=True, timeout=60)


def kept_text(directory: Path, service: str) -> str:
    files = sorted((directory / 'kept').glob(f'*-{service}.log.gz'))
    assert len(files) == 1, f'{service}: {files}'
    return gzip.decompress(files[0].read_bytes()).decode('utf-8')


class Scrub(unittest.TestCase):
    def test_each_kind_goes_and_the_line_stays_readable(self):
        for raw, gone, says in [
            (f'to {PHONE} now', PHONE, '[phone]'),
            (f'to {PHONE_SPACED} now', PHONE_SPACED, '[phone]'),
            (f'to {PHONE_BARE} now', PHONE_BARE, '[phone]'),
            (f'to {PHONE_ABROAD} now', PHONE_ABROAD, '[phone]'),
            (f'mail {EMAIL} now', EMAIL, '[email]'),
            (f'sig {JWT} now', JWT, '[token]'),
            (f'authorization: {BEARER} now', 'abcDEF123', 'Bearer [token]'),
            (f'authorization: bearer {JWT} now', SEGMENT, '[token]'),
            ('GET /track/abc?token=def HTTP/1.1', 'token=def', '/track/abc?[query]'),
            ('https://a.example.com/b?x=1&y=2 next', 'x=1', 'https://a.example.com/b?[query] next'),
            (f'peer {IP4} now', IP4, '[ip]'),
            (f'peer {IP6_FULL} now', IP6_FULL, '[ip]'),
            (f'peer {IP6_SHORT} now', IP6_SHORT, '[ip]'),
            (f'"lat":{LAT},"lng":{LNG}', str(LAT), '"[location]":null'),
            (f'"deliveryLat":"{LAT}"', str(LAT), '"[location]":null'),
            (f'"longitude":{LNG}', str(LNG), '"[location]":null'),
            (f'driving/{LNG},{LAT};next', str(LAT), '[location]'),
        ]:
            with self.subTest(raw=raw):
                out = keep_logs.scrub_line(raw)
                self.assertNotIn(gone, out)
                self.assertIn(says, out)

    def test_ordinary_log_fields_survive(self):
        for line in [
            '2026-11-04T03:43:38.123456789Z {"level":30,"time":1762228000000,"route":"/api/v1/orders/:id","statusCode":500,"responseTime":12.345}',
            '{"level":50,"orderId":"cmw1mlb7x005lonco2ynd2hbp","errorClass":"TypeError","errorCode":"P2002","method":"GET"}',
        ]:
            self.assertEqual(keep_logs.scrub_line(line), line)


class KeptFile(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def test_a_measured_kept_file_holds_no_query_ip_phone_token_email_or_location(self):
        run = run_script(fake_docker(self.dir))
        self.assertEqual(run.returncode, 0, run.stderr)
        for service in ('api', 'worker'):
            text = kept_text(self.dir, service)
            self.assertIn('request completed', text)
            self.assertIn('SOS raised on active ride', text)
            self.assertIsNone(re.search(r'\?[A-Za-z_]+=', text), 'a URI query')
            self.assertIsNone(re.search(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])', text), 'an IPv4 address')
            self.assertIsNone(re.search(r'[0-9a-fA-F]{1,4}::?[0-9a-fA-F]{1,4}::?[0-9a-fA-F]{1,4}', text), 'an IPv6 address')
            self.assertIsNone(re.search(r'\+?592[\s-]?\d{3}[\s-]?\d{4}', text), 'a phone')
            self.assertIsNone(re.search(r'[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}', text), 'an email')
            self.assertIsNone(re.search(r'eyJ[A-Za-z0-9_-]+\.', text), 'a JWT')
            self.assertNotIn('abcDEF123', text)
            self.assertIsNone(re.search(r'"(?:[A-Za-z_]*[Ll]at|[A-Za-z_]*[Ll]ng)"\s*:', text), 'a coordinate field')
            self.assertNotIn(str(LAT), text)
            self.assertNotIn(str(LNG), text)

    def test_the_directory_and_the_files_are_the_deploy_users_alone(self):
        run_script(fake_docker(self.dir))
        kept = self.dir / 'kept'
        self.assertEqual(stat.S_IMODE(kept.stat().st_mode), 0o700)
        files = list(kept.iterdir())
        self.assertEqual(len(files), 2)
        for path in files:
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
            self.assertRegex(path.name, keep_logs.NAME.pattern)

    def test_a_service_with_no_container_is_passed_over_quietly(self):
        run = run_script(fake_docker(self.dir, services=('api',)))
        self.assertEqual(run.returncode, 0)
        self.assertEqual(len(list((self.dir / 'kept').iterdir())), 1)
        self.assertEqual(run.stderr, '')
        self.assertIn('kept api', run.stdout)

    def test_a_run_also_prunes(self):
        env = fake_docker(self.dir)
        kept = self.dir / 'kept'
        kept.mkdir(mode=0o700)
        old = kept / '20260101T000000Z-api.log.gz'
        old.write_bytes(b'x')
        when = time.time() - 31 * 86_400
        os.utime(old, (when, when))
        run_script(env)
        self.assertFalse(old.exists())

    def test_every_app_service_is_kept(self):
        self.assertEqual(keep_logs.SERVICES, ('api', 'worker', 'caddy', 'web', 'admin'))
        run_script(fake_docker(self.dir, services=keep_logs.SERVICES))
        self.assertEqual(len(list((self.dir / 'kept').iterdir())), 5)


class NothingRawEverStays(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)
        self.env = fake_docker(self.dir)
        self.kept = self.dir / 'kept'
        self.kept.mkdir(mode=0o700)

    def run_main(self, env=None):
        err, out = io.StringIO(), io.StringIO()
        with mock.patch.dict(os.environ, env or self.env, clear=True), redirect_stderr(err), redirect_stdout(out):
            code = keep_logs.main()
        return code, err.getvalue(), out.getvalue()

    def test_a_failing_scrub_keeps_nothing_for_that_service_warns_and_exits_0(self):
        real = keep_logs.scrub_line
        lines = {'n': 0}

        def fails_on_the_third_line(line):
            lines['n'] += 1
            if lines['n'] == 3:
                raise ValueError('the scrub broke')
            return real(line)

        with mock.patch.object(keep_logs, 'scrub_line', fails_on_the_third_line):
            code, err, _ = self.run_main()
        self.assertEqual(code, 0)
        self.assertEqual(list(self.kept.glob('*-api.log.gz')), [], 'the failed service left a file')
        self.assertEqual(len(list(self.kept.glob('*-worker.log.gz'))), 1, 'the next service still ran')
        self.assertEqual([p.name for p in self.kept.iterdir() if p.name.startswith('.keep-')], [], 'a partial file stayed')
        self.assertIn('api: nothing kept', err)
        self.assertNotIn('the scrub broke', err)

    def test_docker_logs_failing_part_way_keeps_nothing(self):
        (self.dir / 'x').mkdir()
        env = fake_docker(self.dir / 'x', logs='printf "%s\\n" "$FIXTURE_LINES"; exit 1')
        code, err, _ = self.run_main({**env, 'SWIFT_KEPT_LOGS_DIR': str(self.kept)})
        self.assertEqual(code, 0)
        self.assertEqual(list(self.kept.iterdir()), [])
        self.assertIn('api: nothing kept', err)
        self.assertIn('worker: nothing kept', err)

    def test_a_wedged_docker_is_given_up_on_and_keeps_nothing(self):
        (self.dir / 'y').mkdir()
        env = fake_docker(self.dir / 'y', logs='printf "%s\\n" "$FIXTURE_LINES"; exec sleep 30')
        with mock.patch.object(keep_logs, 'SERVICE_SECONDS', 0.3):
            started = time.monotonic()
            code, err, _ = self.run_main({**env, 'SWIFT_KEPT_LOGS_DIR': str(self.kept)})
        self.assertEqual(code, 0)
        self.assertLess(time.monotonic() - started, 20)
        self.assertEqual(list(self.kept.iterdir()), [])
        self.assertIn('api: nothing kept', err)

    def test_no_docker_at_all_warns_and_exits_0(self):
        code, err, _ = self.run_main({'PATH': str(self.dir / 'nowhere'), 'SWIFT_KEPT_LOGS_DIR': str(self.kept), 'HOME': str(self.dir)})
        self.assertEqual(code, 0)
        self.assertIn('nothing kept', err)
        self.assertEqual(list(self.kept.iterdir()), [])

    def test_a_directory_it_cannot_make_warns_and_exits_0(self):
        blocker = self.dir / 'file'
        blocker.write_text('x')
        code, err, _ = self.run_main({**self.env, 'SWIFT_KEPT_LOGS_DIR': str(blocker / 'kept')})
        self.assertEqual(code, 0)
        self.assertIn('nothing kept', err)


class Bounded(unittest.TestCase):
    def setUp(self):
        self.dir = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, self.dir, ignore_errors=True)

    def file(self, name, age_days=0.0, size=10):
        path = self.dir / name
        path.write_bytes(b'x' * size)
        when = time.time() - age_days * 86_400
        os.utime(path, (when, when))
        return path

    def test_older_than_30_days_goes(self):
        old = self.file('20261001T000000Z-api.log.gz', age_days=30.5)
        young = self.file('20261010T000000Z-api.log.gz', age_days=29.5)
        keep_logs.prune(self.dir)
        self.assertFalse(old.exists())
        self.assertTrue(young.exists())

    def test_the_oldest_go_until_the_total_fits(self):
        oldest = self.file('20261001T000000Z-api.log.gz', age_days=3, size=600)
        middle = self.file('20261002T000000Z-api.log.gz', age_days=2, size=600)
        newest = self.file('20261003T000000Z-api.log.gz', age_days=1, size=600)
        with mock.patch.object(keep_logs, 'KEEP_MAX_BYTES', 1000):
            keep_logs.prune(self.dir)
        self.assertFalse(oldest.exists())
        self.assertFalse(middle.exists())
        self.assertTrue(newest.exists())

    def test_the_real_limits_are_30_days_and_500_mb(self):
        self.assertEqual(keep_logs.KEEP_DAYS, 30)
        self.assertEqual(keep_logs.KEEP_MAX_BYTES, 500 * 1024 * 1024)

    def test_nothing_but_its_own_files_is_touched(self):
        other = self.file('notes.txt', age_days=400)
        keep_logs.prune(self.dir)
        self.assertTrue(other.exists())

    def test_what_a_killed_run_left_ages_out_too(self):
        partial = self.file('.keep-abc123', age_days=31)
        keep_logs.prune(self.dir)
        self.assertFalse(partial.exists())


class Wired(unittest.TestCase):
    def test_pilot_up_keeps_the_logs_before_it_recreates_anything_that_serves(self):
        text = (DEPLOY / 'pilot-up.sh').read_text()
        keep = text.index('python3 "$HERE/keep-logs.py"')
        for recreate in ['--force-recreate api worker', '--force-recreate caddy', '--force-recreate web', '--force-recreate admin']:
            self.assertLess(keep, text.index(recreate), recreate)

    def test_a_failed_keep_never_stops_a_deploy(self):
        line = next(l for l in (DEPLOY / 'pilot-up.sh').read_text().splitlines() if 'keep-logs.py"' in l)
        self.assertRegex(line, r'\|\| echo ')

    def test_compose_caps_the_live_log_of_every_app_service(self):
        text = (DEPLOY / 'docker-compose.yml').read_text()
        self.assertRegex(text, r'x-bounded-logs: &bounded-logs\n  driver: json-file\n  options:\n    max-size: "50m"\n    max-file: "5"\n')
        for service in keep_logs.SERVICES:
            self.assertRegex(text, rf'\n  {service}:\n    logging: \*bounded-logs\n', service)


@unittest.skipUnless(caddy_image_present(), 'the pinned caddy image is not here')
class AccessLogOnTheRealCaddyfile(unittest.TestCase):
    """The real Caddyfile on the pinned Caddy. Its upstreams do not exist, so the API answers 502: a status to log."""

    def test_status_and_host_are_there_and_nothing_that_names_a_person(self):
        name = f'swift-accesslog-test-{os.getpid()}'
        root = Path(tempfile.mkdtemp())
        self.addCleanup(shutil.rmtree, root, ignore_errors=True)
        caddyfile = root / 'Caddyfile'
        caddyfile.write_text(with_global_options(
            (DEPLOY / 'Caddyfile').read_text(),
            '    local_certs\n    skip_install_trust\n    admin off\n    storage_clean_interval off\n'))
        root.chmod(0o755)
        caddyfile.chmod(0o644)
        subprocess.run(['docker', 'run', '-d', '--name', name, '--network', 'none', '--add-host', f'{API_HOST}:127.0.0.1',
                        '-e', f'API_HOST={API_HOST}', '-v', f'{caddyfile}:/etc/caddy/Caddyfile:ro', 'caddy:2.10',
                        'caddy', 'run', '--config', '/etc/caddy/Caddyfile', '--adapter', 'caddyfile'],
                       check=True, capture_output=True, timeout=60)
        self.addCleanup(subprocess.run, ['docker', 'rm', '-f', name], capture_output=True, timeout=60)

        def get():
            command = (f"curl -sk -o /dev/null -H 'Authorization: {BEARER}' -H 'Cookie: session={SEGMENT}'"
                       f" -H 'User-Agent: fixture-agent/1.0' -H 'X-Forwarded-For: {IP4}'"
                       f" 'https://{API_HOST}/api/v1/track/secrettoken?sig=signedvalue&phone={PHONE}'")
            subprocess.run(['docker', 'exec', name, 'sh', '-c', command], capture_output=True, timeout=30)

        def logged():
            read = subprocess.run(['docker', 'exec', name, 'cat', '/data/access-logs/access.log'], capture_output=True, text=True, timeout=30)
            return read.stdout

        def ready():
            get()
            return bool(logged().strip())

        wait_for_test_caddy(self, name, ready)
        text = logged()
        entry = json.loads(text.strip().splitlines()[-1])
        self.assertEqual(entry['status'], 502)  # no API behind this test Caddy
        self.assertEqual(entry['request']['method'], 'GET')
        self.assertEqual(entry['request']['host'], API_HOST)
        self.assertIn('duration', entry)
        self.assertIn('size', entry)
        for gone in ['uri', 'headers', 'remote_ip', 'remote_port', 'client_ip', 'tls']:
            self.assertNotIn(gone, entry['request'], gone)
        for gone in ['resp_headers', 'user_id']:
            self.assertNotIn(gone, entry, gone)
        for forbidden in ['secrettoken', 'sig=', 'signedvalue', PHONE, '/track/', 'Authorization', 'abcDEF123', SEGMENT, 'fixture-agent', IP4, '127.0.0.1']:
            self.assertNotIn(forbidden, text, forbidden)


class RollerSettings(unittest.TestCase):
    def test_the_access_log_is_size_capped_and_30_days(self):
        text = (DEPLOY / 'Caddyfile').read_text()
        self.assertIn('output file /data/access-logs/access.log {', text)
        self.assertRegex(text, r'roll_size 10MiB\n\s+roll_keep 5\n\s+roll_keep_for 720h\n')


if __name__ == '__main__':
    unittest.main()
