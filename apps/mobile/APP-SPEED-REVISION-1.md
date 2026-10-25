# APP-SPEED — PR #1380 revision 1

Builder: Codex GPT-6 Astra for the Swift coordinator. Builder does not merge.
Review: AX315, accepted F1–F5; original head `8898e2f254c2500b3532c12bfe889aa028a38731`.
Base merged before implementation: `d6a6ed6c50afa8f9fe09eec8aafde003ad1bea0b`;
merge commit `d5b6ab5d2f0e9e5cd2c8a75b3f7ebce53128081f`.
All revision edits are under `apps/mobile/`. No API server changes.

## Revision

| Finding | Fix | Regression | Mutation |
|---|---|---|---|
| F1, S2 | `customer/vendor`, `customer/vendors`, `customer/search`, `customer/favorites`, `market/items` have zero freshness. Cached data stays available during background fetching. The policy's 60-second allow-list contains only profile, addresses, my-rating and search-suggestions. | Five real QueryObserver remounts at age 45 seconds assert immediate cached content, exactly one background read and fresh availability afterward. | Reintroduce a 60-second store-detail window; request assertion must fail. |
| F2, S2 | QueryClient's unknown-key default is zero freshness. | Notifications and an invented future query refetch on remount inside 30 seconds while retaining their cached result. | Restore the 30-second default; both assertions must fail. |
| F3, S2 | A due reconnect intent remains registered while a request/retry chain runs. An idle cache event consumes it once. Removal or loss of active observers cancels it. | An in-flight read crosses the 10-second deadline and fails: one trailing refresh succeeds. Scope wipe and observer removal prevent revival. Existing storm/cooldown tests remain. | Drop intent while fetching; the recovery assertion must fail. Reschedule a cancelled read; cancellation assertions must fail. |
| F4, S2 | At the existing replay-401 rejection point, call existing `logoutIfCurrent(captured)`. It clears the exact rejected session/cache without ending a newer login/rotation. Profile retains cached details only for the existing transient-error classification (network/timeout, 408/429, 5xx). | Real Axios interceptor + real authStore + real QueryClient: terminal rejection clears auth/cache; replacement login and newer rotation survive; network/timeout/503 preserve auth/cache. Actual Profile TSX hides cached details for permanent 4xx and signed-out state, and retains them with Retry for transient failures. | Omit sign-out, target the latest session, sign out on all replay failures, permit permanent Profile errors, or ignore signed-out state: corresponding assertions must fail. |
| F5, S3 | Banner says “You're offline. Some things may not load until you're back online.” | Copy contract covers a cold start without any cache promise. | Restore unconditional saved-content wording; assertion must fail. |

The existing browse-freshness test now exercises all four approved non-live
families; its no-spinner/no-refetch assertions remain. The shared-request test
explicitly uses `cancelRefetch: false` when invalidating an already-running live
read, preserving the one-request assertion. No existing test was removed,
disabled or weakened by this revision to accept a failure.

## Image-cache inventory (source audit, report only)

Commands:

```sh
rg -n 'expo-image|cachePolicy|from .*kit/image' apps/mobile/src -g '*.tsx' -g '*.ts' -g '!*.test.ts'
rg -n '<Image|<ExpoImage|<Photo|<Avatar' apps/mobile/src -g '*.tsx' -g '!*.test.ts'
rg -n 'ImageBackground|\.prefetch|useImage|attachment|proofPhoto|documentUrl|selfieUrl' apps/mobile/src -g '*.tsx' -g '*.ts' -g '!*.test.ts'
```

The installed `expo-image/src/Image.types.ts:251` declares the default policy
as `disk`. Therefore direct Expo Image users without an override are included,
as well as the explicit `kit/image.tsx:23` disk wrapper. No app image prefetch
or alternate disk-policy override was found. The wrappers and direct Expo
imports span 21 source files (including the wrapper itself).

| Disk-cached surface | Evidence under `src/` | Data reaching the image |
|---|---|---|
| Catalogue cards, tiles, heroes and category pictures | `kit/food.tsx:153,241,350,406`; `kit/photo-placeholder.tsx:116`; `kit/menu-row.tsx:60` | Store/menu/item/category pictures. Consumers: Home, Market, Search, Restaurant, MenuItem, Nearby, Recommended, Favorites, CategoryFeed, Cart and OrdersHistory. |
| Shared avatar primitive | `kit/avatar.tsx:16` | Avatar URI; no current JSX consumer found by `<Avatar` scan. |
| Home and account avatars | `modules/shop/screens/HomeScreen.tsx:470`; `modules/profile/screens/ProfileScreen.tsx:236`; `PersonalDataScreen.tsx:137`; `modules/vendor/screens/VendorAccountScreen.tsx:666` | Published user/member profile avatar. |
| Trip/order/chat participant avatars | `modules/movement/screens/TaxiScreen.tsx:936`; `modules/orders/screens/DeliveryScreen.tsx:1089`; `FeedbackScreen.tsx:104,294`; `modules/chat/screens/ChatListScreen.tsx:75` | Published driver/rider avatar. Feedback's other rating block receives the store picture (`:214`). |
| Mover vehicle photo | `modules/mover/screens/MoverAccountScreen.tsx:162` | Account vehicle display photo; no verification-document URL is passed here. |
| Vendor catalogue management | `modules/vendor/screens/VendorMenuScreen.tsx:90`; `VendorInsightsScreen.tsx:163`; `VendorItemEditorScreen.tsx:458` | Item photos; editor preview is the existing item URL or selected local image. |
| Advertising | `components/ads/AdBar.tsx:108`; `AdTopCard.tsx:53`; `AdHeroVideo.tsx:101` | Served ad image/poster. This inventories image caching, not the video player's buffering. |
| Onboarding | `modules/onboarding/OnboardingScreen.tsx:71` | Onboarding slide image. |

Published profile avatars can originate from signup selfies. This is explicit
in `screens/auth/SelfieCaptureScreen.tsx:24-29,160`: the captured photo becomes
the public profile picture shown to trip participants. Those public avatars
remain disk-cached; this report does **not** claim that all selfie-derived
imagery is memory-only.

Private-image paths were traced separately:

- `components/onboarding/DocumentUploadCard.tsx:83-88,193` uploads selected
  documents (including private verification selfies); its render shows status,
  icons and text, no image or document preview.
- `modules/account/screens/IdentityVerificationScreen.tsx:44-80,116-132` holds
  uploaded ID/selfie URLs for submission but renders upload-status rows only.
- Raw camera previews in `screens/auth/SelfieCaptureScreen.tsx:72,131` and
  `modules/safety/screens/LivenessCheckScreen.tsx:65,114` use React Native Image
  with the local camera URI, not Expo Image or the disk wrapper. They reset
  local preview state on session-generation change. This is not a claim that
  the camera's temporary file itself is memory-only or immediately deleted.
- `modules/mover/screens/ActiveJobScreen.tsx:249-255,321-327,495-501` captures
  courier pickup/delivery/return proof and passes it to upload mutations. No
  image renderer consumes those proof URLs in mobile source.
- `modules/chat/screens/ConversationScreen.tsx:97-146` renders message text;
  no chat-attachment image renderer exists in the inspected mobile source.
- `modules/advertiser/screens/NewCampaignScreen.tsx:318` uses React Native
  Image for a selected local creative preview, not the shared disk wrapper.

No private remote document, raw verification selfie, delivery-proof or chat
attachment was found entering a disk-cached image surface. Accordingly no
image-cache source change was made. This is a source/data-flow inventory,
not a native filesystem inspection, server ACL verification, historical disk
purge, or guarantee about future signed-image consumers.

## Retained-tab resource observations (unchanged)

```sh
rg -n 'setInterval|setTimeout|useFocus|useIsFocused|maxPages|useInfiniteQuery|pages' apps/mobile/src/modules/shop/screens/HomeScreen.tsx apps/mobile/src/modules/shop/screens/MarketScreen.tsx apps/mobile/src/components/ads apps/mobile/src/hooks/customer.ts
```

- Home's live hold countdown registers a 1,000 ms interval while `holdRunning`
  (`HomeScreen.tsx:192-198`). Its effect has no tab-focus dependency. Home is
  retained and not frozen, so the interval can continue while another tab is
  selected until the hold ends/unmount occurs.
- AdBar registers an interval at `rotationSeconds * 1000` when it has multiple
  items (`AdBar.tsx:78-87`). Touch pauses advancement; no navigation-focus gate
  stops the timer. `useAdViewability.ts:9,55-64` measures every 500 ms when
  enabled; AdBar sets `keepMeasuring: true` (`AdBar.tsx:57`). Native hiding or
  freezing does not clean up a retained component's effect.
- `useMarketItems` (`hooks/customer.ts:222-242`) is an infinite query without
  `maxPages`; Market flattens all accumulated pages (`MarketScreen.tsx:217-220`).
  Five-minute GC applies after inactivity, not to a retained active observer.
  Smaller FlatList windows do not bound accumulated query payloads.
- Zero freshness controls eligibility for mount/reconnect revalidation; it
  does not install missing navigation-focus refreshes on retained screens.
  Existing focus refresh gaps were identified as pre-existing by AX315 and
  were not expanded into this revision.

These interval/page counts are measured from source, not battery/heap/FPS
measurements. No timer or pagination change was made, per the ruling.

## Evidence and gates

All Node commands use `/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin`
first on PATH and existing dependency symlinks. Disk before the full suite:
`df -h /System/Volumes/Data` reported 18 GiB available (92% used).

Exact-old-source replay is built by `scripts/prove-appspeed-mutations.py`:
new tests with the five affected production files read via
`git show 8898e2f2:apps/mobile/<path>` into an isolated temporary snapshot.
All old sources are restored in `finally`; no worktree production source is
mutated. `-t 'F[1-5]:'` selects the revision probes only.

```text
OLD-8898e2f2-F1-F5:
Test Files 4 failed (4)
Tests 13 failed | 14 passed | 29 skipped (56)
```

The 29 tests are deselected by the focused name filter, not disabled tests.
Every finding has an assertion failure on the exact original source.

`python3 scripts/prove-appspeed-mutations.py` completed with exit 0. The final
snapshot and per-probe logs are `/private/tmp/appspeed-mutations-1pbngd7h/`.
All 16 mutants were landed, assertion-killed and restored; the restored suite
passed **62/62 tests in 5/5 files**. No unhandled errors were accepted. An early
probe exposed overlapping dynamic native mocks during the replacement-session
test; the harness now awaits A's mocked teardown before delivering A's late
replay rejection to the already-installed B session. The final run is clean.

| Mutant | Failing tests / total tests |
|---|---:|
| scope-wipe | 1 / 6 |
| critical-freshness | 24 / 34 |
| reconnect-storm | 2 / 34 |
| profile-cache | 4 / 12 |
| offline-mutation-queue | 1 / 34 |
| F1-availability | 1 / 34 |
| F2-default-live | 2 / 34 |
| F3-lost-intent | 1 / 34 |
| F3-cancel-revival | 4 / 34 |
| F4-terminal-signout | 1 / 6 |
| F4-exact-session | 2 / 6 |
| F4-recoverable-session | 3 / 6 |
| F4-profile-rejection | 3 / 12 |
| F4-profile-signedout | 1 / 12 |
| F5-offline-copy | 1 / 4 |
| reviewed-allowlist | 4 / 34 |

Full local mobile suite, from `apps/mobile`:

```text
/Users/westbridgeinc/swift-coordination/scripts/heavy.sh ./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2
Test Files 204 passed (204)
Tests 1852 passed (1852)
exit 0
```

Types, from `apps/mobile`:

```text
/Users/westbridgeinc/swift-coordination/scripts/heavy.sh ./node_modules/.bin/tsc --noEmit -p tsconfig.json
[heavy.sh] slot 1 acquired after 45s
exit 0; no TypeScript diagnostics
```

ESLint uses `/Users/westbridgeinc/swift-donor-main-14deaff5/node_modules/.bin/eslint`
from `apps/mobile`, with the 24 existing TS/TSX paths changed in the PR plus
revision (merge-base diff, working-tree diff and untracked test). Result:
exit 0, no errors or warnings. `git diff --check`: exit 0.

Main advanced during local verification. The recorded local base is the
requested `d6a6ed6c`; GitHub will test the pushed head against its current PR
base. Exact-head CI and the gated-push result are recorded in the PR body,
which can be updated without a documentation-only commit moving the head.

## Verification limits

No real low-end Android, weak-network session, native tab latency, heap,
battery, decoded-image memory, native disk cache, server response/ACL, or
device/simulator test was performed. These remain UNVERIFIED. No production,
staging, database, credentials or customer data were accessed. Independent
review of the revision belongs to the coordinator; local read-only delegation
could not start because the collaboration tool reported a missing thread.
