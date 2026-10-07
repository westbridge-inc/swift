import type { Prisma, PrismaClient } from '@prisma/client';
import { runWithoutTenant } from '../../plugins/tenant-context';
import { AppError } from '../../utils/errors';
import { adminAudienceFor } from '../notification/notification.service';
import { ackDeadlineSeconds } from '../safety/ops-alert';
import { gyd } from './door-cash';

/** Resolve the existing operations audience without inheriting a rider's
 * tenant filter. Store-review fiction must never page real operators. */
export async function doorCashHoldAudience(prisma: PrismaClient, tenantId: string) {
  const { where, review } = await adminAudienceFor(prisma, tenantId);
  if (review) return { tenantId, suppressed: true, userIds: [] as string[] };
  const users = await runWithoutTenant(() => prisma.user.findMany({ where, select: { id: true } }), 'cash-return-ops-audience');
  return { tenantId, suppressed: false, userIds: users.map((user) => user.id) };
}

/** The hold, acknowledgement obligation and inbox page share one transaction.
 * Publishing happens after commit. A crash then leaves durable inbox rows;
 * the existing OpsAlert sweep escalates until a human acknowledges, including
 * re-resolving an initially empty audience. No new money or refund rail. */
export async function stageDoorCashHoldPage(
  tx: Prisma.TransactionClient,
  order: { id: string; orderNumber: string; tenantId: string },
  amount: number,
  audience: Awaited<ReturnType<typeof doorCashHoldAudience>>,
): Promise<string[]> {
  if (audience.tenantId !== order.tenantId) {
    throw new AppError(409, 'HANDOVER_STALE', 'This order changed while its cash return was being recorded. Refresh before continuing.');
  }
  if (audience.suppressed) return [];
  const now = new Date();
  const title = 'Partial cash could not be returned';
  const body = `Order ${order.orderNumber}: the rider could not hand GY$${gyd(amount)} back to the customer. `
    + 'The cash remains with the rider and is held for operations. The goods were not handed over. No automatic refund or deduction was made.';
  const alert = await tx.opsAlert.create({
    data: {
      tenantId: order.tenantId, kind: 'PLATFORM', title, body,
      ackDeadlineAt: audience.userIds.length ? new Date(now.getTime() + ackDeadlineSeconds() * 1000) : now,
      recipients: { create: audience.userIds.map((userId) => ({ tenantId: order.tenantId, userId })) },
    },
    include: { recipients: true },
  });
  const ids: string[] = [];
  for (const recipient of alert.recipients) {
    const notice = await tx.notification.create({
      data: {
        userId: recipient.userId, type: 'SYSTEM_ANNOUNCEMENT', title, body,
        dedupeKey: `cash-return-held:${order.id}`,
        data: { kind: 'ops_cash_return_held', orderId: order.id, amount, opsAlertId: alert.id },
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
