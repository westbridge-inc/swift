# REPORT-031 — Admin mutation tests

Status: DELIVERED WITH INTEGRATION BLOCKERS
From: Codex
To: Claude
Date: 2026-08-24
Re: `admin-tests` — first executable coverage for the four highest-risk operator mutations

## Final outcome — authoritative

The runner and tests are implemented in `/Users/westbridgeinc/swift-codex-admin-tests` on
`codex/admin-tests`. The branch contains the initial local commit `6093ee8`; the final corrective
changes remain in the working tree because this sandbox cannot create the shared worktree's Git
`index.lock` (literal evidence below). Nothing was pushed.

- Vitest + React Testing Library render the real client pages under TanStack Query and mock only
  `fetch`. The production `src/lib/api.ts` performs the real endpoint construction, method/body
  serialization, response parsing, and error propagation.
- Root discovery is wired by the `test: vitest run` package script. Turbo's root dry-run names
  `@swift/admin#test`, directory `apps/admin`, command `vitest run`.
- Final admin result: **7 test files, 24/24 tests passed**, including 20 tests across the four
  selected risk areas and four supplemental tests retained for user suspension and finance rows.
- Literal gates: **`VITEST_EXIT=0`**, **`ESLINT_EXIT=0`**, **`TSC_EXIT=2`**. The full TypeScript
  failure is four unchanged `OpsMap.tsx`/Leaflet errors; the lane-touched TypeScript set separately
  returns **`SCOPED_TSC_EXIT=0`**. The red package gate is not waived or represented as green.

## Why these four

| Risk area | Repository evidence for selection |
|---|---|
| Order cancel / cash-refund record | `admin.routes.ts:1691-1718` makes an authoritative `CANCELLED`/`REFUNDED` terminal transition and atomically couples status evidence, audit, inventory/float, and mover release. A wrong entity or false refund fact directly corrupts fulfilment and money truth. |
| Claim payout | `cash-rules.service.ts:401-434` explicitly calls `markClaimPaid` a **MONEY step**, moves a real guarantee claim to `PAID`, notifies the rider, and uses a status compare-and-set so only one winner exists. |
| Verification approve / reject | `verification.service.ts:375-480` is the terminal document-decision authority; HIRE review fields feed the live passenger-operation gate (`:785-808`). A wrong click changes who may operate. |
| Vendor suspension | `admin.routes.ts:983-1010` writes `SUSPENDED`, forces `acceptingOrders=false`, updates discovery, audits, and notifies the owner. A wrong store ID immediately removes commerce authority. |

Settlement closure and generic user suspension have supplemental coverage because they existed in
the initial lane commit, but they are not counted among the four selections above. Current platform
truth also makes claim payout the genuine payout surface; Swift does not hold vendor order money.

## What the primary tests pin

| Mutation | Entity/payload truth | Rejection truth | Confirmation / repeat protection |
|---|---|---|---|
| Order cancel / refund | Selects the second visible order row and asserts `PUT /api/v1/admin/orders/order-target/cancel` with the exact `reason` and `refund` flag; detail tests bind the visible order number and route ID. | Actual route wording `Cannot cancel an order with status COMPLETED` appears in `role=alert`; PENDING UI remains and no success refetch occurs. | Declining sends zero PUTs. A deferred cash-refund PUT disables the control and a second click leaves the count at one. Only CASH receives a refund-record control; copy says `refunded by {store}`. MMG has no refund control and says Swift cannot refund it. |
| Claim payout | Selects the second visible claim, requires and trims the payment reference, repeats amount + order ID + reference in confirmation, then asserts `PUT .../claim-target/paid` and `{reference:"PAY-REF-TARGET"}`. | Actual service wording `Claim is PAID; expected AUTO_APPROVED/APPROVED` appears; the row stays and the claims query does not refetch. | Blank reference and declined confirmation both send zero PUTs. A deferred payout disables all claim controls and the second click leaves one PUT. |
| Verification decision | Queue contains two documents; the test selects `Target Applicant` and asserts `document-target`, the complete insurance review object, or the exact trimmed rejection reason. | Actual service wording `Document is APPROVED, only PENDING documents can be reviewed` appears; the selected review stays open and no success refetch occurs. | Approve and reject each require identity-bearing confirmation. HIRE approval stays disabled until both reviewer checks are true. While either decision is pending, both buttons disable and a contradictory second request cannot fire. |
| Vendor suspend | Visible `Target Store` and route param `vendor-target` are tied to `PUT .../vendor-target/suspend` with `{reason:"Suspended by admin"}`. | Actual route `NotFoundError` wording `Vendor with id vendor-target not found` appears; ACTIVE state remains and no success refetch occurs. | Declining sends zero PUTs. Confirmation names the store, says orders stop immediately, and discloses that the console cannot reverse the action. |

## Real defects found

### F-031-01 — S1, fixed in this working tree: admin discarded server error text

`apps/admin/src/lib/api.ts` threw only `API error: <status>` even though the API's error handler
returns `error.message`. The initial tests pinned that wrong generic string. `apiFetch` now parses
the envelope once, treats both non-2xx and `success:false` as rejection, and throws the server's
own message. Every primary error case asserts a literal message supported by its called route or
service. This overlaps the later integration fix `d671ed9`; resolve during transplant, do not
duplicate it.

### F-031-02 — S1 money, fixed here: claim payout rejection was silent

The claims page had success-only invalidation and no error rendering. It also allowed a blank
manual payout reference. It now renders an alert and requires evidence before confirmation. This
overlaps integration commits `a1ba088` and `647e6ca`.

### F-031-03 — S1 trust, fixed here: verification decisions were one-click and internally contradictory

Approve/reject had no confirmation. HIRE approval required only insurer + policy even though the
passenger gate requires `hireClassConfirmed` and `plateCrossChecked`; the page could therefore
write APPROVED evidence that still left the driver blocked. The two independent pending flags also
allowed approve and reject requests to cross-fire. Confirmation, both HIRE checks, explanatory
copy, and a combined pending guard are now tested. The HIRE-gate part overlaps `ed08b04`; the
confirmation and combined guard remain lane work.

### F-031-04 — S1 trust, partly fixed here: vendor suspension failure vanished; reversal is absent

The suspension request already had a confirmation, but `suspend.error` was never rendered. It now
surfaces the server message. There is no vendor-unsuspend client, route, or console control, and an
ADMIN suspension is not lifted by billing. The confirmation now discloses that irreversibility.
Building a reversal authority is outside this lane and remains open. Error rendering overlaps the
later integration mutation-notice work in `647e6ca`.

### F-031-05 — S1 money truth, admin UI fixed; API copy remains open

Both order pages offered `refund:true` for MMG even though the route explicitly rejects it with
`MMG_REFUND_UNAVAILABLE`; CASH refund copy also failed the required `refunded by {store}` wording.
Both pages now expose the record-refund action only for CASH and use store-attributed copy. The
API notification at `admin.routes.ts:1737-1739` still says cash `will be refunded — our team will
follow up`, which does not identify the store as refunder. API source edits were prohibited in this
lane, so that server-copy defect is reported, not silently changed.

## Runner setup and integration blockers

- `apps/admin/package.json`: `test: vitest run`; React Testing Library, user-event, `happy-dom`,
  Vite, and Vitest dev dependencies.
- `apps/admin/vitest.config.ts`: `happy-dom`, TS/TSX discovery, automatic JSX runtime, `@` and
  `next/link` test aliases, cleanup setup, and a fixed test API origin.
- `apps/admin/src/test/*`: fresh QueryClient per render and a fetch-boundary harness.
- Root `package.json` already runs `turbo run type-check lint test`, and the workspace includes
  `apps/*`; no root script edit is needed.
- **Lockfile blocker:** `pnpm-lock.yaml` is outside this lane and does not contain the new admin
  dev dependencies. Frozen install returns 1. Integration must regenerate the root lockfile.
- **CI blocker:** `.github/workflows/ci.yml` builds admin but does not invoke admin tests. Workflow
  files are outside this lane; integration must add the admin test command if CI is to enforce it.
- **Base drift:** this worktree is behind current integration; the overlap commits named above
  should be reconciled rather than blindly replayed.

## Literal evidence

### Vitest

Command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --dir apps/admin test -- --reporter=verbose
```

Actual summary:

```text
Test Files  7 passed (7)
Tests       24 passed (24)
Duration    1.37s
VITEST_EXIT=0
```

### ESLint

Command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:/Users/westbridgeinc/swift/node_modules/.bin:$PATH NODE_PATH=/Users/westbridgeinc/swift/node_modules pnpm --dir apps/admin lint
```

Actual output:

```text
✔ No ESLint warnings or errors
ESLINT_EXIT=0
```

### TypeScript — full package gate is red

Command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --dir apps/admin type-check
```

Actual decisive output:

```text
src/components/ops/OpsMap.tsx(33,19): error TS2322: ... Property 'center' does not exist ...
src/components/ops/OpsMap.tsx(37,9): error TS2322: ... Property 'attribution' does not exist ...
src/components/ops/OpsMap.tsx(51,85): error TS2322: ... Property 'icon' does not exist ...
src/components/ops/OpsMap.tsx(66,11): error TS2322: ... Property 'icon' does not exist ...
TSC_EXIT=2
```

`git diff -- apps/admin/src/components/ops/OpsMap.tsx` produced no output. A TypeScript 6 Compiler
API run whose explicit roots were all 20 runner/touched production/test files produced:

```text
SCOPED_TSC_EXIT=0
```

### Root task discovery

Command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:/Users/westbridgeinc/swift-location-wt/node_modules/.bin:$PATH pnpm exec turbo run test --filter=@swift/admin --dry=text
```

Actual decisive output:

```text
Packages in scope: @swift/admin
Tasks to Run
@swift/admin#test
Directory = apps/admin
Command = vitest run
ROOT_WIRING_EXIT=0
```

### Frozen install

Command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm install --frozen-lockfile --lockfile-only --offline --ignore-scripts
```

Actual decisive output:

```text
ERR_PNPM_OUTDATED_LOCKFILE ... pnpm-lock.yaml is not up to date with <ROOT>/apps/admin/package.json
FROZEN_INSTALL_EXIT=1
```

### Diff and commit boundary

```text
$ git diff --check -- apps/admin
[no output]
DIFF_CHECK_EXIT=0

$ git add -- <14 explicit apps/admin paths> && git commit ...
fatal: Unable to create '/Users/westbridgeinc/swift/.git/worktrees/swift-codex-admin-tests/index.lock': Operation not permitted
COMMIT_EXIT=128
```

All implementation and report paths are under `apps/admin/**`; no mobile, web, package, or API
source file was modified. The canonical Swift tree remained read-only.

## Required integration sequence

1. Review the working-tree diff against current main, resolving the explicit upstream overlaps.
2. Stage the explicit `apps/admin/**` paths and create the corrective local commit as
   `westbridgeinc <266192432+westbridgeinc@users.noreply.github.com>`.
3. Regenerate and commit `pnpm-lock.yaml`, then prove frozen install.
4. Add `pnpm --filter @swift/admin test` to the admin CI job.
5. Fix or separately ledger the pre-existing `OpsMap.tsx` Leaflet typing gate; rerun full TSC.
6. Correct the API cash-refund notification to say the cash was `refunded by {store}`.

<details>
<summary>Superseded 2026-08-23 candidate report (kept for audit history; do not use as final evidence)</summary>

## Outcome

The `apps/admin` implementation is complete in `/Users/westbridgeinc/swift-codex-admin-tests` on `codex/admin-tests`, based on `origin/main` at `63374043b95c371158c6252602fccfa9867b80b4`.

- Added Vitest + React Testing Library component-integration coverage for verification approve/reject, order cancel/refund, user suspend, and settlement mark-paid.
- Tests render the real pages under a fresh TanStack Query client and mock only `fetch`; the production `src/lib/api.ts` remains real, so endpoint, method, and serialized body assertions cover the actual client API boundary.
- Added minimal `role="alert"` mutation-error rendering strictly required to prove failures are visible and do not produce fake success/refetch behavior.
- Added `test: vitest run` to `apps/admin/package.json`. CI/local command: `pnpm --filter @swift/admin test`.
- Result: 4 files passed; 12 ordinary tests passed; 2 confirmation requirements are truthful expected failures for the known verification safety gap.

Vitest + Testing Library with `happy-dom` was chosen over Playwright: these are client components whose risk boundary is the mutation-to-HTTP contract. This harness exercises that boundary directly, runs in under one second, and avoids a Next server/browser installation while retaining real page interactions and real API serialization.

## Coverage

| Action | Exact request asserted | Confirmation evidence | Failure evidence |
|---|---|---|---|
| Verification approve | `PUT /api/v1/admin/verification/document-1/approve`; full insurance object | **Missing in UI**; `it.fails` sentinel requires declined confirm to prevent PUT | Visible `Verification action failed: API error: 500`; review remains open; no refetch |
| Verification reject | `PUT /api/v1/admin/verification/document-1/reject`; `{ "reason": "Document is unreadable" }` | **Missing in UI**; `it.fails` sentinel requires declined confirm to prevent PUT | Visible error; review remains open; no refetch |
| Order cancel | `PUT /api/v1/admin/orders/order-1/cancel`; `{ "reason": "Cancelled by admin", "refund": false }` | Decline sends no PUT; accept sends one PUT | Visible 403 error; PENDING state remains; no refetch |
| Order cancel + refund | Same endpoint; `{ "reason": "Cancelled by admin", "refund": true }` | Decline sends no PUT; accept sends one PUT | Visible 403 error; PENDING state remains; no refetch |
| User suspend | `PUT /api/v1/admin/users/user-1/suspend`; `{ "reason": "Suspended by admin" }` | Decline sends no PUT; accept sends one PUT | Visible 500 error; ACTIVE controls remain; no refetch |
| Settlement mark-paid | `PUT /api/v1/admin/finance/settlements/settlement-1/process`; `{ "reference": "BANK-TEST-1" }` | Prompt captured; decline sends no PUT; accept sends one PUT | Visible 500 error; pending row remains; no settlement refetch |

## Findings and integration blockers

### F-031-01 — S1: verification approve/reject have no confirmation

`apps/admin/src/app/verification/page.tsx:224-243` calls `mutate` directly for both transitions. This permits one-click approval or rejection. Per the lane brief, no confirmation UI was added. The two tests at `page.test.tsx:131-166` use `it.fails`, so the gap is executable and cannot be mistaken for passing coverage; once the UI is fixed, they will become unexpected passes until converted to ordinary tests.

### F-031-02 — S1 integration blocker: root lockfile is stale

The lane is restricted to `apps/admin`, so `pnpm-lock.yaml` could not be updated. A fresh CI install currently fails before tests:

```text
$ pnpm install --frozen-lockfile --lockfile-only --offline
ERR_PNPM_OUTDATED_LOCKFILE Cannot install with "frozen-lockfile" because pnpm-lock.yaml is not up to date with <ROOT>/apps/admin/package.json
```

Integration owner action: regenerate and commit the root `pnpm-lock.yaml` after taking these changes, then rerun frozen install and the admin test command.

### F-031-03 — S2: current CI does not invoke admin tests

`.github/workflows/ci.yml:158-176` defines `admin-build` but only runs `pnpm --filter @swift/admin build`. Workflow edits were outside this lane. Integration owner action: add `pnpm --filter @swift/admin test` to the admin job (after the lockfile update).

### F-031-04 — delivery blocker: launcher sandbox cannot write Git metadata or coordination inbox

The worktree points its index into `/Users/westbridgeinc/swift/.git/worktrees/swift-codex-admin-tests`, outside the writable lane root. Explicit-path staging failed:

```text
fatal: Unable to create '/Users/westbridgeinc/swift/.git/worktrees/swift-codex-admin-tests/index.lock': Operation not permitted
```

An `apply_patch` write to the mandated `/Users/westbridgeinc/swift-coordination/inbox-claude/REPORT-031-admin-tests.md` was rejected as outside the writable project, and an explicit copy failed with `Operation not permitted`. Therefore no local commit could be created and this fallback report is preserved at `apps/admin/REPORT-031-admin-tests.md`. The implementation working tree remains intact. Intended author/committer: `westbridge-inc <westbridge-inc@users.noreply.github.com>`.

## Strictly required app changes

The original pages had success invalidation only and rendered no mutation error. A test could prove “no fake success” only by observing unchanged state, but could not prove that the operator sees an honest failure. Added one shared `MutationError` component and narrow rendering at each mutation surface. No business logic, success behavior, endpoints, or confirmation behavior changed.

Temptations intentionally left alone: verification's opposite action remains enabled while one mutation is pending; verification inputs are validated trimmed but sent untrimmed; canceling finance's optional-reference prompt still proceeds to confirmation. These are findings for later work, not requirements for this lane.

## Files changed

- `apps/admin/package.json`
- `apps/admin/vitest.config.ts`
- `apps/admin/src/components/MutationError.tsx`
- `apps/admin/src/test/{setup.ts,test-utils.tsx,next-link.tsx}`
- `apps/admin/src/app/verification/{page.tsx,page.test.tsx}`
- `apps/admin/src/app/orders/[id]/{page.tsx,page.test.tsx}`
- `apps/admin/src/app/users/[id]/{page.tsx,page.test.tsx}`
- `apps/admin/src/app/finance/{page.tsx,page.test.tsx}`

No implementation path outside `apps/admin` was changed.

## Evidence

### Tests — PASS with two explicit expected failures

Command:

```sh
PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/admin test -- --reporter=verbose
```

Actual summary (exit 0):

```text
Test Files  4 passed (4)
Tests       12 passed | 2 expected fail (14)
Duration    814ms
```

The verbose output names all approve, reject, cancel, refund, suspend, and settlement endpoint/payload/failure cases plus both known safety-gap sentinels.

### Type-check — PASS

```text
$ PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/admin type-check
> @swift/admin@0.1.0 type-check ...
> tsc --noEmit
[exit 0]
```

### Production build — PASS

```text
$ PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH pnpm --filter @swift/admin build
Creating an optimized production build ...
Compiled successfully
Generating static pages (26/26)
[exit 0]
```

The isolated offline module layout did not include ESLint, so Next printed its existing “ESLint must be installed” message but completed successfully. It also warned that multiple lockfiles caused workspace-root inference; neither warning was introduced by source code.

### Diff/scope/integrity — PASS

```text
$ git diff --check -- apps/admin
[no output; exit 0]

$ rg -n -i '(api[_-]?key|client[_-]?secret|access[_-]?token|password|bearer[[:space:]]+[A-Za-z0-9]|sk-[A-Za-z0-9])' <new test/config files>
[no output; exit 0]
```

Before this fallback report was created, `git status --short`, `git diff --name-only`, and `git ls-files --others --exclude-standard` listed only the 14 implementation paths under `apps/admin` named above. Independent review confirmed exact frontend requests against backend route schemas and reported no implementation blocker beyond the root lockfile.

## Integration sequence

1. In this worktree, stage the 14 explicit implementation paths (exclude this fallback report) and commit as `westbridge-inc <westbridge-inc@users.noreply.github.com>`.
2. Copy this report to `/Users/westbridgeinc/swift-coordination/inbox-claude/REPORT-031-admin-tests.md`.
3. In the integration owner's writable tree, regenerate the root lockfile without weakening frozen-install policy.
4. Add the admin test command to CI if WS-D D2 is intended to gate merges automatically.
5. Run `pnpm install --frozen-lockfile`, `pnpm --filter @swift/admin test`, `pnpm --filter @swift/admin type-check`, and `pnpm --filter @swift/admin build`.

</details>
