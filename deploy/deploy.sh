#!/usr/bin/env bash
# ===========================================================================
# Local Compose convenience commands. The reviewed staging sequence is
# pilot-up.sh with an exact commit SHA.
#
#   ./deploy/deploy.sh up        # build + migrate + start the whole stack
#   ./deploy/deploy.sh update    # rebuild the app image + migrate + restart
#   ./deploy/deploy.sh logs      # tail API + worker logs
#   ./deploy/deploy.sh health    # curl the running API's /health
#   ./deploy/deploy.sh down      # stop (KEEPS data volumes)
#   ./deploy/deploy.sh nuke      # stop AND delete data volumes (destructive)
#
# Safe by design: staging/self-host only. It never touches the gated
# production cutover path. Requires Docker with the compose plugin.
# ===========================================================================
set -euo pipefail
cd "$(dirname "$0")"

if ! docker compose version >/dev/null 2>&1; then
  echo "error: Docker with the 'compose' plugin is required (install Docker Desktop or docker-compose-plugin)." >&2
  exit 1
fi

if [[ ! -f .env ]]; then
  echo "No deploy/.env yet — creating one from the template."
  cp .env.deploy.example .env
  echo "→ Edit deploy/.env and set POSTGRES_PASSWORD, MEILISEARCH_KEY, JWT_SECRET, then re-run." >&2
  exit 1
fi

# Refuse to run with unfilled required secrets — fail closed, don't boot broken.
missing=()
for k in POSTGRES_PASSWORD MEILISEARCH_KEY JWT_SECRET; do
  v="$(grep -E "^${k}=" .env | head -1 | cut -d= -f2-)"
  [[ -z "$v" ]] && missing+=("$k")
done
if [[ ${#missing[@]} -gt 0 && "${1:-up}" != "down" && "${1:-up}" != "nuke" && "${1:-up}" != "logs" ]]; then
  echo "error: these REQUIRED values are empty in deploy/.env: ${missing[*]}" >&2
  echo "  JWT_SECRET must be >= 32 bytes: openssl rand -hex 32" >&2
  exit 1
fi

ready() {
  docker compose exec -T api node -e \
    "fetch('http://127.0.0.1:3000/ready').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
}
wait_ready() {
  for _ in $(seq 1 60); do
    if ready >/dev/null 2>&1; then echo "✓ API /ready passed"; return 0; fi
    sleep 2
  done
  echo "✗ API did not become ready" >&2
  return 1
}

case "${1:-up}" in
  up)
    docker network inspect swift-pilot-private >/dev/null 2>&1 || docker network create swift-pilot-private >/dev/null
    echo "▸ Building the API image and starting the stack (migrations run first)…"
    docker compose up -d --build
    wait_ready
    ;;
  update)
    docker network inspect swift-pilot-private >/dev/null 2>&1 || docker network create swift-pilot-private >/dev/null
    echo "▸ Rebuilding the app image, migrating, restarting API + worker…"
    docker compose build api
    docker compose stop api worker
    docker compose up -d --force-recreate migrate
    MIGRATE_ID="$(docker compose ps -a -q migrate)"
    [[ -n "$MIGRATE_ID" ]] || { echo "migration container missing" >&2; exit 1; }
    . ./wait-for-migration.sh
    wait_for_migration "$MIGRATE_ID" || { echo "migration did not complete successfully" >&2; exit 1; }
    docker compose up -d --no-deps api worker
    wait_ready
    ;;
  logs)    docker compose logs -f api worker ;;
  health)  ready ;;
  down)    docker compose down ;;
  nuke)
    read -r -p "This DELETES all Swift data volumes. Type 'yes' to confirm: " ok
    [[ "$ok" == "yes" ]] && docker compose down -v || echo "aborted."
    ;;
  *) echo "usage: $0 {up|update|logs|health|down|nuke}" >&2; exit 1 ;;
esac
