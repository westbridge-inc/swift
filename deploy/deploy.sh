#!/usr/bin/env bash
# ===========================================================================
# Swift one-command self-host / staging deploy.
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

API_PORT="$(grep -E '^API_PORT=' .env | head -1 | cut -d= -f2- || true)"; API_PORT="${API_PORT:-3000}"

case "${1:-up}" in
  up)
    echo "▸ Building the API image and starting the stack (migrations run first)…"
    docker compose up -d --build
    echo "▸ Waiting for the API to report healthy…"
    for i in $(seq 1 60); do
      if curl -fsS "http://localhost:${API_PORT}/health" >/dev/null 2>&1; then
        echo "✓ Swift is up — http://localhost:${API_PORT}/health"
        curl -fsS "http://localhost:${API_PORT}/health" && echo
        exit 0
      fi
      sleep 2
    done
    echo "✗ API did not become healthy in time — check: ./deploy/deploy.sh logs" >&2
    exit 1
    ;;
  update)
    echo "▸ Rebuilding the app image, migrating, restarting API + worker…"
    docker compose build api
    docker compose up -d --no-deps migrate
    docker compose up -d --no-deps api worker
    echo "✓ Updated."
    ;;
  logs)    docker compose logs -f api worker ;;
  health)  curl -fsS "http://localhost:${API_PORT}/health" && echo ;;
  down)    docker compose down ;;
  nuke)
    read -r -p "This DELETES all Swift data volumes. Type 'yes' to confirm: " ok
    [[ "$ok" == "yes" ]] && docker compose down -v || echo "aborted."
    ;;
  *) echo "usage: $0 {up|update|logs|health|down|nuke}" >&2; exit 1 ;;
esac
