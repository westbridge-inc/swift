# ORIENTATION.md — Swift Codebase State (June 10, 2026)

Step 0 deliverable. Read-only analysis — no code was changed to produce this file.

---

## 1. Frameworks & Versions

| Layer | Tech | Version |
|-------|------|---------|
| API | Fastify | 5.x |
| ORM | Prisma | 5.x |
| DB | PostgreSQL | 16 + PostGIS 3.4 (docker-compose uses postgis/postgis:16-3.4) |
| Cache | Redis | 7-alpine |
| Background jobs | BullMQ | latest |
| Monorepo | Turborepo | 2.x |
| Admin | Next.js | 15 |
| Mobile (primary) | React Native | 0.77 |
| Mobile (scaffold) | Flutter | 3.x — 7 files only, auth + home stub |
| Packages | @swift/types, @swift/utils, @swift/config | — |

**PostGIS note:** The docker image has PostGIS but the Prisma schema uses plain Float columns for lat/lng everywhere. No spatial queries or indexes. Step 2 will convert Mover location to PostGIS geometry.

---

## 2. Existing Models vs Locked Domain Model

| Domain Entity | Schema State | Gap vs CLAUDE.md locked model |
|---|---|---|
| User | ✅ exists | Roles: CUSTOMER/RIDER/DRIVER/VENDOR_OWNER/ADMIN — locked uses CUSTOMER/MOVER/VENDOR |
| Vendor | ✅ exists | VendorType: RESTAURANT \| SUPERMARKET only — locked needs STORE \| SERVICE too |
| Item/Listing | ✅ exists as Item | No bookingConfig for services; no fulfillmentType (DELIVERY/APPOINTMENT/PICKUP) |
| Order | ✅ exists | States diverge (has RIDER_EN_ROUTE_PICKUP, taxi-specific states, no PICKED_UP in main path); markup fields throughout |
| OrderStatusLog | ✅ exists | Mutable (has no immutability guard) — should be append-only |
| Subscription | ✅ exists | Structure usable; tied to Rider/Driver/Vendor models that will change in Step 2 |
| CountryConfig | ❌ missing | Required; GYD/GY hardcoded throughout codebase |
| Trust levels (L1/L2/L3) | ❌ missing | No trustLevel on User; no VerificationDocument model |
| Mover (unified rider+driver) | ❌ missing | Separate Rider + Driver models; Step 2 combines into Mover |
| Strike system | ❌ missing | |
| PrepaidBalance | ❌ missing | For cash-paying vendors; referenced in CLAUDE.md |
| QR slug (qrSlug) | ❌ missing | For vendor deep links |
| BookingConfig | ❌ missing | For SERVICE listings |

---

## 3. Open PRs — All 12 Are Dependabot Dependency Bumps

| PR | Title | Verdict |
|---|---|---|
| #27 | Bump 49 production deps (batch) | **merge-candidate** — largest batch, includes security patches |
| #26 | Bump axios 1.13.6 → 1.16.0 | merge-candidate |
| #24 | Bump postcss 8.5.8 → 8.5.10 | merge-candidate |
| #23 | Bump turbo 2.8.20 → 2.9.14 | merge-candidate |
| #21 | Bump 5 dev deps | merge-candidate |
| #18 | Bump next 15.5.14 → 15.5.18 | merge-candidate |
| #16 | Bump @babel/plugin-transform-modules-systemjs | merge-candidate |
| #12 | Bump fastify 5.8.2 → 5.8.5 | **merge-candidate** — fastify patch, likely security fixes |
| #9 | Bump pnpm/action-setup 4 → 6 | merge-candidate |
| #4 | Bump actions/upload-artifact 4 → 7 | merge-candidate |
| #2 | Bump actions/setup-node 4 → 6 | merge-candidate |
| #1 | Bump actions/checkout 4 → 6 | merge-candidate |

**Decision needed:** Merge #27 + #12 now (security-adjacent). Others can batch after Step 1 commit.

---

## 4. Payment-Processor & Wallet Code (Master Plan §18 — Remove/Feature-Flag for V1)

V1 is CASH-ONLY. The following must be removed or feature-flagged before launch:

| File | What to do |
|---|---|
| `apps/api/src/modules/wallet/wallet.service.ts` | Remove for V1 (keep in git history) |
| Wallet routes in `customer.routes.ts` | Remove for V1 |
| `apps/api/prisma/schema.prisma` — Transaction, walletBalance, PayoutRequest, PayoutSchedule | Remove in Step 2 migration |
| `apps/api/src/utils/markup.ts` + `markup.test.ts` | Remove — no commission model |
| `apps/api/src/modules/order/order.service.ts` — calculateMarkup import + usage | Remove in Step 2 |
| OrderItem fields: markedUpPrice, markupAmount, totalMarkup, subtotalMarkup, subtotalCustomer | Remove in Step 2 |
| Order fields: subtotalMarkup, subtotalCustomer, taxiFareBase/PerKm/PerMin/Total/Surge | Simplify in Step 2 |

Keep the ledger-shape (Earning model) — it will be needed for Part C wallet later.

---

## 5. Top 10 Risks (Ranked)

1. **Business model mismatch** — Entire codebase built with 5% markup; locked model is cash-only, zero commission. Markup fields in schema, routes, order service, utils. Step 2 migration required. Until then, the API charges customers markup that should not exist.

2. **Socket.IO auth bypass (SEC-1)** — No JWT on socket connection. Client-supplied userId is trusted without verification. Any unauthenticated client can impersonate any user, spy on any order, spoof rider GPS. Fixing in Step 1.

3. **Wallet double-spend (SEC-2)** — Non-atomic balance check + debit in WalletService.debit(). Two concurrent requests can overdraw. Fixing in Step 1.

4. **Hardcoded JWT fallback secret (SEC-3)** — `auth.ts` falls back to `'dev-secret-change-me'` if JWT_SECRET env var is missing. Any server with missing env config issues forgeable tokens. Fixing in Step 1.

5. **No CountryConfig model** — GYD, GY, $50 threshold, 12000/20000/30000 GYD tiers all hardcoded. Adding a second country requires touching dozens of files. Step 2.

6. **No trust levels** — The L2 ID-gate (block orders >= $50 equivalent for unverified users) cannot be implemented without trustLevel on User. Step 2.

7. **CORS wildcard (SEC-5)** — `origin: '*'` with `credentials: true` in both server.ts and socket.ts. Any website can make authenticated requests on behalf of logged-in users. Fixing in Step 1.

8. **Checkout not transactional (CQ-3)** — Order creation and cart deletion are separate operations. Network failure between them leaves orphaned carts or orders. Fixing in Step 1.

9. **Missing DB indexes (CQ-2)** — No explicit indexes on Order.status, customerId, vendorId, placedAt; Rider.isOnline; Vendor.status; Earning.status; Transaction.userId. Full table scans at scale. Fixing in Step 1.

10. **Two mobile stacks** — React Native is complete (25+ screens); Flutter is a 7-file scaffold. Must decide which to continue. Recommend Flutter (better performance on low-end Android common in Guyana market) but React Native has a 2-month head start. Decision needed before Step 3.
