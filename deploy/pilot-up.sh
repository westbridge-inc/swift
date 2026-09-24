#!/usr/bin/env bash
# Single-host STAGING cutover. Invoke with an approved full origin/main SHA.
# This script intentionally stops the old API/worker before migration.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SHA="${1:-}"
COMPOSE=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.yml")
ROUTING=(docker compose --project-directory "$HERE" -f "$HERE/docker-compose.routing.yml")

die() { echo "FATAL: $*" >&2; exit 1; }
env_value() {
  grep -E "^$1=" "$HERE/.env" | head -1 | cut -d= -f2- || true
}

[[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || die "pass a full 40-character git commit SHA"
[ "$(id -u)" -ne 0 ] || die "run as the non-root deploy user"
[ -f "$HERE/.env" ] || die "deploy/.env is missing"
[ "$(env_value PILOT_ENV)" = staging ] || die "PILOT_ENV must be staging"
API_HOST="$(env_value API_HOST)"
[[ "$API_HOST" =~ ^[a-zA-Z0-9][a-zA-Z0-9.-]*\.[a-zA-Z]{2,}$ ]] ||
  die "API_HOST must be a DNS hostname for staging HTTPS"
[ "$API_HOST" != localhost ] || die "API_HOST cannot be localhost"
[ "$(env_value MAPS_PROVIDER)" = osrm ] || die "pilot requires MAPS_PROVIDER=osrm"
[ "$(env_value OSRM_URL)" = http://osrm:5000 ] || die "OSRM_URL must use the private routing service"
# Secrets are not in this file (the encrypted store holds them; checked below
# against the exact revision being deployed). The database password is
# percent-encoded by the app when it assembles DATABASE_URL, so it no longer
# has to be URL-safe.
[ -n "$(env_value BACKUP_BUCKET)" ] || die "BACKUP_BUCKET is missing"
[ -f "$HERE/routing-data/osrm/guyana-latest.osrm" ] ||
  die "OSRM extract is missing; run deploy/setup-routing.sh first"
for tool in git docker curl python3; do command -v "$tool" >/dev/null 2>&1 || die "$tool is required"; done

cd "$ROOT"
[ -z "$(git status --porcelain --untracked-files=normal)" ] ||
  die "checkout has local changes; refusing to change the revision"
git fetch origin main
git merge-base --is-ancestor "$SHA" origin/main ||
  die "the requested SHA is not on current origin/main"
git switch --detach "$SHA"
[ "$(git rev-parse HEAD)" = "$SHA" ] || die "checkout differs from requested SHA"
export SWIFT_TAG="$SHA"

# ── secrets store checks (begin) ──────────────────────────────────────────
# Secrets never live in deploy/.env: the encrypted host store holds them
# (deploy/swift-secrets) and swift-secrets.service materializes them on tmpfs
# for the containers. Graded against THIS revision's allowlist and Compose file.
. "$HERE/secret-names.sh"
SECRET_NAMES="$(secret_allowlist "$ROOT")" ||
  die "could not read the secret allowlist from apps/api/src/utils/secret-files.ts"
# Every spelling Compose would load counts as a declaration — bare, indented
# by any Unicode whitespace, after a file-leading BOM, `export`-prefixed, with
# `=` or `:`, or a bare NAME passed through from this shell — and so do the
# aliases the images read (PGPASSWORD, MEILI_MASTER_KEY). One reader, one call.
DECLARED="$(env_file_declared_names "$HERE/.env" $SECRET_NAMES $SECRET_CONSUMER_ALIASES)"
if [ -n "$DECLARED" ]; then
  name="${DECLARED%%$'\n'*}"
  die "$name is declared in deploy/.env; secrets belong in the encrypted store (sudo swift-secrets set $name) and are wired as ${name}_FILE"
fi
STORE_BIN="$(command -v swift-secrets || true)"
[ -n "$STORE_BIN" ] || STORE_BIN="$HERE/swift-secrets"
[ -x "$STORE_BIN" ] || die "swift-secrets is not installed (install -m 0755 -o root -g root deploy/swift-secrets /usr/local/sbin/swift-secrets)"
# The store's parent (/etc/credstore.encrypted) is root-only (0700, the systemd
# default), so the list runs through sudo like the restart below; an unreadable
# store fails loudly rather than reading as empty.
STORED="$(sudo -n "$STORE_BIN" list)" || die "swift-secrets list failed (it reads the root-only credential store through sudo -n)"
# Everything wired as NAME_FILE — hardwired in Compose or switched on in .env —
# must be in the store, or the app refuses to boot after the old one is stopped.
WIRED="$({
  grep -oE '^[[:space:]]+[A-Z][A-Z0-9_]*_FILE: /run/secrets/[A-Z][A-Z0-9_]*' "$HERE/docker-compose.yml" || true
  grep -oE '^[A-Z][A-Z0-9_]*_FILE=/run/secrets/[A-Z][A-Z0-9_]*' "$HERE/.env" || true
} | sed -E 's#.*/run/secrets/##' | sort -u)"
for name in $WIRED; do
  grep -qx "$name" <<< "$STORED" ||
    die "$name is wired as ${name}_FILE but is not in the encrypted store; run: sudo swift-secrets set $name"
done
for name in AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY; do
  grep -qx "$name" <<< "$STORED" ||
    echo "WARNING: $name is not in the encrypted store; the nightly backup unit (BACKUP_REQUIRED=1) fails until it is" >&2
done
# Fresh files for this deploy, and proof the unit is installed.
sudo -n systemctl restart swift-secrets.service ||
  die "swift-secrets.service could not materialize the store; inspect: sudo systemctl status swift-secrets.service"
# ── secrets store checks (end) ────────────────────────────────────────────

docker network inspect swift-pilot-private >/dev/null 2>&1 ||
  docker network create --driver bridge swift-pilot-private >/dev/null
[ "$(docker network inspect -f '{{.Driver}}' swift-pilot-private)" = bridge ] ||
  die "swift-pilot-private is not a bridge network"
"${COMPOSE[@]}" config --quiet
"${ROUTING[@]}" config --quiet
verify_private_ports() {
  "${COMPOSE[@]}" config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
def ports(name):
    return {(str(p.get("published")), str(p.get("target")), p.get("protocol", "tcp")) for p in s[name].get("ports", [])}
required = {("80", "80", "tcp"), ("443", "443", "tcp")}
if "caddy" not in s or ports("caddy") != required or any(ports(n) for n in s if n != "caddy"):
    sys.exit("refusing Compose configuration with non-proxy public ports")
' || die "main Compose port isolation failed"
  "${ROUTING[@]}" config --format json | python3 -c '
import json, sys
s = json.load(sys.stdin)["services"]
if "osrm" not in s or any(x.get("ports") for x in s.values()):
    sys.exit("refusing routing configuration with public ports")
' || die "routing Compose port isolation failed"
  # The public API never carries DEV_OTP_BYPASS or TEST_CONTROL_ENABLED, and the
  # staging-only journeys override (api-journeys + the one-shot runner) never
  # publishes a port, leaves the private network or gets a Caddy route.
  "${COMPOSE[@]}" config --format json |
    python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" >/dev/null ||
    die "public API isolation failed"
  if [ -f "$HERE/docker-compose.journeys.yml" ]; then
    "${COMPOSE[@]}" -f "$HERE/docker-compose.journeys.yml" --profile journeys config --format json |
      python3 "$HERE/verify-journeys-isolation.py" "$HERE/Caddyfile" --require-journeys >/dev/null ||
      die "journeys override isolation failed"
  fi
}
verify_private_ports

# Pull versioned infrastructure images, then build the exact checked-out API.
"${COMPOSE[@]}" pull postgres redis meilisearch caddy
"${ROUTING[@]}" pull osrm
"${COMPOSE[@]}" build api
"${COMPOSE[@]}" up -d --wait postgres redis meilisearch
"${ROUTING[@]}" up -d --wait osrm

# Check routing from the same private Docker network that the API uses.
docker run --rm --network swift-pilot-private --entrypoint node "swift-api:$SHA" \
  -e "fetch('http://osrm:5000/nearest/v1/driving/-58.16,6.80').then(async r => { if (!r.ok || (await r.json()).code !== 'Ok') process.exit(1) }).catch(() => process.exit(1))"

"${COMPOSE[@]}" stop api worker
"${COMPOSE[@]}" up -d --force-recreate migrate
MIGRATE_ID="$("${COMPOSE[@]}" ps -a -q migrate)"
[ -n "$MIGRATE_ID" ] || die "migration container was not created"
. "$HERE/wait-for-migration.sh"
wait_for_migration "$MIGRATE_ID" || die "migration did not complete successfully"

"${COMPOSE[@]}" up -d --no-deps --force-recreate api worker
"${COMPOSE[@]}" up -d --no-deps --force-recreate caddy
for _ in $(seq 1 90); do
  API_ID="$("${COMPOSE[@]}" ps -q api)"
  WORKER_ID="$("${COMPOSE[@]}" ps -q worker)"
  if [ -n "$API_ID" ] && [ -n "$WORKER_ID" ] &&
     [ "$(docker inspect -f '{{.State.Health.Status}}' "$API_ID")" = healthy ] &&
     [ "$(docker inspect -f '{{.State.Status}}' "$WORKER_ID")" = running ] &&
     curl -fsS --resolve "$API_HOST:443:127.0.0.1" --connect-timeout 5 --max-time 8 "https://$API_HOST/ready" >/dev/null 2>&1; then
    echo "STAGING READY at exact SHA $SHA"
    exit 0
  fi
  sleep 2
done
die "API/worker/HTTPS readiness did not become healthy; inspect Compose logs"
