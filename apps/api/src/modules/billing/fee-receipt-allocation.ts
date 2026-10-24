import type { Prisma } from '@prisma/client';

// ---------------------------------------------------------------------------
// [R12 · REVIEW-G #1771 S3-1 option a] Which weekly-fee payment paid what.
//
// Every credit to a partner's weekly-fee money issues one receipt (receipts.ts)
// for the amount credited. Every debit of that money now says which receipts it
// used, oldest money first (FIFO), in the debit's own transaction:
//   - WEEK: a weekly fee paid from the money (with the week it bought);
//   - RETURNED: a payment MMG returned (its own receipt first);
//   - REFUND_SET_ASIDE: unused money set aside for a refund;
//   - REFUND_RELEASED: a set-aside returned unpaid gives that money back
//     (negative rows mirroring the set-aside's).
// So a receipt can print the week(s) its money covered, what was returned or
// set aside, and what is not used yet; it never infers a week from clocks.
//
// Receipts issued before this existed (weeksTracked = false) are never read
// here: what they paid is not known, and they keep the "paid toward" line. Money
// in the wallet that no tracked receipt holds (credited before receipts tracked
// their weeks) is the oldest money, so a debit uses it first, writing nothing.
// The rows are append-only financial records; they go only with their receipt.
// ---------------------------------------------------------------------------

type Tx = Prisma.TransactionClient;
export type FeeReceiptAllocationKind = 'WEEK' | 'RETURNED' | 'REFUND_SET_ASIDE' | 'REFUND_RELEASED';

const cents = (v: unknown) => Math.round(Number(v) * 100);
const major = (c: number) => c / 100;

interface Unused { id: string; mmgRef: string | null; unused: number }

/** The tracked receipts of a subscription that still hold unused money, oldest first (cents). */
async function receiptsWithUnusedMoney(tx: Tx, subscriptionId: string): Promise<Unused[]> {
  const receipts = await tx.feeReceipt.findMany({
    where: { subscriptionId, weeksTracked: true },
    orderBy: [{ issuedAt: 'asc' }, { receiptNumber: 'asc' }],
    select: { id: true, amount: true, mmgRef: true, allocations: { select: { amount: true } } },
  });
  return receipts
    .map((r) => ({ id: r.id, mmgRef: r.mmgRef, unused: cents(r.amount) - r.allocations.reduce((sum, a) => sum + cents(a.amount), 0) }))
    .filter((r) => r.unused > 0);
}

/**
 * Record which receipts one wallet debit used, in the debit's transaction (the
 * wallet already locked and debited). `balanceBefore` is the wallet balance just
 * before this debit: whatever part of it no tracked receipt holds is used first.
 * A RETURNED debit uses the returned payment's own receipt first (`ownMmgRef`).
 */
export async function recordWalletDebitInTx(tx: Tx, p: {
  subscriptionId: string; amount: number; balanceBefore: number; kind: Exclude<FeeReceiptAllocationKind, 'REFUND_RELEASED'>;
  billingEventId: string; periodStart?: Date; periodEnd?: Date; ownMmgRef?: string;
}): Promise<void> {
  let left = cents(p.amount);
  if (!(left > 0)) return;
  const receipts = await receiptsWithUnusedMoney(tx, p.subscriptionId);
  const own = p.ownMmgRef ? receipts.filter((r) => r.mmgRef === p.ownMmgRef) : [];
  const rest = receipts.filter((r) => !own.includes(r));
  const take = async (r: Unused) => {
    const used = Math.min(left, r.unused);
    if (used <= 0) return;
    await tx.feeReceiptAllocation.create({ data: {
      receiptId: r.id, subscriptionId: p.subscriptionId, kind: p.kind, amount: major(used), billingEventId: p.billingEventId,
      periodStart: p.kind === 'WEEK' ? p.periodStart ?? null : null, periodEnd: p.kind === 'WEEK' ? p.periodEnd ?? null : null,
    } });
    left -= used;
  };
  for (const r of own) await take(r);
  // The money no tracked receipt holds is the oldest: it goes before any tracked receipt.
  const tracked = receipts.reduce((sum, r) => sum + r.unused, 0);
  left -= Math.min(left, Math.max(0, cents(p.balanceBefore) - tracked));
  for (const r of rest) {
    if (left <= 0) break;
    await take(r);
  }
}

/**
 * A refund set-aside returned unpaid gives its money back to the receipts it
 * came from (newest first, up to `amount`), as negative REFUND_RELEASED rows.
 */
export async function recordSetAsideReleasedInTx(tx: Tx, p: { subscriptionId: string; setAsideEventId: string; amount: number; billingEventId: string }): Promise<void> {
  let left = cents(p.amount);
  const setAside = await tx.feeReceiptAllocation.findMany({
    where: { subscriptionId: p.subscriptionId, billingEventId: p.setAsideEventId, kind: 'REFUND_SET_ASIDE' },
    include: { receipt: { select: { issuedAt: true, receiptNumber: true } } },
  });
  setAside.sort((a, b) => b.receipt.issuedAt.getTime() - a.receipt.issuedAt.getTime() || b.receipt.receiptNumber.localeCompare(a.receipt.receiptNumber));
  for (const row of setAside) {
    if (left <= 0) break;
    const back = Math.min(left, cents(row.amount));
    await tx.feeReceiptAllocation.create({ data: {
      receiptId: row.receiptId, subscriptionId: p.subscriptionId, kind: 'REFUND_RELEASED', amount: -major(back), billingEventId: p.billingEventId,
    } });
    left -= back;
  }
}
