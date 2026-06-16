# SWIFT — MASTER BUILD SPECIFICATION

### The complete feature-by-feature build bible for Claude Code

**Westbridge Inc. · Caribbean Super App · Guyana launch → CARICOM expansion**

-----

> **How to use this document:** This is the full specification for Swift. Every vertical, screen, system, and rule is written out. Hand it to Claude Code as the source of truth. When building any feature, find its section here and follow it exactly. Sections marked **[V1]** are launch-critical; **[V2]** are later phases; **[FINTECH]** is the future financial layer.

-----

# PART 1 — WHAT SWIFT IS

## 1.1 The product in one paragraph

Swift is a Caribbean super-app: one mobile app where a customer can order food, get groceries, send a parcel, book a taxi, shop local retail, and hire verified service providers (plumbers, electricians, chefs, caterers, party organizers, and more). Every provider is ID-verified and police-cleared. The business runs on **flat weekly subscription fees** paid by vendors, drivers, riders, and service providers — never commission, never customer fees. Customers pay nothing to use the app. V1 is cash-on-delivery; a fintech wallet layer comes later.

## 1.2 The six verticals

1. **Food delivery** — order from restaurants [V1]
1. **Groceries** — order from grocery stores/supermarkets [V1]
1. **Courier** — send parcels/items person-to-person [V1]
1. **Taxi / ride-hailing** — book a verified driver [V1, gated on insurance/legal]
1. **Retail** — “local Amazon”: buy goods from local stores with cross-store search [V2]
1. **Services** — hire verified tradespeople & professionals [V2]

## 1.3 The non-negotiable business rules

These rules are load-bearing. Never build a feature that violates them. If a task would, STOP and flag it.

- **Revenue = flat weekly subscription fees only.** Vendors/drivers/riders/providers pay a weekly fee. NEVER commission. NEVER customer-facing fees.
- **Participants keep 100%** of their earnings/sales/fares. The flat fee is their only cost.
- **Customers pay nothing** to use the platform.
- **2-week free trial** for all new paying participants.
- **V1 is cash-only** (cash on delivery / cash on completion). No fintech in V1.
- **Multi-country via `CountryConfig`** — Guyana first, then CARICOM. NEVER hardcode country-specific values.
- **Trust is the brand.** Every provider is verified. Safety is a visible feature, not just compliance.

## 1.4 Revenue model (WRR)

- The core metric is **Weekly Recurring Revenue (WRR)** = active paying participants × weekly fee.
- Five paying participant types: restaurants, grocery stores, retail stores, riders, taxi drivers — plus service providers.
- Subscription billing rail: **PowerTranz/FAC** primary, **WiPay** backup. Stripe Connect ruled out (Guyana unsupported).
- The whole model lives or dies on **retention** — a participant who stops paying is pure churn. Build features that keep them earning enough that the fee feels trivial.

-----

# PART 2 — TECH ARCHITECTURE

## 2.1 Stack

- **Monorepo:** Turborepo
- **Backend:** TypeScript + Fastify + Prisma + PostgreSQL
- **Customer mobile app:** React Native
- **Provider/driver apps:** React Native (may share codebase with role switching)
- **Admin dashboard:** Next.js
- **Storage:** encrypted object storage (S3 / Cloudflare R2) for documents — NOT blobs in Postgres

## 2.2 The `CountryConfig` system (critical)

Every country-specific value lives in a `CountryConfig` object, never hardcoded. Each country (Guyana, Trinidad, Jamaica, Barbados, etc.) has its own config. A feature reads from the active country’s config.

`CountryConfig` must include at minimum:

- `currency` (e.g. GYD, TTD, JMD), currency symbol, formatting
- `taxiCredentialName` (Guyana: “Hire Car Licence”; Trinidad: “H-Taxi Badge”; Jamaica: “PPV Badge”; Barbados: “PSV Badge”)
- `insuranceClassName` (e.g. “Hire” insurance)
- `verificationSources` (which registries/APIs are available — GEI registry, GESW portal, ID Analyzer coverage)
- `taxRates` (VAT etc. — Guyana 14%)
- `highValueGateUSD` ($50 ID gate, converted to local currency)
- `weeklyFees` per role
- `language`/locale
- `regulatoryNotes` (e.g. data-protection representative requirements)

## 2.3 Data model — core entities (Prisma)

Build these core tables. Each is expanded in later sections.

- **User** (base account: phone, email, name, role(s), country, trustLevel, createdAt)
- **Customer** (extends User; trust tier, order history, saved addresses)
- **Vendor** (business: type [restaurant/grocery/retail], name, docs, subscription status, catalogue, ratings)
- **Driver** (taxi: vehicle, docs, verification status, liveRidesEnabled, ratings)
- **Rider** (delivery: docs, verification status, ratings)
- **ServiceProvider** (trade/profession, docs, qualification badges, ratings)
- **Document** (type, fileKey [→ encrypted storage], status, extractedData, expiry, reviewedBy, reviewedAt — the audit trail)
- **Subscription** (participant, plan, status [trial/active/lapsed], trialEndsAt, lastBilled, nextBillDue)
- **Order** (customer, vendor, items, status, total, paymentMethod [cash], assignedRider, timeline)
- **Ride** (customer, driver, pickup, dropoff, fare, status, timeline)
- **CourierJob** (sender, pickup, dropoff, parcelType, fee, assignedRider, status)
- **ServiceJob** (customer, provider, description, quote, status, schedule)
- **Rating** (fromUser, toUser, transactionId, score, comment, createdAt — verified-transaction-only)
- **Chat** (linked to an order/ride/job; messages; closes when transaction ends)
- **AuditLog** (actor, action, target, metadata, timestamp — immutable)
- **CountryConfig** (as above)

## 2.4 Cross-cutting principles

- **Type safety end-to-end** — lean on TypeScript + Prisma. The compiler is the vibe-coder’s safety net.
- **Tests required on money/trust/safety paths** — Vitest (unit/integration), Playwright (E2E). Standing rule: every feature change writes/updates its tests; never ship earnings, billing, verification, or trust-tier logic untested.
- **CI** — GitHub Actions runs the full test suite on every PR. Red = don’t merge.
- **All document access via short-lived signed URLs**, logged.

-----

# PART 3 — VERIFICATION & ONBOARDING (the trust engine)

> This is the most important system in Swift. It powers safety, liability protection, and the trust brand. Every vertical depends on it.

## 3.1 Governing principle

**Verification intensity tracks PHYSICAL-SAFETY risk, not role importance.** Verify hard where someone could be physically harmed (taxi, riders, in-home services). Verify light where the worst case is a bad transaction (retail).

## 3.2 The universal verification flow

Every provider/driver/rider/vendor goes through this:

```
1. SUBMIT      Applicant uploads required documents during self-serve signup
2. AI PRE-CHECK  AI (ID Analyzer) extracts data, checks format/expiry,
                 auto-rejects obvious fails (blurry / expired / wrong type)
                 with a resubmit prompt — no human time used
3. PROVISIONAL   Plausible docs → applicant gets provisional access:
                 set up profile, explore — BUT cannot operate live
                 (drivers can't take passengers; providers can't accept jobs)
4. HUMAN REVIEW  Reviewer confirms authenticity via admin dashboard.
                 Target: < 24 hours. Audit log records who/when/what/why.
5. DECISION      Approve → full activation (live operation unlocked)
                 Reject → reason + resubmit prompt
6. RE-VERIFY     Documents that expire (insurance, fitness, clearance) are
                 re-checked on schedule (insurance = annual). Automated
                 reminders flag upcoming expiries.
```

**HARD RULE:** Drivers/providers get provisional access but **CANNOT operate live** (carry passengers, accept in-home jobs) until fully human-approved. This is the #1 liability rule. Never let an unverified person operate.

## 3.3 Verification tooling

- **ID Analyzer** (API) — automated identity verification: passport, national ID, *regular* driver’s license. Returns: genuine/fake, confidence %, face match, liveness. Anti-forgery (tamper/deepfake detection). Confirmed Guyana support. ~1 credit per check; free tier 100/mo (also evaluate Didit: 500 free/mo).
  - Does NOT cover occupational permits (hire car licence, trade licences) — those are manual.
- **Police Clearance Certificate** — the Guyana-realistic background check. Applicant obtains it from the police, uploads it. Reviewed manually. Has a recency requirement (e.g. issued within last 6 months) and periodic re-check.
- **GESW portal** (esw.gra.gov.gy) — validates GESW-issued business permits/certificates via reference number + auth key. Manual lookup. NOT for hire car licence or insurance.
- **GEI registry** — Government Electrical Inspectorate public registry of licensed electricians. Check an electrician’s name against it.
- **Caribbean background-check APIs** (Cleared / Straightline) — optional automated background checks across the region, as scale grows.

## 3.4 Per-role verification requirements

### TAXI DRIVERS [highest risk — your liability shield]

**Mandatory, all gating live rides:**

- Government ID → ID Analyzer (auto)
- Regular driver’s licence → ID Analyzer (auto)
- **Hire Car Driver’s Licence** (occupational) → manual review (no API). In Guyana: 3-year validity, proves police clearance was done for issuance.
- **“Hire”-class motor insurance** → manual review. MUST be hire/fare-paying-passenger class, NOT private. Re-verify ANNUALLY (it lapses). Cross-check against the H-plate.
- **Police Clearance** → manual review
- **Fitness Certificate** → manual review, annual
- Selfie → face match (ID Analyzer)

**Insurance 5-point manual check** (build as dashboard fields):

1. Matches the driver (name)
1. **Hire class** (NOT private) ← critical, starred
1. Current (not expired)
1. Real insurer (GTM, GBTI, Caricom General, etc.)
1. (Suspicious → confirm policy number with insurer)

**Note (CountryConfig):** every Caribbean country has the same model, different names — Guyana “Hire Car”, Trinidad “H”, Jamaica “PPV”, Barbados “PSV”. In all of them the driver ALREADY needs commercial/hire insurance by law to operate — Swift verifies an existing legal requirement, it does not impose a new cost.

### DELIVERY RIDERS [medium risk]

- Government ID → ID Analyzer (auto)
- Driver’s licence (if motorized; bicycle/foot need only ID) → ID Analyzer
- Regular motor insurance (if motorized) → manual, annual
- Police clearance → recommended (handles cash + enters spaces)
- Selfie → face match

### RESTAURANTS / GROCERY / RETAIL VENDORS [low-medium risk]

- Owner government ID → ID Analyzer (auto)
- Business registration / TIN → manual or GESW validation, or **attestation** (tick-box) for low-risk
- Food Handler’s Certificate (restaurants/grocery only) → manual or attestation
- Everything beyond legitimacy → **attestation** (the eBay model): provider ticks a box confirming they hold required licences; responsibility shifts to them.

### SERVICE PROVIDERS (plumber, electrician, carpenter, chef, caterer, party organizer, cleaner, etc.) [risk varies by trade]

**Mandatory for ALL:**

- Government ID → ID Analyzer (auto)
- **Police Clearance** → manual review (the key in-home-safety check)

**Optional trust upgrade (earns a visible badge):**

- Trade qualification/licence → uploaded, validated, earns “Certified” badge
  - **Electricians:** GEI Licence — check against the GEI public registry (real, official)
  - **Others:** CVQ / GTEE / City & Guilds certificates from technical institutes
- Providers WITHOUT a qualification can still join — their status is shown transparently (see Services section for the messaging).

**Risk-tiered caution (shown to customers):**

- Low-risk trades (carpenter, cleaner, mover, chef, caterer, party organizer): soft — choose by ratings
- High-risk trades (electrician, gas, major plumbing): strong — prominently recommend a licensed provider; surface licensed ones first

### CUSTOMERS [lowest]

- **Level 1:** phone (OTP) — instant
- **Level 2:** ID-verified → triggered at the **$50 USD high-value order gate** → ID Analyzer
- **Level 3:** earned trust (established order history)

## 3.5 Document storage (Data Protection Act 2023 — LIVE LAW)

Guyana’s Data Protection Act is in force (Commissioner appointed Jan 2026). Storing IDs/licences triggers real obligations.

**Storage architecture:**

- Raw files → encrypted object storage (S3/R2), encryption at rest + in transit.
- Database stores only: fileKey + verification status + extracted metadata.
- View documents via short-lived **signed URLs**, never public links. Every access logged.

**Compliance (bake into the flow):**

- Consent checkbox + privacy notice at upload (required).
- Purpose limitation (docs are for verification only).
- Retention policy (delete after defined period when no longer needed; e.g. participant leaves → scheduled deletion).
- 72-hour breach notification plan.
- **Nevis entity = foreign** → requires a Guyana local representative registered with the Data Protection Office; cross-border transfer rules apply if data stored outside Guyana (mind the storage region). (Admin/legal task, not code — but storage region choice matters.)

## 3.6 The audit log (your legal proof)

EVERY verification action auto-records: actor, action (approve/reject/resubmit), target, reason, timestamp, document snapshot reference. This is immutable and is Swift’s proof of diligence. It’s generated as a byproduct of using the dashboard — the reviewer never has to “remember” to document. For insurance: also record class (hire ✓), expiry, insurer, policy number, and any manual confirmation note.

## 3.7 Self-serve onboarding (the participant journey)

Onboarding is self-serve, modeled as a **status-card checklist** (not a rigid wizard):

- Applicant: picks country → signs up → picks role → sees a checklist of required documents as cards
- Each card: “Recommended next step” highlighted, “Get Started” for pending, green check for done
- Cards are **region-labeled via CountryConfig** (Guyana shows “Hire Car Insurance”; Trinidad “H-Car Insurance”)
- Upload → status updates (Pending → Approved/Rejected)
- Provisional access while items pending; live operation gated until safety-critical items approved
- 2-week free trial begins on activation

-----

# PART 4 — THE SIX VERTICALS (feature by feature)

-----

## 4.1 FOOD DELIVERY [V1]

### Customer flow

1. Home → tap **Food** vertical
1. Browse vendors (list/map), filtered by: cuisine, distance, rating, delivery time, price tier
1. Each vendor card shows: photo, name, ✓ Verified badge, rating, est. delivery time, distance, price tier ($/$$/$$$)
1. Tap vendor → vendor detail screen: hero image, name, rating + review count, hours, location, “Cash on delivery” tag, menu by category
1. Tap dish → add to cart (quantity, notes/special requests, options like spice level)
1. Cart → review items, delivery address, delivery instructions, **payment: cash on delivery**
1. Place order → order confirmed
1. Track order: status timeline (Received → Preparing → Rider assigned → Picked up → On the way → Delivered)
1. Chat with rider (functional chat, see Part 5)
1. On delivery → rate vendor + rider (verified-transaction rating)

### Vendor (restaurant) side

- Self-serve onboarding (verification per Part 3)
- Catalogue management: add/edit menu items (name, description, photo, price, category, options, availability toggle)
- Receive orders → accept → mark Preparing → mark Ready → rider picks up
- See earnings (keeps 100%, pays only weekly fee)
- Subscription status, trial countdown
- Vendor dashboard: orders, menu, ratings, earnings, hours, profile

### Key features

- Menu item availability toggle (sold out)
- Scheduled vs. ASAP orders
- Delivery instructions field
- Order notes per item
- Vendor open/closed status (hours-based + manual override)

-----

## 4.2 GROCERIES [V1]

Same core as food, with grocery-specific features:

- Catalogue is larger (many SKUs) → upload via existing inventory file (CSV/Excel export from POS) → AI maps columns to Swift schema → vendor confirms before live (AI maps/normalizes, never invents prices/stock)
- Stock/quantity tracking (groceries are finite, unlike made-to-order food)
- “Out of stock” handling + substitution preferences (“if X unavailable, substitute Y / refund / call me”)
- Weight-based items (e.g. produce priced per kg)
- Larger basket support
- Same flow: browse → add → cash on delivery → rider delivers → rate

-----

## 4.3 COURIER (send a parcel) [V1] — a signature Swift feature

### Customer flow

1. Home → tap **Courier**
1. Set **Pick up from** (address) and **Deliver to** (address)
1. Choose **what you’re sending**: Documents (small) / Parcel (medium) / Large box (bulky)
1. Optional: recipient name + phone, item description, photo
1. See price (distance + size based)
1. **Find a rider** → verified rider assigned
1. Track: Rider assigned → Picked up → In transit → Delivered
1. Chat with rider for handoff coordination
1. Rate rider

### Use cases to support

- “Send my partner lunch to the office” (order from a vendor → deliver to someone else’s address)
- Person-to-person item sending (formalizes the informal “drop this for me” market)
- Document delivery (legal/business)
- Gift sending

### Features

- Different address for pickup vs. dropoff (vs. food where pickup = vendor)
- Recipient (third party) details + their own tracking link/notification
- Proof of delivery (photo / signature / handoff confirmation)
- Cash payment (sender pays, or recipient pays — configurable)

-----

## 4.4 TAXI / RIDE-HAILING [V1 — gated on insurance + legal sign-off]

### Customer flow

1. Home → tap **Taxi** (or “Rides” in bottom nav)
1. Map screen: current location pin (pulsing), nearby verified drivers shown as cars, animated
1. Set pickup (auto from location) + destination
1. See route + ride options:
- **Swift Go** — standard, affordable
- **Swift XL** — larger, up to 6 people
- Each shows: ✓ verified tag, ETA, fare estimate (GYD), car icon
1. Select ride → **Confirm · Pay cash**
1. Driver assigned → live tracking (driver approaching, ETA)
1. Chat with driver (functional)
1. Trip in progress → arrival
1. Rate driver

### Driver side

- Self-serve onboarding (heaviest verification per Part 3 — gated)
- Go online/offline toggle
- Receive ride requests → accept/decline
- Navigation to pickup → to destination
- Keeps 100% of fare + tips, pays only weekly fee
- Earnings dashboard
- **Cannot take live rides until fully verified** (provisional access only allows setup)

### Features

- Live driver location on map
- Fare estimate before booking (distance/time based)
- Ride options (Go/XL)
- Share trip status with a contact (safety feature — “share my ride with Mom”)
- Cash payment
- Driver + customer two-way ratings

-----

## 4.5 RETAIL — “Local Amazon” [V2]

### Concept

Buy goods from local stores, delivered locally — filling the gap international e-commerce (Amazon) serves badly in the Caribbean.

### Customer flow

1. Home → tap **Shops**
1. **Cross-store search**: search “rice cooker” → see every local store that has one, with price + availability + store rating
1. Browse by category or store
1. Product detail: photos, price, store, availability, description
1. Add to cart (can mix stores? — V2 decision; start single-store carts)
1. Cash on delivery → rider delivers
1. Rate store + product

### Store side

- **Onboarding via existing inventory file:** store exports inventory (CSV/Excel from POS) → uploads → AI maps their columns to Swift schema → store confirms → catalogue live. AI maps/normalizes; never invents prices/stock.
- Tiny shops with no file: AI-assisted catalogue from photos/list (fallback), with confirm step
- Inventory/stock tracking
- Returns/disputes handling (retail has returns; food doesn’t)

### The hard part — cross-store search & taxonomy

- **V1 of retail:** AI structures each store’s catalogue individually; search works by keyword/tags across and within stores (rough but working)
- **V2:** unified product taxonomy — AI maps messy vendor product names to a shared concept so “rice cooker” across stores groups together → enables price comparison. This is the hard, valuable core. (Conceptually similar to a normalized knowledge-graph.)
- Don’t over-build the taxonomy early. Rough-but-working search beats a perfect taxonomy that ships late.

### Features

- Cross-store product search
- Price comparison (V2)
- Store ratings + product ratings
- Stock/availability
- Returns & dispute flow

-----

## 4.6 SERVICES (hire professionals) [V2] — the big market expansion

### Concept

Hire verified tradespeople and professionals: plumber, electrician, carpenter, cleaner, mover, mechanic, **chef, caterer, party organizer**, tutor, etc. Higher-value, stickier, emotional (events, homes, celebrations). The verification moat makes it safe in a market built on word-of-mouth.

### Customer flow

1. Home → tap **Services**
1. Browse/search by category (Plumbing, Electrical, Catering, Events, Cleaning, etc.)
1. Provider profiles show: name, ✓ ID Verified, ✓ Police Cleared, optional qualification badges (✓ GEI Licensed / ✓ CVQ Certified / ✓ City & Guilds), rating + reviews, description, photos of past work
1. For a job: **describe the work** (text + photos) → request quotes
1. **Quote via chat:** provider asks questions, gives a quote directly in chat (services are variable — not fixed-price)
1. Agree → schedule (date/time)
1. Provider does the job
1. Pay (cash on completion in V1)
1. Rate provider (and provider rates customer — two-way)

### The transparency system (critical — see Services Trust PDF)

- **Mandatory for all:** ID + Police Clearance
- **Optional badge:** trade qualification (earns visible “Certified” badge, wins more work)
- **Providers without a qualification can still join** — profile transparently shows “self-skilled, no formal trade licence”
- **Risk-tiered customer messaging:**
  - Low-risk trades: status shown, choose by reviews
  - **High-risk (electrical/gas/major plumbing):** prominent recommendation to choose a licensed provider; surface licensed ones first; for electricians, can check GEI registry
- **Framing:** “here’s how to choose safely” + recommendation — NOT a “you accept all liability” disclaimer (which doesn’t actually protect Swift legally, especially for physical harm)

### Provider side

- Self-serve onboarding (ID + police clearance mandatory; qualification optional)
- At signup without a qualification: shown a message that their profile will display “self-skilled, no trade licence” and that adding one later earns a badge and more work
- Profile: services offered, description, work photos, pricing guidance
- Receive job requests → quote via chat → schedule → complete
- Keeps 100%, pays weekly fee
- Earnings + ratings dashboard

### Features

- Category browse/search
- Quote-via-chat (not fixed price)
- Scheduling/calendar
- Work portfolio photos
- Qualification badges + GEI registry check (electricians)
- Two-way ratings
- Risk-tiered trust messaging

-----

# PART 5 — SHARED SYSTEMS (power every vertical)

-----

## 5.1 CHAT (functional only — NOT social)

**Principle: chat serves the transaction, then closes. It is NOT a WhatsApp competitor.** (WhatsApp owns Caribbean social messaging — don’t fight it.)

### Rules

- Chat is **scoped to an active order / ride / courier job / service job**
- It exists to coordinate: “I’m at the back gate”, “leave with security”, “2 min away”, handoff coordination, and **quote negotiation for services**
- **Quick-reply presets** for speed: “I’m here”, “Leave at door”, “Calling you”, “On my way”
- Thread **closes when the transaction ends** — no persistent inbox, no friend lists, no free-form social messaging
- Supports text + photos (e.g. photo of the leak for a plumbing quote, proof of delivery)

### Per-vertical chat use

- Food/grocery/courier: coordinate delivery handoff
- Taxi: coordinate pickup
- Services: **quote negotiation** (describe job + photos → provider quotes in chat) + scheduling

-----

## 5.2 RATINGS & REVIEWS

**The third leg of the trust system** (after ID-verification and qualification badges). Answers “are they actually good?”

### Rules

- **Verified-transaction-only:** only someone who actually hired/paid through Swift can rate. This is the single most important anti-fraud rule. No fake reviews, no competitor sabotage.
- **Two-way:** providers/drivers rate customers too (was the customer reasonable, did they pay, was the home safe). Protects providers, keeps marketplace fair.
- **Anti-manipulation:** flag suspicious patterns (rating bombing, fake accounts, pay-for-reviews).
- Score (e.g. 1–5 stars) + optional written comment
- Display: average rating + review count on every provider/vendor/driver profile
- Ratings create switching cost (a provider’s reputation lives on Swift → retention)

### Why ratings matter most for services

Ratings are what make the open “let skilled-but-unlicensed people in” model safe — they give customers a quality signal documents can’t. A highly-rated unlicensed carpenter is more trustworthy to a customer than an unrated licensed newcomer.

-----

## 5.3 CUSTOMER TRUST TIERS

Three tiers gating what a customer can do:

- **Level 1 — phone-verified (OTP).** Instant. Can place standard orders.
- **Level 2 — ID-verified.** Triggered at the **$50 USD high-value order gate** (converted per CountryConfig). ID via ID Analyzer.
- **Level 3 — earned trust.** Established order history → may unlock higher limits / perks.

The $50 gate: when an order/transaction exceeds the threshold, require Level 2 ID verification before completing.

-----

## 5.4 QR CODES (acquisition + catalogue)

- Every vendor/provider gets a QR code
- **Acquisition tool:** a vendor’s QR pulls their existing customers onto Swift (seeds the network — key for cold-start density)
- **Catalogue tool:** scanning the QR shows the vendor’s catalogue/profile directly
- Physical + digital QR (printable for storefronts, shareable digitally)

-----

## 5.5 SUBSCRIPTIONS & BILLING

- Every paying participant (vendor/driver/rider/provider) has a **Subscription**
- **2-week free trial** on activation → then weekly fee billing
- Billing rail: **PowerTranz/FAC** primary, **WiPay** backup
- States: `trial` → `active` → `lapsed` (non-payment) → churned
- **The day-15 conversion moment is critical:** decide card-at-signup (auto-converts) vs. card-at-day-14 (re-sell). Build the chosen mechanic. In a cash market many won’t have cards — design accordingly.
- Lapsed participants: grace handling, reactivation flow
- Trial countdown shown to participant
- Tests required on billing state transitions (money path)

-----

## 5.6 ADMIN DASHBOARD (Next.js — how YOU run Swift)

### Verification Center (priority module)

- Queue of pending submissions (filterable by role/status/country, searchable)
- Detail panel per applicant:
  - ID Analyzer result (genuine, confidence, face match, liveness)
  - Each document: auto-verified vs. manual, status, expiry, view (signed URL)
  - Insurance 5-point check as confirmable fields (matches / hire-class* / current / real insurer)
  - Live-rides lock/unlock indicator
  - Approve / Reject / Request-resubmit buttons
- **Audit log** panel — every action auto-recorded (who/when/what/why)

### Other modules

- **Participant management:** all vendors/drivers/riders/providers, searchable, status, docs, expiry reminders, suspend/reactivate
- **Subscription/WRR tracking:** who’s paying, who’s lapsed, trial conversions, WRR by category
- **Operations:** live orders/rides/jobs across verticals
- **Compliance:** data-retention status, document access logs
- **Country switcher** (CountryConfig — Guyana now, others later)

-----

## 5.7 FINTECH LAYER [FINTECH — future phase, do NOT build in V1]

The destination. Only after delivery density + trusted user base are established. Documented here so the architecture stays compatible.

- **Wallet** — customers hold money in Swift
- **Bill payment** — pay GPL (electricity), GWI (water), phone, internet from the app. The recurring, mandatory behavior that makes Swift a daily habit / indispensable.
- **Pay for orders/rides from wallet** (smoother than cash)
- **Phone top-up**
- **Send money** (person-to-person — the social-financial hook)
- **Regulatory path:** wallet/EMI licensing; ECCB covers 8 XCD territories under one regulator (the high-value thesis). Requires the verification/KYC rail (built for delivery) as its foundation.
- **The verification rail itself is a second asset** — potentially infrastructure other platforms use; protect via trade secrets + insurer relationships + first-mover, NOT patents.

-----

# PART 6 — APP STRUCTURE & UX

## 6.1 Customer app navigation

- **Bottom nav:** Home · Rides · Send (courier) · Account (+ Orders)
- **Home screen:**
  - Header: greeting, location selector, search bar
  - **Trust strip:** “Every Swift driver & rider is ID-verified and police-cleared” (the brand signal)
  - **Vertical switcher** (the hero — Swift celebrates its verticals): Food, Groceries, Taxi, Courier, Shops, Services as tappable cards
  - Promo banner (“Send lunch to someone today”)
  - “Popular near you” vendor cards

## 6.2 Design identity (distinct from Uber)

- **Warm Caribbean palette:** deep teal → green (the sea/Guyana), warm gold accent. NOT Uber’s cold black/white.
- Typography: Space Grotesk (display) + Inter (body)
- Rounded, friendly cards; trust badges woven throughout
- The “S” logo mark in teal-gold gradient
- Verified/safety signals visible everywhere (it’s the brand edge)
- Motion: smooth transitions, animated map, micro-interactions — polished, not flashy

## 6.3 Provider/driver app

- **Status-card onboarding checklist** (Uber-style but Swift-branded): recommended-next-step highlighted, each doc a card, region-labeled via CountryConfig, provisional access while pending, live operation gated until approved
- Go online/offline (drivers/riders)
- Job/ride/order inbox
- Earnings dashboard (keeps 100%, weekly fee shown)
- Ratings
- Subscription + trial status

-----

# PART 7 — BUILD SEQUENCING

1. **Foundation:** schema + CountryConfig + auth + core data model
1. **Verification system + admin Verification Center** (highest-risk, unblocks everything) — with encrypted storage, signed URLs, audit logging
1. **Self-serve onboarding** (status-card checklist, provisional access, gating)
1. **V1 verticals:** Food → Groceries → Courier (simple, standardized). Then Taxi (gated on insurance/legal).
1. **Functional chat + ratings** (verified-transaction, two-way)
1. **Subscriptions/billing** (trial → weekly fee, day-15 mechanic)
1. **Tests on money/trust/safety paths + CI**
1. **[V2]** Retail (cross-store search) → Services (with trust transparency system)
1. **[FINTECH]** Wallet → bill pay → send money (future)

**Launch strategy:** food/groceries/courier first in ONE town to density. Taxi once insurance/legal sorted. Services + retail after simple verticals proven. Don’t spread thin — density in one place beats thin coverage everywhere.

-----

# PART 8 — LOAD-BEARING RULES (never violate)

1. Flat weekly fees only — never commission, never customer fees.
1. Participants keep 100%.
1. V1 cash-only — no fintech.
1. Verification intensity tracks physical-safety risk.
1. Drivers/providers CANNOT operate live until fully verified (provisional ≠ live).
1. Insurance must be hire-class + current; re-verify annually.
1. All documents encrypted, signed-URL access, audit-logged (Data Protection Act).
1. Ratings are verified-transaction-only + two-way.
1. Chat is transactional only — closes when transaction ends.
1. Everything CountryConfig-driven — never hardcode country values.
1. Tests required on money/trust/safety paths; CI on every PR.
1. When a task needs a lawyer/insurer/regulator (not code), flag it — don’t code around it.

If a task would violate any of these, STOP and flag it rather than building it.