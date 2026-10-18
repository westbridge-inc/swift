import type { Prisma, PrismaClient } from '@prisma/client';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { AppError, NotFoundError } from '../../utils/errors';
import { adminAudienceWhere } from '../notification/notification.service';
import { ackDeadlineSeconds } from '../safety/ops-alert';
import { gyd, shortHandoverPage } from './door-cash';

/** Resolve the existing operations audience without inheriting a rider's
 * tenant filter. Store-review fiction must never page real operators. */
export async function doorCashHoldAudience(prisma: PrismaClient, tenantId: string) {
  // Classification must succeed before any page can be staged. A lookup error
  // must not turn a review tenant's fictional cash into a real operations page.
  const tenant = await runWithoutTenant(() => prisma.tenant.findUnique({ where: { id: tenantId }, select: { kind: true } }), 'cash-return-tenant');
  if (!tenant) throw new AppError(503, 'CASH_OPERATIONS_UNAVAILABLE', 'Cash return could not be recorded. Try again.');
  if (tenant.kind === 'REVIEW') return { tenantId, suppressed: true, userIds: [] as string[] };
  const where = adminAudienceWhere(tenantId);
  const users = await runWithoutTenant(() => prisma.user.findMany({ where, select: { id: true } }), 'cash-return-ops-audience');
  return { tenantId, suppressed: false, userIds: users.map((user) => user.id) };
}

/** One durable operations page about cash at the door: the OpsAlert (its
 * acknowledgement obligation), its recipients and their inbox rows commit in
 * the caller's transaction. Publishing happens after commit. A crash then
 * leaves durable inbox rows; the existing OpsAlert sweep escalates until a
 * human acknowledges, including re-resolving an initially empty audience.
 * No new money or refund rail. */
async function stageCashPage(
  tx: Prisma.TransactionClient,
  order: { id: string; tenantId: string },
  audience: Awaited<ReturnType<typeof doorCashHoldAudience>>,
  page: { title: string; body: string; dedupeKey: string; data: Record<string, string | number> },
): Promise<string[]> {
  if (audience.tenantId !== order.tenantId) {
    throw new AppError(409, 'HANDOVER_STALE', 'This order changed while its cash was being recorded. Refresh before continuing.');
  }
  if (audience.suppressed) return [];
  const now = new Date();
  const alert = await tx.opsAlert.create({
    data: {
      tenantId: order.tenantId, kind: 'PLATFORM', title: page.title, body: page.body,
      ackDeadlineAt: audience.userIds.length ? new Date(now.getTime() + ackDeadlineSeconds() * 1000) : now,
      recipients: { create: audience.userIds.map((userId) => ({ tenantId: order.tenantId, userId })) },
    },
    include: { recipients: true },
  });
  const ids: string[] = [];
  for (const recipient of alert.recipients) {
    const notice = await tx.notification.create({
      data: {
        userId: recipient.userId, type: 'SYSTEM_ANNOUNCEMENT', title: page.title, body: page.body,
        dedupeKey: page.dedupeKey,
        data: { ...page.data, orderId: order.id, opsAlertId: alert.id },
      },
      select: { id: true },
    });
    await tx.opsAlertRecipient.update({
      where: { id: recipient.id }, data: { notificationId: notice.id, deliveredAt: now },
    });
    ids.push(notice.id);
  }
  return ids;
}

/** Partial cash the rider could not hand back: the hold's operations page. */
export async function stageDoorCashHoldPage(
  tx: Prisma.TransactionClient,
  order: { id: string; orderNumber: string; tenantId: string },
  amount: number,
  audience: Awaited<ReturnType<typeof doorCashHoldAudience>>,
): Promise<string[]> {
  // [review S4-3] Never reads as Swift holding the cash: it is the rider's.
  return stageCashPage(tx, order, audience, {
    title: 'Partial cash could not be returned',
    body: `Order ${order.orderNumber}: the rider could not hand GY$${gyd(amount)} back to the customer. `
      + 'The cash is still with the rider; operations will follow up. The goods were not handed over. No automatic refund or deduction was made.',
    dedupeKey: `cash-return-held:${order.id}`,
    data: { kind: 'ops_cash_return_held', amount },
  });
}

/** [review S3-1] A short handover's page commits WITH the handover (the owner
 *  ruled it "recorded, held and paged"), so a lost push never loses it. */
export async function stageDoorCashShortPage(
  tx: Prisma.TransactionClient,
  order: { id: string; orderNumber: string; tenantId: string },
  decision: { due: number; collected: number; shortfall: number },
  audience: Awaited<ReturnType<typeof doorCashHoldAudience>>,
): Promise<string[]> {
  const page = shortHandoverPage(order.orderNumber, decision);
  return stageCashPage(tx, order, audience, {
    title: page.title,
    body: page.body,
    dedupeKey: `cash-door-short:${order.id}`,
    // The kind is a literal on purpose: the mobile notification census scans for it.
    data: { kind: 'ops_cash_door_short', due: decision.due, collected: decision.collected, shortfall: decision.shortfall },
  });
}

/** What operations recorded about partial cash that was held at the door. */
export const DOOR_CASH_RESOLVED_DISPOSITION = 'DOOR_CASH_RESOLVED';

/**
 * [review S2-1] Operations records HELD partial cash as resolved (the rider
 * handed it back later, or it was otherwise settled, as the reason says).
 * Before this nothing in the product could move HELD, so the rider holding it
 * could never close their account. RECORD ONLY: Swift moves, refunds and
 * deducts nothing; the amount, the rider's original report and every other
 * column stay as they were. One transaction: HELD -> RESOLVED (a compare-and-
 * set, so it happens once) and the caller's audit row commit together.
 */
export async function resolveHeldDoorCash(
  prisma: Pick<PrismaClient, '$transaction'>,
  input: {
    orderId: string;
    adminUserId: string;
    reason: string;
    audit: (tx: Prisma.TransactionClient, facts: { disposition: string; amount: number; previousStatus: 'HELD' }) => Promise<void>;
  },
): Promise<{ orderId: string; orderNumber: string; amount: number; resolvedAt: Date }> {
  if (!input.reason.trim()) {
    throw new AppError(400, 'REASON_REQUIRED', 'Say how the held cash was resolved before recording it.');
  }
  return prisma.$transaction(async (tx) => {
    const resolvedAt = new Date();
    const moved = await tx.order.updateMany({
      where: { id: input.orderId, doorCashReturnStatus: 'HELD' },
      data: { doorCashReturnStatus: 'RESOLVED', doorCashReturnResolvedAt: resolvedAt, doorCashReturnResolvedById: input.adminUserId },
    });
    const row = await tx.order.findUnique({
      where: { id: input.orderId },
      select: { id: true, orderNumber: true, doorCashReturnAmount: true },
    });
    if (!row) throw new NotFoundError('Order', input.orderId);
    if (moved.count !== 1) {
      throw new AppError(409, 'NO_HELD_CASH', 'This order has no partial cash held for operations (it was returned at the door, already resolved, or never recorded).');
    }
    const amount = Number(row.doorCashReturnAmount);
    await input.audit(tx, { disposition: DOOR_CASH_RESOLVED_DISPOSITION, amount, previousStatus: 'HELD' });
    return { orderId: row.id, orderNumber: row.orderNumber, amount, resolvedAt };
  });
}
