import type { Prisma, PrismaClient } from '@prisma/client';
import { startOfDayGY, startOfMonthGY, startOfWeekGY } from '../../utils/time-gy';

/**
 * [Board 13a "CASH COLLECTED · cash in hand" · owner 25 Oct 22:33Z] The cash a mover has actually kept from CASH
 * jobs, per period (Guyana days, Monday weeks — the same windows as the earnings summary).
 *
 * Per handed-over CASH job (deliveredAt set), from stored columns only — never a client-side guess:
 *
 *   collected   doorCashCollectedAmount — the cash the mover STATED taking at the door (L02 · row 34). Null means
 *               not stated (an older app, or a handover with no statement): the full totalAmount was assumed, as
 *               everywhere else on the platform.
 *   paid store  riderFloatForOrder(order) = subtotalBase on a CASH store order — the goods at the store's price,
 *               the share the mover fronts at pickup (the same column cashMathForOffer names payToVendor). A taxi
 *               ride has no store: nothing is paid out of it.
 *
 *   A ride or a courier job counts only once its cash was captured (createEarnings' rule, M-28/M-29). An MMG job
 *   carries no door cash; the delivery pay a store owes for an MMG order is the separate "Stores owe you" ledger.
 *
 *   cash in hand = collected − paid store. A short handover lowers it: the owner's ruling (5 Oct) is that the mover
 *   bears a shortfall. A refused handover is not DELIVERED, so its partial cash (doorCashReturnAmount, returned or
 *   held for operations) is never counted here. In a relay the order's riderId is the rider who delivered and
 *   collected; the earlier holder was paid its float back by that rider, so the same formula holds for both.
 */
export interface CashInHandWindows {
  today: number;
  thisWeek: number;
  thisMonth: number;
  allTime: number;
}

export type CashInHandMover = { riderId: string } | { driverId: string };

const cents = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

async function cashSince(
  prisma: Pick<PrismaClient, 'order'>,
  mover: CashInHandMover,
  since: Date | null,
): Promise<number> {
  const ride = 'driverId' in mover;
  const base: Prisma.OrderWhereInput = {
    ...mover,
    paymentMethod: 'CASH',
    // Handed over: DELIVERED, or a delivered order closed later (COMPLETED) or refunded by its store afterwards (the
    // store owes that refund, A-14; the mover's door cash is unchanged). deliveredAt is written only on DELIVERED.
    status: { in: ['DELIVERED', 'COMPLETED', 'REFUNDED'] },
    deliveredAt: since ? { gte: since } : { not: null },
    // A driver's jobs are rides (no store); a rider's are store deliveries and courier jobs (subtotalBase 0).
    ...(ride ? { orderType: 'TAXI' } : { orderType: { not: 'TAXI' } }),
    // [M-28 / M-29] A ride's fare or a courier's fee is money only once the cash outcome captured it: the same rule
    // createEarnings mints by, so this figure never counts a job its earnings do not.
    NOT: { orderType: { in: ['TAXI', 'COURIER'] }, paymentStatus: { not: 'CAPTURED' } },
  };
  const [assumed, stated] = await Promise.all([
    prisma.order.aggregate({ where: { ...base, doorCashCollectedAmount: null }, _sum: { totalAmount: true, subtotalBase: true } }),
    prisma.order.aggregate({ where: { ...base, doorCashCollectedAmount: { not: null } }, _sum: { doorCashCollectedAmount: true, subtotalBase: true } }),
  ]);
  const collected = cents(assumed._sum.totalAmount) + cents(stated._sum.doorCashCollectedAmount);
  const paidStore = ride ? 0 : cents(assumed._sum.subtotalBase) + cents(stated._sum.subtotalBase);
  return (collected - paidStore) / 100;
}

export async function cashInHandWindows(
  prisma: Pick<PrismaClient, 'order'>,
  mover: CashInHandMover,
): Promise<CashInHandWindows> {
  const [today, thisWeek, thisMonth, allTime] = await Promise.all([
    cashSince(prisma, mover, startOfDayGY()),
    cashSince(prisma, mover, startOfWeekGY()),
    cashSince(prisma, mover, startOfMonthGY()),
    cashSince(prisma, mover, null),
  ]);
  return { today, thisWeek, thisMonth, allTime };
}
