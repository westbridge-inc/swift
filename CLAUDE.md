# Swift — Claude Code Instructions

## What this is
Swift: Caribbean super app (Guyana launch). Two-sided marketplace.
Vendors + Movers pay flat WEEKLY SUBSCRIPTIONS and keep 100% of earnings.
Customers pay nothing to the platform. Revenue = subscriptions + ads.
V1 is CASH-ONLY: no order payment processing, no wallet, no commission.
Full spec: docs/swift-master-plan.pdf (Section 18 lists superseded decisions).

## Hard rules (never break)
1. Money, auth, billing, verification = deterministic code. NEVER an AI call.
2. Never hold or process order money. Cash is recorded only.
3. No PII / documents / payment data to any external AI service.
4. All external services behind swappable interfaces:
   PaymentProvider, KycProvider, Maps, Notifications, BankingProvider.
5. One concern per session. Propose a plan BEFORE writing code.

## Locked domain model
Roles: CUSTOMER, MOVER (rider and/or driver), VENDOR.
VendorType: RESTAURANT | SUPERMARKET | STORE | SERVICE (exactly 4).
Listing: one model for goods AND services (services carry bookingConfig:
  duration, slots). fulfillment: DELIVERY | APPOINTMENT | PICKUP.
Order states: placed -> accepted -> preparing -> ready -> picked_up
  -> delivered | cancelled. Immutable order event log.
Trust levels: L1 phone-verified (OTP, mandatory), L2 ID-verified
  (required for orders >= USD $50 equivalent), L3 earned/trusted.
Cash rules: rider float (rider pays vendor at pickup, collects from
  customer); GOLDEN RULE: payment before handover; under-$50 company
  guarantee with GPS/photo claim flow; strike system on customers.
Subscriptions: weekly, tiered (rider 12000 GYD, small vendor 20000,
  large 30000, franchise per store, catalogue-size tiers above).
Auto-suspend on non-payment. Prepaid balance path for cash vendors.
CountryConfig wraps currency, thresholds, tiers, document checklists.

## Engineering standards
- TypeScript strict. Zod (or equiv) validation on every route.
- Tests required for every business rule; failure paths first.
- Idempotency keys on all billing calls; audit log on money events.
- PostGIS for mover geolocation; indexes on hot queries.
- No secrets in code. Env only.
