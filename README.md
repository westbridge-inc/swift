# Swift

Caribbean super app — Guyana launch. Food, groceries, store pickup, services,
courier, and taxi on one platform.

## The model

Swift is **B2B SaaS, not a commission marketplace**:

- **Vendors and movers pay flat weekly subscriptions** and keep **100% of their
  earnings**. Guyana tiers: movers $12,000 GYD, small vendors $20,000 GYD,
  large vendors $30,000 GYD per week (all configured per country, never
  hardcoded).
- **Customers pay nothing to the platform.** No markups, no service fees.
- **V1 is cash-only.** Swift never holds or processes order money — cash is
  recorded, payment happens directly between customer, mover, and vendor.
  Platform revenue = subscriptions + ads.
- **Trust levels** protect the cash flow: L1 phone-verified (mandatory),
  L2 ID-verified (required at the $50-USD-equivalent order gate), L3 earned.
  Failed cash handovers under the gate are company-guaranteed with a
  GPS/photo claim flow and a customer strike system.

Full spec: `docs/SWIFT-MASTER-SPEC.md` · **Launch (zero→live): `docs/LAUNCH-RUNBOOK.md`** · Operations: `docs/RUNBOOK.md` · System design: `docs/SYSTEM_DESIGN.md` · Session rules: `CLAUDE.md`

## Monorepo

| Path | What |
|---|---|
| `apps/api` | Fastify 5 + Prisma + PostgreSQL/PostGIS + Redis + Socket.IO |
| `apps/admin` | Next.js 15 admin (founder cockpit) |
| `apps/mobile` | React Native app (role-based: customer / mover / vendor) |
| `packages/` | `@swift/ui` (shared RN design system), `@swift/types`, `@swift/utils`, `@swift/config` |

## Quickstart

Prereqs: **Node 20+**, **pnpm 9**, **Docker**.

```bash
# 1. Infra — Postgres/PostGIS :5434, Redis :6382, Meilisearch :7700
docker compose -f infrastructure/docker/docker-compose.yml up -d

# 2. Env — every provider defaults to a dev adapter; only JWT_SECRET is required
cp apps/api/.env.example apps/api/.env          # then set JWT_SECRET + JWT_REFRESH_SECRET

# 3. Install + database (migrate is clean on a fresh DB; db seed creates demo data)
pnpm install
cd apps/api
npx prisma migrate deploy && npx prisma generate && npx prisma db seed

# 4. Run the API (:3000) and prove it
npx tsx src/server.ts
npx vitest run                                  # full suite — needs the seed; NODE_ENV=test, no DEV_OTP_BYPASS
```

Then, from the repo root, run the other surfaces:

```bash
pnpm --filter @swift/admin dev                  # admin cockpit → :3001 (Next.js)
pnpm --filter @swift/mobile start               # mobile app → Expo
```

**Going live is a config change, not a code change.** Flip the providers in
`apps/api/.env` and supply their credentials — `NOTIFICATION_PROVIDER=twilio`
(OTP), `MAPS_PROVIDER=osrm|google`, `STORAGE_PROVIDER=s3`,
`PAYMENT_PROVIDER=powertranz` (weekly subscriptions only). Every variable is
documented in `apps/api/.env.example`. Launching a new **country** is a
`CountryConfig` row (currency, ID-gate, subscription tiers, document checklists).

## Engineering rules (never break)

1. Money, auth, billing, verification = deterministic code. **Never an AI call.**
2. Never hold or process order money. Cash is recorded only.
3. No PII, documents, or payment data to any external AI service.
4. Every external service behind a swappable interface
   (PaymentProvider, KycProvider, Maps, Notifications, BankingProvider).
5. Zod validation on every route input; tests for every business rule,
   failure paths first; idempotency keys on billing; append-only order log.

`CountryConfig` wraps everything country-specific (currency, ID-gate,
subscription tiers, document checklists) — launching a new country is a
config row, not a code change.
