# SECURITY-FINDINGS.md — Step 1 Output (June 10, 2026)

> Updated later the same day: the suite is green (114/114), the regression
> tests claimed below now actually exist, and zod validation covers every
> route input (see SEC-7 section added at the bottom).

## Fixed in This Step

### SEC-1: Socket.IO Authentication Bypass
- **Fix:** Added `io.use()` JWT middleware. Connections without a valid token are rejected before the handshake completes. `socket.data.userId` is set from the verified JWT payload — client-supplied userIds are never trusted.
- **File:** `apps/api/src/plugins/socket.ts`
- **Regression test:** `apps/api/src/__tests__/socket-auth.test.ts` — no token → refused; tampered token → refused; valid token → accepted and user room joined.

### SEC-2: Wallet Race Condition (Double-Spend)
- **Fix:** `WalletService.debit()` and `WalletService.credit()` now wrap balance check + update + transaction record inside a single Prisma `$transaction` with `Serializable` isolation. Concurrent debits on the same account are serialized at the database level.
- **File:** `apps/api/src/modules/wallet/wallet.service.ts`
- **Regression test:** `apps/api/src/__tests__/wallet-concurrency.test.ts` — 5 concurrent debits against a balance that covers one: at most one commits, balance never negative, ledger count matches.
- **Note (2026-06-20): CLOSED for V1.** WalletService has since been **removed** (cash-only) — the `wallet/` module, service, and concurrency test are gone, and the last live writer of `walletBalance`/`Transaction` (an admin order-cancel "refund to wallet") was removed too. The `walletBalance`/`Transaction` schema fields remain dormant, reserved for the Part C wallet rework; **no live code path emits them.**

### SEC-3: Hardcoded JWT Fallback Secret
- **Fix:** `auth.ts` now throws at startup if `JWT_SECRET` is not set. No fallback value. Access token expiry reduced from 24h → 30min. Refresh token session expiry reduced from 30 days → 7 days.
- **File:** `apps/api/src/plugins/auth.ts`, `apps/api/src/modules/auth/auth.service.ts`

### SEC-4: Unauthenticated Refresh Endpoint — No Input Validation
- **Fix:** Added Zod schema validation to `POST /auth/refresh`. Returns 400 on missing/wrong-type refreshToken. Added stricter rate limit (10 req/min general, 5/min OTP) on auth endpoints.
- **File:** `apps/api/src/modules/auth/auth.routes.ts`
- **Regression tests:** `apps/api/src/__tests__/rate-limit.test.ts` (6th send-otp in a minute → 429) and in `auth.test.ts`: OTP resend cooldown → 429, OTP brute-force lockout after 5 failed attempts, malformed refresh body → 400.

### SEC-5: CORS Wildcard
- **Fix:** `server.ts` now requires `CORS_ORIGIN` env var. In development without the var, it allows localhost origins only (not `*`). `socket.ts` mirrors this logic.
- **File:** `apps/api/src/server.ts`, `apps/api/src/plugins/socket.ts`

### SEC-6: Hardcoded OTP in Development
- **Fix:** `AuthService.sendOtp()` always generates a real OTP with `generateOtp()` and stores it in Redis. The dev shortcut (`123456` accepted without Redis check) is removed. OTP is still logged in development for convenience.
- **File:** `apps/api/src/modules/auth/auth.service.ts`

### SEC-10: Helmet CSP Disabled
- **Fix:** Helmet CSP enabled with a strict default-src 'self' policy.
- **File:** `apps/api/src/server.ts`

### CQ-2: Missing Database Indexes
- **Fix:** Added indexes on Order (status, customerId, vendorId, placedAt, riderId), Rider (isOnline, isAvailable), Vendor (status, vendorType), Earning (status, riderId, driverId), Transaction (userId, createdAt), Notification (userId + isRead), Subscription (nextBillingDate, status).
- **File:** `apps/api/prisma/schema.prisma`
- **Note:** Run `npx prisma migrate dev --name add_hot_path_indexes` to apply.

### CQ-3: Order Checkout Not Transactional
- **Fix:** `OrderService.checkout()` wraps order creation, promo code increment, stats updates, and cart deletion in a single `$transaction`. Either all succeed or all roll back.
- **File:** `apps/api/src/modules/order/order.service.ts`

### SEC-7: Unvalidated Input on Non-Auth Routes (closed later same day)
- **Was:** Only `auth.routes.ts` validated input. The other 10 route files had 51 raw `request.body as` casts and unvalidated query strings — `?limit=abc` produced `take: NaN` → Prisma 500s; invalid enum filter strings (e.g. `?status=garbage`) reached Prisma and threw.
- **Fix:** Zod schemas on every body and every filter/query input across chat, search, rider, driver, vendor, admin, and customer routes. Enum filters use `z.nativeEnum` from `@prisma/client` so they stay in sync with the schema. Numeric query params use `z.coerce.number()` with bounds. `parsePagination()` is NaN-safe with unit tests. Route params (`:id`) remain plain strings by design — the router guarantees the type, and lookups 404.
- **Files:** all `apps/api/src/modules/*/**.routes.ts`, `apps/api/src/utils/pagination.ts`

### Known issue deferred to Step 2 (role model rework)
- `POST /customer/switch-role` accepts `VENDOR`, but the `UserRole` enum stores `VENDOR_OWNER`, so `user.roles.includes('VENDOR')` can never be true — switching to vendor mode always 403s. Pre-existing behavior, preserved for now; Step 2 replaces roles with CUSTOMER/MOVER/VENDOR anyway.

---

## Still Open — Requires Human / Professional Review

| # | Issue | Why Not Fixed Here | Recommended Action |
|---|---|---|---|
| SEC-8 | ~~JWT token blacklist on logout~~ | **CLOSED in Step 3** — `authenticate` is session-backed: logout/password-reset delete sessions and the access token dies immediately (regression-tested in step3-auth.test.ts) | Done |
| SEC-9 | Missing RBAC ownership checks on address/order endpoints | Requires reading all 1,748 lines of customer.routes.ts carefully | Fix during Step 2 god-file split |
| SEC-11 | Admin token in `localStorage` | Fixing properly requires httpOnly cookie sessions + login page redesign for admin app | Fix in Step 13 (dashboards) |
| SEC-13 | No idempotency keys on payments/orders | Requires schema additions + client coordination | Fix in Step 5 (billing engine) |
| SEC-14 | No fraud detection on payments | V1 is cash-only; relevant when card payments added | Part C |
| SEC-17 | Socket.IO CORS was wildcarded | Fixed in server.ts — verify socket.ts CORS_ORIGIN is set in prod env | Ops task at deploy time |

---

## What Still Needs a Professional Security Review Before Launch

1. **Auth & billing paths** — A focused freelance security review (~$1.5–5k per playbook) should cover `auth.routes.ts`, `auth.service.ts`, and the subscription billing job before public launch.
2. **Document storage** — KYC documents (Step 4) involve PII. Storage path, encryption at rest, and access controls need legal + security sign-off.
3. **Cash guarantee flow** — The GPS/photo claim flow (Step 10) is a financial decision path. Ensure no AI call can influence outcomes.
