#!/usr/bin/env python3
"""Keep the app containers' logs across a recreate, scrubbed and bounded.

A container's log dies with the container, and every deploy recreates them. Run
this just before a recreate: pilot-up.sh does, and anything else that recreates
a service should call it first (`python3 deploy/keep-logs.py`).

For each service it writes one gzip file to ~/kept-logs (a directory only the
deploy user can read; no root needed, so a host that is already provisioned
needs no change). Every line goes through the scrub on its way in. If reading
the log or scrubbing it fails at any point, NOTHING is kept for that service:
a raw line never reaches the disk. Files older than 30 days go, then the oldest
files until the total fits 500 MB.

It never stops a deploy: every failure is a warning on stderr and the exit code
stays 0. Standard library only.
"""
import gzip
import os
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

PROJECT = 'swift'
SERVICES = ('api', 'worker', 'caddy', 'web', 'admin')
KEEP_DAYS = 30
KEEP_MAX_BYTES = 500 * 1024 * 1024
# A log already bounded by compose reads in seconds. A wedged docker costs a deploy
# this long per service, no more.
SERVICE_SECONDS = 120
# This script's files: a kept log, or what a killed run left of one.
NAME = re.compile(r'^(?:\d{8}T\d{6}Z-[a-z]+\.log\.gz|\.keep-\w+)$')

# What may not stay in a kept log, whatever wrote the line. The applications
# redact at the source: this is the second lock, for what a library or a future
# log line lets through. Order matters: a JWT or a query is taken out whole first.
SCRUBS = (
    (re.compile(r'\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?'), '[token]'),
    (re.compile(r'(?i)\bbearer\s+[A-Za-z0-9._~+/=-]+'), 'Bearer [token]'),
    # A URL's query, and a bare path's: whatever follows the ? up to the next space or quote.
    (re.compile(r'(?<=[A-Za-z0-9_/.~%-])\?[^\s"\'`<>]*'), '?[query]'),
    # {1,64}, the longest local part an address may have: unbounded, one long line costs n squared here.
    (re.compile(r'[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}'), '[email]'),
    (re.compile(r'\+\d[\d\s-]{7,16}\d'), '[phone]'),
    (re.compile(r'(?<![\d.])592[\s-]?\d{3}[\s-]?\d{4}(?!\d)'), '[phone]'),
    # A coordinate field in a JSON line, then a bare "6.80, -58.15" pair (a routing URL carries those).
    (re.compile(r'"[A-Za-z_]*(?:[Ll]at|LAT|[Ll]ng|LNG|[Ll]on|[Ll]atitude|[Ll]ongitude)"\s*:\s*"?-?\d+(?:\.\d+)?"?'), '"[location]":null'),
    (re.compile(r'-?\d{1,3}\.\d{3,}\s*[,;]\s*-?\d{1,3}\.\d{3,}'), '[location]'),
    (re.compile(r'(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])'), '[ip]'),
    # Eight groups, or any form with :: (a time of day has two colons and no ::).
    (re.compile(r'(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}:){7}[0-9A-Fa-f]{1,4}(?![0-9A-Fa-f:])'), '[ip]'),
    (re.compile(r'(?<![0-9A-Fa-f:])(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?::(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![0-9A-Fa-f:])'), '[ip]'),
)


def scrub_line(line: str) -> str:
    for pattern, replacement in SCRUBS:
        line = pattern.sub(replacement, line)
    return line


def warn(message: str) -> None:
    print(f'keep-logs: {message}', file=sys.stderr)


def container_of(service: str) -> str:
    """The service's container, by compose's own labels, so a profile that is off is simply not there."""
    found = subprocess.run(
        ['docker', 'ps', '-aq', '--filter', f'label=com.docker.compose.project={PROJECT}',
         '--filter', f'label=com.docker.compose.service={service}'],
        capture_output=True, text=True, timeout=30, check=True)
    ids = found.stdout.split()
    return ids[0] if ids else ''


def keep_service(service: str, directory: Path, stamp: str) -> bool:
    """One service's log, scrubbed, into one file. On any failure nothing stays, and it says so."""
    temp = None
    reader = None
    watchdog = None
    try:
        container = container_of(service)
        if not container:
            return False
        handle, temp = tempfile.mkstemp(dir=directory, prefix='.keep-')  # 0600
        reader = subprocess.Popen(['docker', 'logs', '--timestamps', '--since', f'{KEEP_DAYS * 24}h', container],
                                  stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        # A killed reader ends the loop below, and its exit code keeps nothing.
        watchdog = threading.Timer(SERVICE_SECONDS, reader.kill)
        watchdog.daemon = True
        watchdog.start()
        with os.fdopen(handle, 'wb') as raw, gzip.GzipFile(fileobj=raw, mode='wb', mtime=0) as kept:
            for line in reader.stdout:
                kept.write(scrub_line(line.decode('utf-8', 'replace')).encode('utf-8'))
        if reader.wait(timeout=30) != 0:
            raise RuntimeError('docker logs failed')
        os.replace(temp, directory / f'{stamp}-{service}.log.gz')
        temp = None
        return True
    except Exception as err:  # noqa: BLE001 - a deploy must go on whatever went wrong here
        warn(f'{service}: nothing kept ({type(err).__name__})')
        return False
    finally:
        if watchdog is not None:
            watchdog.cancel()
        if reader is not None and reader.poll() is None:
            reader.kill()
        if temp is not None:
            Path(temp).unlink(missing_ok=True)


def prune(directory: Path, wall=time.time) -> None:
    """Thirty days at most, 500 MB at most, oldest first. Only this script's own files."""
    files = sorted((p for p in directory.iterdir() if NAME.match(p.name)), key=lambda p: p.stat().st_mtime)
    oldest_allowed = wall() - KEEP_DAYS * 86_400
    kept = []
    for path in files:
        if path.stat().st_mtime < oldest_allowed:
            path.unlink()
        else:
            kept.append(path)
    total = sum(p.stat().st_size for p in kept)
    while kept and total > KEEP_MAX_BYTES:
        path = kept.pop(0)
        total -= path.stat().st_size
        path.unlink()


def main() -> int:
    # The deploy's ceiling (timeout 180): leave through keep_service's finally, so a killed run keeps nothing.
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(143))
    try:
        directory = Path(os.environ.get('SWIFT_KEPT_LOGS_DIR') or Path.home() / 'kept-logs')
        directory.mkdir(mode=0o700, parents=True, exist_ok=True)
        directory.chmod(0o700)
        stamp = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())
        kept = [service for service in SERVICES if keep_service(service, directory, stamp)]
        prune(directory)
        print(f'keep-logs: kept {", ".join(kept) or "nothing"}')
    except Exception as err:  # noqa: BLE001 - a deploy must go on whatever went wrong here
        warn(f'nothing kept ({type(err).__name__})')
    return 0


if __name__ == '__main__':
    sys.exit(main())
