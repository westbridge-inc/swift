# Swift

Caribbean super-app (Guyana launch). Turborepo monorepo: `apps/api` (Fastify + Prisma),
`apps/mobile` (React Native / Expo), `apps/admin` (Next.js).

## Prerequisites

- **Node 20** (required — `package.json` `engines` is `>=20`, and `.nvmrc` pins 20).
  Node 18 or 22 will not run the stack reliably. With nvm: `nvm use` (reads `.nvmrc`).
- **pnpm 9** (`corepack enable`), Docker (Postgres + Redis + Meilisearch).

## Quickstart

```sh
nvm use                                       # Node 20 (reads .nvmrc)
bash infrastructure/scripts/dev-setup.sh      # compose up (pg/redis/meili) + install + generate + seed
```

Or manually:

```sh
nvm use && pnpm install
docker compose -f infrastructure/docker/docker-compose.yml up -d   # postgres :5434, redis, meilisearch
pnpm db:sync && pnpm db:seed                  # root scripts: prisma db push + seed
pnpm --filter @swift/api dev                  # API on :3000  → GET /health
```

See `docs/RUNBOOK.md` (deploy) and `docs/LAUNCH-RUNBOOK.md` (launch) for more.

---

Proprietary. © 2026 Westbridge Inc. All rights reserved. See [LICENSE](LICENSE).
