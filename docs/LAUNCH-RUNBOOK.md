# Swift — Launch Runbook (zero → live)

A step-by-step checklist to take this repo from "code complete" to "a real
customer can place a real order." Pairs with `PRE-LAUNCH-GAPS.md` (what's left)
and `RUNBOOK.md` (ongoing ops, rollback, restore).

> **Deploying the repo alone does NOT make the platform live.** "Live" means
> three surfaces working together: the **API** (backend), the **Admin** web
> console, and the **mobile app** (customer + mover + vendor — one React Native
> app distributed through the App Store / Play Store, *not* a web deploy).

---

## 0. Accounts & credentials — what you actually need

| Service | Required? | Why / where | Cost |
|---|---|---|---|
| **Postgres + PostGIS** | ✅ Required | Primary DB + geo dispatch | host (Fly/Neon/RDS) |
| **Redis** | ✅ Required | OTPs, dispatch offers, queues, cache | host (Fly/Upstash) |
| **Meilisearch** | ✅ Required | Vendor/item search | host or self-run |
| **`JWT_SECRET` / `JWT_REFRESH_SECRET`** | ✅ Required | API **refuses to boot** without them | free (generate) |
| **Twilio** | ✅ Required | OTP/SMS — **without it nobody can sign up or log in** | pay-per-SMS |
| **S3 or Cloudflare R2** | ✅ Required | KYC/verification document storage (private + encrypted) | usage |
| **Apple Developer account** | ✅ Required (iOS) | App Store distribution | $99/yr |
| **Google Play Developer account** | ✅ Required (Android) | Play Store distribution | $25 once |
| **Expo account** | ✅ Required | EAS builds of the mobile app | free tier ok |
| **Hosting (Fly.io)** | ✅ Required | API + Admin (`deploy-api.yml` / `deploy-admin.yml`) | usage |
| **PowerTranz / FAC** | ⚠️ Needed to bill | Weekly **subscription** charges (the revenue). Can launch then enable. | merchant acct |
| **Google Maps API key (Android)** | ⚠️ Android only | `react-native-maps` renders the map on **Android** via Google Maps SDK. **iOS uses Apple Maps — no key.** | free tier |
| **Google Maps API key (backend)** | ❌ Optional | Driving ETAs/fares. Default `haversine` (straight-line) works; `osrm` is a free routing alternative. | free tier |
| **Meilisearch master key** | ✅ in prod | Secures the search index | free |
| **Anthropic API key** | ❌ Optional | AI language layer only — app is fully functional without it | usage |

**On Google Maps specifically:** you do **not** need it to launch. The backend
defaults to Haversine ETAs. The *only* place a Google Maps key is effectively
required is **rendering the map inside the Android app** (`react-native-maps`);
iOS uses Apple Maps for free. (A planned MapLibre swap would remove even that.)

---

## 1. Provision infrastructure

Either managed services or the provided compose file as a template
(`infrastructure/docker/docker-compose.yml`). You need, reachable from the API:

- **PostgreSQL 16 + PostGIS** → `DATABASE_URL`
- **Redis 7** → `REDIS_URL`
- **Meilisearch** → `MEILISEARCH_URL` (+ `MEILISEARCH_KEY` in prod)

## 2. Configure secrets (production env)

Set these in your host's secret store (never commit). Full list +
docs in `apps/api/.env.example`. Minimum for a real launch:

```bash
NODE_ENV=production
JWT_SECRET=$(openssl rand -hex 32)            # 64 hex chars
JWT_REFRESH_SECRET=$(openssl rand -hex 32)
DATABASE_URL=postgresql://…                    # your PostGIS
REDIS_URL=redis://…
MEILISEARCH_URL=…   MEILISEARCH_KEY=…
CORS_ORIGIN=https://admin.swift.gy             # admin origin(s); NO wildcard in prod
TRUST_PROXY=true                               # behind Fly/LB

NOTIFICATION_PROVIDER=twilio
TWILIO_ACCOUNT_SID=…  TWILIO_AUTH_TOKEN=…  TWILIO_FROM=+1…

STORAGE_PROVIDER=s3
AWS_S3_BUCKET=…  AWS_ACCESS_KEY_ID=…  AWS_SECRET_ACCESS_KEY=…  AWS_REGION=…
STORAGE_SIGNING_SECRET=$(openssl rand -hex 32)
API_PUBLIC_URL=https://api.swift.gy

PAYMENT_PROVIDER=powertranz                    # when ready to bill subscriptions
PAYMENT_GATEWAY_KEY=…  PAYMENT_GATEWAY_SECRET=…  POWERTRANZ_API_URL=https://…

# MAPS_PROVIDER=haversine (default — fine) | osrm (+OSRM_URL) | google (+GOOGLE_MAPS_API_KEY_BACKEND)
# DEV_OTP_BYPASS must be UNSET/0 in prod.
```

## 3. Database — migrate & seed

```bash
cd apps/api
npx prisma migrate deploy          # applies all migrations (verified drift-free)
npx prisma db seed                 # seeds CountryConfig (Guyana) — REQUIRED; without it
                                   # there is no currency / ID-gate / tiers / doc checklists
```
> Seed is idempotent (upsert). Confirm the **Guyana `CountryConfig`** row exists
> and `isActive=true` before launch.

## 4. Deploy API + Admin

- **API** → `flyctl deploy --config apps/api/fly.toml` (or trigger `deploy-api.yml`
  with `FLY_API_TOKEN` set). The workflow runs `prisma migrate deploy` on release.
- **Admin** → `deploy-admin.yml`. Set its API base URL + the admin's own secrets.
- Point DNS: `api.swift.gy` → API, `admin.swift.gy` → Admin (match `CORS_ORIGIN`
  and the mobile `EXPO_PUBLIC_API_URL`).

## 5. Smoke-test the API

```bash
curl https://api.swift.gy/health                         # {status:"healthy", db:ok, redis:ok}
curl -X POST https://api.swift.gy/api/v1/auth/send-otp \  # should send a REAL SMS via Twilio
  -H 'content-type: application/json' -d '{"phone":"+592…"}'
curl https://api.swift.gy/api/v1/auth/countries          # Guyana present + isActive
```

## 6. Mobile app — build & submit (the part that isn't "just a deploy")

Prereqs: `npm i -g eas-cli`, `eas login`, and from `apps/mobile/` run `eas init`
(creates the EAS project + writes the `projectId` into `app.json`).

1. **Android Maps key:** add a Google Maps **Android** API key so the map renders
   (`app.json` → `expo.android.config.googleMaps.apiKey`, ideally via
   `app.config.js` reading an env/EAS secret — don't hardcode a raw key).
2. **Configure store creds** in `eas.json` → `submit.production` (Apple ID /
   ASC app id / team id; Google Play service-account JSON).
3. **Build:**
   ```bash
   eas build --profile production --platform ios
   eas build --profile production --platform android
   ```
   (`eas build --profile preview` makes an internal/TestFlight build first — do that for QA.)
4. **Submit:**
   ```bash
   eas submit --profile production --platform ios       # → App Store Connect (Apple review ~1–3 days)
   eas submit --profile production --platform android    # → Play (internal → production)
   ```
   The `production` profile points the app at `https://api.swift.gy`
   (`EXPO_PUBLIC_API_URL`); `preview` points at staging.

## 7. On-device QA (before public release)

Install the **preview** build (TestFlight / Play internal) and walk every flow:
sign-up → OTP (real SMS) → each vertical (food/grocery/store/services/courier/taxi)
→ checkout (cash) → order tracking; mover onboarding → docs → go-online → accept →
deliver; vendor onboarding → menu → accept order. Confirm maps render on Android.

## 8. Onboard supply & go live

- Seed/onboard real **vendors** and **movers** (admin console or onboarding flow);
  work the **verification queue** (manual KYC review — needs ops staff).
- Start subscriptions/trials for approved partners so they can operate.
- Flip the store listings to public release. **You're live.**

## 9. Rollback / restore

See `RUNBOOK.md` (API rollback, DB restore). Mobile: promote the previous
build in App Store Connect / Play, or ship an EAS Update if configured.
