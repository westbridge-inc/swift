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

Full spec: `docs/SWIFT-MASTER-SPEC.md` · Operations: `docs/RUNBOOK.md` · System design: `docs/SYSTEM_DESIGN.md` · Session rules: `CLAUDE.md`

## Monorepo

| Path | What |
|---|---|
| `apps/api` | Fastify 5 + Prisma + PostgreSQL/PostGIS + Redis + Socket.IO |
| `apps/admin` | Next.js 15 admin (founder cockpit) |
| `apps/mobile` | React Native app (role-based: customer / mover / vendor) |
| `apps/mobile-flutter` | Flutter scaffold (stack decision pending) |
| `packages/` | `@swift/types`, `@swift/utils`, `@swift/config` |

## Quickstart

```bash
docker compose -f infrastructure/docker/docker-compose.yml up -d   # PG 5434, Redis 6382
pnpm install
cd apps/api
npx prisma migrate deploy && npx prisma generate && npx prisma db seed
npx tsx src/server.ts                # API on :3000
npx vitest run                       # test suite (requires the seed)
```

Copy `apps/api/.env.example` to `apps/api/.env` first — the server refuses to
start without `JWT_SECRET`.

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
