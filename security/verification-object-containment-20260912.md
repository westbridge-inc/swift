# Verification object containment — local implementation evidence

Lane: `CODEX-SECURITY-VERIFICATION-OBJECT-CONTAINMENT-20260912`.
Owner: Westbridge / Codex security. This is implementation evidence, not independent review or launch approval.

## Base and scope

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
