# WEB-PARITY-B evidence

Scope: `apps/web` only, branch `feat/web-parity-cart-docs-info`, builder Westbridge / Codex GPT-6 Astra. No merge or deployment.

## Result and limits

- Mixed saved carts render groups from each item's `vendorId`, with names from the API's `vendors[]`. Each group has an explicit removal action. Choosing checkout explains that the other stores must first be removed; no items are silently removed or stored in a second client-side cart.
- The existing checkout may run after one verified store remains. Missing or stale store identity keeps checkout blocked. Checkout payloads, price/fee formulas, replay keys and server authority are unchanged.
- Cart-page errors use customer language; stable API error codes retain actionable stock, identity, account, address and minimum-order guidance.
- Profile, Help and earner Account show company/contact facts from `site.config.ts`, legal links and the actual web package version. The current phone source has contact/legal links but no About/version screen; its configured native version is not presented as a web version.
- Signup and the owner dashboard fetch role requirements from the phone's verification API. Bicycle is a distinct signup vehicle and has no car-detail fields. Driver agreement acceptance is explicit before provisioning. The earner portal uses the server's saved-vehicle checklist and keeps its existing upload endpoints. Store staff are directed to the owner. Standalone service-provider requirements use `SERVICE_PROVIDER` and explain unavailable trade requirements.
- Scope verification found **22 changed paths, 0 outside apps/web, 0 overlaps with PR #1377/#1378/#1370, 0 new app routes**. No route classification changes. No files changed from the inspected path lists of PRs #1377, #1378 or #1370, or the customer shell/session/account/home files assigned to WEB-PARITY-A.

## API capability gaps — coordinator work required

1. **Selected-store checkout preserving other stores is unavailable.** `apps/api/src/modules/user/customer.routes.ts:139` and `:175` accept fulfillment/express/tip choices, but no store subset. `apps/api/src/modules/order/order.service.ts:693` consumes every saved item; `:1442` deletes the complete cart. The mobile CartScreen also renders aggregate checkout with per-store fee rows (`apps/mobile/src/modules/cart/screens/CartScreen.tsx:924,977`), despite the single-store assumption documented in `kit/cart-bar.tsx:43`. Inventing a `vendorId` request field would not safely scope checkout. This PR does not claim to supply that missing capability.
2. **Removing the last-added store leaves stale store metadata.** `customer.routes.ts:1925` removes items without retargeting `cart.vendorId`; address validation at `:1972` still uses it. Web blocks this state and provides a store link and plain recovery instructions. There is no safe read-only retarget endpoint; hidden add/remove reconstruction was not introduced.
3. **The checklist is authenticated.** It is available after account registration, before partner provisioning. There is no public pre-registration checklist endpoint. `SERVICE_PROVIDER` additionally needs the saved trade; no new standalone service-provider onboarding API/flow was added.
4. **Storefront checkout copy remains in PR #1377's excluded component.** Read-only audit of `apps/web/src/components/storefront/storefront-experience.tsx` found technical strings at lines 424, 609, 623, 633, 645, 654, 1023 and 1025, plus raw caught errors. Coordinator must apply the same plain-language policy there. The mutation-proven census in this PR covers the cart page and its new error presenter, not an asserted whole-app clean census.

## Verification record

Commands run with `/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin` first in PATH and existing symlinked dependencies; no install.

- Targeted initial run: `vitest run --config vitest.comb.config.ts --maxWorkers=2` with cart grouping, copy, partner parity, signup documents, checkout path and store-pin tests: **47 passed, 3 failed**. The three failures were existing map tests whose blanket API fixture lacked the new verification response. The fixture now returns an authentic checklist response, and all original map assertions remain.
- Store-pin rerun: **1 file / 18 tests passed**.
- `vitest run --config vitest.comb.config.ts --maxWorkers=2 src/lib/cart-copy.test.ts src/components/partner-parity.test.tsx src/app/signup/documents.test.tsx src/lib/money.test.ts`: **4 files / 70 tests passed**.
- Cart grouping and copy rerun, including a real-code identity refusal/recovery fixture: **2 files / 19 tests passed**.
- `heavy.sh ./node_modules/.bin/tsc --noEmit --incremental false -p apps/web/tsconfig.json`: **exit 0**, output `[heavy.sh] slot 1 acquired after 375s`.
- Targeted `next lint --file ...` over all changed TypeScript files: **exit 0**, `No ESLint warnings or errors`.
- First `SWIFT_WEB_CHANNEL=staging NEXT_PUBLIC_API_URL=https://api-staging.swiftgy.com API_URL=https://api-staging.swiftgy.com heavy.sh next build`: **exit 0**, 53 static pages generated. A named JSON import warning was corrected to a default import for the final build. Workspace-root/multiple-lockfile warning is pre-existing.
- Read-only GETs using `curl --silent --show-error --max-time 20 --output /dev/null --write-out ...` returned **HTTP 200** for both `https://api-staging.swiftgy.com/legal/vendor-agreement` and `/legal/driver-agreement`.
- `git diff --check`: **exit 0**, no output.

- First full suite: `heavy.sh ./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2`: **58 files passed / 1 failed; 681 tests passed / 1 failed**. Failure was the duplicate FAQ link added to Help. Removed the duplicate link; the existing test was not changed. A separate vendor-agreement assertion was also added before the final run.
- `node scripts/prove-parity-mutations.mjs`: **exit 0; 4/4 mutants killed; all restored tests passed**. Actual failure evidence:

```text
KILLED: mixed-store grouping
FAIL ... groups the screenshot items by their actual store and hides the combined checkout
Unable to find role="region" and name "First Store"
RESTORED: mixed-store grouping 8e8e5c072c2555f1ed9753aa1169e2c3cf78ed69456d5e9de558efea4d18bc7a
KILLED: plain-language census
FAIL ... src/app/(app)/cart/page.tsx has no technical customer strings
AssertionError: expected [ Array(1) ] to deeply equal []
RESTORED: plain-language census 1215d26804b865efb3390f419b386016d364ed3123971f7f9897dbb7c1630870
KILLED: bicycle checklist request
FAIL ... requests the canonical MOVER / BICYCLE requirements
Unable to find role="listitem"
RESTORED: bicycle checklist request c974557bad50e863aaa76f2ca8cd7bd7aa849574312600b9ac1dff9673627199
KILLED: company address rendering
FAIL ... renders company, contact, legal and actual web version details
RESTORED: company address rendering e4fdffebdd10b1e452723ff65f1c200fdb8058a00b0d24794e41a01f8f28bc1a
```

- `git fetch origin main` followed by `git merge origin/main`: **Already up to date.** Base `bd2f93ac173101603dcc9d87609898660446054b`.
- Portable fresh-checkout proof config: `vitest run --config vitest.parity.config.ts --maxWorkers=2 src/lib/cart-copy.test.ts`: **1 file / 13 tests passed**, exit 0.
- Main branch protection read through `gh api .../branches/main/protection/required_status_checks`: **12 required checks**: API Build, API Tests, Admin Build, Desktop Build (TS), Lint & Type Check, Migration Replay, Secret Scan, Security Scan, Web Build, Public Env Gate, UI Barrier, Mobile Bundle Gate.

- Account/signup correction rerun: `vitest run --config vitest.comb.config.ts --maxWorkers=2 src/components/account/account.test.tsx src/app/signup/store-pin.test.tsx`: **2 files / 61 tests passed**, exit 0.

- Final `SWIFT_WEB_CHANNEL=staging NEXT_PUBLIC_API_URL=https://api-staging.swiftgy.com API_URL=https://api-staging.swiftgy.com heavy.sh ./node_modules/.bin/next build`: **exit 0**. Actual output: `[heavy.sh] slot 1 acquired after 530s`; `Compiled successfully in 7.4s`; `Linting and checking validity of types`; `Generating static pages (53/53)`. Only the pre-existing workspace-root/multiple-lockfile warning remains. `apps/web/.next` was removed after completion as requested.
- Exact implementation commit `75f9a298dbde73693433a3dc211750d498aea704`: **3/3 independent bounded source/proof reviews APPROVE**, 0 unresolved findings. Cart reviewer confirmed unchanged money formulas/payload/replay protection; docs reviewer confirmed agreement, owner scope and provisioning fixes; proof reviewer confirmed both mutation runner/config are committed.

- Final `heavy.sh ./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2`: **exit 0; 59/59 files, 683/683 tests passed**. Actual output:

```text
[heavy.sh] slot 0 acquired after 585s
Test Files  59 passed (59)
     Tests  683 passed (683)
  Duration  19.91s
```

Local gates: full web suite, standalone typecheck, final build (including lint/type validation), targeted lint, 4/4 mutation proofs, diff hygiene and 3/3 independent reviews passed. No migration or database change; no database integration run required. GitHub required checks are recorded on the PR after push; the builder never merges.

## Review reconciliation

Three independent read-only subagents reviewed cart changes, document changes and test/mutation evidence. All six S2 implementation/proof findings were fixed and source-rechecked: preserved money-test guards with new copy, actual checkout error-code guidance, API-hosted agreement URLs, owner-only store checklist no upload link before vehicle provisioning, and a tracked portable mutation-runner configuration for fresh checkouts. No remaining blocking implementation finding in their bounded source reviews. API/cross-lane limitations above remain explicit.

No real account, document upload, order placement, phone simulator, database, live customer data, production system or deployment was accessed. Installed-iPhone/PWA interaction and authenticated staging checklist/order behavior remain UNVERIFIED. No merge was attempted.
