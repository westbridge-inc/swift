# Web performance evidence — 2026-09-29

Baseline: `bd2f93ac173101603dcc9d87609898660446054b`. WEB-PERF is the sole writer of this worktree. Only `apps/web` changes; no API, pricing arithmetic, service worker, or infrastructure changes. No new URLs.

## Read-only staging measurements

Command for each sample (three fresh curl processes, no credentials):

```sh
curl --silent --show-error --max-time 20 --compressed -o /dev/null \
  -w 'status=%{http_code} http=%{http_version} ttfb=%{time_starttransfer} total=%{time_total} bytes=%{size_download}\n' URL
```

All samples returned HTTP 200 over HTTP/2. These are observations from this machine, not iPhone/4G measurements. This branch has not been deployed, so they are baseline network observations, not a deployed before/after speed claim.

| Public GET | TTFB samples (seconds) | Download bytes with `--compressed` |
| --- | --- | ---: |
| API `/health` | .512828 / .380788 / .390055 | 59 |
| API `/api/v1/market/depth` | .394082 / .328662 / .391945 | 105 |
| API `/api/v1/discovery/categories` | .385859 / .391671 / .333550 | 57 |
| API `/api/v1/market/items` | .452494 / .370213 / .360968 | 855 |
| API `/api/v1/public/storefronts` | .335292 / .364539 / .393582 | 531 |
| Website `/` | .602156 / .381089 / .407817 | 13,027 |
| Website public store, one sample | .389349 | 14,674 |

A referenced content-hashed static CSS asset returned `public, max-age=31536000, immutable`, gzip, HTTP/2, 9,098 transferred bytes. No HTTP caching changes are needed in this branch.

Header GETs (`curl --compressed -D - -o /dev/null`) found `content-encoding: gzip` on Home and store HTML, HTTP/2 on both hosts, and `cache-control: private, no-cache, no-store, max-age=0, must-revalidate` on the store page. Market depth reported `visible: true`, 27 items, one vendor. The measured discovery response had no categories.

## Request census: source and tested behavior

`→` means dependent requests; `||` means independent concurrent requests. Cookie-based private reads are never made during these public measurements. Their sequence is established by source and synthetic tests.

| Surface | Before | After / repeated navigation |
| --- | --- | --- |
| Home `/` | Shell `auth/me || market/depth || customer/home`; signed-in `me → addresses → home?lat/lng`. Home returns to its epoch/location cache (default five-second stale window); addresses reuse 60 seconds. | Unchanged feed/address behavior and cache. Shell depth observer now follows page hydration in React render order. |
| Public store `/store/[slug]` | Server `public/storefronts/:slug` for metadata/page (Next request memoization); browser `public/storefronts/:slug || customer/vendors/:id || auth/me`; confirmed identity → `cart || addresses`. Catalogue refresh every 30 seconds. | Unchanged: storefront lane owns this live commerce surface. Navigating outside the app shell creates its own session/cart reads. |
| Ordering store `/order/vendor/[id]` | `customer/vendors/:id` concurrent with shell public reads, default five-second query freshness. Appointment slots only when booking opens. | Unchanged; no menu price cache extension. |
| Market `/market` | Browser `depth → (categories || items)`, two browser API phases after hydration. Shell/page deduplicate depth. | Server `depth || categories`, then depth-visible → items (does not await categories). Default catalogue is in HTML; zero duplicate browser Market reads on fresh hydration (test). Persistent layout; focus/hover prepares one category query, ordinary category clicks consume it through native history. Direct filtered links still fetch their filtered items in the browser. |
| Search `/order/search` | 300 ms debounce → `customer/vendors?search=...`; local component state discarded on navigation, repeated query fetched again. | Same debounce, React Query keyed by checking/signed-in/guest status, principal, epoch, and exact trimmed term. Repeating same query within 30 seconds: two GETs → one. Late answers cannot replace current query/identity. |
| Cart `/cart` | Shell identity → `cart || addresses` → public storefront → public rich vendor menu. Mutations and final checkout revalidate server quotes. | Unchanged; cart lane owns these files. No cached checkout proof introduced. |
| Orders `/orders` | Identity → scoped orders query, five-second global freshness. Cached rows could show old status during refresh. | Same scoped list, staleTime zero on entry; active tab polls every 15 seconds. Cached row geometry remains but status/amount are marked checking/unavailable until the server answers. No amount computation changed. |
| Account `/account` | Identity → profile. Account → settings → Account repeats profile (three HTTP GETs); profile and consent already parallel in settings. | Profile uses an in-memory React Query cache scoped to auth principal and epoch, stale 60 seconds, GC five minutes. Three navigation reads → one HTTP GET. Successful PUT updates the same session cache and supersedes older GETs. Auth changes clear it synchronously. Other account reads remain live. |
| Explore `/explore` | Entire page is a client component; vendor GET on every mount. | Static content/icons rendered on server; only the live rail hydrates, one scoped five-second query after identity settles. |

Source anchors: `src/app/(app)/layout.tsx`, `src/components/customer-home.tsx`, `src/components/storefront/storefront-page.tsx`, `src/components/storefront/storefront-experience.tsx`, each named route page, `src/lib/customer.ts`, `src/components/account/account-frame.tsx` and `account-api.ts`. No personal response is serialized by Market: its server reads omit credentials, use `no-store`, time out after three seconds per request, and construct a new QueryClient for every render. Failure leaves the existing browser retry UI in charge. Items are never requested for a closed/unknown depth verdict.

## Images and fonts

Read-only public GETs parsed in memory found **zero populated image/logo fields** in Home, Market items, storefront list and search. Decoded JSON sizes were Home 9,588 bytes, Market items 5,258, storefront list 2,187, search 2,194. Therefore remote photo format/dimensions/transfer savings are unverified, not assumed.

Existing Home popular slots are 160/176 px wide; vendor cards use 264 px desktop / 30vw tablet / 46vw phone; ordering-store items use 80 px and its cover reserves 176/224 px height. These use Next Image with explicit geometry and lazy loading below the fold (ordering-store cover is priority), but `unoptimized` transfers the original source. Storefront image work is owned by #1377. No arbitrary-host image optimizer or undocumented image URL transform is added. Local icon measurements: `icon-192.png` is 192×192, 5,736 bytes; Apple icon is 180×180, 5,375 bytes. Font source audit found no web font download or `@font-face`: CSS uses the configured family with system fallback, so there is no late-loaded font swap. Preserve the current look.

## Build and checks

Baseline command (through the machine-wide semaphore):

```sh
export PATH=/Users/westbridgeinc/.nvm/versions/node/v20.19.6/bin:$PATH
NEXT_TELEMETRY_DISABLED=1 SWIFT_WEB_CHANNEL=staging \
NEXT_PUBLIC_API_URL=https://api-staging.swiftgy.com \
/Users/westbridgeinc/swift-coordination/scripts/heavy.sh ./node_modules/.bin/next build
```

Actual baseline result: exit 0, compiled in 13.0 seconds, generated 53/53 static pages. Build output reports Next 15.5.25. `.next` is removed after each build. Final build sizes and gate counts are recorded in the PR body.

| Route | Before route JS | Before first-load JS |
| --- | ---: | ---: |
| Home | 7.88 kB | 136 kB |
| Public store | 15.5 kB | 131 kB |
| Ordering store | 6.27 kB | 135 kB |
| Market | 5.66 kB | 134 kB |
| Search | 3.44 kB | 119 kB |
| Cart | 9.27 kB | 120 kB |
| Orders | 2.3 kB | 121 kB |
| Account | 4.87 kB | 125 kB |
| Explore | 5.14 kB | 121 kB |

Focused existing tests: four files, 53 tests passed. New behavior tests cover SSR HTML, shell hydration, request overlap, depth gates, hover/focus deduplication, connection constraints, search debounce/races/reuse, profile navigation/isolation/save races, and non-final cached order status. Full suite/build/type-check and mutation outcomes are appended after execution.

## Conservative infrastructure recommendation for coordinator

HTTP/2 and gzip were already observed: verify existing Caddy settings before changing anything. If trialing Cloudflare proxy/CDN for staging, restrict cache rules to content-hashed `/_next/static/*` assets, preserving their immutable headers. Do not cache HTML, RSC, `/api`, auth, or the service worker; do not enable a broad Cache Everything rule. Confirm negotiated HTTP/2, compression and upstream/browser keep-alive reuse from Guyana. Compare waterfall/TTFB before and after, and roll back by disabling the single static-assets rule or proxy. No configuration was changed here.

Unverified: real iPhone over Guyana 4G, post-deployment timing, populated remote image bytes, Cloudflare benefit, and every production property. No production access, server access, or credential reads were performed.

## Mutation / old-code proof

Each replacement was temporary, ran the focused behavioral test file, and was restored in `finally`. Production source was restored before final gates. Command: `./node_modules/.bin/vitest run --config vitest.comb.config.ts --maxWorkers=2 TEST_FILE`. Every case below exited 1 (expected red); no tests were weakened.

```text
old-profile-api: exit 1; Test Files  1 failed (1) | Tests  1 failed | 5 passed (6) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/components/cache-performance.test.tsx > per-person reuse without changing live money reads > reuses Account profile in settings and returns the saved server response to Account
old-search: exit 1; Test Files  1 failed (1) | Tests  1 failed | 5 passed (6) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/components/cache-performance.test.tsx > per-person reuse without changing live money reads > reuses a repeated search within its person, then hides old results and late responses on account change
old-orders: exit 1; Test Files  1 failed (1) | Tests  1 failed | 5 passed (6) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/components/cache-performance.test.tsx > per-person reuse without changing live money reads > rechecks cached orders immediately and does not present the old price or status as final
serial-market: exit 1; Test Files  1 failed (1) | Tests  1 failed | 6 passed (7) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/lib/market-performance.test.tsx > Market request phases and server rendering > starts categories and depth together; items require depth but never wait for categories
old-shell-hydration: exit 1; Test Files  1 failed (1) | Tests  2 failed | 5 passed (7) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/lib/market-performance.test.tsx > Market request phases and server rendering > renders a populated public catalogue in the server HTML without a browser fetch waterfall | FAIL  src/lib/market-performance.test.tsx > Market request phases and server rendering > hydrates page and parent shell without duplicate market reads
no-session-reset: exit 1; Test Files  1 failed (1) | Tests  3 failed | 2 passed (5) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 3 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/lib/session-profile-cache.test.ts > deduplicates concurrent reads and reuses only the current session profile | FAIL  src/lib/session-profile-cache.test.ts > an old session write cannot seed the profile cache after signing back in as the same person | FAIL  src/lib/session-profile-cache.test.ts > a delayed read resolves the successful write, with prior cache false
no-connection-guard: exit 1; Test Files  1 failed (1) | Tests  1 failed | 6 passed (7) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/lib/market-performance.test.tsx > Market request phases and server rendering > does not prefetch on offline, save-data or 2G connections
no-save-reconciliation: exit 1; Test Files  1 failed (1) | Tests  2 failed | 3 passed (5) | ⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯ | FAIL  src/lib/session-profile-cache.test.ts > a delayed read resolves the successful write, with prior cache false | FAIL  src/lib/session-profile-cache.test.ts > a delayed read resolves the successful write, with prior cache true
```
