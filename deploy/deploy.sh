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
  echo "→ Edit deploy/.env (settings only), run ./deploy/gen-secrets.sh for the secrets, then re-run." >&2
  exit 1
fi

# ── secrets store check (begin) ───────────────────────────────────────────
# The stack reads its secrets from /run/swift-secrets, a tmpfs that
# swift-secrets.service fills from the systemd-creds store: a LINUX host with
# the store installed (deploy/swift-secrets). There is no macOS path for this
# stack; stopping it needs no store on any OS.
ACTION="${1:-up}"
if [[ "$ACTION" != down && "$ACTION" != nuke && "$ACTION" != logs ]]; then
  if [[ "${SWIFT_DEV_NO_STORE:-0}" == 1 ]]; then
    echo "WARNING: SWIFT_DEV_NO_STORE=1 — skipping the secret-store check. You must provide every" >&2
    echo "         /run/swift-secrets/NAME file yourself. This is for a throwaway local stack only," >&2
    echo "         never for a host that holds a real credential." >&2
  elif [[ "$(uname -s)" != Linux ]]; then
    echo "error: this stack delivers secrets through /run/swift-secrets (systemd-creds + tmpfs), which exists on Linux only." >&2
    echo "  On macOS run the API with pnpm dev against the local infra containers. To force a throwaway" >&2
    echo "  stack here anyway, set SWIFT_DEV_NO_STORE=1 and provide the files yourself." >&2
    exit 1
  else
    # Fail closed, don't boot broken: the required secrets must be in the store.
    STORE_BIN="$(command -v swift-secrets || true)"
    [[ -n "$STORE_BIN" ]] || STORE_BIN=./swift-secrets
    # The store's parent is root-only (0700), so list through sudo -n exactly as
    # pilot-up does; a list that fails is a refusal, never an empty store.
    stored="$(sudo -n "$STORE_BIN" list)" || {
      echo "error: could not list the encrypted store (it is root-only; this reads it with sudo -n swift-secrets list)" >&2
      exit 1
    }
    missing=()
    for k in POSTGRES_PASSWORD MEILISEARCH_KEY JWT_SECRET OTP_HASH_SECRET MASTER_KEK STORAGE_SIGNING_SECRET CONSENT_IP_PEPPER; do
      grep -qx "$k" <<< "$stored" || missing+=("$k")
    done
    if [[ ${#missing[@]} -gt 0 ]]; then
      echo "error: these REQUIRED secrets are not in the encrypted store: ${missing[*]}" >&2
      echo "  ./deploy/gen-secrets.sh stores them; sudo systemctl restart swift-secrets.service delivers them to /run/swift-secrets" >&2
      exit 1
    fi
  fi
fi
# ── secrets store check (end) ─────────────────────────────────────────────

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
