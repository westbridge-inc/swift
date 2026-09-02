#!/bin/bash
# Swift development environment bootstrap.
#
# [INF-002] This script never authors schema and never touches a database it
# has not proven disposable. The database work is four separate, interactive
# stages of scripts/dev/bootstrap.ts — verify, create, migrate, seed — and each
# one proves its target BEFORE the first SQL statement: an explicit
# SWIFT_DEV_BOOTSTRAP=YES, a loopback host, a disposable database name, an
# interactive terminal outside CI, then (read-only) the connecting role, the
# server-side disposable marker and the schema fingerprint, then a typed
# confirmation naming the database. `migrate` applies the immutable checked-in
# migration set with `prisma migrate deploy`; nothing here runs `migrate dev`
# or `db push`. Rollback: unset SWIFT_DEV_BOOTSTRAP.
set -euo pipefail

if [ -n "${CI:-}" ] || [ -n "${GITHUB_ACTIONS:-}" ] || [ ! -t 0 ]; then
  echo "dev-setup.sh is an interactive developer bootstrap; it does not run in CI or without a terminal." >&2
  exit 1
fi

echo "Setting up Swift development environment..."

# Start infrastructure
echo "Starting Docker services (PostgreSQL, Redis, Meilisearch)..."
docker compose -f infrastructure/docker/docker-compose.yml up -d

# Wait for PostgreSQL
echo "Waiting for PostgreSQL..."
until docker exec swift-postgres pg_isready -U swift > /dev/null 2>&1; do
  sleep 1
done

# Install dependencies
echo "Installing dependencies..."
pnpm install

# Generate Prisma client
echo "Generating Prisma client..."
(cd apps/api && npx prisma generate)

# The local Docker stack's owner login (infrastructure/docker/docker-compose.yml)
# and the least-privilege bootstrap login `create` provisions. The bootstrap
# password lives outside the repository, generated once, readable only by you.
export SWIFT_DEV_BOOTSTRAP=YES
export DATABASE_URL="${DATABASE_URL:-postgresql://swift:swift@localhost:5434/swift}"
SWIFT_HOME="${HOME}/.swift"
mkdir -p "$SWIFT_HOME"; chmod 700 "$SWIFT_HOME"
if [ -z "${SWIFT_BOOTSTRAP_PASSWORD:-}" ]; then
  if [ ! -f "$SWIFT_HOME/bootstrap.env" ]; then
    umask 077
    printf 'SWIFT_BOOTSTRAP_PASSWORD=%s\n' "$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 32)" > "$SWIFT_HOME/bootstrap.env"
  fi
  # shellcheck disable=SC1091
  . "$SWIFT_HOME/bootstrap.env"
  export SWIFT_BOOTSTRAP_PASSWORD
fi
DB_NAME="${DATABASE_URL##*/}"; DB_HOSTPORT="$(printf '%s' "$DATABASE_URL" | sed -E 's#^[a-z]+://[^@]*@([^/]+)/.*$#\1#')"
export SWIFT_BOOTSTRAP_URL="postgresql://swift_bootstrap:${SWIFT_BOOTSTRAP_PASSWORD}@${DB_HOSTPORT}/${DB_NAME}"

bootstrap() { (cd apps/api && npx tsx ../../scripts/dev/bootstrap.ts "$@"); }

echo "Proving the database target (read-only)..."
bootstrap verify || true
echo "Stamping the disposable marker and provisioning the least-privilege login (owner stage)..."
bootstrap create
echo "Applying the checked-in migration set (as swift_bootstrap)..."
bootstrap migrate
echo "Seeding the demo dataset (as swift_bootstrap)..."
bootstrap seed

echo ""
echo "Setup complete! Start development:"
echo "  pnpm dev         — Start all apps"
echo "  pnpm db:studio   — Open Prisma Studio"
echo ""
echo "Services:"
echo "  API:         http://localhost:3000"
echo "  Admin:       http://localhost:3001"
echo "  PostgreSQL:  localhost:5434"
echo "  Redis:       localhost:6382"
echo "  Meilisearch: http://localhost:7700"
echo ""
echo "Bootstrap journal: ${SWIFT_BOOTSTRAP_JOURNAL:-$SWIFT_HOME/bootstrap-journal.jsonl}"
