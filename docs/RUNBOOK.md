# Swift Runbook

Operations basics for the API. Written so a stranger can deploy, roll back,
and restore. (Playbook Step 15.)

## Architecture in one paragraph

Fastify API (`apps/api`) on Node 20+, PostgreSQL 16 + PostGIS, Redis 7
(cache, OTPs, dispatch offers, BullMQ queues), Socket.IO on the same HTTP
server. Everything external sits behind swappable providers (`src/providers/`):
KYC, payments, storage, maps, notification channels — selected by env vars,
all defaulting to local/sandbox adapters.

## Environments & secrets

- Copy `apps/api/.env.example`; the server **refuses to start without
  `JWT_SECRET`**, and production **requires `CORS_ORIGIN`** (no wildcard).
- Provider keys are optional in dev (sandbox adapters). `ANTHROPIC_API_KEY`
  is optional everywhere — the app is fully functional without AI.
- Never commit `.env`. Secrets live in the deploy platform's secret store.

## Deploy

CI (`.github/workflows/ci.yml`) is the gate: lint, typecheck, full test
suite against PostGIS + Redis services, API/admin builds, dependency audit.
**Nothing deploys that isn't green.**

1. Merge/push to `main` → confirm the CI run is green.
2. Run the `Deploy API` workflow manually (workflow_dispatch) once Fly.io
   credentials are configured; `Deploy Admin` likewise needs `VERCEL_TOKEN`.
3. Migrations run with `npx prisma migrate deploy` (never `migrate dev` in
   production). Two raw-SQL artifacts are created idempotently by the seed
   and by migrations: the bookings partial unique index and the PostGIS
   extension + riders geo index.

> **Clean-DB deploy is validated (2026-06-26).** Dev uses `prisma db push`, so
> the local `_prisma_migrations` table drifts from the migration files — but a
> fresh `migrate deploy` is what production actually runs, so verify it directly
> rather than trusting dev state. Reproduce against a scratch DB:
>
> ```sh
> createdb swift_migcheck
> DATABASE_URL=…/swift_migcheck npx prisma migrate deploy        # all 24 apply, incl. the
>                                                                # ride_classes add/remove/re-add churn
> DATABASE_URL=…/swift_migcheck npx prisma migrate diff \
>   --from-url …/swift_migcheck --to-schema-datamodel prisma/schema.prisma --script   # → empty = no drift
> DATABASE_URL=…/swift_migcheck npx prisma db seed              # succeeds
> ```
>
> Last run: 24/24 migrations applied, **no drift**, seed OK.

## Rollback

- App: redeploy the previous image/release from the platform dashboard
  (releases are immutable; `fly releases` / Vercel deployments list).
- Migrations are additive-only by policy so far — rolling the app back one
  release is safe against the current schema. If a future migration is
  destructive, it must ship with a written down-path in its directory.

## Backups & restore (tested, not assumed)

- Platform Postgres daily snapshots ON (verify in provider dashboard).
- Manual backup: `pg_dump "$DATABASE_URL" -Fc -f swift-$(date +%F).dump`
- Restore drill (the same steps CI runs on every push — see the
  `restore-test` job): create a scratch DB, `pg_restore` into it, sanity:

```bash
createdb swift_restore_check
pg_restore --no-owner -d swift_restore_check swift-YYYY-MM-DD.dump
psql swift_restore_check -c 'SELECT count(*) FROM users; SELECT count(*) FROM orders;'
```

If those counts look sane and the app boots against the restored DB with
read-only checks, the backup is real. **An untested backup does not exist.**

## On-call basics

- Health: `GET /health` — reports api/db/redis. Degraded = investigate Redis
  first (OTPs, offers, queues all touch it), then Postgres connections.
- Logs are structured (pino) with `x-request-id` correlation; authorization
  headers, tokens, and passwords are redacted at the logger.
- Queues: BullMQ workers run in-process. Stuck dispatch offers self-heal via
  offer TTLs; billing is idempotent at the DB so re-running a cycle is safe.
- Suspended vendor/mover complaining? Check `billing_events` /
  `reimbursement_claims` for the audit trail — the ledger tells the story.
- Cash-claim disputes: every claim carries GPS + timestamp + optional photo;
  the strike history for customer/phone/address is in `strikes`.

## Known manual gates

- `Deploy API` / `Deploy Admin` / `Build Mobile` workflows are
  workflow_dispatch until credentials + the mobile-stack decision exist.
- Remaining `pnpm audit` highs are transitive via prisma (`effect`) and
  vitest (`vite`) awaiting upstream releases — tracked, non-blocking
  (security job is continue-on-error and annotates each run).
