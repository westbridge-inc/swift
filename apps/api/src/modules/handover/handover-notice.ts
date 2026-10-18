import type { Prisma, PrismaClient } from '@prisma/client';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import type { NotificationService } from '../notification/notification.service';
import { checkoutOutboxId } from '../order/checkout-outbox';

export const HANDOVER_NOTICE_KIND = 'handover-completed-notice';
/** [REVIEW-B 14 Oct S2-1] A failing push is retried for this long, then closed
 *  unconfirmed (the inbox notice remains), as the rider-cancel notice does. */
export const HANDOVER_NOTICE_WINDOW_MS = 30 * 60_000;

/** Terminal proof and its customer-facing obligation share the same commit. */
export async function persistHandoverNotice(tx: Prisma.TransactionClient, order: {
  id: string; tenantId: string; customerId: string; orderNumber: string; status: string;
}): Promise<void> {
  const dedupeKey = `order:${order.id}:${HANDOVER_NOTICE_KIND}`;
  const id = checkoutOutboxId(dedupeKey);
  const notificationId = `${id}_inbox`;
  const pickup = order.status === 'COMPLETED';
  await tx.notification.upsert({ where: { id: notificationId }, update: {}, create: {
    id: notificationId, userId: order.customerId, dedupeKey, type: 'ORDER_UPDATE',
    title: pickup ? 'Order collected' : 'Delivered!',
    body: pickup ? `Your order ${order.orderNumber} has been collected.` : `Your order ${order.orderNumber} has been delivered. Enjoy your meal!`,
    data: { orderId: order.id, orderNumber: order.orderNumber, status: order.status, audience: 'customer' },
  } });
  await tx.orderOutbox.upsert({ where: { id }, update: {}, create: {
    id, dedupeKey, orderId: order.id, tenantId: order.tenantId, kind: HANDOVER_NOTICE_KIND, queue: 'notification',
    payload: { orderId: order.id, customerUserId: order.customerId, notificationId },
  } });
}

/** One inbox row; retry push submission after outages or a lost response.
 *  Every row ends: delivered once when the customer has no push channel (the
 *  inbox row IS the channel), delivered when push confirms, or closed
 *  unconfirmed after HANDOVER_NOTICE_WINDOW_MS. */
export async function drainHandoverNotices(
  deps: { prisma: PrismaClient; notifications: Pick<NotificationService, 'publishPersisted'>; now?: () => Date },
  options: { orderId?: string; limit?: number } = {},
): Promise<{ delivered: number; pending: number; expired: number }> {
  const system = <T>(fn: () => Promise<T>) => runAsSystem('handover-notice-drain', fn);
  const clock = () => deps.now?.() ?? new Date();
  let delivered = 0;
  let pending = 0;
  let expired = 0;
  for (let i = 0; i < Math.min(200, Math.max(1, options.limit ?? 50)); i += 1) {
    const now = clock();
    const due = {
      kind: HANDOVER_NOTICE_KIND, processedAt: null, availableAt: { lte: now },
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
    if (now.getTime() - row.createdAt.getTime() >= HANDOVER_NOTICE_WINDOW_MS) {
      // The end state for a push that never confirms: closed, recorded, no more socket repeats.
      await system(() => deps.prisma.orderOutbox.updateMany({
        where: { id: row.id, processedAt: null, attempts },
        data: { processedAt: clock(), claimedAt: null, lastError: 'Handover push not confirmed within its window; the inbox notice remains' },
      }));
      expired += 1;
      continue;
    }
    let sent = false;
    try {
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload['notificationId'] === 'string' && typeof payload['customerUserId'] === 'string' && payload['orderId'] === row.orderId) {
        sent = await runWithTenant(row.tenantId, async () => {
          const notice = await deps.prisma.notification.findFirst({ where: {
            id: payload['notificationId'] as string, user: { tenantId: row.tenantId }, userId: payload['customerUserId'] as string,
            dedupeKey: row.dedupeKey,
          }, select: { id: true } });
          if (!notice) return false;
          // No push channel (push turned off, or no active device): the inbox
          // row is the delivery, so publish it once and close; push is
          // required only where a device could actually receive it.
          const customer = await deps.prisma.user.findFirst({ where: { id: payload['customerUserId'] as string, tenantId: row.tenantId }, select: { notificationPrefs: true } });
          const pushOn = (customer?.notificationPrefs as { push?: unknown } | null)?.push !== false;
          const devices = pushOn ? await deps.prisma.deviceToken.count({ where: { userId: payload['customerUserId'] as string, isActive: true } }) : 0;
          return deps.notifications.publishPersisted(notice.id, { requirePush: devices > 0 });
        });
      }
    } catch { /* The durable notice remains pending; the sweep retries it. */ }
    await system(() => deps.prisma.orderOutbox.updateMany({
      where: { id: row.id, processedAt: null, attempts },
      data: sent ? { processedAt: clock(), claimedAt: null, lastError: null } : {
        claimedAt: null, lastError: 'Handover push not confirmed',
        availableAt: new Date(clock().getTime() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8))),
      },
    }));
    if (sent) delivered += 1; else pending += 1;
  }
  return { delivered, pending, expired };
}
