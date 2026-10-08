import type { Prisma, PrismaClient } from '@prisma/client';
import { AppError } from '../../utils/errors';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { HANDOVER_SECRETS_OMIT } from '../handover/handover-security';
import type { NotificationService } from '../notification/notification.service';
import { checkoutOutboxId } from '../order/checkout-outbox';
import { lockTaxiOrderForCustodyDecision } from './passenger-custody';
import { taxiNotificationData } from './taxi-notification';

export const DRIVER_PICKUP_NOTICE_KIND = 'driver-pickup-notice';
type PickupStatus = 'DRIVER_EN_ROUTE' | 'DRIVER_ARRIVED';

/** The caller's observed assignment must still own the locked pickup step. */
export async function advanceDriverPickup(prisma: PrismaClient, input: {
  orderId: string; driverId: string; assignmentVersion: number; changedBy: string;
  from: 'DRIVER_ASSIGNED' | 'DRIVER_EN_ROUTE'; target: PickupStatus;
  note: string; arrivedAt?: Date; etaMinutes?: number | null;
}) {
  return prisma.$transaction(async (tx) => {
    await lockTaxiOrderForCustodyDecision(tx, input.orderId);
    const current = await tx.order.findUnique({ where: { id: input.orderId } });
    if (!current || current.orderType !== 'TAXI' || current.driverId !== input.driverId
        || current.driverAssignmentVersion !== input.assignmentVersion) {
      throw new AppError(409, 'ACTOR_NOT_ASSIGNED', 'This ride assignment changed. Refresh your current ride.');
    }
    if (current.status !== input.from) {
      throw new AppError(409, 'INVALID_STATUS', `Cannot advance pickup from status ${current.status}`);
    }
    const updated = await tx.order.update({ where: { id: input.orderId },
      data: { status: input.target, ...(input.arrivedAt ? { driverArrivedAt: input.arrivedAt } : {}) },
      omit: HANDOVER_SECRETS_OMIT,
    });
    await tx.orderStatusLog.create({ data: { orderId: input.orderId, status: input.target, changedBy: input.changedBy, note: input.note } });
    const dedupeKey = `order:${current.id}:${DRIVER_PICKUP_NOTICE_KIND}:${current.driverAssignmentVersion}:${input.target}`;
    const id = checkoutOutboxId(dedupeKey);
    const notificationId = `${id}_inbox`;
    const arrived = input.target === 'DRIVER_ARRIVED';
    await tx.notification.upsert({ where: { id: notificationId }, update: {}, create: {
      id: notificationId, userId: current.customerId, dedupeKey, type: 'ORDER_UPDATE',
      title: arrived ? 'Driver Arrived' : 'Driver En Route',
      body: arrived ? 'Your driver has arrived. Please share your ride PIN to begin the trip.'
        : input.etaMinutes ? `Your driver is on the way. Arriving in ~${input.etaMinutes} minutes.` : 'Your driver is on the way to pick you up.',
      data: taxiNotificationData(current.id, { status: input.target, ...(!arrived && input.etaMinutes != null ? { eta: input.etaMinutes } : {}) }) as Prisma.InputJsonValue,
    } });
    await tx.orderOutbox.upsert({ where: { id }, update: {}, create: {
      id, dedupeKey, orderId: current.id, tenantId: current.tenantId, kind: DRIVER_PICKUP_NOTICE_KIND, queue: 'notification',
      payload: { orderId: current.id, notificationId, driverId: input.driverId, assignmentVersion: current.driverAssignmentVersion, status: input.target, customerId: current.customerId },
    } });
    return updated;
  });
}

/** Retry a persisted pickup notice, suppressing already obsolete assignment facts. */
export async function drainDriverPickupNotices(
  deps: { prisma: PrismaClient; notifications: Pick<NotificationService, 'publishPersisted'>; now?: () => Date },
  options: { orderId?: string; limit?: number } = {},
): Promise<{ delivered: number; pending: number; obsolete: number }> {
  const system = <T>(fn: () => Promise<T>) => runAsSystem('driver-pickup-notice-drain', fn);
  const clock = () => deps.now?.() ?? new Date();
  let delivered = 0; let pending = 0; let obsolete = 0;
  for (let i = 0; i < Math.min(200, Math.max(1, options.limit ?? 50)); i += 1) {
    const now = clock();
    const due = { kind: DRIVER_PICKUP_NOTICE_KIND, processedAt: null, availableAt: { lte: now },
      ...(options.orderId ? { orderId: options.orderId } : {}),
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - 60_000) } }],
    };
    const row = await system(() => deps.prisma.orderOutbox.findFirst({ where: due, orderBy: [{ availableAt: 'asc' }, { id: 'asc' }] }));
    if (!row) break;
    const claim = await system(() => deps.prisma.orderOutbox.updateMany({ where: { ...due, id: row.id, attempts: row.attempts }, data: { claimedAt: now, attempts: { increment: 1 } } }));
    if (claim.count !== 1) continue;
    const attempts = row.attempts + 1;
    let outcome: 'delivered' | 'pending' | 'obsolete' = 'pending';
    try {
      const payload = row.payload as Record<string, unknown>;
      if (typeof payload['notificationId'] === 'string' && typeof payload['customerId'] === 'string' && payload['orderId'] === row.orderId) {
        outcome = await runWithTenant(row.tenantId, async () => {
          const order = await deps.prisma.order.findFirst({ where: { id: row.orderId, tenantId: row.tenantId },
            select: { driverId: true, driverAssignmentVersion: true, status: true, customerId: true },
          });
          if (!order || order.driverId !== payload['driverId'] || order.driverAssignmentVersion !== payload['assignmentVersion']
              || order.status !== payload['status'] || order.customerId !== payload['customerId']) return 'obsolete';
          const notice = await deps.prisma.notification.findFirst({ where: {
            id: payload['notificationId'] as string, userId: order.customerId, user: { tenantId: row.tenantId }, dedupeKey: row.dedupeKey,
          }, select: { id: true } });
          return notice && await deps.notifications.publishPersisted(notice.id, { requirePush: true }) ? 'delivered' : 'pending';
        });
      }
    } catch { /* The durable notice is retried by the next sweep. */ }
    await system(() => deps.prisma.orderOutbox.updateMany({ where: { id: row.id, processedAt: null, attempts },
      data: outcome !== 'pending' ? { processedAt: clock(), claimedAt: null, lastError: null } : {
        claimedAt: null, lastError: 'Pickup push not confirmed', availableAt: new Date(clock().getTime() + Math.min(300_000, 2_000 * 2 ** Math.min(attempts, 8))),
      },
    }));
    if (outcome === 'delivered') delivered += 1; else if (outcome === 'obsolete') obsolete += 1; else pending += 1;
  }
  return { delivered, pending, obsolete };
}
