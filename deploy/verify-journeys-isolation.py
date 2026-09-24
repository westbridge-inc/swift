#!/usr/bin/env python3
"""Isolation contract for the staging journey suite (deploy/docker-compose.journeys.yml).

Reads a rendered Compose model (`docker compose ... config --format json`) on
stdin and exits non-zero, naming the first violation, unless:

  * only Caddy publishes host ports, exactly 80/tcp and 443/tcp, and no
    service uses the host network;
  * no service except the private `api-journeys` carries DEV_OTP_BYPASS or
    TEST_CONTROL_ENABLED (the public API never accepts the code 000000 and
    never answers /test-control);
  * when the journey services are present (or --require-journeys is given):
    `api-journeys` and `journeys` publish nothing, sit only on the private
    network (swift-pilot-private), are not privileged and never mount the
    Docker socket; `api-journeys` runs the public API's exact image in
    loadtest mode with both switches on, TEST_CONTROL_SECRET only as a
    NAME_FILE and SMS, email and push pinned to the in-memory dev adapters;
    the runner holds no secret (LIVETEST_* settings only) and
    targets http://api-journeys:<port>; the Caddyfile never routes to either.

It prints variable NAMES only, never values: the rendered model inlines
deploy/.env. Used by deploy/pilot-up.sh (verify_private_ports) and
deploy/journeys-run.sh. Service-free tests: deploy/tests/test_journeys_isolation.py.

Usage: docker compose ... config --format json | verify-journeys-isolation.py CADDYFILE [--require-journeys]
"""

import json
import re
import sys

PRIVATE = "api-journeys"
RUNNER = "journeys"
PRIVATE_NETWORK = "swift-pilot-private"
SWITCHES = ("DEV_OTP_BYPASS", "TEST_CONTROL_ENABLED")
# The in-memory adapters (providers/notifications/channels.ts accepts dev|twilio, dev|smtp, dev|expo).
NON_SENDING = ("NOTIFICATION_PROVIDER", "EMAIL_PROVIDER", "PUSH_PROVIDER")
PROXY_PORTS = {("80", "80", "tcp"), ("443", "443", "tcp")}


class Refused(Exception):
    pass


def ports(service):
    return {
        (str(p.get("published")), str(p.get("target")), p.get("protocol", "tcp"))
        for p in service.get("ports") or []
    }


def env(service):
    raw = service.get("environment") or {}
    if isinstance(raw, list):  # defensive: the JSON renderer emits a map
        return dict(item.split("=", 1) if "=" in item else (item, None) for item in raw)
    return raw


def switch_on(value):
    return value not in (None, "", "0")


def network_names(model, service):
    declared = model.get("networks") or {}
    attached = service.get("networks") or {}
    keys = attached if isinstance(attached, list) else list(attached.keys())
    return {k: (declared.get(k) or {}).get("name", k) for k in keys}


def check_private_attachment(model, name, service):
    if service.get("ports"):
        raise Refused(f"{name} publishes a host port")
    if service.get("network_mode"):
        raise Refused(f"{name} sets network_mode; it must use the private network only")
    if service.get("privileged"):
        raise Refused(f"{name} is privileged")
    nets = network_names(model, service)
    if list(nets.values()) != [PRIVATE_NETWORK]:
        raise Refused(f"{name} must be attached to {PRIVATE_NETWORK} only (found: {sorted(nets.values())})")
    declared = (model.get("networks") or {}).get(next(iter(nets)), {})
    if not declared.get("external"):
        raise Refused(f"{name}'s network must be the external {PRIVATE_NETWORK} bridge")
    for volume in service.get("volumes") or []:
        if "docker.sock" in str(volume.get("source", "")) or "docker.sock" in str(volume.get("target", "")):
            raise Refused(f"{name} mounts the Docker socket")


def verify(model, caddyfile_text, require_journeys=False):
    services = model.get("services") or {}

    # 1. Only the proxy is reachable from outside the host.
    if "caddy" not in services or ports(services["caddy"]) != PROXY_PORTS:
        raise Refused("caddy must publish exactly 80/tcp and 443/tcp")
    for name, service in services.items():
        if name != "caddy" and service.get("ports"):
            raise Refused(f"{name} publishes a host port; only caddy may")
        if service.get("network_mode") == "host":
            raise Refused(f"{name} uses the host network")

    # 2. The public surface never carries the test switches.
    for name, service in services.items():
        if name == PRIVATE:
            continue
        for switch in SWITCHES:
            if switch_on(env(service).get(switch)):
                raise Refused(f"{name} carries {switch}; only the private {PRIVATE} may (remove it from deploy/.env)")

    present = PRIVATE in services or RUNNER in services
    if not (present or require_journeys):
        return "no journey services in this model; public isolation holds"
    for name in (PRIVATE, RUNNER):
        if name not in services:
            raise Refused(f"{name} is missing from the journeys model")

    private, runner = services[PRIVATE], services[RUNNER]
    check_private_attachment(model, PRIVATE, private)
    check_private_attachment(model, RUNNER, runner)

    # 3. The private instance: the public API's image, loadtest, both switches.
    penv = env(private)
    if "api" not in services or private.get("image") != services["api"].get("image"):
        raise Refused(f"{PRIVATE} must run the public api's exact image")
    if penv.get("NODE_ENV") != "loadtest":
        raise Refused(f"{PRIVATE} must run with NODE_ENV=loadtest (production never hosts journeys)")
    for switch in SWITCHES:
        if penv.get(switch) != "1":
            raise Refused(f"{PRIVATE} must set {switch}=1")
    for name in NON_SENDING:
        if penv.get(name) != "dev":
            raise Refused(f"{PRIVATE} must pin {name}=dev (nothing it sends may leave the process)")
    if penv.get("TEST_CONTROL_SECRET") not in (None, ""):
        raise Refused(f"{PRIVATE} carries TEST_CONTROL_SECRET as a value; use TEST_CONTROL_SECRET_FILE")
    if penv.get("TEST_CONTROL_SECRET_FILE") != "/run/secrets/TEST_CONTROL_SECRET":
        raise Refused(f"{PRIVATE} must read TEST_CONTROL_SECRET_FILE=/run/secrets/TEST_CONTROL_SECRET")

    # 4. The runner: no secrets, targets the private instance only.
    renv = env(runner)
    foreign = sorted(k for k in renv if not k.startswith("LIVETEST_"))
    if foreign:
        raise Refused(f"{RUNNER} may carry LIVETEST_* settings only (found: {foreign})")
    if not re.fullmatch(r"http://api-journeys:\d{2,5}", str(renv.get("LIVETEST_BASE_URL", ""))):
        raise Refused(f"{RUNNER} must target http://api-journeys:<port>")
    for volume in runner.get("volumes") or []:
        if str(volume.get("target", "")).startswith("/run/secrets"):
            raise Refused(f"{RUNNER} mounts the secret directory")

    # 5. No public route reaches either service.
    if re.search(r"\b(api-)?journeys\b", caddyfile_text):
        raise Refused("the Caddyfile routes to a journey service")
    return "journey services are private, portless and off the public route"


def main(argv):
    args = [a for a in argv[1:] if not a.startswith("--")]
    if len(args) != 1:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    try:
        with open(args[0], encoding="utf-8") as fh:
            caddyfile = fh.read()
        model = json.load(sys.stdin)
        print(verify(model, caddyfile, require_journeys="--require-journeys" in argv))
        return 0
    except Refused as refusal:
        print(f"refusing journeys configuration: {refusal}", file=sys.stderr)
        return 1
    except (OSError, ValueError) as error:
        print(f"refusing journeys configuration: unreadable input ({error.__class__.__name__})", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
