# Weekly fee — up to four weeks ahead: limit and refunds (finance procedure: weekly fee refunds)

**DRAFT — owner-reviewed, not lawyer-confirmed.** Owner rulings of 6 Nov 2026 ("one month at a time": up to four weeks ahead, replaces #62 of 14 Oct, "no paying ahead"), 8 Oct 2026 ("NO wallet", points 2–4) and 7 Oct 2026 (unused credit at deletion).

**In person (owner 5 Nov 2026).** Anyone (a business, a rider, a driver) may pay directly to the company by cash, cheque or bank transfer, recorded by a person (section 6). MMG checkout stays. Never through an agent or a Swift Number.

Swift holds no money for anyone. Partners may pay **up to four weeks ahead** (owner 6 Nov 2026; one week at a time from 14 Oct, owner #62). While a week runs, the four weeks after it may be paid; never a fifth. The MMG checkout offers 1 to 4 weeks, each only when it fits. Money received before its week starts is Swift's own fee paid early: it is spent only on weekly fees and never withdrawn or sent on. Partners see **"Your next N weekly fees are already paid"** (or the amount paid toward the next one); the action is **"Pay weekly fee"**. Never call it a wallet, a balance or a top-up, and never offer more than the four weeks.

## 1. The limit: four weeks ahead

What counts as ahead (`pay-ahead.ts`, `PAY_AHEAD_MAX_WEEKS = 4`, a fixed rule in code, not a setting): money received for coming weeks (`prepaidBalance`) plus whole weeks already paid beyond the running week (a card Pay now pays the next week by moving `nextBillingDate`). Weeks of a free trial were not paid and never count. A week that is due now is not "ahead": money that pays it is allowed on top of the limit.

| Path | What happens past the limit |
| --- | --- |
| MMG checkout (partner opens it, 1-4 weeks) | Refused before any page exists: `409 PAY_AHEAD_LIMIT`, "Your weekly fee is already paid as far as Swift takes it, up to four weeks ahead. You can pay again once the next week has started." (or the most that can be paid now). |
| Card Pay now (partner opens it) | Refused the same way before any card page exists. |
| Admin "Record fee payment" | Refused with the most that can still be recorded. Record at most that amount and refund the rest (section 2). In production this button is off anyway (section 4). |
| Admin "Record in-person payment" | Refused the same way, when it is asked and again when it is applied. Hand back what cannot be recorded (section 6). |
| Agent payment (MMG agent cash, a Swift Number) arriving | Recorded and **held for a person** (`UNMATCHED`, failure `PAY_AHEAD_LIMIT`); never credited, never dropped. Refund it (section 3). |
| Admin "Attach" of an agent payment | Refused with the most that can still be recorded. |
| A credit that lands anyway (an MMG checkout confirmed after something else filled the room, a late MMG approval, a card capture for a week already paid) | Credited — the money is already Swift's to hold for the partner — and the operators are paged: **"Weekly fee paid more than four weeks ahead — refund owed"**, naming the amount above the limit. Refund that amount (section 2). |

## 2. Refunding money above the limit

1. Confirm the page's amount on the account (money received for coming weeks, and the next billing date).
2. Return the amount above the limit to the partner through MMG (or another way the partner agrees to in writing), within the support reply time on the refunds page.
3. Record the refund with the admin refund action for fee credit (two admins, a reason, an audit row). Until that action is live, do **not** change balances in the database: leave the page open and escalate to the owner.

## 3. Agent money held for a person

An agent payment held as `PAY_AHEAD_LIMIT` or `TOPUP_ON_HOLD` is refunded, not credited: use **Refund flag** on the agent-payments tab, return the money at MMG/agent level, and note the MMG reference. Money never moves automatically.

**One refund per MMG payment.** One real payment can arrive as several observations (the agent webhook, MMG's statement). Refund flag closes the MMG transaction (`REFUNDED`): its other observations, held or still being processed, are marked reconciled ("refunded once"), and no later observation, attach, checkout or recorded payment can credit it or bring it back to the queue. Refund only the row you flagged.

Refund flag refuses, and nothing is refunded, when:

- the payment was already credited to a weekly fee (`409 ALREADY_CREDITED`): do **not** refund it, the money already paid the partner's fee;
- the same MMG payment was already flagged for refund (`409 ALREADY_REFUNDED`, "Do not refund this payment…"): do **not** refund it again; the row is closed as a duplicate of the first refund;
- the row is a second record of a payment already credited or refunded, or already flagged (`409 NOT_UNMATCHED`, "Do not refund…");
- the row disagrees with MMG's record of the same transaction (`409 PROVIDER_ID_CONFLICT`: amount, currency or reference): finance checks it against the MMG statement first. A refund of another record of that payment never closes a conflict row; it stays in the queue for a person. There is no in-app action for a conflict row yet: escalate it to the owner with the MMG statement line, and do not edit the database.

## 4. Production: the agent and top-up routes stay held

Production runs with `BILLING_TOPUP_HOLD=1` (deploy settings example; the API also treats an unset value as a hold when `NODE_ENV=production`). With the hold on:

- the admin "Record fee payment" button is not shown, and the server refuses it (`503 TOPUP_ON_HOLD`);
- agent payments are recorded and held for a refund (section 3); "Attach" is refused;
- partners pay through the MMG checkout page (card later), or in person (section 6), which has its own door and does not read this hold.

Only an explicit `BILLING_TOPUP_HOLD=0` opens it, on a test server.

## 5. Closing an account

Account deletion waits while any money received for weeks that have not started remains (`FEE_CREDIT` blocker; the partner is told the amount and to open Get help). It counts the whole credit, so all four weeks paid ahead are covered. Support refunds the unstarted weeks (a week that has started is not refunded), records the refund (section 2, step 3), and then the deletion can proceed. No partner money is kept after they leave.

Until the admin refund action for fee credit is live, a refund at closing is done by hand: return the unstarted weeks through MMG, keep the MMG reference, and escalate to the owner to record it (do not edit balances in the database). The deletion stays blocked until then.

Before card payments are switched on: the deletion blocker counts `prepaidBalance` only; a week paid ahead by card (a moved `nextBillingDate`) must be added to it first, and an open card Pay now must count toward the four weeks at the door (today a capture that lands past the cap is kept and paged, section 1).

## 6. Paid in person, directly to the company (owner 5 Nov 2026)

Subscriptions > **Record in-person payment**. SUPER_ADMIN only. The first panel reads the account **before you take any money**: if the door is closed it says why; if open it says the most, and the least while a week is due. A second admin approves it. While the owner is the only admin: press Start in Approvals, wait (12 hours by default), enter the sign-in code, then Execute. An ask nobody starts lapses after 24 hours; hand the money back or ask again. The money counts only when it is executed, so a partner who is suspended stays suspended until then. Their fee page says the payment is waiting and offers no second one.

| Paid by | Before you record it | Reference | Books |
| --- | --- | --- | --- |
| Cash | Take the cash and give a numbered slip from the receipt book. Swift's own receipt is issued on Execute: print it from Finance, or it reaches them on their fee page and by notice. | The slip number | `CASH_ON_HAND` |
| Cheque | **Wait until it has cleared.** A cheque not yet cleared is not recorded. | The cheque number (add the bank if numbers could repeat) | `BANK_LOCAL` |
| Bank transfer | See it in the company bank account. | The bank's reference | `BANK_LOCAL` |

The amount is in whole Guyana dollars. One reference credits once, whichever account or method it is tried on, and a reference Swift has on record for any other money is refused. A cheque covering several branches needs one reference per branch (add a suffix such as `-1`, `-2`); there is no way to split one reference. Never type a card, account or phone number, or a name, as a reference or in the reason: these rows are never erased. An MMG payment is never recorded here.

It follows the MMG page's rules: the four-week limit (section 1; a monthly cash, cheque or transfer payment for up to four weeks fits), the free trial (trial weeks do not count as ahead), a waived or stopped fee has nothing to pay, nothing beside a payment being confirmed, and no money is taken while the fee is paused. While a week is due it takes at least what is due. It never counts as a way to pay for the fee pause. If the door refuses, **do not take the money**, and hand back any you took.

**Refund.** Money not yet used on a week goes back through **Refund credit** (section 2): set aside, really pay it back by cash, cheque, bank transfer or MMG, then record that payout with its own reference, never the one the money came in on. A week that has started is not refunded.

**A record made by mistake** (the wrong account or amount): stop and go to the owner. Do not use the refund for it, because a payout that never happened cannot be recorded truthfully, and the reference stays used. There is no correction action, and never edit the database.

Moving cash to the bank is not recorded in Swift: Finance shows cash taken less cash paid back, not what is in the drawer.

## 7. Price changes and weeks paid ahead (owner 6 Nov 2026)

- **A rise** (fee-rise-notice.ts) never reaches a week already paid. When it would apply, every whole week held at the old fee keeps it: the rise moves past all of them at once (`billing.service applyHeldFeeRiseInTx`, audit `BILLING_FEE_RISE_DEFERRED` with `weeksKeepOldPrice`). Once the rise is told, a new payment reaches only weeks that start before its date (`pay-ahead.ts` `riseFrom`): every door says so and names the most that can be taken.
- **A cut** (`applyCardPriceCuts`) applies from the next weekly fee not yet charged, including weeks paid ahead: money paid ahead is charged at the fee of the week it pays, and what is left counts toward later fees (or is refunded at closing, section 5).
