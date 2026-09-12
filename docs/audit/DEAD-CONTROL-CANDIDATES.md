# Dead-Control Candidate Ledger

Status: REPORT-ONLY — no deletion or dependency removal authorized

Repository SHA: `d51a1b0ed5cbe6b7a210c90e8b4e9d85fabaadd1`

Generated: 2026-09-12

## Interpretation

This is a triage ledger, not a list of dead code. A candidate remains in the
repository until its production ingress, same-file use, dynamic/framework
registration, package surface, schema/security role, and operational purpose
have been checked. Cleanup requires a separate bounded change and affected-suite
proof.

The supplied D6 and D8 detectors were executed with Node `v20.19.6`. D6 is a
two-line test heuristic. D8 is regex-based, ignores references in the defining
file, is not module-resolution aware, and collapses same-name symbols. Neither is
suitable as a blocking CI gate in its present form.

## Detector truth table

| Detector | Eligible population | Raw leads | Verified interpretation |
|---|---:|---:|---|
| Route reachability, original | 0 routes | 0 | Vacuous result: it read `server.ts`; composition lives in `app.ts` |
| Route reachability, repaired | 573 static paths/patterns | 99 | Path-prefix text leads; webhooks, direct browser pages, internal routes, and honest placeholders can be valid; manifest SHA-256 `98ae1e4211764c892f50c7a4b8431cb6380391bca2b87471f8455f4f25231e0b` |
| D5 dependency overrides | 35 ranged entries | 30 “redundant”, 5 “inapplicable” | Hygiene leads only; detector does not prove the pnpm graph or vulnerability state |
| D6 raw Prisma in tests | 520 test files | 64 occurrences | Some are intentional DDL/RLS harnesses; others lack exact-role boundary proof |
| D8 exported symbols | 1,768 exports / 350 production files | 224 | 201 are consumed in their own file; the narrowed graph called 23 declaration-only, but whole-repository search refuted 3 |

## D8 — 23 scanner-reported declaration-only export leads

The scanner considered a narrowed consumer graph. Exact whole-repository search
has already proved three claims false; the other 20 remain
`NEEDS_CALL_GRAPH_EVIDENCE`. `deletion_allowed` is `false` for every item.

| Symbol | Location | Risk if wrongly removed |
|---|---|---|
| `entityFor` | `apps/api/src/modules/admin/admin-authority.ts:691` | Admin audit/authority metadata |
| `SAFE_ACTIONS` | `apps/api/src/modules/agent/agent.service.ts:32` | Automated-action safety boundary |
| `RETRY_CLASS` | `apps/api/src/modules/billing/failure-taxonomy.ts:23` | Billing retry semantics |
| `captureDocumentNumber` | `apps/api/src/modules/integrity/capture-hooks.ts:96` | Sensitive identity/integrity capture |
| `capturePlate` | `apps/api/src/modules/integrity/capture-hooks.ts:108` | Vehicle identity/integrity capture |
| `blockedAuthorIds` | `apps/api/src/modules/moderation/user-block.service.ts:67` | Block/privacy filtering |
| `defaultJournalPath` | `apps/api/src/modules/ops/bootstrap-plan.ts:238` | Bootstrap/recovery operation |
| `STAGES` | `apps/api/src/modules/ops/bootstrap-plan.ts:43` | Bootstrap stage contract |
| `SEED_RUN_ID` | `apps/api/src/modules/ops/purge-plan.ts:35` | Purge planning / seed identification |
| `terminalityOf` | `apps/api/src/modules/order/order-status.ts:166` | Order state-machine terminality |
| `scanEventsLostTotal` | `apps/api/src/modules/qr/scan-log.ts:64` | Lost QR telemetry observability |
| `RATING_TEXT_MAX` | `apps/api/src/modules/rating/rating-math.ts:17` | Input limit contract |
| `REPLY_TEXT_MAX` | `apps/api/src/modules/rating/rating-math.ts:18` | Input limit contract |
| `isSafetyTag` | `apps/api/src/modules/rating/tag-registry.ts:51` | Safety-rating classification |
| `escrowProof` | `apps/api/src/modules/safety/deletion-hold.ts:464` | Safety deletion/escrow evidence |
| `SOS_ESCALATION_ENFORCED_AT` | `apps/api/src/modules/safety/sos-escalation.ts:29` | SOS rollout/cutover contract |
| `isCappedTier` | `apps/api/src/modules/vendor/vendor-tier.ts:144` | Vendor tier enforcement |
| `effectiveDocState` | `apps/api/src/modules/verification/doc-state.ts:107` | Verification state semantics |
| `isDocStateViolation` | `apps/api/src/modules/verification/doc-state.ts:121` | Verification invariant check |
| `EXPIRING_DOC_TYPES` | `apps/api/src/modules/verification/verification.service.ts:80` | Document-expiry coverage |
| `ordersPlacedCounter` | `apps/api/src/plugins/observability.ts:116` | Order telemetry |
| `UnauthorizedError` | `apps/api/src/utils/errors.ts:19` | Public/internal error API |
| `ensureEphemeralIdentity` | `apps/api/src/utils/seed-guard.ts:107` | Seed/test identity safety |

Before changing any item, inspect package consumers outside `apps/api/src`,
generated/import-by-name use, scripts, tests, telemetry dashboards, runbooks,
and whether the correct action is merely to remove `export` while retaining the
local implementation.

### Exact-repository correction — first semantic tranche

These three are **KEEP / scanner false positive** on baseline `d51a1b0e`:

- `defaultJournalPath` is imported and invoked by
  `scripts/dev/bootstrap.ts:35,45`.
- `STAGES` is imported and used to validate the requested bootstrap stage by
  `scripts/dev/bootstrap.ts:35,42`.
- `ensureEphemeralIdentity` is imported and awaited by
  `apps/api/prisma/seed.ts:3,11`.

Their consumers sit outside the scanner's narrowed `apps/api/src` graph. This
is direct evidence that the detector cannot authorize cleanup. Exact `rg -w`
over the repository found declaration-only occurrences for the other 20 names,
but that proves neither runtime irrelevance nor whether a disconnected safety,
retry, privacy, telemetry, or validation control should be wired instead of
deleted. They remain report-only candidates pending product and behavioral
evidence.

## D8 — confirmed false-positive class

At least 201 of D8's 224 results are used inside the file where they are
declared. Representative retained examples include:

- `GooglePlacesProvider`, constructed in `places-provider.ts`.
- `ManualReviewKycProvider`, constructed in `kyc-provider.ts`.
- `readMoverAuthorityCutoverState`, used by its cutover preparation module.
- `verifyApprovals` and `verifyBackup`, called by the purge planner.
- `runCollusionAffinityScan`, scheduled by the queue runtime.
- kill-switch helpers executed within their safety modules.
- configuration constants including `BOOTSTRAP_ROLE`, `DEFAULT_DB_ALLOWLIST`,
  `DEFAULT_PLACEMENTS`, `FONTS`, and `PLATFORM_CONFIG_VERSION`.

These may have an unnecessarily broad export surface, but they are not dead
runtime code.

## D6 — 64 raw-Prisma test leads

The current scanner reported these locations:

```text
apps/api/src/__tests__/admin-audit-unique-selector.test.ts:49
apps/api/src/__tests__/ads-checkout-aggregate.test.ts:24
apps/api/src/__tests__/ads-checkout.test.ts:12
apps/api/src/__tests__/ads-creative-review.test.ts:13
apps/api/src/__tests__/ads-foundation-model.test.ts:15
apps/api/src/__tests__/ads-lifecycle-cron.test.ts:14
apps/api/src/__tests__/ads-refund-obligation.test.ts:21
apps/api/src/__tests__/ads-reservation.test.ts:11
apps/api/src/__tests__/ads-serving-events.test.ts:32
apps/api/src/__tests__/ads-stats-rollup.test.ts:11
apps/api/src/__tests__/agent-cash-channels.test.ts:25
apps/api/src/__tests__/agent-cash-identity.test.ts:27
apps/api/src/__tests__/agent-cash.test.ts:17
apps/api/src/__tests__/algo-config.test.ts:44
apps/api/src/__tests__/audit-append-only.test.ts:25
apps/api/src/__tests__/bank-recon-immutable.test.ts:17
apps/api/src/__tests__/bank-recon.test.ts:15
apps/api/src/__tests__/batching-shadow-scan.test.ts:11
apps/api/src/__tests__/billing-receipts-invariants.test.ts:11
apps/api/src/__tests__/booking-exclusivity.test.ts:12
apps/api/src/__tests__/delivery-rates-config.test.ts:60
apps/api/src/__tests__/dev-bootstrap.test.ts:14
apps/api/src/__tests__/discovery-admin.test.ts:15
apps/api/src/__tests__/discovery-ai.test.ts:20
apps/api/src/__tests__/discovery-backfill.test.ts:15
apps/api/src/__tests__/discovery-derivation.test.ts:19
apps/api/src/__tests__/discovery-matcher.test.ts:19
apps/api/src/__tests__/domain-model.test.ts:14
apps/api/src/__tests__/integrity-foundation.test.ts:28
apps/api/src/__tests__/integrity-kpis.test.ts:11
apps/api/src/__tests__/purge-plan.test.ts:19
apps/api/src/__tests__/rating-math.test.ts:20
apps/api/src/__tests__/rating-safety-flag.test.ts:13
apps/api/src/__tests__/rating-stats.test.ts:19
apps/api/src/__tests__/retail-catalogue-seed.test.ts:38
apps/api/src/__tests__/safety-audit-fixes.test.ts:20
apps/api/src/__tests__/safety-guardian-model.test.ts:16
apps/api/src/__tests__/safety-guardian-sweep.test.ts:14
apps/api/src/__tests__/safety-incident-idempotency.test.ts:141
apps/api/src/__tests__/safety-sos-core.test.ts:12
apps/api/src/__tests__/safety-sos-model.test.ts:12
apps/api/src/__tests__/safety-trip-share-digest.test.ts:15
apps/api/src/__tests__/safety-trip-share.test.ts:14
apps/api/src/__tests__/sales-components.test.ts:22
apps/api/src/__tests__/sales-digest.test.ts:18
apps/api/src/__tests__/san-registry.test.ts:12
apps/api/src/__tests__/search-service-tenancy.test.ts:51
apps/api/src/__tests__/seed-plan.test.ts:32
apps/api/src/__tests__/settlement-import-staged.test.ts:28
apps/api/src/__tests__/sos-emergency-fanout.test.ts:12
apps/api/src/__tests__/sos-escalation-outbox.test.ts:21
apps/api/src/__tests__/sos-retrigger-append.test.ts:18
apps/api/src/__tests__/sos-tenant-routing.test.ts:19
apps/api/src/__tests__/stock-ledger.test.ts:18
apps/api/src/__tests__/storage-orphans.test.ts:12
apps/api/src/__tests__/tenancy-foundation.test.ts:15
apps/api/src/__tests__/tenant-wall-binds-app.test.ts:58
apps/api/src/__tests__/tenant-wall-binds-app.test.ts:59
apps/api/src/__tests__/test-target-lock.test.ts:137
apps/api/src/__tests__/trial-fee-education.test.ts:11
apps/api/src/__tests__/usd-dual-display.test.ts:13
apps/api/src/__tests__/usd-pricing-ttd.test.ts:10
apps/api/src/__tests__/vehicle-identity.test.ts:9
apps/api/src/modules/dispatch/float.test.ts:7
```

Initial taxonomy:

- `tenant-wall-binds-app` and `test-target-lock` are deliberate test harnesses.
- `search-service-tenancy`, `batching-shadow-scan`, and
  `safety-guardian-sweep` need proof that their real worker/system entrypoints use
  the intended capability and exact runtime role.
- `ads-checkout` is a high-priority money/tenancy boundary candidate because
  the test constructs services with raw Prisma while exercising scoped ad and
  money models.
- `modules/dispatch/float.test.ts` is a method-level harness, not evidence that
  request tenancy works.
- Every remaining item needs model/entrypoint classification before a comment,
  test rewrite, or exemption is justified.

An accepted exemption must state why raw access is necessary, which tenant or
system boundary the test is exercising, and where the production entrypoint is
tested under its exact role. A generic `scoped-exempt` comment is not proof.

## Route reachability leads

The repaired detector now reads `apps/api/src/app.ts`, includes its registered
relative helper/plugin source, supports prefixless/default-export plugins and
statically expands finite literal loops, refuses a zero-route census, and reads
production files in all four client trees. It reports 573 static route
paths/patterns and 99 reachability leads (manifest SHA-256
`98ae1e4211764c892f50c7a4b8431cb6380391bca2b87471f8455f4f25231e0b`).
Tests, fixtures, and mocks are excluded. This is still a raw text
heuristic: it ignores HTTP method, stops comparison at the first route parameter,
and can count comments or unrelated string literals. Accordingly it has both
false-positive and false-negative classes and is not a runtime Fastify route
count. The largest unmatched bucket is admin (58), followed by vendor (11),
verification (5), auth (4), and customer (4).

Immediate manual-review leads:

- A second trace refuted the alleged passenger `/rides/:id` mismatch: all three
  passenger endpoints exist. It instead found a real inverse gap: the backend
  driver-cancel/re-dispatch route has no mobile `driverApi`, hook, or active-job
  control.
- `/places/reverse` has no mobile client seam.
- Verification appeal and DSAR routes have no obvious mobile verification-client
  seam.
- MMG notification/inquiry are expected server-to-server candidates.
- Search sync, statement render, public QR, legal, and test-control routes need
  classification rules rather than automatic client requirements.

The next detector version must inventory both directions, preserve HTTP method,
understand template literals/client base URLs, carry allowlisted server-to-server
and direct-navigation reasons, and emit a machine-readable manifest. Until then,
the 99 entries are reviewed manually and the detector remains non-blocking.

## Required proof for any cleanup PR

- Candidate ID and pinned SHA.
- Complete static and dynamic entrypoint trace.
- Explicit retained behavior and owner-approved retirement decision where the
  candidate represents a product surface.
- No schema, migration, security, audit, observability, worker, or runbook
  dependency.
- A failing-before/passing-after boundary regression where behavior is repaired,
  or bundle/call-graph evidence where code is genuinely removed.
- Complete affected type, lint, unit, integration, build, route, screen, worker,
  and golden-journey checks.
- Independent exact-head review and the normal merge gates.
