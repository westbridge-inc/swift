# Weekly fees paid ahead — limit and refunds (finance procedure)

**DRAFT — owner-reviewed, not lawyer-confirmed.** Owner rulings of 8 Oct 2026 ("NO wallet", points 2–4) and 7 Oct 2026 (unused credit at deletion).

Swift holds no money for anyone. A weekly fee paid before it is due is Swift's own fee paid early: it is spent only on the weekly fee and never withdrawn or sent on. Partners see it as **"Fee paid ahead — covers N weeks"**; the action is **"Pay weekly fee"**. Never call it a wallet, a balance or a top-up.

## 1. The limit: four weeks ahead

What counts as ahead (`pay-ahead.ts`): the fee paid ahead (`prepaidBalance`) plus whole weeks already paid beyond the running week (a card Pay now pays the next week by moving `nextBillingDate`). Weeks of a free trial were not paid and never count. A week that is due now is not "ahead": money that pays it is allowed on top of the limit.

| Path | What happens past the limit |
| --- | --- |
| MMG checkout (partner opens it) | Refused before any page exists: `409 PAY_AHEAD_LIMIT`, "Your weekly fee is already paid ahead as far as Swift allows (4 weeks). You can pay again once a week has been used." |
| Card Pay now (partner opens it) | Refused the same way before any card page exists. |
| Admin "Record fee payment" | Refused with the most that can still be recorded. Record at most that amount and refund the rest (section 2). In production this button is off anyway (section 4). |
| Agent payment (MMG agent cash, a Swift Number) arriving | Recorded and **held for a person** (`UNMATCHED`, failure `PAY_AHEAD_LIMIT`); never credited, never dropped. Refund it (section 3). |
| Admin "Attach" of an agent payment | Refused with the most that can still be recorded. |
| A credit that lands anyway (an MMG checkout confirmed after something else filled the room, a late MMG approval, a card capture for a week already paid) | Credited — the money is already Swift's to hold for the partner — and the operators are paged: **"Weekly fees paid ahead past the 4-week limit — refund owed"**, naming the amount above the limit. Refund that amount (section 2). |

## 2. Refunding money above the limit

1. Confirm the page's amount on the account (fee paid ahead and next billing date).
2. Return the amount above the limit to the partner through MMG (or another way the partner agrees to in writing), within the support reply time on the refunds page.
3. Record the refund with the admin refund action for fee credit (two admins, a reason, an audit row). Until that action is live, do **not** change balances in the database: leave the page open and escalate to the owner.

## 3. Agent money held for a person

An agent payment held as `PAY_AHEAD_LIMIT` or `TOPUP_ON_HOLD` is refunded, not credited: use **Refund flag** on the agent-payments tab, return the money at MMG/agent level, and note the MMG reference. Money never moves automatically.

**One refund per MMG payment.** One real payment can arrive as several observations (the agent webhook, MMG's statement). Refund flag closes the MMG transaction (`REFUNDED`): its other held observations are marked reconciled ("already refunded once"), and no later observation, attach, checkout or recorded payment can credit it. Refund only the row you flagged. If Refund flag answers that the payment was already credited to a weekly fee, do **not** refund it: the money already paid the partner's fee.

## 4. Production: no fee credited by hand

Production runs with `BILLING_TOPUP_HOLD=1` (deploy settings example; the API also treats an unset value as a hold when `NODE_ENV=production`). With the hold on:

- the admin "Record fee payment" button is not shown, and the server refuses it (`503 TOPUP_ON_HOLD`);
- agent payments are recorded and held for a refund (section 3); "Attach" is refused;
- partners pay only through the MMG checkout page (card later).

Only an explicit `BILLING_TOPUP_HOLD=0` opens it, on a test server.

## 5. Closing an account

Account deletion waits while any fee paid ahead remains (`FEE_CREDIT` blocker; the partner is told the amount and to open Get help). Support refunds the unstarted weeks paid ahead (a week that has started is not refunded), records the refund (section 2, step 3), and then the deletion can proceed. No partner money is kept after they leave.

Until the admin refund action for fee credit is live, a refund at closing is done by hand: return the unstarted weeks through MMG, keep the MMG reference, and escalate to the owner to record it (do not edit balances in the database). The deletion stays blocked until then.

Before card payments are switched on: the deletion blocker counts the fee paid ahead only; weeks paid ahead by card (a moved `nextBillingDate`) must be added to it first, and an open card Pay now must count toward the four weeks at the door (today a capture that lands past the cap is kept and paged, section 1).
