# Pre-launch gaps — what's left before Swift takes a real order in production

_Last updated: 2026-06-20. An honest, current picture for anyone who lands on this repo._

Swift is **substantially built and on `main`** — the six verticals, the trust engine, cash-float
dispatch (proximity offer cascade + accept/decline), billing + 14-day trials, full spec §I
conformance (8/8, CI-enforced), taxi **ride classes** (Standard/Comfort/XL), the app-store-grade
mobile UI, and the admin console. CI is green, and the API boots to a healthy `/health` from the
documented quickstart. **What remains is integration, QA, and deploy — not feature invention.**

## 1. Provider credentials (config, not code — adapters already exist)

Every external service is behind a swappable provider that defaults to a dev adapter. To go live,
set these in `apps/api/.env` (all documented in `apps/api/.env.example`):

| Provider | Env | For | Needed at launch? |
|---|---|---|---|
| **Twilio** | `NOTIFICATION_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID/AUTH_TOKEN/FROM` | OTP / SMS | **Yes** |
| **PowerTranz/FAC** | `PAYMENT_PROVIDER=powertranz` + gateway keys | Weekly **subscription** billing (never order money) | Yes (to bill subs) |
| **Maps** | `MAPS_PROVIDER=osrm` + `OSRM_URL` (or `google` + key) | Driving ETAs | Optional (Haversine default works) |
| **Storage** | `STORAGE_PROVIDER=s3` + AWS keys | Verification document storage | Yes (for KYC docs) |
| **Meilisearch** | `MEILISEARCH_KEY` | Search master key | In prod |

## 2. On-device QA (cannot be automated in this repo)

The mobile app is built and type/lint-clean, but the iOS-simulator bridge (idb) is unavailable in
the build environment, so several flows have **not had on-device tap-through QA**: the customer app
sweep, the new **taxi ride-class selector**, and the vendor/mover dashboards. Run the app on a
device/simulator and walk the core flows before launch.

## 3. Deploy

- **API** → Fly (`deploy-api.yml`); **Admin** → (`deploy-admin.yml`).
- Run `prisma migrate deploy` on the production DB (verified drift-free), then `prisma db seed`
  the `CountryConfig` for each launch market.
- Set `CORS_ORIGIN` + `TRUST_PROXY` for the production topology (SEC-17).

## 4. Verification operations (built — needs people, not code)

Guyana V1 verification is **document-upload + manual admin review** — no third-party KYC API is
needed (none covers Guyana well). The engine is built (role checklists, document expiry sweep,
HIRE-class insurance gate, append-only audit log). It needs **ops staff** to work the queue.

## 5. Known V2 / deferred items (documented decisions, not bugs)

- **Food/grocery delivery priority** — *not a V1 gap.* Dispatch carries **one order per rider**
  (claiming sets the rider unavailable; no batching), so food delivery is already direct/ASAP — a
  "priority/express" fee would charge for the default behaviour. It becomes meaningful only with
  batching / multi-order routing (V2). The **courier** vertical already has speed tiers
  (`STANDARD/EXPRESS/RUSH`).
- **Ride-class premium-driver enforcement** — `Driver.vehicleClass` already gates dispatch by class;
  an admin UI / onboarding step to mark drivers as `COMFORT`/`XL` is the follow-up (all default to
  `STANDARD`, so those tiers match no driver until a premium fleet is onboarded).
- **Mobile MapLibre rendering** — the backend OSRM provider has landed; swapping the mobile map
  component (`react-native-maps` → MapLibre) is a native-module change needing on-device work.
- **Wallet / fintech** — dormant by design (cash-only V1). `walletBalance`/`Transaction` schema is
  reserved for the Part C wallet rework; **no live code path emits them.**
- **Admin delivery zones** — delivery range is enforced per-vendor (radius) + per-market
  (`CountryConfig`) today; map-drawn zones are on the roadmap.

## 6. Open security tickets (triaged — see `SECURITY-FINDINGS.md`)

- **SEC-9 (IDOR/ownership)** — verified **closed** (address/order endpoints scope to the owner).
- **SEC-11** admin token in `localStorage` — accepted V1 risk (small internal operator set);
  durable fix is httpOnly-cookie sessions.
- **SEC-13** order-placement idempotency — low-risk for cash-only (no double-charge); subscription
  billing is already idempotent.
- **SEC-14** payment fraud detection — relevant when card payments land (Part C).
- A focused external review of the auth/billing paths and KYC storage is recommended pre-launch.

---

**Bottom line:** the product is real and on `main`. The path to a first real order is: wire ~4
credentials → on-device QA → deploy → staff the verification queue. Everything else above is a
documented V2 item or an ops task.
