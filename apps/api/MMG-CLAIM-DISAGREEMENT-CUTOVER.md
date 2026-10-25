# Direct-MMG claim disagreement — cutover and rollback

`ORDER-SPINE S1-6` · migration `20260922130000_mmg_claim_disagreement` ·
authority `src/modules/order/mmg-claim.service.ts`

## What changes

A direct-MMG marketplace order is paid customer → store outside Swift. Swift
holds none of the money and has no provider evidence on this rail; the only
signals are the store's claim (`paymentStatus = CLAIMED`) and the customer's
own statement. From this release:

- The customer's statement is durable: `customerMmgClaim` =
  `UNRECORDED | PAID | NOT_PAID`, with `customerMmgClaimAt`. A denial made
  before the store claims is found by the store's later claim.
- Customer claims, store claims and operator decisions take the same `orders`
  row lock and are decided on the locked row. Two claims that disagree — a
  denial against `CLAIMED`/`CAPTURED`, or two different payment references —
  latch `mmgClaimMismatchAt`, which every fulfilment gate already reads.
- Neither party clears a latched disagreement. An operator decision must name
  the claim generation it reviewed (`expectedClaimRevision`); the same
  decision retried is a replay, a stale or conflicting one is refused.
- State, audit evidence and a notice obligation (`order_outbox`, kind
  `mmg-claim-notice`) commit in one transaction. Notices are delivered from
  the obligation, keyed per (order, generation, role), re-checked against the
  current row, and worded as what each party SAID — never as a confirmation.
  The obligation stays owed until every recipient it names holds an inbox row
  and, for a dispute, an operator was reached: the request delivers it first,
  then the `checkout-outbox` sweep's own drain (`drainMmgClaimNotices`) retries
  it with backoff (30 s doubling, at most 15 min apart). The queue publisher
  never claims this kind — it would consume the row on the queue's acceptance.
- Ticking a shelf-picked line and proposing a substitution commit under the
  same `orders` row lock, with the fulfilment gate re-run on the locked row: a
  denial that commits first refuses them; one that arrives during them waits.
- Unpaid or disputed direct-MMG work is no longer offered by dispatch or listed
  on the rider board; both assignment writes already refused it.
- An operator's `CUSTOMER_DID_NOT_PAY` returns the claim to `PENDING` and keeps
  the store's reference reserved: the store cannot re-claim that order, and
  the customer is not offered a new external pay link. Pre-custody
  cancellation stays available.

The CHECK constraints make an unheld disagreement unwritable by any writer.

## Contract changes callers must know

| Surface | Before | After |
|---|---|---|
| `POST /api/v1/admin/orders/:id/payment-claim/resolve` | `{ resolution, note }` | `{ resolution, note, expectedClaimRevision }` — missing revision → 400; stale → 409 `MMG_CLAIM_STALE`; different decision already recorded → 409 `MMG_CLAIM_ALREADY_RESOLVED`; nothing open → 409 `MMG_CLAIM_NOT_DISPUTED`. No shipped caller exists; any external caller must be updated. |
| `POST /api/v1/customer/orders/:id/payment-claim` | any 3–64 char reference, stored raw | reference normalised and shape-checked exactly like the store's (`REFERENCE_REQUIRED` / `REFERENCE_INVALID`); closed orders → `ORDER_CLOSED`; reversed/failed/unresolved payments → `PAYMENT_NOT_CLAIMABLE`; TAXI / no store → `NOT_A_MARKETPLACE_ORDER`. Response adds `mismatch`, `replayed`, `mmgClaim`. |
| `POST /api/v1/vendor/orders/:id/confirm-payment` | an operator-rejected attempt could be re-claimed | 409 `MMG_ATTEMPT_REJECTED`; the customer notice is the store's claim, not "is confirmed" |
| `GET /api/v1/customer/orders/:id` | — | adds `mmgClaim`; `paymentAction` is null for a rejected attempt |

## Writer cutover

1. Apply the migration (expand only; every existing row satisfies all four
   CHECKs immediately).
2. Deploy the API as a coordinated cutover, not a rolling mix. While an old
   instance still serves, the CHECKs fail its conflicting writes closed: an old
   admin resolver cannot clear a dispute recorded under the new contract, and
   an old customer route cannot overwrite a recorded denial. Those requests
   error rather than lose evidence — expected during the window, not a defect.
3. Legacy rows keep their pre-contract evidence untouched: `UNRECORDED` means
   nothing was said under this contract, not that the customer was silent.
   Existing open mismatches stay held. Historical denials that were never
   durable cannot be recovered automatically; an operator adjudicates them.

## Rollback

Forward repair is preferred. Roll the schema back only after the application
is rolled back to a version that never writes these columns, and only while
no claim has been recorded under the new contract — the guard refuses
otherwise, because dropping a recorded "I did not pay" reopens the defect.

```sql
BEGIN;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "orders" WHERE "customerMmgClaim" <> 'UNRECORDED'
             OR "mmgClaimRevision" <> 0 OR "mmgClaimResolution" IS NOT NULL) THEN
    RAISE EXCEPTION 'refusing rollback: recorded direct-MMG claim evidence would be discarded';
  END IF;
END $$;
ALTER TABLE "orders" DROP CONSTRAINT "chk_orders_mmg_disagreement_held",
  DROP CONSTRAINT "chk_orders_mmg_claim_resolution_shape",
  DROP CONSTRAINT "chk_orders_customer_mmg_claim_shape",
  DROP CONSTRAINT "chk_orders_mmg_claim_revision_nonneg";
ALTER TABLE "orders" DROP COLUMN "mmgClaimRevision", DROP COLUMN "mmgClaimResolvedRevision",
  DROP COLUMN "mmgClaimResolvedAt", DROP COLUMN "mmgClaimResolution",
  DROP COLUMN "customerMmgClaimAt", DROP COLUMN "customerMmgClaim";
DROP TYPE "MmgClaimResolution";
DROP TYPE "CustomerMmgClaim";
DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20260922130000_mmg_claim_disagreement';
COMMIT;
```

Unprocessed `mmg-claim-notice` rows left in `order_outbox` would be published
by an older sweep to a worker that does not handle the kind, and consumed
unsent; drain or mark them before rolling the application back.

## Still open — not closed by this change

- Offers already live when a dispute opens are not withdrawn, and their
  timeout can still count against the rider; new offers are not made.
- No admin console surface for the decision and no web customer control; the
  first-party customer control is the mobile order screen.
- Post-custody disputes, a second payment attempt after a rejected one,
  historical claim adjudication and provider reconciliation need their own
  scoped workflows.
- A notice nobody can receive (no operator provisioned, an inbox write that
  keeps failing) stays owed and is retried and logged every backoff interval;
  there is no escalation channel beyond the operator inbox.
- Runtime proof owed: real two-session PostgreSQL races, migration
  forward/rollback under the non-superuser runtime roles, and process-restart
  recovery (`src/__tests__/mmg-claim-races.test.ts` plus the cross-lane
  integration gate).
