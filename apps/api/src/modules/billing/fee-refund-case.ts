import { Prisma, type FeeRefundCase, type PrismaClient } from '@prisma/client';
import type Redis from 'ioredis';
import { AppError, NotFoundError } from '../../utils/errors';
import { endOfGuyanaDay, guyanaWallClockParts } from '../../utils/guyana-day';
import type { OnAudit } from '../../lib/audit-writer';
import type { NotificationService } from '../notification/notification.service';
import { pageOps, resolveOpsPage } from '../ops/ops-page';
import { RETURN_PROVEN, reversalRefusal } from './mmg-fee-reversal';

// ---------------------------------------------------------------------------
// [Row 156 · owner 1 Oct 2026] "Weekly-fee refunds: none, except a duplicate or
// mistaken payment, refunded through MMG within 3 business days."
//
// The return of a payment already exists (mmg-fee-reversal.ts: a second person,
// a durable claim, MMG asked once, MMG's lookup decides). What did not exist was
// the ask: nothing recorded when a partner asked, so nothing could keep the
// promise. A case is that record and its clock. The law:
//   1. A case moves no money and takes no MMG reference. Opening one needs a
//      person, a reason and an audit row (C3), never a second person: it is a
//      note that a clock started, and the return keeps its own two-person gate.
//   2. A case closes in one way only: a sweep finds that MMG's lookup proved this
//      very payment returned (RETURN_PROVEN). The database refuses anything else,
//      so a typed number can never close a case, and refuses a delete.
//   3. A case MMG cannot serve stays open and visible: a refused return, a held
//      one, or one waiting on the switch (MMG_FEE_REVERSAL). Overdue is the truth.
//   4. Overdue cases share ONE platform page, closed when none is overdue. It is
//      a bounded page, not one per case, so a backlog cannot storm the on-call phone.
// ---------------------------------------------------------------------------

export const FEE_REFUND_BUSINESS_DAYS = 3;
export const FEE_REFUND_OVERDUE_TITLE = 'Weekly-fee refund overdue';
export const FEE_REFUND_OVERDUE_KEY = 'ops_page:fee-refund-overdue';
export const FEE_REFUND_OVERDUE_WINDOW_SECONDS = 86_400;
const DAY_MS = 86_400_000;
/** How many open cases one sweep closes; the next sweep takes the rest. */
const SWEEP_BATCH = 200;
const LIST_LIMIT = 200;

export type FeeRefundKind = 'DUPLICATE' | 'MISTAKEN';

/**
 * The end of the `days`th Monday-to-Friday after the day of `from`, Guyana time. The day of the ask is not counted.
 * There is no holiday list: a holiday counts as a working day here, so the date only ever falls early, never late.
 */
export function businessDaysDue(from: Date, days: number = FEE_REFUND_BUSINESS_DAYS): Date {
  const { year, month, day } = guyanaWallClockParts(from);
  let cursor = Date.UTC(year, month - 1, day);
  for (let left = days; left > 0;) {
    cursor += DAY_MS;
    const weekday = new Date(cursor).getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return endOfGuyanaDay(new Date(cursor).toISOString().slice(0, 10));
}

const isOverdue = (row: Pick<FeeRefundCase, 'state' | 'dueBy'>, now: Date) => row.state === 'OPEN' && row.dueBy.getTime() < now.getTime();

/** A case as the console reads it. */
function caseView(row: FeeRefundCase, now: Date) {
  return {
    id: row.id, checkoutId: row.checkoutId, subscriptionId: row.subscriptionId, kind: row.kind, reason: row.reason,
    amount: Number(row.amount), currencyCode: row.currencyCode, state: row.state, dueBy: row.dueBy, overdue: isOverdue(row, now),
    reversalId: row.reversalId, refundedAt: row.refundedAt, openedAt: row.createdAt,
  };
}

/** The partner asked for this payment back: the clock starts. No money moves. */
export async function openFeeRefundCase(
  prisma: PrismaClient,
  input: { tenantId: string; checkoutId: string; kind: FeeRefundKind; reason: string; actorId: string },
  onAudit: OnAudit,
  now: Date = new Date(),
) {
  try {
    const row = await prisma.$transaction(async (tx) => {
      const intent = await tx.mmgCheckoutIntent.findFirst({ where: { id: input.checkoutId, tenantId: input.tenantId } });
      if (!intent) throw new NotFoundError('MMG checkout', input.checkoutId);
      // Only a payment Swift credited on MMG's proof has anything to return, and a pay-all payment has no single payer.
      if (!intent.subscriptionId) throw reversalRefusal('CHAIN_CHECKOUT');
      if (intent.status !== 'CONFIRMED') throw reversalRefusal('NOT_CONFIRMED');
      if (await tx.mmgFeeReversal.findFirst({ where: { checkoutId: intent.id, ...RETURN_PROVEN }, select: { id: true } })) throw reversalRefusal('ALREADY_REVERSED');
      const created = await tx.feeRefundCase.create({ data: {
        tenantId: intent.tenantId, subscriptionId: intent.subscriptionId, checkoutId: intent.id, kind: input.kind, reason: input.reason,
        openedByUserId: input.actorId, amount: intent.amount, currencyCode: intent.currencyCode, dueBy: businessDaysDue(now), createdAt: now,
      } });
      await onAudit(tx, { caseId: created.id, checkoutId: intent.id, kind: input.kind, dueBy: created.dueBy.toISOString() });
      return created;
    });
    return caseView(row, now);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw new AppError(409, 'REFUND_CASE_EXISTS', 'This payment already has a refund case.');
    }
    throw err;
  }
}

/** The case of one payment, if it has one. */
export async function feeRefundCaseOf(prisma: PrismaClient, input: { tenantId: string; checkoutId: string }, now: Date = new Date()) {
  const row = await prisma.feeRefundCase.findFirst({ where: { checkoutId: input.checkoutId, tenantId: input.tenantId } });
  return row ? caseView(row, now) : null;
}

/** The console's list: what is open, the nearest due date first, then what closed most recently. */
export async function listFeeRefundCases(prisma: PrismaClient, input: { tenantId: string; state?: 'OPEN' | 'REFUNDED' }, now: Date = new Date()) {
  const rows = await prisma.feeRefundCase.findMany({
    where: { tenantId: input.tenantId, ...(input.state ? { state: input.state } : {}) },
    orderBy: [{ state: 'asc' }, { dueBy: 'asc' }],
    take: LIST_LIMIT,
  });
  return rows.map((row) => caseView(row, now));
}

/**
 * The worker's sweep. Closes every open case whose payment MMG's lookup has proven returned, then pages the overdue
 * ones as ONE platform page, closed when none is overdue. A case is not closed from anything else: the database's
 * guard (20261104150000_fee_refund_case_proof) refuses it.
 */
export async function sweepFeeRefundCases(
  deps: { prisma: PrismaClient; redis: Redis; notifications: NotificationService; resolveRecipients?: () => Promise<string[]> },
  now: Date = new Date(),
): Promise<{ refunded: number; overdue: number }> {
  const open = await deps.prisma.feeRefundCase.findMany({ where: { state: 'OPEN' }, select: { id: true, checkoutId: true }, orderBy: { dueBy: 'asc' }, take: SWEEP_BATCH });
  const proven = await deps.prisma.mmgFeeReversal.findMany({ where: { checkoutId: { in: open.map((c) => c.checkoutId) }, ...RETURN_PROVEN }, select: { id: true, checkoutId: true, reversedAt: true, failedAt: true } });
  const byCheckout = new Map(proven.map((r) => [r.checkoutId, r]));
  let refunded = 0;
  for (const row of open) {
    const reversal = byCheckout.get(row.checkoutId);
    if (!reversal) continue;
    const closed = await deps.prisma.feeRefundCase.updateMany({
      where: { id: row.id, state: 'OPEN' },
      data: { state: 'REFUNDED', reversalId: reversal.id, refundedAt: reversal.reversedAt ?? reversal.failedAt ?? now },
    });
    refunded += closed.count;
  }
  const overdue = await deps.prisma.feeRefundCase.count({ where: { state: 'OPEN', dueBy: { lt: now } } });
  if (overdue === 0) {
    await resolveOpsPage(deps.prisma, FEE_REFUND_OVERDUE_TITLE, 'no-refund-overdue');
    // The page is closed, so its window goes with it: the next overdue case pages at once.
    await deps.redis.del(FEE_REFUND_OVERDUE_KEY);
    return { refunded, overdue };
  }
  await pageOps(deps, {
    key: FEE_REFUND_OVERDUE_KEY,
    windowSeconds: FEE_REFUND_OVERDUE_WINDOW_SECONDS,
    title: FEE_REFUND_OVERDUE_TITLE,
    body: `${overdue} weekly-fee refund case(s) are past their ${FEE_REFUND_BUSINESS_DAYS} business days. See Mission Control > MMG payments and the weekly-fee refund procedure.`,
    data: { kind: 'ops_fee_refund_overdue', overdue },
  });
  return { refunded, overdue };
}
