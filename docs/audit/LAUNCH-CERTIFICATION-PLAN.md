# Swift Full-Platform Launch Certification Plan

Status: DRAFT — execution plan and current-main evidence, not a launch verdict

Pinned baseline: `d51a1b0ed5cbe6b7a210c90e8b4e9d85fabaadd1`

Prepared: 2026-09-12

Owner: Westbridge

## Purpose

This plan turns “audit the whole Swift platform” into finite, repeatable proof.
It covers the code that can execute, the connections between API and clients,
the state and money transitions behind every vertical, the operational systems
needed to keep those flows alive, and the controls required to ship safely.

The supplied audit/remediation files are advisory inputs. They do not override
the repository, current-main behavior, test isolation, Git merge gates, or the
requirement to reproduce every material claim. Their scanner results are leads,
not findings, and none of them authorizes a deletion or a production action.

“Certified” in this document means that an identified version passed the stated
checks in an isolated environment. It does not mean the repository will never
need another change after launch.

## Current baseline

The baseline was measured from a clean worktree at the pinned SHA.

| Measure | Current result | Meaning |
|---|---:|---|
| Files outside `.git` | 1,989 tracked files | Repository census at the pinned baseline, including configuration and prose |
| TypeScript files / lines | 1,263 / 251,558 | Includes tests |
| TSX files / lines | 326 / 62,200 | Includes tests |
| JavaScript files / lines | 17 / 1,516 | Mostly tooling |
| Prisma schema lines | 6,783 | One schema; migrations counted separately |
| SQL files / lines | 223 / 9,919 | Historical migrations and rollback/control SQL |
| Production-like TS/TSX/JS files / lines | 876 / 177,692 | Excludes conventional test, fixture, and mock paths |
| Test TS/TSX lines | 134,443 | A large test corpus is present; coverage quality still needs grading |
| API route census before detector repair | 0 routes, exit 0 | Vacuous green caused by reading `server.ts` |
| Static route-declaration census after bounded repair | 573 static paths/patterns; 99 reachability leads | Manual static triage: 1 detector false positive, 2 server-generated uses, 6 external/direct ingress, 3 test/ops-only, 87 needing runtime/product disposition. Includes app.ts plus registered helper/plugin source and statically expanded finite loops; manifest SHA-256 `98ae1e4211764c892f50c7a4b8431cb6380391bca2b87471f8455f4f25231e0b`; it is not a runtime Fastify count |
| Raw-Prisma test candidates | 64 of 520 test files | Boundary-review leads; many are deliberate harnesses |
| Export scanner candidates | 224 of 1,768 exports | 201 are used in their defining file; its narrowed graph called 23 declaration-only, but exact whole-repository search already refuted 3, leaving at most 20 first-pass leads |
| Dependency override leads | 35 ranged overrides | 30 labelled redundant and 5 inapplicable by a simplistic detector; no removal authorized |

Current main also contains eight merged changes after the older audit baseline
`156244e`: tenant-wall attestation, admin audit corrections, MMG handover
refusal, dependency updates, document-expiry availability enforcement,
ops-only incident merging, tenant-scoped search reconciliation, and truthful
zero-recipient paging. Every older finding must therefore be reproduced against
the pinned current baseline before it can be called open or closed.

## Evidence law

Evidence is ranked in this order:

1. An executable adversarial or end-to-end test against the real production
   entrypoint and isolated Postgres/Redis.
2. A deterministic compiler, linter, schema, migration, or security-tool result.
3. A complete static trace from client action through route, authority, state
   transition, persistence, event/job, notification, and recovery path.
4. A line-referenced code review.
5. A scanner or model hypothesis.

Lower-ranked evidence may open a finding. It may not certify a higher-ranked
claim. A check that examined zero eligible objects is a failure, never a pass.
Every result records the repository SHA, command, exit status, decisive output,
environment boundary, and whether the behavior actually ran.

## Definition of launch-ready

A release candidate is launch-ready only when all of the following are true on
the exact candidate SHA and current base:

- The launch surface is enumerated. Every visible control has a working target,
  an honest unavailable state, or an owner-approved feature flag defaulting off.
- Every client/API contract is matched by method, path, request schema, response
  shape, authorization class, tenant behavior, error behavior, and version.
- Every stateful vertical has an explicit state machine with terminality,
  idempotency, concurrency, cancellation, custody, retry, and reconciliation
  proofs.
- Every movement of money has exact integer currency semantics, ledger and
  settlement provenance, duplicate/replay protection, refund/failure behavior,
  and sandbox-provider evidence.
- Authentication, authorization, RLS, object ownership, secrets, audit trails,
  rate limits, privacy, retention, and deletion controls pass adversarial tests.
- Migrations apply to a fresh database and the supported rollback procedure is
  executed. Drift, privilege, trigger, RLS, and seed checks pass under the exact
  runtime and migration roles.
- Type checking, lint, unit tests, affected integration suites, client builds,
  security scans, dependency scans, and golden journeys pass without skipped or
  vacuous gates.
- Workers, queues, retries, dead letters, scheduled jobs, clocks, backups,
  restoration, observability, paging, and provider fallbacks are rehearsed.
- iOS/Android/web/admin/desktop release artifacts are signed, environment-bound,
  secret-scanned, and exercised in staging. Apple account actions remain an
  explicit owner/store step; a Team ID alone is not a credential or release.
- Guyana-specific privacy, consumer, payments, transport, tax, retention, and
  professional-services decisions are confirmed by qualified counsel or the
  relevant regulator where required. Code review cannot issue a legal opinion.
- The PR has all required checks on its exact head/current base, independent
  review of that SHA, no unresolved findings, and a post-merge main recheck.

## Phase 0 — freeze and enumerate the launch surface

Before deleting or building broadly:

1. Record every app, route, screen, deep link, background job, webhook, feature
   flag, provider integration, database model, migration, and deploy component.
2. Classify each as `LAUNCH_REQUIRED`, `DARK_COMPLETE`, `HONEST_PLACEHOLDER`,
   `INTERNAL_ONLY`, `RETIRED_CANDIDATE`, or `UNVERIFIED`.
3. Record the owner-approved launch decision per surface. An audit may recommend
   a flag but may not silently remove a vertical the owner expects to launch.
4. Freeze user-visible additions while S0/S1 launch blockers are open.
5. Generate a machine-readable route/client contract and screen/navigation
   census. Each detector must assert a non-zero eligible population.

The route detector was the first proven dead control: it inspected the obsolete
composition file and returned a clean empty result. Its bounded repair is kept
report-only until its 99 candidates are reviewed and false-positive classes are
documented.

## Phase 1 — dead code, scraps, and duplicate systems

No code is deleted merely because an export or file lacks a textual reference.
Framework entrypoints, reflection, workers, migrations, CLI scripts, fixtures,
dynamic imports, package exports, and same-file consumers all defeat naive
searches.

Each cleanup candidate follows this sequence:

1. Pin the SHA and detector version.
2. Identify static imports, dynamic imports, package exports, framework
   conventions, route/screen registration, job scheduling, and same-file use.
3. Trace at least one production ingress or prove none exists across all clients
   and runtime processes.
4. Identify schema, migration, security-control, audit, and operational
   dependencies.
5. Classify as `KEEP`, `UNEXPORT_ONLY`, `REWIRE`, `RETIRE_BEHIND_FLAG`,
   `DELETE_CANDIDATE`, or `NEEDS_RUNTIME_EVIDENCE`.
6. For a deletion candidate, first add or identify boundary tests that prove the
   retained behavior. Delete the smallest coherent unit in its own PR.
7. Run the complete affected suites, build every affected client, compare route
   and bundle manifests, and inspect the diff for accidental generated or lockfile
   changes.

Never delete or rewrite historical migrations as cleanup. Never remove a
dependency override without proving the resolved graph and vulnerability state.
Never lower a test or coverage threshold to make cleanup green. The current
candidate census lives in `DEAD-CONTROL-CANDIDATES.md`.

## Phase 2 — cross-cutting security and integrity foundation

These controls are audited before feature certification because every vertical
depends on them:

- Authentication: OTP/password/browser sessions, refresh/revocation, step-up,
  device binding, enumeration resistance, brute-force controls, and outage
  behavior.
- Authorization: route matrix, object ownership, role transition, admin
  capability tiers, second approval, support impersonation, and audit atomicity.
- Tenancy: scoped client construction, RLS/FORCE RLS, runtime-role privilege,
  public-browse authority, worker/system work, search indexing, deletes, exports,
  and cross-tenant adversarial probes.
- Money: integer amounts and currency, holds, claims, disputes, idempotency,
  ledger balance, settlement, refund, reversal, reconciliation, and provider
  callback distrust.
- Documents: purpose-bound upload, object-key authority, encryption, malware/type
  checks, one-use render grants, explicit render acknowledgement, human decision
  provenance, appeal/rectification, retention, legal hold, purge proof, and audit.
- Platform: secrets/history, dependencies, supply chain, CORS/headers, SSRF,
  injection, logging/redaction, abuse/rate limits, backups, restore, monitoring,
  and incident response.

The document-review implementation is still a draft security branch. Its review
case identity and terminal assignment are being sealed after an independent
review found that a closed case could otherwise be rebound. It is not part of
current main and is not launch evidence until its migration and adversarial
suites run against the assigned isolated services and all merge gates pass.

## Phase 3 — vertical-by-vertical certification

Each vertical receives a dossier containing its surface map, state machine,
authority matrix, money/custody model, failure matrix, test map, findings, and
an executable golden-journey record. Static code presence is not certification.

### 1. Identity, onboarding, verification, and admin document review

Golden journeys:

- Customer, vendor, rider, driver, and professional-provider onboarding.
- Correct document requirements by role/category/country.
- Upload → validate/extract → manual queue → claim → render → acknowledge →
  approve/reject/request-info/escalate → eligibility projection.
- Expiry/revocation immediately removes the affected ability to work or list,
  while preserving lawful evidence and notifying the person safely.
- Appeal, rectification, data export, erasure, legal hold, retention expiry, and
  proof of byte deletion.
- Two administrators racing, stale sessions, grant replay, object swap, tenant
  attack, failed audit write, worker outage, and recovery.

Document storage decision: extract only the fields actually needed for the
declared purpose, but do not assume extraction automatically permits deletion of
the source image. Originals should be encrypted, access-limited, audited, and
retained only for a documented legal/operational period; then purged with a
receipt unless a valid hold applies. Final Guyana retention periods and whether
specific regulated documents must be retained require legal/regulator advice.

### 2. MMG checkout, subscriptions, settlements, and collections

Golden journeys:

- Cash and MMG order checkout; callback is never trusted as final payment proof.
- Authoritative MMG lookup matches merchant reference, provider transaction,
  exact amount, currency, and accepted final status; replay and cross-order use
  fail.
- Vendor-owes-rider and rider/subscription obligations are created once,
  presented clearly, settled once, disputed, reversed, and reconciled.
- Trial → notice → invoice → grace → restriction/suspension → payment →
  reinstatement, including outage and late callback behavior.
- Collections intake, contact cadence, promises, disputes, hardship/manual hold,
  payment allocation, receipts, immutable audit, and lawful retention.

The third-party WooCommerce plugin is clean-room reference material only. Exact
MMG cryptography, authentication lifetime, callback, lookup endpoint, and status
vocabulary remain provider-contract questions until official documentation and
sandbox vectors prove them.

### 3. Food ordering, grocery/retail, delivery, and pickup

Golden journeys:

- Browse → availability/price quote → cart → checkout hold → vendor accept →
  prep → ready → dispatch → pickup ceremony → delivery ceremony → ledger.
- Grocery substitutions, quantity/weight differences, partial availability,
  price changes, item unavailable, and customer approval.
- Pickup order with no rider fee or rider dispatch, correct pickup code, wrong
  code/retry controls, cancellation, refund, and handover evidence.
- Vendor timeout, no rider, rider dropout, customer cancel, vendor cancel,
  prep/cancel race, hold expiry, duplicate checkout, duplicate notification,
  worker restart, and reconciliation.

Grocery currently shares the generic Vendor/Item/Order engine; certification
must prove its category and fulfillment differences rather than assume food tests
cover them.

### 4. Taxi

Golden journeys:

- Quote → request → dispatch → driver accept → arrival → rider identity/PIN →
  trip start → live safety → completion → payment/ledger/rating.
- Driver decline/dropout, no supply, cancellation at every phase, stale GPS,
  route/price change, duplicate accept, crash/restart, SOS, “not my driver,” and
  stranded-trip reconciliation.
- Customer, driver, admin, notification, socket, and deep-link views agree on the
  same order and state.

The initial static allegation that mobile `rideApi` calls three nonexistent
passenger routes was refuted by a second trace: `GET /rides/:id`,
`POST /rides/:id/cancel`, and `POST /rides/:id/sos` are all registered, and the
cancel/SOS wrappers are used. The adjacent verified gap is on the driver side:
the API provides a controlled pre-custody driver-cancel/re-dispatch route, but
the mobile `driverApi`, mover hook, and active-job UI expose no cancel action.
Going offline is refused while the ride is assigned, so the driver can become
trapped in the accepted flow without an in-app release path. This is the first
taxi remediation candidate; its direct route and mobile contract tests are
required before merge.

### 5. Send / courier

Golden journeys:

- Estimate → sender/recipient/payer agreement → dispatch → pickup proof → custody
  → live tracking → delivery/payment proof → ledger.
- Recipient-pays cash, refused payment, no-show, damaged/lost parcel, return to
  sender, cancellation before and after custody, proof upload failure, driver
  dropout, and duplicate terminal calls.
- Tracking tokens are scoped, expiring, non-enumerable, and redact live location
  once the viewer no longer has a valid need.

### 6. Services and service jobs

Golden journeys:

- Browse provider → scope/availability → request/quote → accept → schedule →
  start → safety check → completion → payment/ledger/review.
- Provider/customer cancellation, overlapping slots, provider unavailable,
  reschedule, no-show, dispute, partial work, refund, duplicate start/complete,
  and concurrent transition races.
- The client exposes every allowed transition and never invents a transition the
  API cannot perform.

Earlier audit leads about service-job races and a missing valid start path must
be re-run against current main; they remain leads until reproduced.

### 7. Appointments and professional services

Accountants, lawyers, and similar professionals may be unable or unwilling to
publish a fixed job price before understanding the matter. The audit will first
determine what the current Booking and ServiceJob models actually require. It
will then present, rather than silently implement, a product decision among
explicit price modes such as fixed price, “from” price, quote required, and free
or paid consultation.

Golden journeys:

- Discover → request appointment without misleading fixed price → provider
  confirms scope/time → customer accepts any quote and terms → reminder →
  attend/reschedule/cancel/no-show → receipt/review.
- No charge may be inferred from a booking. A later quote needs explicit customer
  acceptance, currency/amount, expiry, cancellation terms, and an audit trail.
- Conflict prevention is enforced transactionally across concurrent requests.

Current static blocker lead: the web storefront explicitly refuses appointment
checkout while server/mobile appointment paths exist. Launch scope and parity
must be decided and tested.

### 8. QR, attribution, discovery, maps, and search

Golden journeys:

- Create/rotate/disable QR → print/download → public scan → safe redirect or
  app-open attribution → storefront → conversion; malformed/unknown/expired
  codes behave uniformly and cannot redirect off-platform.
- Search/autocomplete/details/reverse geocode → selected address → route/quote;
  provider outage, stale index, tenant change, deletion, and fallback are honest.
- OSRM, VROOM, Nominatim, and Meilisearch deployment versions, data/update
  cadence, licences/attribution, backups, capacity, health checks, monitoring,
  and fallback behavior are proved in staging.

Current static lead: the API exposes reverse geocoding but the mobile API seam
does not. This may be a missing client capability or an intentionally unused
endpoint; trace before changing it.

### 9. Safety, notifications, chat, ratings, and moderation

Golden journeys:

- SOS from taxi, delivery, courier, and service job → persistence → operator
  alert → guardian/emergency fan-out → acknowledgement/escalation → closure.
- Guardian check-ins, liveness, trip share, “not my driver,” emergency-contact
  management, notification preferences, and offline/retry delivery.
- Every actionable notification kind navigates to a real, authorized screen;
  revoked or cross-account deep links fail safely.
- Blocks, reports, moderation queue, appeals, reviews/replies, abuse limits, and
  privacy deletion interact correctly.

The notification-type routing census must be regenerated from current main; an
older claim of 52 unrouted actionable kinds is not accepted without reproduction.

### 10. Admin, finance, operations, ads, and platform governance

Golden journeys:

- Every visible admin control calls a registered route, requires the documented
  capability/approval, writes its audit row atomically, and refreshes the UI.
- Finance, disputes, settlements, subscriptions, incident merge, verification,
  legal holds, search repair, DLQ, feature flags, pricing, zones, and ads have
  real success, refusal, rollback, and empty states.
- Dashboard aggregates are reconciled to source records and tenant scope.
- A failed audit write rolls back privileged state; a failed external action is
  never shown as complete.

The repaired route census currently lists 58 admin-route reachability leads.
Desktop Mission Control is included in the haystack, but each lead still needs
screen and runtime classification before it becomes a finding.

## Phase 4 — executable golden-journey suite

The final suite uses real Postgres and Redis and production entrypoints:

- API and web: Playwright plus HTTP-level adversarial tests.
- Mobile: Maestro/device tests for iOS and Android, using only non-protected test
  simulators/devices.
- Workers: deterministic queue tests with crash/retry/reconciliation phases.
- Providers: official MMG/maps/storage/SMS/push sandbox or contract simulators,
  followed by bounded staging smoke tests when credentials and authorization are
  separately available.
- Load: k6 scenarios for browse, checkout, dispatch, sockets, SOS, admin queues,
  and worker backlog, with explicit latency/error/capacity budgets.

Each journey must prove both the happy path and its highest-consequence races.
Skipped tests, mocked-away authority, raw database shortcuts, and a missing
service are reported as `UNVERIFIED`, not green.

## Phase 5 — CI, release, and operational certification

Required repeatable gates include:

- Strict TypeScript, lint, unit/integration/E2E tests, and non-vacuous coverage
  floors per package and critical module.
- Route/client, screen/navigation, worker-registration, notification-routing,
  schema/model, RLS/privilege, migration, and seed-control censuses with non-zero
  population assertions.
- Gitleaks full history, Semgrep/custom rules, dependency/container/IaC scans,
  licence review, and generated-client bundle secret scans.
- Fresh forward migration, supported rollback, drift detection, backup/restore,
  startup/readiness, and least-privilege role rehearsal.
- Reproducible signed builds, environment approval, release tags and notes,
  rollback/runbooks, error tracking, uptime/SLO alerts, queue/DLQ alerts, database
  and object-store monitoring, and on-call ownership.

No tool is installed merely to increase scanner count. Knip, jscpd, and Madge
are possible additions only after their monorepo entrypoints and false-positive
policy are defined. Current API V8 coverage has no threshold; thresholds must be
introduced from a measured baseline and raised deliberately, never guessed.

## Work packaging and review

- One bounded concern per Codex-owned `codex/product-*` or `codex/security-*`
  branch, created from fresh current `origin/main` and registered before work.
- One failing regression or explicit executable proof per behavior fix.
- No direct `main` push, rebase, force push, deployment, production credential,
  live customer data, or cross-editing another agent's branch/worktree.
- Re-scan and rerun affected suites after every bounded batch; integrate current
  main without rewriting published history.
- Open a draft PR only when the change is internally coherent. Merge only after
  exact-head/current-base CI, independent review, resolved findings, migration
  proof where applicable, complete affected suites, and post-merge recheck.

## Durable outputs

The audit produces:

- `PLATFORM-SURFACE-MANIFEST`: routes, screens, jobs, providers, models, flags,
  deploy components, and ownership.
- `DEAD-CONTROL-CANDIDATES`: every cleanup lead and evidence disposition.
- One `VERTICAL-CERTIFICATION` dossier per numbered vertical above.
- `SECURITY-REGISTER`: severity, exploit/failure path, evidence, fix, regression,
  and disposition for every verified finding.
- `GOLDEN-JOURNEY-MATRIX`: journey, clients, environment, last passing SHA,
  evidence artifact, and failure owner.
- `LAUNCH-FREEZE`: exact enabled/dark surface and external decisions.
- `VERDICT`: “If launched now, what breaks?”, unresolved blockers, operational
  limits, and the exact release candidate tested.

## Known blockers at this checkpoint

- Current main is not certified launch-ready.
- The alleged passenger taxi route mismatch was refuted. A missing mobile
  driver-cancel control, web appointment blockage, and mobile reverse-geocode
  absence are current static contract leads requiring dedicated remediation or
  product-scope decisions.
- The 99 route reachability leads, 64 raw-Prisma test leads, at most 20 remaining
  declaration-only export leads, and dependency override leads are unclassified;
  none authorizes deletion. Three of the export scanner's 23 claims are already
  refuted by consumers outside its narrowed graph.
- Product-lane Postgres is unassigned, so product database integration tests are
  held. Security-lane Postgres/Redis endpoints were unreachable at this
  checkpoint.
- The document review engine and audit runner remain draft branches behind main;
  neither is merged or deployed.
- MMG production contract, open-source routing/search operations, backups,
  monitoring, store release, and Guyana legal retention decisions remain
  externally or operationally unverified.

The immediate execution order is: finish the dead-control ledger and detector
repair review; resolve the document-provenance security draft; reproduce the
taxi contract mismatch; then certify MMG/money, food/grocery/pickup, courier,
services/appointments, and the remaining cross-cutting verticals in the order
above.
