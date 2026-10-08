import type { Prisma, PrismaClient } from '@prisma/client';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import type { NotificationService } from '../notification/notification.service';
import { checkoutOutboxId } from './checkout-outbox';

export const RIDER_CANCEL_NOTICE_KIND = 'rider-cancel-notice';

/** Called with the cancellation's locked order, before its transaction commits. */
export async function persistRiderCancellationNotice(
  tx: Prisma.TransactionClient,
  order: { id: string; tenantId: string; riderId: string | null },
): Promise<void> {
  if (!order.riderId) return;
  const rider = await tx.rider.findUniqueOrThrow({ where: { id: order.riderId }, select: { userId: true } });
  const dedupeKey = `order:${order.id}:${RIDER_CANCEL_NOTICE_KIND}`;
  const id = checkoutOutboxId(dedupeKey);
  const notificationId = `${id}_inbox`;
  await tx.notification.upsert({
    where: { id: notificationId }, update: {},
    create: {
      id: notificationId, userId: rider.userId, dedupeKey,
      type: 'ORDER_UPDATE', title: 'Delivery cancelled',
      body: 'The customer cancelled this delivery. Stop travelling to its pickup and check your current jobs.',
      data: { orderId: order.id, status: 'CANCELLED', audience: 'earner' },
    },
  });
  await tx.orderOutbox.upsert({
    where: { id }, update: {},
    create: { id, dedupeKey, orderId: order.id, tenantId: order.tenantId,
      kind: RIDER_CANCEL_NOTICE_KIND, queue: 'notification',
      payload: { orderId: order.id, riderUserId: rider.userId, notificationId },
    },
  });
}

/** One inbox row; retry push submission after outages or a lost response. */
export async function drainRiderCancellationNotices(
  deps: { prisma: PrismaClient; notifications: Pick<NotificationService, 'publishPersisted'>; now?: () => Date },
  options: { orderId?: string; limit?: number } = {},
): Promise<{ delivered: number; pending: number }> {
  const system = <T>(fn: () => Promise<T>) => runAsSystem('rider-cancel-notice-drain', fn);
  const clock = () => deps.now?.() ?? new Date();
  let delivered = 0;
  let pending = 0;
  for (let i = 0; i < Math.min(200, Math.max(1, options.limit ?? 50)); i += 1) {
    const now = clock();
    const due = {
      kind: RIDER_CANCEL_NOTICE_KIND, processedAt: null, availableAt: { lte: now },
      ...(options.orderId ? { orderId: options.orderId } : {}),
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 60_000) } }],
    };
    const row = await system(() => deps.prisma.orderOutbox.findFirst({ where: due, orderBy: [{ availableAt: 'asc' }, { id: 'asc' }] }));
    if (!row) break;
    const claim = await system(() => deps.prisma.orderOutbox.updateMany({
      where: { ...due, id: row.id, attempts: row.attempts },
      data: { claimedAt: now, attempts: { increment: 1 } },
    }));
    if (claim.count !== 1) continue;
    const attempts = row.attempts + 1;
    let sent = false;
    try {
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload['notificationId'] === 'string' && typeof payload['riderUserId'] === 'string' && payload['orderId'] === row.orderId) {
        sent = await runWithTenant(row.tenantId, async () => {
          const notice = await deps.prisma.notification.findFirst({ where: {
            id: payload['notificationId'] as string, user: { tenantId: row.tenantId }, userId: payload['riderUserId'] as string,
            dedupeKey: row.dedupeKey,
          }, select: { id: true } });
          return notice ? deps.notifications.publishPersisted(notice.id, { requirePush: true }) : false;
        });
      }
    } catch { /* The durable notice remains pending; the sweep retries it. */ }
    await system(() => deps.prisma.orderOutbox.updateMany({
      where: { id: row.id, processedAt: null, attempts },
      data: sent ? { processedAt: clock(), claimedAt: null, lastError: null } : {
        claimedAt: null, lastError: 'Cancellation push not confirmed',
        availableAt: new Date(clock().getTime() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8))),
      },
    }));
    if (sent) delivered += 1; else pending += 1;
  }
  return { delivered, pending };
}
