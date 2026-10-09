# MMG weekly-fee checkout: the API contract

This is the contract the phone app and the web build against. The API side shipped in two PRs of the MMG checkout series:
- **PR 2:** the checkout intent, verification with MMG, and crediting (`mmg-checkout.service.ts`).
- **PR 3:** the routes below and `payActions` (`mmg-checkout.routes.ts`).

A payload from an API older than PR 3 has no `payActions`. Treat an absent `payActions` as "no way to pay in the app".

The wire format to MMG is in `providers/mmg/CHECKOUT-CONTRACT.md`. It never reaches a client.

## 0. Rules every client follows

1. **The server decides everything:**
   - which ways to pay exist;
   - how much;
   - whether a payment happened.

   Clients render server state. They never compute an amount, never infer "paid" from a redirect or a browser result, and never offer a new payment method that is not in `payActions`. Reopening the same MMG checkout uses only the separate server grant below.
2. **Partners are never offered a payment at an MMG agent, in cash, by Swift Number or by account number.** The subscription payload still carries `san`, `sanFormatted`, `payCashSteps` and `activationCopy` for app builds already in people's hands. **Do not render them.** They will be removed once the new app has shipped.
3. **Nothing is credited until MMG confirms it.** A fee is credited only after MMG's own transaction records (the merchant lookup API) confirm the exact amount, the currency (GYD) and that the money went to Swift's merchant account. A redirect, a reply token or the app's word never credits anything.
4. **Hidden, never teased.** A method whose state is `off` is not shown at all: no disabled button, no "coming soon".

## 1. Route families

| Partner | Family | Who may call |
|---|---|---|
| Store owner (restaurant, supermarket, store) and service provider | `/api/v1/vendor` | the store's OWNER; `x-vendor-id` selects the store |
| Delivery rider and courier | `/api/v1/rider` | the rider |
| Taxi driver | `/api/v1/driver` | the driver |

Below, `{family}` means one of `vendor`, `rider` or `driver`. The same routes and shapes apply to all three.

## 2. Headers

| Header | Where | Value |
|---|---|---|
| `Authorization` | every partner route | `Bearer <access token>` |
| `x-client-platform` | every partner route below (**required**) | `ios`, `android` or `web` |
| `x-vendor-id` | vendor routes | the selected store's id |
| `Idempotency-Key` | `POST …/mmg-checkout` only | 8–128 characters from `[A-Za-z0-9_-]`, new per tap |

**The web signs in with its existing session.** Every partner route accepts either `Authorization: Bearer …` or, from the web, the browser session. For the browser session, send the HttpOnly `swift_at` cookie with `credentials: 'include'`, plus `x-swift-client: web`, from an allowed origin (`CORS_ORIGIN`). The header and origin gate is the CSRF defence. This is the same `app.authenticate` every other partner route uses.

**`x-client-platform`.** The server has a per-platform switch for the MMG checkout. A missing or unknown value counts as "unknown": the checkout is then offered only if it is switched on for every platform.

**`Idempotency-Key`.** Generate one key when the partner taps Pay. Reuse it for any retry of that same tap, for example after a network failure.

## 3. The subscription payload

`GET /api/v1/{family}/subscription` keeps every field it has today. The checkout fields below are additive.

```ts
type SubscriptionFee = {
  // ... every existing field (status, weeklyRate, currentPeriodEnd, nextBillingDate,
  //     gracePeriodEnd, isTrialActive, trialEndDate, weeklyFeeGyd, walletBalanceGyd,
  //     amountDueGyd, ...) unchanged.
  payActions: PayAction[];                  // every known method, in display order
  latestMmgCheckout: CheckoutStatus | null; // the newest checkout of the last 24 h, to resume after a restart
  reopenableMmgCheckout: { ref: string; expiresAt: string } | null; // additive; the same page only
  recentCheckouts: CheckoutStatus[];        // the last 10 checkouts, newest first
};

type PayAction =
  | { id: 'MMG_CHECKOUT'; state: 'live'; amountGyd: number; currencyCode: 'GYD' }
  | { id: 'MMG_CHECKOUT'; state: 'off' }
  | { id: 'CARD'; state: 'off' };
```

`latestMmgCheckout` and every entry of `recentCheckouts` is a `CheckoutStatus` (section 5), so each carries the partner's receipt references: `swiftReference` always, and `mmgTransactionId` once the checkout is `CONFIRMED`. Show both under "Recent checkouts", worded "Swift reference" and "MMG transaction ID" (section 5, "The receipt").

### When `MMG_CHECKOUT` is `live`

It is `live` only when **all** of these hold:
- the server's MMG checkout is configured and valid (`MMG_CHECKOUT_ENABLED=1` with complete credentials, which the boot guard already checks);
- the platform switch allows the caller's platform (section 2);
- the subscription can be paid: `TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED` or `CHURNED` (paying rejoins), and its fee is not waived;
- none of this fee's payments is being confirmed: no MMG checkout that is open, confirming, held or expired without an answer, and no card payment that is pending, awaiting 3-D Secure or unclear (the same pause that refuses a new page with `409 PAYMENT_CONFIRMING`, section 4). While a checkout is open or confirming, `latestMmgCheckout` carries it: follow its status from there. Only `reopenableMmgCheckout` grants a button back to that same page;
- the billing confirmation clock covers the subscription (the billing cutover maps every subscription; one it has not mapped yet stays `off` until it has, and reading the payload never maps one);
- the partner is in a production tenant: a store-review demo account never opens a real MMG page.

It is `off` for `PAUSED` (weekly billing stopped: resume first), `CANCELLED`, waived fees and store-review demo accounts, and while a payment is being confirmed.

### Reopen the partner's own checkout (additive)

`MMG_CHECKOUT` remains `off` while an OPEN checkout pauses fee collection. A
separate `reopenableMmgCheckout` may carry only its opaque `ref` and ISO
`expiresAt`, never the page URL. Older clients can ignore this addition; older
APIs omit it, which grants no reopen action.

The grant exists only for this subscription's latest checkout, still `OPEN`
and strictly before its deadline. Its `ACTIVE` hold must be the only active
confirmation hold on the covered billing clock, in the current epoch. Missing
or stale fee authority, another unresolved checkout or payment (including
`CONFIRMING`/`HELD` and pending card payments), a non-production payer, or a
configuration/platform kill switch removes the grant. Reading takes no hold
and changes no payment.

With this grant, phone relaunch and web reload show **Back to MMG's page** and
**expires at HH:MM (Guyana time)**. The button calls the existing start route
with a new `Idempotency-Key`. The server binds it to the same OPEN checkout and
repeats its locked authority checks before returning the same page URL; no
second checkout or hold is created. Clients never retain that URL.

After expiry without an MMG answer, hide Pay and Back: **This checkout expired.
We're checking this payment with MMG. Don't pay again. Support will help.**
Refresh status remains available. Expiry is no proof of non-payment, releases
no hold, and permits no retry payment.

UAT remains to confirm whether MMG accepts opening the same checkout token
twice. The existing server reuse behavior does not establish that provider fact.

### `amountGyd`

`amountGyd` is exactly what `POST …/mmg-checkout` will charge right now:
- the amount due, rounded **up** to whole GYD (MMG takes whole dollars); any part of a dollar above the amount due is kept as credit;
- when nothing is due, one week's fee, kept as credit toward the next bill.

Button label: `Pay GY$<amountGyd, grouped> with MMG`.

### `CARD`

`CARD` stays `off` until the card rail exists (PT-4).

## 4. Start a checkout

`POST /api/v1/{family}/subscription/mmg-checkout`

The body is `{}`. The server prices the checkout; a client amount would be ignored.

**Success:** `201` for a new checkout; `200` when an open checkout is handed back again.

```ts
{ success: true, data: {
  ref: string;            // opaque; keep it and poll with it
  status: 'OPEN' | CheckoutStatus['status']; // OPEN, except on a key replay (see checkoutUrl)
  checkoutUrl: string | null; // the MMG page; open it in the in-app browser; never log, store or share it.
                          // null only when the same Idempotency-Key replays a checkout that is no longer OPEN:
                          // the page is never handed out twice. Follow `ref` instead (section 5).
  amountGyd: number;
  currencyCode: 'GYD';
  expiresAt: string;      // ISO time; after it, this checkout cannot be started on MMG
} }
```

**One open checkout per subscription.**
- If one is `OPEN` and not expired, it comes back (`200`) with the same `ref` and `checkoutUrl`.
- The same `Idempotency-Key` always gets the same answer. A key answered with a checkout (a new one, one handed back, or one it was refused for because it is `CONFIRMING`) stays bound to that checkout: a retry gets that checkout as it stands now, never a new one. The same key for another subscription is `409 IDEMPOTENCY_KEY_REUSED`.
- If a checkout is `CONFIRMING`, a new one is refused so the partner cannot pay twice.
- While any weekly-fee payment is still being confirmed (an MMG checkout that is open, confirming, held or expired without an answer, or a card payment that is pending, awaiting 3-D Secure or unclear), no new MMG page is issued: `409 PAYMENT_CONFIRMING`. Reminders and suspension are paused for the same time. An expired page with no answer from MMG stays a confirmation until MMG answers "not paid" or a person confirms it.

**The phone flow:**

```
POST …/mmg-checkout                      → { ref, checkoutUrl }
WebBrowser.openAuthSessionAsync(checkoutUrl, 'swift://pay/mmg/return')
// whatever the browser result (success, cancel, dismiss):
poll GET …/mmg-checkout/{ref}            → section 5
```

**The web flow:** open `checkoutUrl` in the same tab. MMG sends the partner back to the return page (section 6), which links back to the dashboard.

| Status | Code | Meaning | What the client does |
|---|---|---|---|
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | the header is missing or malformed | send a key |
| 401 | (existing auth codes) | not signed in, or the token expired | the usual refresh or sign-in |
| 403 | (existing role codes) | not this store's owner | hide Pay |
| 404 | `SUBSCRIPTION_NOT_FOUND` | no subscription | refetch |
| 409 | `PAY_ACTION_OFF` | the MMG checkout is not live for this subscription or platform (or the account is a store-review demo) | refetch the subscription, hide the button |
| 409 | `IDEMPOTENCY_KEY_REUSED` | the key was used for a different request | new tap, new key |
| 409 | `CHECKOUT_CONFIRMING` | an earlier checkout is being confirmed; `error.details.ref` names it | show that checkout (section 5); do not start another |
| 409 | `PAYMENT_CONFIRMING` | another weekly-fee payment (any checkout or card payment) is being confirmed; `error.details.ref` is optional: it names a checkout only when the server knows which one, so never rely on it | "We're confirming a payment. Don't pay again."; refetch the subscription |
| 409 | `PAYMENT_QUOTE_CHANGED` | the fee, the wallet or the owed week changed while the page was being prepared | refetch the subscription, then let the partner tap again |
| 429 | `RATE_LIMITED` | too many attempts | wait and retry |
| 503 | `MMG_CHECKOUT_UNAVAILABLE` | the checkout could not be built or stored safely right now | "Try again in a minute." |

The error body is always `{ success: false, error: { code, message, details? } }`.

## 5. Follow a checkout

`GET /api/v1/{family}/subscription/mmg-checkout/{ref}`

```ts
{ success: true, data: CheckoutStatus }

type CheckoutStatus = {
  ref: string;
  status: 'OPEN' | 'CONFIRMING' | 'CONFIRMED' | 'NOT_PAID' | 'EXPIRED' | 'HELD';
  amountGyd: number;
  currencyCode: 'GYD';
  createdAt: string;
  expiresAt: string;
  confirmedAt: string | null;            // set when CONFIRMED
  subscriptionStatus: SubscriptionStatus; // the subscription now, so the screen updates in place
  swiftReference: string;                // ours: the merchantTransactionId MMG was sent (18 digits). Always.
  mmgTransactionId: string | null;       // MMG's transaction, only when CONFIRMED; null otherwise
};
```

### The receipt

Every checkout carries the two references a partner can quote to support, who finds the payment by either one (section 11):
- `swiftReference`, worded "Swift reference": always.
- `mmgTransactionId`, worded "MMG transaction ID": only once the checkout is `CONFIRMED`. A transaction an MMG reply merely named (a `CONFIRMING` or `HELD` checkout) is never sent: it is a lead for a person, not a receipt, and showing it would read as "paid".

An API older than this sends neither: show nothing in their place.

`404 CHECKOUT_NOT_FOUND` is the one answer for an unknown `ref` and for another partner's `ref`.

### Polling

- After the browser closes, poll every 3 s for 1 minute, then every 15 s for 10 minutes, then stop.
- Stop early at `CONFIRMED`, `NOT_PAID` or `HELD`.
- `EXPIRED` is not final for money, because a late MMG confirmation is still credited. Refresh it quietly when the screen gains focus.
- A push notification of kind `billing_mmg_checkout` arrives when a checkout reaches `CONFIRMED`, `NOT_PAID` or `HELD`. Its data is `{ subscriptionId, ref, status, vendorId? }`.
  - Route it to the weekly-fee screen.
  - `vendorId` is present only when a store pays. Select that store (`x-vendor-id`) before opening the screen.
  - If the owner can no longer open that store (`403` or `404`), open the fee screen of the store currently selected.

### What each state means, and the words the app may use

| Status | Meaning | The app may say |
|---|---|---|
| `OPEN` | created; the partner has not finished on the MMG page, or MMG has not told Swift yet | "Finish paying on the MMG page." After returning: "Waiting for MMG…" |
| `CONFIRMING` | MMG sent the partner back; Swift is checking with MMG | "Confirming your payment with MMG. Don't pay again." |
| `CONFIRMED` | MMG answered success for this checkout and its records confirm the payment (the six conditions below), and the fee is credited | "Paid: GY$X received on <date>." |
| `NOT_PAID` | MMG answered for this checkout that it was not paid (result 1, 2 or 6; 7 when MMG declines the transaction it named), or MMG's own record for this checkout shows the payment did not complete. Never a return path or a missing record alone | "MMG didn't complete this payment. You can try again." |
| `EXPIRED` | the checkout ran out of time, or MMG never confirmed it within a day; no failure is declared | "This checkout expired. We're checking this payment with MMG. Don't pay again. Support will help." |
| `HELD` | MMG's records show a payment that cannot be confirmed automatically: a condition below fails (status word, amount, currency, merchant, time, a number already credited), the server is not configured to read MMG's payment time (condition 5), MMG never answered success for it, or MMG's answers for this checkout disagree; a person reviews it, and reminders and suspension stay paused meanwhile | "We're checking this payment by hand. Don't pay again. Support will contact you." |

**Automatic confirmation (owner, 1 Oct).** A payment is credited automatically only when ALL of these hold; anything else is `HELD` for a person, with no reminders and no suspension, and operators are alerted once:
1. MMG's reply decrypts with ResultCode `0`, naming this checkout's `merchantTransactionId` and an MMG `transactionId`, and reaches Swift (through the return door or the notify door, whichever is first) while the checkout is open: by its deadline, with two minutes' tolerance. A not-paid answer (`1`, `2`, `6`, `7`) for the same checkout, or success naming two transactions, means MMG's answers disagree.
2. MMG's lookup of that `transactionId` answers HTTP 200 with `transactionStatus` exactly `successful`.
3. Every `creditParty` entry keyed `accountid`, including one with an empty or missing value, is the checkout's configured merchant number (`MMG_CHECKOUT_MERCHANT_ID`). A payment to any other number, another Swift number included, is held.
4. `amount` is exactly the checkout's whole-GYD amount and `currency` is `GYD`.
5. `creationDate` lies inside the checkout's window (created to expiry, two minutes' tolerance), read in the zone the server setting `MMG_CHECKOUT_CREATION_ZONE` names (section 8), and is no more than two minutes after Swift first received an MMG reply naming the transaction. With the setting unset, MMG's payment time cannot be checked, so every MMG payment is `HELD`.
6. Neither the `transactionId` nor the lookup's `transactionReference` (MMG's ledger number, a different number) was ever credited by any channel. The credit claims both, under the one-credit-per-MMG-payment constraint.

Never say "paid" before `CONFIRMED`. Never promise an instant restore: access comes back when the payment is credited, and `subscriptionStatus` shows it.

## 6. The web return pages

After payment, MMG sends the partner's browser to the return address registered for Swift's merchant account: `<MMG_CHECKOUT_RETURN_ORIGIN>/pay/mmg/<outcome>`, for example `…/pay/mmg/success` and `…/pay/mmg/error`.

The official merchant page says MMG posts an encrypted TOKEN to the configured Response URL. In UAT (1 Oct) MMG appended it to the Response URL's PATH (`…/payment/token=<encrypted>`), not the query, so the page forwards that path value too. The page forwards bounded fields and interprets nothing. MMG must also register the Error URL; the optional Notify URL requires separate authentication and transport confirmation. Checkout series PR 3 owns the API route wiring and route-level checks below; these are pending integration requirements, not completed PR 2 behavior.

1. **Accept both GET and POST.** Take every query parameter (GET) or form field (POST) exactly as received:
   - a key that appears more than once is forwarded as an array of its values, in order;
   - at most 16 values in total, each at most 4096 characters.

   The page never decides the state itself. Only the API's answer, or an API error, decides it. A duplicate key is not a reason for `UNKNOWN`: dropping a genuine reply would leave a real payment for manual reconciliation.
2. **Call the API server-to-server,** never from the browser:
   - `POST /api/v1/billing/mmg-checkout/return`
   - body `{ outcome: string, params: Record<string, string | string[]> }`
   - answer `{ success: true, data: { state: 'CONFIRMED' | 'CONFIRMING' | 'NOT_PAID' | 'UNKNOWN' } }`

   The answer carries no amount, name or `ref`: anyone who holds the link would see the page.
3. **Render only that state:**

   | State | Page text |
   |---|---|
   | `CONFIRMED` | "Payment received. Your Swift weekly fee is paid." |
   | `CONFIRMING` | "We're confirming your payment with MMG. Don't pay again. You can close this page." |
   | `NOT_PAID` | "MMG didn't complete this payment. You can try again in the Swift app." (only when MMG's own answer or record for the checkout says so; the `…/pay/mmg/error` path alone decides nothing) |
   | `UNKNOWN` | "Open the Swift app to see your weekly fee." (a missing or unreadable link, or an unknown checkout) |

   Any error from `/return` (`400`, `413`, `429` or `5xx`) renders `UNKNOWN`. The app shows the truth from its own polling.
4. **Show two links on every state:**
   - "Back to the Swift app" → `swift://pay/mmg/return`, with no parameters. On a phone this closes the in-app browser.
   - "Continue on the web" → one neutral web route that picks the page from the signed-in session:
     - a store owner → the dashboard's weekly-fee page;
     - a mover → the portal's weekly-fee page;
     - someone who is both → a chooser;
     - signed out → sign in, then the same choice.

     The return page cannot tell who paid: its answer names no one. A cookie set when the checkout started would not survive MMG's cross-site redirect (SameSite), least of all a form POST.
5. **Headers and privacy:** send `X-Robots-Tag: noindex`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Never log, render or forward the received values anywhere except `/return`. Keep the query out of analytics.

The planned `POST /api/v1/billing/mmg-checkout/notify` is for MMG's servers. Its authentication and server-to-server behavior must be confirmed with MMG before enabling it (U3). It accepts JSON or a form of up to 16 KB and always answers `200 { success: true }`. The app and the web never call it.

**Registered with MMG (5 Oct 2026):** MMG has registered Swift's UAT Notify URL, `https://api-staging.swiftgy.com/api/v1/billing/mmg-checkout/notify` (this route). A notify is a pointer only: it is written down and prompts Swift's own lookup with MMG; it never credits anything by itself. Its authentication remains unconfirmed (U3).

Both public routes are rate-limited per source address and size-capped: `/return` takes 120 calls a minute and a body of up to 96 KB (the 16 values of 4096 characters the page forwards, as JSON); `/notify` takes 60 a minute and 16 KB. Over the limit is `429`, over the cap is `413`, and a `/return` body that is not `{ outcome, params }` within those bounds is `400`. Neither credits anything by itself: they only prompt the server to check with MMG. With `MMG_CHECKOUT_ENABLED` off, a body within those bounds is answered neutrally (`UNKNOWN`, `200`) and nothing is written down; a malformed `/return` body is still `400`.

**One token.** MMG sends one reply token, as one string. A token named more than once (a repeated query or form field arrives as an array, and `token` and `Token` are two) is ambiguous: `/return` answers `UNKNOWN` and `/notify` ignores it, before anything is opened, looked up or written down.

**MMG's result code.** MMG sends the outcome, success or failure, to the same Response URL, so the `…/pay/mmg/success` path is not a success. The API reads the reply's documented `ResultCode`:
- `3`, `4`, `5` (invalid secret key, merchant id mismatch, token decryption failed): MMG could not accept Swift's request. The reply is written down, operators are paged once per checkout and code, the checkout is left exactly as it was whatever its state, and the page answers `UNKNOWN`. Nothing is ever credited on these.
- every other reply goes to the service, which decides as described under "Official response interpretation" below: `0` confirms only under the six conditions (section 5): a paid record that fails one is held for a person, and a record MMG does not have yet keeps the checkout confirming; `1`, `2` and `6` are `NOT_PAID` at once; `7` is `NOT_PAID` at once when it names no transaction, and waits for MMG's lookup when it names one.

### Official response interpretation (service boundary)

The service accepts only root `merchantTransactionId`, `transactionId` and string `ResultCode` (`0`–`7`). The merchant reference must exactly equal a persisted checkout reference. Messages, HTML and nested or guessed fields never identify a transaction or decide a state.

- `0` (success) triggers an authoritative lookup. A paid record credits automatically only under the six conditions above; otherwise it is held for a person; an absent record keeps confirming and can expire.
- `1` (agent not registered), `2` (failed) and `6` (cancelled) are "not paid": the checkout becomes `NOT_PAID`, the confirmation pause is released, and the partner may pay again. A transaction the answer names is still looked at later: a paid record is held for a person (MMG never answered success for it, or its answers disagree) and pauses reminders and suspension again for the same week.
- `7` (timed out) is not paid unless the lookup says paid: naming no transaction it is `NOT_PAID` at once; naming one, MMG's lookup decides (declined is `NOT_PAID`; paid is held for a person to confirm, since only a `0` answer confirms automatically; pending or unknown keeps confirming and the pause held).
- After any `0` answer for a checkout, a later `1`, `2`, `6` or `7` releases nothing; MMG's answers then disagree, so a paid record is held for a person.
- A `0` answer for a checkout that is already `CONFIRMED`, or that becomes `CONFIRMED` by another transaction while the answer is being handled, naming a transaction that checkout did not credit, is written down, and operators are alerted that money was received and not applied: once per checkout and transaction, whichever door and however often MMG repeats it, and once more for each different transaction. It is never credited automatically. If that alert cannot be saved, the 2-minute poll sends it later: it re-reads every checkout confirmed in the last 14 days and alerts any such transaction no operator was alerted about.
- `3` (invalid secret), `4` (merchant mismatch), and `5` (token decryption failed) are a configuration or security alert for operators, paged once per checkout and code. The checkout is never touched, nothing is looked up or credited, and the answer is `UNKNOWN`.
- An unknown code or malformed response leaves the checkout unchanged. `ResultMessage` and `htmlResponse` are never rendered.

UAT (1 Oct) showed that MMG's lookup carries neither Swift's `merchantTransactionId` nor its description, so `MMG_LOOKUP_REFERENCE_FIELDS` stays empty: a payment is tied to its checkout by MMG's own success answer for it (condition 1), never by a lookup field. Every channel claims MMG payments through #1395's one identity path.

## 7. Notices (push, SMS, inbox)

The server writes the fee notices. They never offer an agent, cash, a Swift Number or an account number.
- **MMG checkout live for the partner:** "Pay GY$X with MMG in the Swift app."
- **Otherwise:** the amount and the due date only, with no pay-action promise.

## 8. Operations

- **Configuration:** `MMG_CHECKOUT_*` (`providers/mmg/CHECKOUT-CONTRACT.md`). With the configuration absent or `MMG_CHECKOUT_ENABLED=0`, `MMG_CHECKOUT` is `off` everywhere.
- **The MMG page at rest:** the server keeps each checkout's `checkoutUrl` sealed with the platform's envelope encryption (`MASTER_KEK`); it is opened only to answer the partner who may pay it. Without a master key no checkout is started (`503 MMG_CHECKOUT_UNAVAILABLE`).
- **Crediting after an upgrade:** no checkout credits until every earlier MMG credit (push-rail payments, admin top-ups, agent cash) has been reconciled to its provider identity. The billing poll runs that backfill once and records it, with any historical conflicts counted and paged once; until then a confirmed checkout waits in `CONFIRMING`. A conflicted transaction stays as it is and is never credited again by any channel.
- **Unmatched observations:** a reply that names no checkout of ours is written down, then pruned in bounded batches: after a week when it did not decrypt, after 90 days when it did. A checkout's own replies and lookups are kept.
- **MMG's payment time (`MMG_CHECKOUT_CREATION_ZONE`):** how the lookup's `creationDate` is read for condition 5. Exactly one of:
  - `GUYANA_WALL_CLOCK`: a stamp ending in `Z`, or with no zone, is Guyana time. This is what MMG writes: verified in UAT on 1 Oct, and the owner ruled on 4 Oct that production writes it the same way. Staging and production both set it.
  - `UTC`: `Z` is UTC, and a stamp with no zone cannot be read (held).

  An explicit numeric offset (for example `-04:00`) is read as stated with either value. Unset is the safety net, not a configuration: no MMG payment is then confirmed automatically, each one is `HELD` (reason `CREATION_ZONE_UNVERIFIED`) and operators are alerted once per checkout. Any other value stops the server from starting. If MMG's time for a payment is later than the first MMG reply Swift received about it (beyond two minutes), the payment is `HELD` (reason `CREATION_AFTER_REPLY`) and operators are told that MMG's stamps may not match the configured zone.
- **The per-platform switch:** the platform-config key `billing.feeCheckout.platforms`, value `{ "ios": true, "android": true, "web": true }`. A missing row, or a missing platform in it, counts as on (owner ruling "3 b": the iPhone button is on; owner ruling of 1 Oct, option 2: the in-app MMG checkout on iOS and Android). Setting a platform to `false` hides the MMG checkout there within a minute, with no deploy or app build: the server-side fallback for the iOS app. A store-review demo account never gets it, on any platform. Only the JSON booleans `true` and `false` count: any other value for a platform (the string `"false"` included) switches that platform off, and a value that is not an object switches every platform off, each with a warning in the server log.

## 9. Answers to the UI lane (2026-09-29)

1. **Duplicate return keys:** they do not stay `UNKNOWN`. Forward them as an array, and the API tries every value (section 6, step 1).
2. **A push for a multi-store owner:** its data carries `vendorId` when a store pays. Select that store, then open its fee screen (section 5).
3. **A mover's web return:** the return page links to one neutral route that picks the dashboard or the portal from the signed-in session (section 6, step 4).
4. **The web session cookie:** yes. Every partner route takes a Bearer token, or the `swift_at` cookie with `x-swift-client: web` from an allowed origin (section 2).

## 10. Not in this contract yet

- Card payments: `CARD` stays `off` until PT-4.
- The HELD review queue's decisions (confirm or reject a held payment) and reversals: the rest of PR 6. The checkouts list and support's lookup are section 11.

## 11. Support lookup (admin)

For Swift support, never a partner. Both routes are under `/api/v1/admin`, for `ADMIN` and `SUPER_ADMIN` holding the `billing.mmg.read` capability (class C1: they disclose who paid). The shapes are `@swift/types` `mmg-checkout-support`; the API builds them field by field.

`GET /api/v1/admin/billing/mmg-checkouts?q=&status=&cursor=&limit=`
- `q` (optional, up to 64 characters) is matched EXACTLY after normalisation, never as a substring:
  - as an id, its digits (a pasted `MMG-2040 2048 536279` is `20402048536279`; at least 6 digits). It matches our `merchantTransactionId` (`SWIFT_REFERENCE`), the confirmed `mmgTransactionId` (`MMG_TRANSACTION_ID`), a transaction an MMG reply named (`MMG_CANDIDATE`), or MMG's own ledger number from its lookup, `transactionReference` (`MMG_REFERENCE`);
  - as a phone, E.164: `+…` as written, a 7-digit number as `+592…`, `592` plus 7 digits with its `+`. It matches every checkout of the partner with that phone (`PARTNER_PHONE`).
  - No `q`: the checkouts list.
- `status`: one of the six statuses. `limit`: 1–50, default 20. `cursor`: the `nextCursor` of the previous page; anything else is `400`.
- Answer: `{ success: true, data: MmgCheckoutSupportRow[], nextCursor: string | null }`, newest first. A row: `id`, `swiftReference`, `mmgTransactionId`, `mmgTransactionReference` (when a lookup returned one), `amount`, `currencyCode`, `status`, `platform`, `partner` (`kind`, `displayName`, `maskedPhone`, `subscriptionId`), `createdAt`, `replyAt`, `confirmedAt`, `reason` (operators only) and `matchedBy`.

`GET /api/v1/admin/billing/mmg-checkouts/:id`
- The row (without `matchedBy`), plus `timeline` (every reply and lookup in order: `source`, `at`, MMG's `resultCode`, the lookup's `transactionStatus`, `amount`, `currency`, `mmgTransactionId`, `mmgTransactionReference`, `windowCheck` (a lookup: `INSIDE`, `OUTSIDE` the window, `AFTER_REPLY` when MMG's time is more than two minutes after the first reply naming the payment, or `UNREADABLE`; the same check that credits) and `failure`), `timelineTruncated`, and `creditedPeriod` for a `CONFIRMED` checkout (`APPLIED` with the week it paid, `CREDIT` kept for the next bill, or `PENDING`, with the receipt number).
- `404` for an unknown id and for another tenant's checkout.

**Never in an answer:** the MMG page (sealed at rest), any token or Idempotency-Key, MMG's reply message or HTML, keys or headers.

**Every read is recorded** in the admin audit trail, inside the request, before the answer leaves: who, when, which identifier type matched (`queryType`), what kind of query it was (`queryShape`) and the checkout ids. Never the query itself: it may be a phone number. A refused read, and a detail of a checkout that is not there, disclosed nothing and are not recorded.

Changes to this contract are made here first, in the same PR as the code that changes.
