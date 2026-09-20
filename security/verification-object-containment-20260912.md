# Verification object containment — local implementation and correction evidence

Lane: `CODEX-SECURITY-VERIFICATION-OBJECT-CONTAINMENT-20260912`.
Owner: Westbridge / Codex security. This is implementation evidence, not independent review or launch approval.

The initial implementation below was independently reviewed at `67222490f9b5350ca5ac75f46371f637428524f5` and rejected by REPORT-213. Its test results are historical. The review-correction section at the end records the current candidate and supersedes the initial claims where they differ.

## Initial implementation: base and scope

Fresh owned worktree: `/Users/westbridgeinc/swift-codex-security-verification-object-containment-20260912`.
Branch: `codex/security-verification-object-containment-20260912`.
Exact initial `HEAD` and `origin/main`: `198cfb7ab1020de5acb9b0a78ee5f121087243c6`.

The one new existing-metadata resolver requires the expected subject's canonical verification namespace, exactly one matching live envelope metadata row with matching `createdBy`, and either no referencing submission at intake or exactly the expected existing submission. It censuses the relative, `/uploads/`, and `uploads/` spellings together. Foreign, public-media, malformed, missing, ambiguous/shared, shredded and unproven legacy references return the same non-enumerating error. Metadata exceptions also fail closed.

The resolver gates checklist and L2 intake before provider/collision/identity/document effects, rechecks before collision capture and transactional creation, gates admin URL mint and signed render, and gates the shared DSAR/retention/image/account deletion primitive before storage reads or key mutation. Render storage/decryption failures are non-enumerating. Unknown storage failures do not prove absence; metadata-probe failure cannot create passing purge evidence.

Orphan retry requires an existing subject binding and revalidated, unclaimed envelope metadata. Bare, foreign, public, claimed, legacy or shredded orphan references remain open. Avatar replacement/account cleanup only delete the exact subject's server-issued avatar namespace; unproven pointers are retained in the census without retry deletion authority.

No schema, migration, document-state trigger, identity-signal policy, client contract, reviewer/viewer governance, or purge-operation fence was changed. The image-only purge still keeps the record/extraction; full erasure retains its existing full-record behavior.

## Signup selfie compatibility

Runtime writer trace: `auth.routes.ts`'s authenticated `/selfie` upload is the only non-null writer of `User.avatar` and `selfieCapturedAt`; it chooses `avatars/<authenticated user>/` and storage chooses the 16-character filename. `customer.routes.ts`'s profile schema and explicit write allow only first name, last name and email. Account erasure clears the avatar/capture marker.

The existing operator/checklist face-match path re-reads the persisted avatar/capture marker and accepts only that subject's strict server-generated avatar key. There is no caller-supplied equality bypass. Invalid legacy pointers return `SELFIE_REQUIRED` with an instruction to retake the profile selfie through the existing endpoint. Owned signup selfie face matching remains tested and working. The current mobile L2 screen separately uploads both ID and selfie through verification upload, so both L2 references require envelope authority; its API is unchanged.

When envelope encryption is unconfigured, verification upload now refuses with `503 VERIFICATION_UPLOAD_UNAVAILABLE` before plaintext storage instead of handing the client a file that cannot safely be submitted.

## Deterministic red / green evidence

All commands below ran from the owned worktree with Node 20.19.6 on PATH. No database, Redis or external provider calls were made.

Before the production fix, the initial 11 containment tests all failed: six actual B-upload to A checklist/ID/selfie attempts (same and cross tenant) and five poisoned persisted-pointer DSAR/retention/image/account/orphan sinks. The negative controls observed forbidden provider/document or storage side effects, rather than accepting any arbitrary failure as proof.

Command used for red and expanded green:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts
```

Initial red: `Test Files 1 failed | 2 passed (3)`; `Tests 11 failed | 14 passed (25)`.
Final expanded green: `Test Files 15 passed (15)`; `Tests 139 passed (139)`; duration 3.29 seconds.

Focused final command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts
```

Result: `Test Files 1 passed (1)`; `Tests 63 passed (63)`; duration 1.11 seconds.

The 63 tests use real service/route handlers over explicit per-subject in-memory metadata and storage. They include real envelope encryption/decryption, owned positives at intake/mint/render/all deletion paths, invalid signup avatar recovery, replacement/account avatar guards, metadata/key/storage failures, shared references and orphan denial/revalidation. Route-handler tests explicitly bind principals; they do not claim to exercise Fastify authentication/admin hooks. Auth, tenant middleware, real storage adapters and database constraints still require integration evidence.

The no-service configuration explicitly includes the containment suite, both existing identity-signal suites, and the relevant expiry, durability, processor-register, registry-literal, dependency, FX, minimisation, mover-pointer, INV-15 and admin static regressions. The normal database-test configuration and target lock are untouched.

Additional checks:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api type-check
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api lint
git diff --check
```

Each completed with exit 0. Type-check runs both `tsc --noEmit` and `tsc -p tsconfig.scripts.json`; lint covers all API source and scripts. Schema/migrations, `identity-signal-policy.ts`, and `doc-state.ts` have no diff.

Dependencies were installed from the existing offline store with `pnpm install --offline --frozen-lockfile --ignore-scripts` (1,393 packages, zero downloads). Local Prisma client generation succeeded without a database connection. No tracked dependency or lockfile changed.

## Integration fixture migration — 25 existing files

Each positive intake/deletion fixture now provides explicit per-subject authority rather than mocking the resolver. The new shared `src/__tests__/helpers/verification-object.ts` creates only metadata for stub-processor tests and cleans up its exact seeded keys. It does not claim byte/encryption integration; existing upload/render suites retain real encrypted upload fixtures. Safe basename markers preserve sandbox decision behavior.

Under `apps/api/src/__tests__/`:

- `account-deletion.test.ts`
- `activation-authority.test.ts`
- `doc1-always-review.test.ts`
- `doc1-category-gate.test.ts`
- `doc1-collision-second-review.test.ts`
- `doc1-custody.test.ts`
- `doc1-degradation.test.ts`
- `doc1-document-record.test.ts`
- `doc1-dsar.test.ts`
- `doc1-extraction-ledger.test.ts`
- `doc1-fraud-escalation.test.ts`
- `doc1-hard-limits.test.ts`
- `doc1-image-policy.test.ts`
- `doc1-purge-receipt.test.ts`
- `doc1-review-case.test.ts`
- `doc1-reviewer-recusal.test.ts`
- `doc1-state-machine.test.ts`
- `doc1-subjects.test.ts`
- `document-intake-characterization.test.ts`
- `envelope-encryption.test.ts`
- `integrity-enforcement.test.ts`
- `onboarding-review.test.ts`
- `storage-orphans.test.ts`
- `verification-hardening.test.ts`
- `verification.test.ts`

The list includes the two existing upload/render suites whose expected errors changed, alongside 23 fixture migrations. No negative ownership test obtains an implicit default authority; the cross-owner controls use the actual B upload and expected A principal.

## Held evidence and remaining boundaries

- All 25 modified database-backed suites are UNVERIFIED locally. Security PostgreSQL/Redis were unavailable and no service probes/startup or shared namespace access was attempted. Run the complete API CI suite, including adjacent selfie, legal-hold, retention, tenant-admin isolation, reviewer RBAC and sensitive-read suites; do not treat local green as a substitute.
- Structural object lineage, uniqueness at concurrent claim, arbitrary historical reference reconciliation, complete selfie/orphan/extraction erasure and a committed purge/legal-hold fence remain separate audit units. This change does not close the legal-hold race: a hold can still race an already-authorized irreversible storage action.
- Fail-closed legacy/shredded/public orphans are deliberately not automatically deleted. A previously shredded object with lingering ciphertext needs explicit reconciliation; this patch does not restore a bare-key retry capability or claim full erasure completion.
- Production readiness requires configured encryption and legacy re-upload/reconciliation. Invalid signup selfie pointers have the existing retake route and a clear API instruction; valid server-owned selfie paths are not blacked out.
- No independent exact-head review, CI, push, PR, merge, deployment, credential/customer-data access or protected-simulator action is claimed by this report. Only a local commit is authorized after the local checks pass.

## REPORT-213 corrections — local candidate, 2026-09-12

### Immutable starting point and authority

Before editing, `git branch --show-current`, `git rev-parse HEAD HEAD^{tree}`, and `git status --short` returned:

```text
codex/security-verification-object-containment-20260912
67222490f9b5350ca5ac75f46371f637428524f5
3fdb36c1bb83bfeb24c0d4f31601b33da7bac64e
[no status output: clean]
```

The protocol, lane register, shared context, initial evidence and complete independent REPORT-213 were read first. The existing lane was changed to ACTIVE CORRECTIONS before source edits. The debugging skill supplied the reproduce/isolate/fix sequence. This remains the Codex-owned security lane; only source/tests/evidence and a local explicit-path commit are authorized. No finding is waived or independently approved by this implementation report.

### Finding dispositions and caller contracts

| Finding | Local correction and retained boundary |
| --- | --- |
| F-213-01, S1 | Shared `storage-key.ts` defines provider selection, local base directory and exactly the local adapter's prefix/path resolution. The adapter and authority resolver both use it. Local metadata and document references are keyset-scanned, including other subjects/tenants, and compared by resolved local path. Caller keys must still be canonical and the one metadata row must match the exact supplied key and creator. Dot segments, doubled separators, parent segments and supported uploads spellings cannot escape that census. S3/R2 stay literal-key stores. Query/config/census failures remain the same non-enumerating denial. |
| F-213-02, S1 | Account preflight commits due retention clocks on unpurged document rows in the same transaction as DEACTIVATED. An authority refusal retains the document, key, metadata and extracted fields; it does not write a purge receipt. Independently authorized avatar/session/address/recovery/cart/personal cleanup continues. A failed storage probe writes only FAILED evidence and retains the pointer. The service returns `deleted:false/PENDING_DOCUMENT_ERASURE`; the HTTP route returns 202 and audits pending, not completed. The existing mobile caller shows the pending message and logs out. |
| F-213-03, S2 | Orphan retry scans a fixed-time census using an explicit `(createdAt,id)` keyset and pages of at most 100 rows, stopping after the requested number of successful deletions or exhaustion. It does not use a mutable-row Prisma cursor/skip. Permanently invalid oldest rows stay open but cannot starve eligible later rows. Authority is re-proved on every retry. |
| F-213-04, S2 | Generated declaration checks the same country/tier checklist as intake and obtains/wraps a DEK before legal publication, tier change, consent, rendering or upload. Unsupported SERVICE declarations fail early without inventing checklist policy. Missing/invalid/unavailable key wrapping returns 503 with zero side effects; plaintext fallback is removed. Encrypted success still traverses actual intake. The existing micro-vendor DB fixture sets a synthetic test-only KEK, resets the key-provider cache and restores environment/cache in teardown. |

Local census is bounded to 100 pages of 100 rows per reference table and at most two matching records in memory. If a complete table census cannot be proved within that bound, authority is refused, even for an otherwise valid object. This intentional availability cost is temporary containment, not structural lineage or a scalable normalized-key index. No S3/R2 filesystem normalization is applied.

Recovery uses the retained `VerificationDocument` row, its nonempty pointer and its due `retentionExpiresAt`, not a newly invented receipt/schema. `VerificationService.purgeExpiredDocuments` runs from the existing daily queue without user authentication. It continues past unavailable authority and tries later due rows. For a DEACTIVATED account with its established `deleted:` phone tombstone it also shreds extracted values when valid object proof is later restored. An unresolved row remains open; after attempting the tail the reaper still throws the generic authority error, preserving the existing queue failure/page and withholding a completed-run heartbeat. No automatic process invents missing metadata or restores deletion authority for an unproven legacy key.

The caller census used:

```sh
rg -n 'deleteAccount|purgeExpiredDocuments|shredAndProbe|retryStorageOrphans|unregistered-declaration' apps/api/src apps/mobile/src apps/web/src apps/admin/src apps/desktop/src packages/types/src --glob '!*.test.ts' --glob '!*.unit.test.ts'
```

Observed consumers: customer DELETE account route; mobile customer API wrapper and PersonalDataScreen; verification image/full purge and retention reaper; the daily queue; account orphan retry; generated vendor declaration. The direct route tests bind a principal but do not exercise real authentication middleware or database constraints. The existing auth guard still rejects DEACTIVATED; recovery deliberately does not require that guard to admit the deleted account.

### Deterministic red-before / green-after

All commands below ran in the owned worktree with Node v20.19.6. No DB, Redis, live provider or network was used. Local storage adapter coverage uses isolated temporary fixture files; destructive containment spies are in-memory.

First expanded correction replay, before production correction:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts
```

Actual red summary at 19:57:25 local: `Test Files 1 failed (1)`; `Tests 18 failed | 68 passed (86)`; exit 1. Failures reproduced alias acceptance/destructive access, wrong S3 literal equivalence, account abort after cutoff, orphan results `[0,0,0]`, and declaration mutations/plaintext or raw invalid-key error.

The initial SERVICE replay exposed a missing mock delegate; that harness deficiency was corrected, not counted as product proof. Before production correction, the isolated replay then failed for the actual contract mismatch:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts -t 'unsupported SERVICE'
```

Actual red at 19:57:41: `Tests 1 failed | 85 skipped (86)`; observed late `INVALID_DOC_TYPE`, expected early `DECLARATION_UNSUPPORTED`; exit 1.

The newly inspected HTTP and mobile caller contracts had independent red controls:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts -t 'HTTP deletion'
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/mobile exec vitest run src/modules/profile/screens/PersonalDataScreen.test.ts
```

HTTP red at 20:01:59: `Tests 1 failed | 90 skipped (91)`, no 202 status call. Mobile red at 20:02:31: `Tests 1 failed | 1 passed (2)`, observed false completed-deletion text for a pending response. Both commands exited 1.

Final focused API replay (same focused command above) at 20:07:13: `Test Files 1 passed (1)`; `Tests 92 passed (92)`; duration 2.00s; exit 0. The 29 added cases cover 12 cross-subject aliases (metadata/document), 2 literal S3/R2 controls, 2 later-page alias controls, a census-limit refusal, 3 account legacy/missing/outage cases, background recovery past a persistent obstruction, repeated orphan results `[5,2,0]` over 6 invalid and 7 eligible rows, failed-probe pending behavior, HTTP pending auditing/status, and 5 declaration key/checklist/encrypted-success cases.

The existing poisoned-account negative control now expects an honest pending result instead of a thrown exception; all forbidden document storage/key/extraction/receipt assertions remain. It does not weaken the authority rule to get green.

### Complete local affected checks

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api type-check
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api lint
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/mobile test
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/mobile type-check
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/mobile lint
git diff --check
```

Actual final results:

| Check | Output / result |
| --- | --- |
| All API containment/no-service | `Test Files 17 passed (17)`; `Tests 184 passed (184)`; start 20:06:05; duration 11.81s; exit 0. All prior 15 suites retained; existing image-metadata-strip and order-status-single-source suites added. |
| API source and scripts typecheck | `tsc --noEmit && tsc -p tsconfig.scripts.json`; no diagnostics; exit 0. |
| Full API lint | `eslint 'src/**/*.{ts,tsx}' 'scripts/**/*.ts'`; no diagnostics; exit 0. |
| All mobile suites | `Test Files 131 passed (131)`; `Tests 1162 passed (1162)`; start 20:03:28; duration 11.07s; exit 0. |
| Mobile focused confirmation | `Test Files 1 passed (1)`; `Tests 2 passed (2)`; start 20:02:51; duration 369ms; exit 0. |
| Mobile typecheck / lint | Both exit 0, no diagnostics. |
| Diff hygiene | No output; exit 0. |

During development the first API typecheck identified eight test/index-access/union-narrowing diagnostics and the first lint identified one multiline `it.each` invocation. These were corrected; the final commands above passed. No failed gate is hidden or waived.

```sh
git diff --name-only 198cfb7ab1020de5acb9b0a78ee5f121087243c6 -- apps/api/prisma apps/api/src/modules/verification/doc-state.ts apps/api/src/modules/verification/identity-signal-policy.ts apps/api/vitest.config.ts .github/workflows/ci.yml
git merge-base HEAD 198cfb7ab1020de5acb9b0a78ee5f121087243c6
git rev-parse origin/main
```

Actual outputs: first command empty, exit 0; merge-base `198cfb7ab1020de5acb9b0a78ee5f121087243c6`; current remote-tracking main `9fb74a687e00c9c3a528cab10a4979e6e52c9a9b`. Per parent direction no fetch, base integration or history rewrite was performed. Final correction commit/tree/diff are recorded in the external coordination handoff to avoid a self-referential commit identifier.

### Normal CI and held integration gates

The normal `apps/api/vitest.config.ts` still includes all `src/**/*.test.ts` and its unchanged DB/Redis target-lock setup. `.github/workflows/ci.yml` API Tests provisions isolated PostGIS/Redis, replays migrations, seeds, and runs `pnpm --filter @swift/api test -- --coverage`. It does not set a KEK; the micro-vendor fixture now supplies/restores its own synthetic key. Do not replace normal CI with the no-service configuration.

All 25 earlier migrated database suites plus `doc1-micro-vendor-tier.test.ts` (26 modified DB suites total) remain UNVERIFIED locally. DB/Redis integration is intentionally HELD; no service startup/probe, database mutation or alternate target-lock bypass was attempted.

A conservative literal-caller/service-delegate census plus adjacent safety/retention/RBAC/selfie coverage identifies the following 98 explicitly held suites under `apps/api/src/__tests__/`. This is a lower bound, not proof that all transitive effects are enumerated; the full normal API CI suite remains required.

Census command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH node --input-type=module -e 'import fs from "node:fs"; const dir="apps/api/src/__tests__"; const boundary=/storage-provider|object-authority|purge-receipt|storage-orphans|AccountService|account\.service|vendorRoutes|vendor\.routes|VerificationService|verification\.service|unregistered-declaration/; const service=/new PrismaClient|prismaPlugin|redisPlugin/; const adjacent=new Set(["safety-deletion-hold.test.ts","safety-legal-hold.test.ts","retention-clocks.test.ts","doc1-review-rbac.test.ts","selfie.test.ts"]); const files=fs.readdirSync(dir).filter(f=>f.endsWith(".test.ts") && (adjacent.has(f) || (()=>{const t=fs.readFileSync(`${dir}/${f}`,"utf8"); return boundary.test(t) && service.test(t);})())).sort(); console.log(`${files.length} held suites`); console.log(files.join("\n"));'
```

Actual output:

```text
98 held suites
acceptance.test.ts
account-deletion.test.ts
activation-authority.test.ts
attack-payout-link-change.test.ts
auth-accounts.test.ts
authz-matrix.test.ts
billing-suspension-retention.test.ts
busy-hours.test.ts
catalogue.test.ts
checkout-bulk-snapshot.test.ts
compliance-audit.test.ts
delivery-cash-settlement.test.ts
discovery-vendor.test.ts
dispatch-trigger.test.ts
doc1-activation-rehearsal.test.ts
doc1-always-review.test.ts
doc1-category-gate.test.ts
doc1-claim-semantics.test.ts
doc1-collision-second-review.test.ts
doc1-custody.test.ts
doc1-degradation.test.ts
doc1-document-record.test.ts
doc1-dsar.test.ts
doc1-extraction-ledger.test.ts
doc1-fleet-propagation.test.ts
doc1-fraud-escalation.test.ts
doc1-hard-limits.test.ts
doc1-image-policy.test.ts
doc1-legal-hold.test.ts
doc1-micro-vendor-tier.test.ts
doc1-purge-receipt.test.ts
doc1-reaper-alarm.test.ts
doc1-registry.test.ts
doc1-renewal-schedule.test.ts
doc1-retention-policy.test.ts
doc1-review-case.test.ts
doc1-review-rbac.test.ts
doc1-reviewer-recusal.test.ts
doc1-state-machine.test.ts
doc1-storefront-disclosure.test.ts
doc1-subjects.test.ts
doc1-taxi-validators.test.ts
document-intake-characterization.test.ts
envelope-encryption.test.ts
ful-004-vendor-delivery.test.ts
handover-pickup-lockout.test.ts
handover-secret-admin.test.ts
import-files.test.ts
integrity-enforcement.test.ts
integrity-extensions.test.ts
inventory.test.ts
mmg-fulfilment-gate.test.ts
mmg-pay-link.test.ts
mmg-vendor-attestation.test.ts
money-decimal-wire.test.ts
mover-freeing.test.ts
notifications.test.ts
onboarding-review.test.ts
operate-gate-unification.test.ts
order-cancellation.test.ts
order-creation-account-authority.test.ts
order-flow.test.ts
order-hold.test.ts
order-picking.test.ts
orders.test.ts
picking-readiness.test.ts
platform-audit.test.ts
preview-drafts.test.ts
promo-terms.test.ts
qr-analytics.test.ts
qr-resolver.test.ts
rating-standing.test.ts
retail.test.ts
retention-clocks.test.ts
review-responses.test.ts
safety-deletion-hold.test.ts
safety-legal-hold.test.ts
scheduling-availability.test.ts
scheduling-reschedule.test.ts
scheduling-slot-freeing.test.ts
search-sync.test.ts
selfie.test.ts
socket-auth.test.ts
staff-roles.test.ts
statements.test.ts
storage-orphans.test.ts
vendor-analytics-coverage.test.ts
vendor-analytics-ops.test.ts
vendor-bookings.test.ts
vendor-item-bulk.test.ts
vendor-operate-gate.test.ts
vendor-overview-truth.test.ts
vendor-promos.test.ts
vendor-public-phone-rail.test.ts
vendor-repeat-customers.test.ts
vendor-self-delivery-terminal.test.ts
verification-hardening.test.ts
verification.test.ts
```

### Still open / not certified

- Structural immutable object lineage (tenant/purpose/location/generation), concurrent-claim uniqueness, and arbitrary historical reconciliation remain separate security work. The local bounded census does not solve filesystem hardlink/symlink/case identity beyond the storage adapter's lexical key resolution.
- A committed purge/legal-hold fence is still absent. A hold can race irreversible storage operations; this correction does not claim to fix that race. Existing holds remain excluded. Partially shredded/legacy objects lacking adequate authority remain unresolved and require authorized reconciliation; no bare-key retry is restored.
- Full selfie/unattached-object/extraction erasure across the platform is not certified. The account recovery change only preserves and retries the retained document obligation. Other unrelated failures after cutoff and concurrent late writes are not a general deletion-saga redesign.
- Generated declaration failures after successful checklist/key preflight (publication/consent/storage/DB/intake races) are not a fully transactional publication saga. The corrected guarantee is no unavailable-envelope or unsupported-checklist side effect.
- Reviewer/viewer governance, legal content/policy changes, production readiness and launch approval are outside scope. No schema, migration, consent policy or normal CI configuration was changed.
- No independent review of the corrected head, full DB/Redis-backed API CI, current-base integration/recheck, push, PR or merge has occurred. Current-main normal merge, fresh exact-head independent review and all required current-head/current-base CI gates remain mandatory.
- No production/deployment/credential/customer-data/provider contact, Claude-owned source edit, protected-simulator action, direct-main push, force push, rebase or history rewrite was performed.

## REPORT-220 F-220-01 correction — 2026-09-12 lane

The earlier sequential recovery claim above is superseded by REPORT-220's
independent S1 interleaving proof. On starting head
`89b2942564344fcf8d488da79758b336bdd78ee2` (tree
`8cc1c72a80a8d29423fa7ffd5e77adbd029e951e`), a reaper could retire the due
document and write CONFIRMED_ABSENT while retaining its extraction-run DEK
and field ciphertext. This section records the bounded local correction,
not independent approval or full-erasure certification.

Account preflight now commits the exact `deleted:${userId}` phone tombstone
with the due clocks and DEACTIVATED cutoff. Its original phone has already
been captured by any authorized safety escrow. The final cleanup repeats
the tombstone idempotently. Cleanup remains keyed by user ID; the number
becomes available for reuse at cutoff instead of at final personal cleanup.

`purgeDocumentNow` reads the exact marker from the user row in its existing
final FOR UPDATE query. A matching marker OR explicit DSAR field-erasure
option requires extraction-run/field shredding in the same transaction as
document retirement and the receipt. Reaper candidate snapshots no longer
choose field-erasure semantics. DEACTIVATED has only account-deletion
writers, but admin ban can replace it; the marker survives that transition.
An ordinary banned/suspended/active account, a deactivated account without
the marker, another subject's marker and a suffix alias do not acquire
field-erasure intent. Existing legal holds still exclude the document.

Commands below ran from this worktree with Node v20.19.6 on PATH:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts -t F-220-01
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/mobile test
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api type-check
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/api lint
```

Actual results:

- First command, before production edits, 20:54:47: 6 failed / 4 passed /
  92 skipped (102), exit 1. The failures included cutoff before cleanup,
  both metadata-restoration schedules, absent cutoff marker and both locked
  exact-marker cases. Concrete run DEK and field ciphertext remained.
- Final focused file, 21:00:08: 106 passed, exit 0. All prior 92 cases remain;
  14 additions cover the interleavings, exact-marker/status controls, safety
  escrow and legal-hold exclusion. Query results copy user snapshots and
  honor document predicates. An initial post-fix harness error indexed the
  later empty sweep; it was corrected without changing erasure assertions.
- Final no-service API, 21:01:35: 17 files / 198 tests passed, 16.30s, exit 0.
- Full mobile, 20:59:34: 131 files / 1,163 tests passed, 9.99s, exit 0.
- API typecheck (`tsc --noEmit && tsc -p tsconfig.scripts.json`) and full
  API lint (`eslint 'src/**/*.{ts,tsx}' 'scripts/**/*.ts'`): exit 0, no diagnostics.

`account-document-erasure-race.test.ts` adds four normal-CI PostgreSQL tests:
cutoff visibility before cleanup, metadata recovery during independent
cleanup, a stale candidate at the real user-lock barrier, and rollback of
document/run/field/receipt state on a field-shred failure. They use the real
test Prisma connection and transactions with synthetic storage, and retain
the normal target lock. They were NOT run locally. Add this file to the
98-suite affected/adjacent census above; all database evidence remains
UNVERIFIED until normal API CI runs it. The rollback case deliberately does
not claim recovery of an already-shredded image.

The source corrections for lexical aliases, literal S3/R2 authority, orphan
tail progress, declaration preflight, signup coexistence and all mobile
bytes remain unchanged from the starting head. No schema/migration,
document-state, identity policy, normal CI or target-lock change was made.
Structural lineage, general deletion/recovery sagas, historical/full erasure
and committed purge/legal-hold fencing remain OPEN.

The pinned implementation base remains
`9fb74a687e00c9c3a528cab10a4979e6e52c9a9b`. During this correction, main advanced
to `7d5902e9d0edac974e4fbe2541a9242467ed6277`; no fetch/merge/rebase/push occurred
here. The coordination correction report binds the local commit/tree.
A later normal main merge, fresh independent exact-head Astra review and
all current-head/current-base CI gates are required before publication.

## REPORT-224 F-224-01 correction — ordinary retention cannot postpone erasure

Starting head `fea3b92916170ff023470d90a06eb417b0eb11ba`, tree
`a0bc84f6659bdbd23d6fc94516f4f22dda1fbdcc`, contains exact current main
`7d5902e9d0edac974e4fbe2541a9242467ed6277`. REPORT-224 accepted the earlier
F-220-01 race repair but reproduced a new integration gap: the real admin
ban handler's ordinary retention scheduling replaced a pending erasure's
due clock with another 365 days. Merely mutating status in a test had not
exercised that caller. This section is implementation evidence, not approval.

The scheduler still obtains its country/type ruling through the existing
policy function. It commits deadline writes in one transaction after taking
the same user FOR UPDATE lock as cutoff and final purge. For non-AML records,
each UPDATE itself requires a null or later existing deadline; an earlier
deadline is neither read from a stale snapshot nor replaced. If scheduling
wins the lock first, later cutoff makes the document due. If cutoff wins,
scheduling retains that due clock. Repeated ordinary scheduling returns zero
changed rows. The handler ignores this count; new/shortened clocks count as
before. Missing authority still remains pending, never a passing receipt.

AML is an explicit exception, not a new legal-precedence decision. The ruling
now also exposes the same existing AML classification it already reads.
`source` alone is insufficient: a 3,000-day AML registry policy reports
REGISTRY because it already exceeds the seven-year floor. AML updates retain
their pre-existing replacement/restart behavior and exact max-of-policy
duration; only non-AML scheduling is monotonic. No floor, registry value,
country default, legal-hold rule, DSAR refusal or schema was changed.

Fourteen no-service additions execute actual services and the registered
admin handler with a supplied principal. They cover missing metadata after
actual ban, restoration without login, both paused scheduling/cutoff orders,
null/due/earlier/equal/later clocks, repeat scheduling, held/purged/other-subject
exclusions, registry/AML clocks and AML reclassification plus DSAR refusal.
The before-cutoff scheduler control calls the production service directly:
the current sole HTTP caller bans first, and a ban before a new account
deletion would make that deletion ineligible. No impossible unlocked HTTP
schedule is claimed. The no-service delegates implement OR/AND predicates
and distinguish user/rider/driver raw queries; they do not certify DB locks.

Commands (worktree root, Node v20.19.6 first on PATH):

```sh
pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts -t F-224-01
pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts -t 'applicable AML'
pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts src/__tests__/verification-object-containment.unit.test.ts
pnpm --filter @swift/api exec vitest run --config vitest.containment.config.ts
pnpm --filter @swift/mobile test
pnpm --filter @swift/api type-check
pnpm --filter @swift/api lint
```

Actual red/green results (2026-09-12 local UTC-04:00):

- Valid pre-production red, 21:24:16: 8 failed / 4 passed / 106 skipped
  (118), 2.32s, exit 1. Actual admin ban and cutoff-first stale scheduler both
  replaced epoch 1789214400000 with 1820750400001 (+365 days and 1ms).
  The preceding run also exposed an incomplete synthetic raw-query delegate
  that returned a user as a rider; it was fixed before the valid red above.
- A blanket-minimum interim was deliberately rejected after a new AML control
  failed 2 / 118 skipped (120), 21:30:26, 2.23s, exit 1. That interim is not
  the committed correction; existing AML extension behavior is preserved.
- Final focused: 120 passed, 21:31:05, 2.44s, exit 0.
- Final no-service API: 17 files / 212 tests passed, 21:32:08, 14.57s, exit 0.
- Full API lint: exit 0, no diagnostics. The final coordination report binds
  source/scripts typecheck, full mobile, hygiene and the exact commit/tree.

Twelve further normal-CI PostgreSQL cases extend the four F-220-01 cases in
`account-document-erasure-race.test.ts` (16 total). They use real transactions
and exact backend IDs; `pg_blocking_pids` must observe the expected blocker
in both orders before either transaction is released. They also cover
cutoff rollback while the scheduler waits, whole scheduler-batch rollback,
actual registered ban, all five ordinary-clock cases and two isolated AML
reclassification cases. The latter create only their own synthetic registry
rows, never mutate seeded market policy. These 16 tests were NOT executed
locally. No normal API test target lock was bypassed; the earlier 99-suite
affected/adjacent DB census remains service-backed CI-only/UNVERIFIED.

An exact-source AML compatibility replay ran from `apps/api`:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH NODE_ENV=test node --import tsx <<'JS'
const assert = require('node:assert/strict'), {execFileSync} = require('node:child_process'), Module = require('node:module'), path = require('node:path'), ts = require('typescript');
const base = 'fea3b92916170ff023470d90a06eb417b0eb11ba';
function original(relative, exported) {
  const filename = path.resolve(relative), m = new Module(filename, module);
  m.filename = filename; m.paths = Module._nodeModulePaths(path.dirname(filename));
  const source = execFileSync('git', ['show', base + ':apps/api/' + relative], {encoding:'utf8'});
  m._compile(ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText, filename);
  return m.exports[exported];
}
const Previous = original('src/modules/verification/verification.service.ts', 'VerificationService');
const Current = require('./src/modules/verification/verification.service.ts').VerificationService;
const oldPolicy = original('src/modules/verification/retention-policy.ts', 'retentionDaysFor');
const currentPolicy = require('./src/modules/verification/retention-policy.ts').retentionDaysFor;
const DAY=86400000, start=Date.parse('2026-09-12T12:00:00Z'); let clock=start;
const realNow=Date.now; Date.now=()=>clock;
function fixture(registryDays, amlRecordClass, deadline) {
  const row={id:'synthetic-doc',userId:'synthetic-subject',docType:'synthetic',role:'CUSTOMER',purgedAt:null,retentionExpiresAt:deadline};
  const db={user:{findUnique:async()=>({countryCode:'GY'})},countryConfig:{findUnique:async()=>({code:'GY',dataRetentionDays:365})},docType:{findUnique:async()=>({persistRetentionDays:registryDays,amlRecordClass})},verificationDocument:{findMany:async()=>[{...row}],updateMany:async({where,data})=>{if(where.OR && !where.OR.some(c=>c.retentionExpiresAt===null?row.retentionExpiresAt===null:row.retentionExpiresAt!==null&&row.retentionExpiresAt>c.retentionExpiresAt.gt))return{count:0};Object.assign(row,data);return{count:1};}},$queryRaw:async()=>[{id:row.userId}]};
  db.$transaction=async fn=>fn(db); return {row,db};
}
(async()=>{
  let schedules=0,policyRulings=0;
  for(const aml of ['NOT_APPLICABLE','CDD_IDENTITY','CDD_ENTITY','TRANSACTION_LINKED'])for(const registry of [null,365,2555,3000]){
    const h=fixture(registry,aml,null),input={countryCode:'GY',docType:'synthetic',role:'CUSTOMER',countryDefaultDays:365};
    const old=await oldPolicy(h.db,input),fresh=await currentPolicy(h.db,input),{amlRecord,...same}=fresh;
    assert.deepEqual(same,old); assert.equal(amlRecord,aml!=='NOT_APPLICABLE');policyRulings++;
    if(aml==='NOT_APPLICABLE')continue;
    for(const deadline of [null,new Date(start-1),new Date(start+4000*DAY)]){
      const before=fixture(registry,aml,deadline),after=fixture(registry,aml,deadline);
      const a=new Previous(before.db,{},{}),b=new Current(after.db,{},{});
      for(const offset of [0,DAY]){
        clock=start+offset;
        assert.equal(await b.scheduleDocumentRetention(after.row.userId),await a.scheduleDocumentRetention(before.row.userId));
        assert.deepEqual(after.row.retentionExpiresAt,before.row.retentionExpiresAt); schedules++;
      }
    }
  }
  console.log(JSON.stringify({exactRejectedHead:base,unchangedPolicyRulings:policyRulings,identicalAmlScheduleResults:schedules,realServices:true,syntheticDelegatesOnly:true}));
})().finally(()=>{Date.now=realNow;}).catch(error=>{console.error(error);process.exitCode=1;});
JS
```

Actual output, exit 0:

```json
{"exactRejectedHead":"fea3b92916170ff023470d90a06eb417b0eb11ba","unchangedPolicyRulings":16,"identicalAmlScheduleResults":72,"realServices":true,"syntheticDelegatesOnly":true}
```

Separate OPEN policy/legal boundary: AccountService's unheld account-erasure
loop does not consult AML classification, whereas document DSAR refuses AML
records and retention scheduling applies its floor. REPORT-202 already left
the underlying legal classification, start event and expiry UNVERIFIED.
The interaction of immediate whole-account deletion with an applicable AML
obligation needs its own record-specific policy decision and bounded repair;
this patch neither resolves nor certifies that precedence.

All cash-main/client bytes, account cutoff/F-220 final-purge behavior, alias
and object authority, orphan-tail progress, declaration preflight, holds,
DSAR policy, normal CI/test-lock configuration and schema/migrations remain
unchanged. Structural lineage, historical/full erasure, partial-shred recovery
and committed purge/legal-hold fencing remain OPEN. The coordination report
binds the local commit/tree; fresh independent exact-head Astra review and
all current-head/current-base CI gates remain mandatory. No service/provider,
credential/customer-data, production/deployment, simulator or Git publication
action occurred during this correction.

## REPORT-231 avatar-erasure correction — 2026-09-19 local candidate

The published exact head `07c70e2bfdf3d86906ef4e0caa7a4e59165c56ca`
had 13/13 green CI checks but was correctly rejected by independent exact-head
review: every production avatar orphan was routed through verification-envelope
authority, could never drain, and account deletion could still claim success.
Old CI is therefore superseded and cannot authorize merge.

Failing tests were written before this production correction. The focused
service-free replay observed three genuine failures: a request-tenant-filtered
User delegate hid a foreign-tenant physical alias (`received 1`, expected 0), a
second account-deletion request returned `{deleted:true}` while the prior avatar
obligation remained open, and the scheduled orphan drain occurred after the
fallible document reaper. Actual red: 3 failed / 130 passed (133), exit 1.

The resulting correction now:

- gives avatars their own provider-canonical authority (local
  `/uploads/avatars/<subject>/<16>.<ext>`; S3/R2
  `avatars/<subject>/<16>.<ext>`), separate from encrypted verification
  envelopes;
- performs the global current-pointer/physical-alias census with raw SQL and
  first proves `row_security_active('users'::regclass) = false` on the same
  transaction connection; filtered, missing or erroneous visibility evidence
  refuses deletion;
- accepts only the closed historical/pending avatar reason allowlist as delete
  authority, locks User then StorageOrphan, re-reads immutable provenance,
  deletes and post-probes, and closes only the exact row with CAS;
- treats only explicit `ENOENT`, `NoSuchKey` or `NotFound` as absence; an
  arbitrary 404/`NoSuchBucket` remains open;
- queues the old pointer in the same transaction as selfie replacement or
  account pointer clearing, and rejects conflicting subject/tenant provenance
  so the pointer mutation rolls back rather than becoming an invocation-local
  obligation that the next request forgets;
- derives account completion from every open subject avatar obligation plus
  the exact preflight row, with the global StorageOrphan census and
  `row_security_active('storage_orphans'::regclass)` proof sharing one
  transaction connection; inability to prove an empty census returns pending;
- returns 202/pending through the existing route/audit/mobile contract until
  both document and avatar obligations are discharged; and
- runs a bounded standing orphan stage before the fallible document purge,
  containing and paging its own failure so neither erasure stream starves the
  other.

The real-PostgreSQL additions cover serialized concurrent selfie replacement,
provider-canonical old/current pointers, cross-tenant alias refusal, confirmed
absence, retry and immutable provenance. `storage-orphans.test.ts` now cleans
its exact census after each case; its prior open verification row could
otherwise make the avatar count assertion nondeterministic. Those DB cases are
held locally because both assigned services were actually unavailable:
`pg_isready -h 127.0.0.1 -p 5434 -t 5` returned `no response`; Redis 6382/14
returned `Connection refused`. Normal CI must provision the security namespace,
replay migrations and execute them.

Final local evidence on the dirty candidate, Node 20.19.6:

| Check | Actual result |
| --- | --- |
| Focused authority/account/queue correction | 1 file / 138 tests passed |
| Complete no-service containment configuration | 17 files / 230 tests passed; 9.92s |
| API source + scripts typecheck | `tsc --noEmit && tsc -p tsconfig.scripts.json`; exit 0 |
| Full API lint | exit 0, no diagnostics |
| Mobile pending-deletion contract | 1 file / 2 tests passed |
| Mobile typecheck and full lint | both exit 0, no diagnostics |
| Diff hygiene | `git diff --check`; exit 0 |

Three independent pre-commit Astra review passes found five initial issues and
two follow-on issues; all seven were corrected and the final pass reported no
remaining blocker in scope. This is not the merge review: after commit/push, a
new reviewer must inspect the immutable exact head and fresh current-base CI.

Explicit residual: under a NOBYPASSRLS connection where PostgreSQL reports RLS
active for either census table, this compatibility implementation intentionally
refuses destructive avatar cleanup/completion. Structural provider-independent
object lineage or a sanctioned same-transaction system authority is still
required before that deployment posture can drain these obligations. The safe
failure is pending erasure, never a false success or cross-tenant delete.
