import type { Prisma } from '@prisma/client';
import { weeklyFeeAmount, type Priced } from './subscription-fee';

// ---------------------------------------------------------------------------
// THE amount due now: one answer for the fee screen (payInfo) and for every
// notice that states what a partner owes [AX332 F2 / AX349].
//
// A charge already ISSUED keeps the amount it was issued for: an 8,000 MMG
// request still pending when the rate moves to 6,000 settles 8,000 when it is
// approved. So what is due is that charge, at its own amount. With none
// outstanding it is next week's fee minus the parked wallet balance, floored
// at 0 (the [3.4] rule the fee screen has always used). A screen and a notice
// that each worked this out for themselves disagreed; both call this instead.
//
// Type-only imports: the client is passed in (a transaction or the pool), so
// anything can depend on this module.
// ---------------------------------------------------------------------------

type DueNowDb = Pick<Prisma.TransactionClient, 'subscriptionPayment' | 'prepaidBalance'>;

/**
 * The charge already issued for the week now owed, at its issued amount, or
 * null when none is outstanding. Live means PENDING (the request is on the
 * payer's phone) or UNKNOWN (the initiate died mid-flight and the request may
 * still be there): approving either settles ITS amount. A request for an
 * earlier week is not owed: that week was paid another way, so approving it is
 * banked to the wallet. The newest live intent stands for the week; there is
 * one by construction (SWIFT-004 never fires over a live request), and a
 * second must not double it.
 */
export async function issuedChargeDue(
  db: DueNowDb,
  sub: { id: string; nextBillingDate: Date },
): Promise<number | null> {
  const live = await db.subscriptionPayment.findFirst({
    where: { subscriptionId: sub.id, status: { in: ['PENDING', 'UNKNOWN'] }, periodStart: sub.nextBillingDate },
    orderBy: { createdAt: 'desc' },
    select: { amount: true },
  });
  return live ? Number(live.amount) : null;
}

/** THE amount due now, in the subscription's own currency. */
export async function amountDueNow(
  db: DueNowDb,
  sub: Priced & { id: string; nextBillingDate: Date },
): Promise<number> {
  const issued = await issuedChargeDue(db, sub);
  if (issued !== null) return issued;
  const wallet = await db.prepaidBalance.findUnique({ where: { subscriptionId: sub.id }, select: { balance: true } });
  return Math.max(0, weeklyFeeAmount(sub) - Number(wallet?.balance ?? 0));
}
