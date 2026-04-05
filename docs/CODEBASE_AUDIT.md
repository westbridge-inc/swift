# Swift Super App — Comprehensive Codebase Audit

> Audit Date: 2026-04-05
> Methodology: Security + Code Quality + Infrastructure audit per [daily.dev best practices](https://daily.dev/blog/audit-your-codebase-best-practices)
> Scope: Full monorepo — API, Admin, Mobile, Infrastructure, CI/CD

---

## Executive Summary

| Category | Critical | High | Medium | Low | Total |
|----------|----------|------|--------|-----|-------|
| Security | 6 | 5 | 6 | 3 | 20 |
| Code Quality | 3 | 5 | 4 | 2 | 14 |
| Infrastructure | 2 | 4 | 6 | 4 | 16 |
| **TOTAL** | **11** | **14** | **16** | **9** | **50** |

**Overall Assessment:** The codebase has a strong architectural foundation (Fastify, Prisma, Zod, Turborepo) but has **11 critical vulnerabilities** that must be fixed before production deployment. The most urgent are Socket.IO auth bypass, wallet race conditions, and hardcoded secrets.

---

## CRITICAL ISSUES (Fix Immediately)

### SEC-1: Socket.IO Authentication Bypass (CRITICAL)
**File:** `apps/api/src/plugins/socket.ts`
- No JWT verification on socket connection
- Client-supplied `userId` trusted without verification
- Any client can subscribe to any order's tracking updates
- Any client can update any user's location in Redis
- **Impact:** Full impersonation, location spoofing, order surveillance

### SEC-2: Wallet Race Condition — Double-Spend (CRITICAL)
**File:** `apps/api/src/services/wallet.service.ts`
- Balance check and debit are separate non-atomic operations
- Two concurrent requests can overdraw the wallet
- Transaction records created outside database transaction
- **Impact:** Financial loss, negative balances

### SEC-3: Hardcoded JWT Secrets (CRITICAL)
**Files:** `.env`, `apps/api/src/plugins/auth.ts`
- JWT_SECRET = `swift-dev-jwt-secret-2026` (predictable)
- Fallback secret = `dev-secret-change-me` (if env var missing)
- **Impact:** Attacker can forge valid tokens for any user

### SEC-4: Unauthenticated Refresh Token Endpoint (CRITICAL)
**File:** `apps/api/src/modules/auth/auth.routes.ts`
- POST `/auth/refresh` has no auth guard, no input validation
- Raw `request.body as { refreshToken: string }` — no Zod schema
- No rate limiting on this specific endpoint
- **Impact:** Token brute-force, session hijacking

### SEC-5: CORS Wildcard Default (CRITICAL)
**File:** `apps/api/src/server.ts`
- `origin: process.env['CORS_ORIGIN'] || '*'` — defaults to wildcard
- Combined with `credentials: true` — security anti-pattern
- **Impact:** Any website can make authenticated requests on behalf of users

### SEC-6: Hardcoded OTP in Development (CRITICAL)
**File:** `apps/api/src/modules/auth/auth.service.ts`
- OTP hardcoded to `123456` when `NODE_ENV === 'development'`
- If NODE_ENV is unset, behavior is undefined
- **Impact:** Trivial auth bypass in misconfigured environments

### CQ-1: God File — customer.routes.ts (CRITICAL)
**File:** `apps/api/src/modules/user/customer.routes.ts` — **1,748 lines**
- Contains cart, vendors, orders, addresses, notifications, favorites, wallet — everything
- Business logic embedded in route handlers instead of services
- **Impact:** Unmaintainable, untestable, high bug risk

### CQ-2: Missing Database Indexes (CRITICAL)
**File:** `apps/api/prisma/schema.prisma`
- Only 1 explicit index in entire schema (ChatRoomParticipant)
- Missing indexes on: `Order.status`, `Order.customerId`, `Order.vendorId`, `Order.placedAt`, `Rider.isOnline`, `Vendor.status`, `Earning.status`, `Transaction.userId`
- **Impact:** Full table scans on every query, degrading performance at scale

### CQ-3: Order Checkout Not Transactional (CRITICAL)
**File:** `apps/api/src/services/order.service.ts`
- Order creation: 5+ database operations without `$transaction()`
- If cart deletion fails after order creation → orphaned state
- If payment debit fails after order creation → unpaid order
- **Impact:** Data inconsistency, financial discrepancies

### INF-1: No Security Scanning in CI (CRITICAL)
**File:** `.github/workflows/ci.yml`
- No `npm audit`, no SAST, no dependency vulnerability checks
- No secret scanning
- **Impact:** Vulnerable dependencies deployed to production undetected

### INF-2: CI Doesn't Run Tests (CRITICAL)
**File:** `.github/workflows/ci.yml`
- Only runs lint + type-check, NOT `pnpm test`
- 105 tests exist but never execute in CI
- **Impact:** Regressions deployed to production

---

## HIGH ISSUES (Fix Before Launch)

### SEC-7: Weak Rate Limiting
**File:** `apps/api/src/server.ts`
- Generic 200 req/min for ALL routes including auth and payment
- Auth endpoints need 5-10 req/min, not 200
- `x-forwarded-for` header can be spoofed behind proxy

### SEC-8: Weak JWT Configuration
**File:** `apps/api/src/plugins/auth.ts`
- Access token: 24-hour expiry (should be 15-30 min)
- Refresh token: 30-day expiry (should be 7 days)
- No token blacklist on logout — JWT valid until expiry
- No refresh token rotation

### SEC-9: Missing Authorization (RBAC) Checks
**File:** `apps/api/src/modules/user/customer.routes.ts`
- Address endpoints: no ownership verification
- Order endpoints: incomplete ownership checks
- Rating endpoint: no caller verification

### SEC-10: Helmet CSP Disabled
**File:** `apps/api/src/server.ts`
- `contentSecurityPolicy: false` — no XSS protection via headers

### SEC-11: Admin Token in localStorage
**File:** `apps/admin/src/lib/api.ts`
- `localStorage.getItem('swift_admin_token')` — vulnerable to XSS
- Should use httpOnly secure cookies

### CQ-4: God File — admin.routes.ts (1,250 lines)
### CQ-5: God File — vendor.routes.ts (1,212 lines)

### CQ-6: 15+ `as any` Type Casts
**Files:** admin.routes.ts, driver.routes.ts, wallet.service.ts, notification.service.ts
- `const where: any = {}` pattern repeated 8+ times in admin routes
- Admin guard uses `(request: any, reply: any)` instead of Fastify types
- Bypasses TypeScript safety entirely

### CQ-7: Missing Service Abstractions
- `buildCartResponse()` (150+ lines) lives in route file, not a service
- Vendor enrichment logic duplicated 4 times across routes
- Cart operations mixed into customer routes

### INF-3: Docker Compose — Weak Default Credentials
**File:** `infrastructure/docker/docker-compose.yml`
- PostgreSQL: `swift:swift` — trivially weak
- No health checks on any service
- No `.dockerignore` files

### INF-4: Hardcoded Credentials in Test Files
**Files:** `apps/api/src/__tests__/auth.test.ts`, `order-flow.test.ts`
- Database connection strings hardcoded in committed test files

### INF-5: Minimal ESLint Configuration
**File:** `.eslintrc.js`
- Only `eslint:recommended` — no TypeScript-specific rules
- No React rules for admin/mobile apps
- No import organization enforcement

### INF-6: No Admin or Mobile Tests
- Admin app: 0 test files
- Mobile app: 0 test files
- API: 5 test files covering ~20% of code

---

## MEDIUM ISSUES (Fix Post-Launch)

| # | Issue | File | Category |
|---|-------|------|----------|
| SEC-12 | Missing input validation on chat routes | chat.routes.ts | Security |
| SEC-13 | No idempotency keys on payments/orders | Multiple | Security |
| SEC-14 | No fraud detection on payments | wallet.service.ts | Security |
| SEC-15 | Insufficient OTP rate limiting (1/60s) | otp.ts | Security |
| SEC-16 | No request body size limits | server.ts | Security |
| SEC-17 | Socket.IO CORS also wildcarded | socket.ts | Security |
| CQ-8 | N+1 queries in vendor detail, home feed | customer.routes.ts | Performance |
| CQ-9 | Missing return types on async functions | Multiple | TypeScript |
| CQ-10 | Duplicated distance/ETA calculations | Multiple | Duplication |
| CQ-11 | Silent error swallowing in search service | search.service.ts | Reliability |
| INF-7 | .env / .env.example mismatch | Root | Config |
| INF-8 | Inconsistent TS targets across apps | tsconfig files | Config |
| INF-9 | Missing database field constraints | schema.prisma | Database |
| INF-10 | No structured logging for production | server.ts | Observability |
| INF-11 | No environment-specific Docker configs | infrastructure/ | DevOps |
| INF-12 | Turborepo missing test task config | turbo.json | Build |

---

## LOW ISSUES (Track for Later)

| # | Issue | Category |
|---|-------|----------|
| SEC-18 | OTP logged in development mode | Logging |
| SEC-19 | Email validation not strict enough | Validation |
| SEC-20 | Scheduled order timestamp not validated | Validation |
| CQ-12 | No concurrent operation tests | Testing |
| CQ-13 | Missing Swagger/OpenAPI documentation | Documentation |
| INF-13 | Single migration file | Database |
| INF-14 | Dev setup script has wrong port numbers | Scripts |
| INF-15 | No Prettier ignore file | Config |
| INF-16 | Seed script uses console.warn for info | Code Style |

---

## Prioritized Action Plan

### Phase 1: Security Critical Path (Week 1)

| # | Action | Files to Change | Est. Lines |
|---|--------|----------------|------------|
| 1 | Fix Socket.IO — require JWT on connection, verify ownership | plugins/socket.ts | ~60 |
| 2 | Fix wallet — wrap debit/credit in `$transaction()` | services/wallet.service.ts | ~30 |
| 3 | Rotate JWT secrets, remove fallback | .env, plugins/auth.ts | ~5 |
| 4 | Add Zod schema + rate limit to refresh endpoint | auth.routes.ts | ~20 |
| 5 | Fix CORS — remove wildcard default, require explicit config | server.ts | ~5 |
| 6 | Remove hardcoded OTP — use proper generation in all envs | auth.service.ts | ~10 |
| 7 | Reduce JWT expiry to 30min, refresh to 7 days | plugins/auth.ts, auth.service.ts | ~10 |
| 8 | Add per-endpoint rate limiting (auth: 5/min) | auth.routes.ts, server.ts | ~25 |
| 9 | Enable Helmet CSP | server.ts | ~15 |
| 10 | Add RBAC ownership checks to all endpoints | customer.routes.ts | ~40 |

### Phase 2: Code Quality (Week 2-3)

| # | Action | Files to Change |
|---|--------|----------------|
| 1 | Split customer.routes.ts → cart, vendors, orders, profile routes | 4 new files |
| 2 | Split admin.routes.ts → users, vendors, finance, config routes | 4 new files |
| 3 | Split vendor.routes.ts → menu, orders, analytics routes | 3 new files |
| 4 | Add 20+ database indexes to schema.prisma | schema.prisma |
| 5 | Wrap order checkout in `$transaction()` | order.service.ts |
| 6 | Remove all `as any` casts, add proper types | 6+ files |
| 7 | Extract buildCartResponse to CartService | New service file |
| 8 | Extract vendor enrichment to VendorService | New service file |

### Phase 3: Infrastructure & Testing (Week 3-4)

| # | Action | Files to Change |
|---|--------|----------------|
| 1 | Add `pnpm test` to CI pipeline | ci.yml |
| 2 | Add `npm audit` security scan to CI | ci.yml |
| 3 | Add unit tests for OrderService, WalletService, RatingService | 3+ test files |
| 4 | Add admin app component tests | apps/admin/tests/ |
| 5 | Remove hardcoded credentials from test files | 2 test files |
| 6 | Add Docker health checks | docker-compose.yml |
| 7 | Create .dockerignore files | 2 new files |
| 8 | Upgrade ESLint to include TypeScript + React rules | .eslintrc.js |
| 9 | Add structured JSON logging for production | server.ts |
| 10 | Add test task to turbo.json | turbo.json |

### Phase 4: Hardening (Month 2)

| # | Action |
|---|--------|
| 1 | Implement idempotency keys for orders and payments |
| 2 | Add request body size limits |
| 3 | Implement token blacklist on logout |
| 4 | Add fraud detection rules for wallet operations |
| 5 | Create environment-specific Docker configs |
| 6 | Add database field constraints (VarChar limits, coordinate ranges) |
| 7 | Implement progressive OTP backoff |
| 8 | Add Swagger/OpenAPI documentation |
| 9 | Reach 80%+ test coverage |
| 10 | Set up Sentry error monitoring |

---

## What's Already Good

The audit also identified strong patterns that should be maintained:

- **Error handling middleware** — Comprehensive, handles Zod, Prisma, AppError, rate limits
- **Utility extraction** — distance.ts, markup.ts, pagination.ts, otp.ts well-organized
- **Service class pattern** — OrderService, WalletService, RatingService properly structured
- **Plugin architecture** — Fastify plugins cleanly separate infrastructure concerns
- **Prisma usage** — Template literal queries (safe from SQL injection), proper connection lifecycle
- **Health check** — Comprehensive endpoint checking API + DB + Redis
- **Graceful shutdown** — Proper cleanup hooks for all connections
- **TypeScript strict mode** — Enabled in base tsconfig
- **Module boundaries** — No cross-module import violations detected
- **Background jobs** — BullMQ properly structured for order lifecycle automation
