#!/bin/bash
set -e

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
cd apps/api && npx prisma generate && cd ../..

# Run migrations
echo "Running database migrations..."
cd apps/api && npx prisma migrate dev --name init && cd ../..

# Seed database
echo "Seeding database..."
cd apps/api && npx prisma db seed && cd ../..

echo ""
echo "Setup complete! Start development:"
echo "  pnpm dev         — Start all apps"
echo "  pnpm db:studio   — Open Prisma Studio"
echo ""
echo "Services:"
echo "  API:         http://localhost:3000"
echo "  Admin:       http://localhost:3001"
echo "  PostgreSQL:  localhost:5432"
echo "  Redis:       localhost:6379"
echo "  Meilisearch: http://localhost:7700"
