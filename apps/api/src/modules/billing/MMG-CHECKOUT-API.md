# MMG weekly-fee checkout: the API contract

This is the contract the phone app and the web build against. The API side ships in two PRs of the MMG checkout series:
- **PR 2:** the checkout intent, verification with MMG, and crediting.
- **PR 3:** the routes below and `payActions`.

Until PR 3 is merged, these routes do not exist and `payActions` is absent from the subscription payload. Treat an absent `payActions` as "no way to pay in the app".

The wire format to MMG is in `providers/mmg/CHECKOUT-CONTRACT.md`. It never reaches a client.

## 0. Rules every client follows

1. **The server decides everything:**
   - which ways to pay exist;
   - how much;
   - whether a payment happened.

   Clients render server state. They never compute an amount, never infer "paid" from a redirect or a browser result, and never offer a method that is not in `payActions`.
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

**`x-client-platform`.** The server has a per-platform switch for the MMG checkout. A missing or unknown value counts as "unknown": the checkout is then offered only if it is switched on for every platform.

**`Idempotency-Key`.** Generate one key when the partner taps Pay. Reuse it for any retry of that same tap, for example after a network failure.

## 3. The subscription payload

`GET /api/v1/{family}/subscription` keeps every field it has today and gains three.

```ts
type SubscriptionFee = {
  // ... every existing field (status, weeklyRate, currentPeriodEnd, nextBillingDate,
  //     gracePeriodEnd, isTrialActive, trialEndDate, weeklyFeeGyd, walletBalanceGyd,
  //     amountDueGyd, ...) unchanged.
  payActions: PayAction[];                  // every known method, in display order
  latestMmgCheckout: CheckoutStatus | null; // the newest checkout of the last 24 h, to resume after a restart
  recentCheckouts: CheckoutStatus[];        // the last 10 checkouts, newest first
};

type PayAction =
  | { id: 'MMG_CHECKOUT'; state: 'live'; amountGyd: number; currencyCode: 'GYD' }
  | { id: 'MMG_CHECKOUT'; state: 'off' }
  | { id: 'CARD'; state: 'off' };
```

### When `MMG_CHECKOUT` is `live`

It is `live` only when **all** of these hold:
- the server's MMG checkout is configured and valid (`MMG_CHECKOUT_ENABLED=1` with complete credentials, which the boot guard already checks);
- the platform switch allows the caller's platform (section 2);
- the subscription can be paid: `TRIAL`, `ACTIVE`, `PAST_DUE`, `SUSPENDED` or `CHURNED` (paying rejoins), and its fee is not waived.

It is `off` for `PAUSED` (weekly billing stopped: resume first), `CANCELLED` and waived fees.

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
  status: 'OPEN';
  checkoutUrl: string;    // the MMG page; open it in the in-app browser; never log, store or share it
  amountGyd: number;
  currencyCode: 'GYD';
  expiresAt: string;      // ISO time; after it, this checkout cannot be started on MMG
} }
```

**One open checkout per subscription.**
- If one is `OPEN` and not expired, it comes back (`200`) with the same `ref` and `checkoutUrl`.
- The same `Idempotency-Key` always gets the same answer.
- If a checkout is `CONFIRMING`, a new one is refused so the partner cannot pay twice.

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
| 409 | `PAY_ACTION_OFF` | the MMG checkout is not live for this subscription or platform | refetch the subscription, hide the button |
| 409 | `IDEMPOTENCY_KEY_REUSED` | the key was used for a different request | new tap, new key |
| 409 | `CHECKOUT_CONFIRMING` | an earlier checkout is being confirmed; `error.details.ref` names it | show that checkout (section 5); do not start another |
| 429 | `RATE_LIMITED` | too many attempts | wait and retry |
| 503 | `MMG_CHECKOUT_UNAVAILABLE` | the checkout could not be built right now | "Try again in a minute." |

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
};
```

`404 CHECKOUT_NOT_FOUND` is the one answer for an unknown `ref` and for another partner's `ref`.

### Polling

- After the browser closes, poll every 3 s for 1 minute, then every 15 s for 10 minutes, then stop.
- Stop early at `CONFIRMED`, `NOT_PAID` or `HELD`.
- `EXPIRED` is not final for money, because a late MMG confirmation is still credited. Refresh it quietly when the screen gains focus.
- A push notification of kind `billing_mmg_checkout` (data `{ subscriptionId, ref, status }`) arrives when a checkout reaches `CONFIRMED`, `NOT_PAID` or `HELD`. Route it to the weekly-fee screen.

### What each state means, and the words the app may use

| Status | Meaning | The app may say |
|---|---|---|
| `OPEN` | created; the partner has not finished on the MMG page, or MMG has not told Swift yet | "Finish paying on the MMG page." After returning: "Waiting for MMG…" |
| `CONFIRMING` | MMG sent the partner back; Swift is checking with MMG | "Confirming your payment with MMG. Don't pay again." |
| `CONFIRMED` | MMG's records confirm the payment and the fee is credited | "Paid: GY$X received on <date>." |
| `NOT_PAID` | MMG's records show this payment did not complete | "MMG didn't complete this payment. You can try again." |
| `EXPIRED` | the checkout ran out of time and no payment was seen | "This checkout expired. If you paid, it will be credited once MMG confirms it." |
| `HELD` | MMG's records do not match this checkout (amount, currency or merchant), or the same MMG payment was claimed twice; a person reviews it | "We're checking this payment by hand. Don't pay again. Support will contact you." |

Never say "paid" before `CONFIRMED`. Never promise an instant restore: access comes back when the payment is credited, and `subscriptionStatus` shows it.

## 6. The web return pages

After payment, MMG sends the partner's browser to the return address registered for Swift's merchant account: `<MMG_CHECKOUT_RETURN_ORIGIN>/pay/mmg/<outcome>`, for example `…/pay/mmg/success` and `…/pay/mmg/error`.

What MMG attaches is not yet confirmed (`CHECKOUT-CONTRACT.md` U3): it may be a query parameter or a form POST, and the name is unknown. The page therefore forwards everything and interprets nothing.

1. **Accept both GET and POST.** Take every query parameter (GET) or form field (POST) exactly as received: at most 16 entries, each value at most 4096 characters.
2. **Call the API server-to-server,** never from the browser:
   - `POST /api/v1/billing/mmg-checkout/return`
   - body `{ outcome: string, params: Record<string, string> }`
   - answer `{ success: true, data: { state: 'CONFIRMED' | 'CONFIRMING' | 'NOT_PAID' | 'UNKNOWN' } }`

   The answer carries no amount, name or `ref`: anyone who holds the link would see the page.
3. **Render only that state:**

   | State | Page text |
   |---|---|
   | `CONFIRMED` | "Payment received. Your Swift weekly fee is paid." |
   | `CONFIRMING` | "We're confirming your payment with MMG. Don't pay again. You can close this page." |
   | `NOT_PAID` | "MMG didn't complete this payment. You can try again in the Swift app." |
   | `UNKNOWN` | "Open the Swift app to see your weekly fee." (a missing or unreadable link, or an unknown checkout) |

   Any error from `/return` (`400`, `413`, `429` or `5xx`) renders `UNKNOWN`. The app shows the truth from its own polling.
4. **Show two links on every state:**
   - "Back to the Swift app" → `swift://pay/mmg/return`, with no parameters. On a phone this closes the in-app browser.
   - "Continue on the web" → the web dashboard's weekly-fee page.
5. **Headers and privacy:** send `X-Robots-Tag: noindex`, `Cache-Control: no-store` and `Referrer-Policy: no-referrer`. Never log, render or forward the received values anywhere except `/return`. Keep the query out of analytics.

`POST /api/v1/billing/mmg-checkout/notify` is for MMG's servers, if MMG calls one (U3). It accepts JSON or a form of up to 16 KB and always answers `200 { success: true }`. The app and the web never call it.

Both public routes are rate-limited and size-capped. Neither credits anything by itself: they only prompt the server to check with MMG.

## 7. Notices (push, SMS, inbox)

The server writes the fee notices. They never offer an agent, cash, a Swift Number or an account number.
- **MMG checkout live for the partner:** "Pay GY$X with MMG in the Swift app."
- **Otherwise:** the amount and the due date only, with no pay-action promise.

## 8. Operations

- **Configuration:** `MMG_CHECKOUT_*` (`providers/mmg/CHECKOUT-CONTRACT.md`). With the configuration absent or `MMG_CHECKOUT_ENABLED=0`, `MMG_CHECKOUT` is `off` everywhere.
- **The per-platform switch:** the platform-config key `billing.feeCheckout.platforms`, value `{ "ios": true, "android": true, "web": true }`. A missing row, or a missing platform in it, counts as on (owner ruling "3 b": the iPhone button is on). Setting a platform to `false` hides the MMG checkout there within a minute, with no deploy.

## 9. Not in this contract yet

- Card payments: `CARD` stays `off` until PT-4.
- The admin checkouts list, the HELD review queue and reversals (PR 6).

Changes to this contract are made here first, in the same PR as the code that changes.
