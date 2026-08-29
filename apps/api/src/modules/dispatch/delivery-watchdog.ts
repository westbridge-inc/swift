import type { OrderStatus, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { FloatService } from './float.service';
import { lockTaxiOrderForCustodyDecision } from '../rides/passenger-custody';
import { log } from '../../utils/logger';
import { TERMINAL_ORDER_STATUSES } from '../order/order-status';

const STALE_LOCATION_MINUTES = 15;

/**
 * [danger #32 / E25] Watchdog for a DELIVERY whose rider went GPS-dark after
 * claiming — the delivery twin of `recoverStrandedTaxiRides`. Such an order is
 * invisible to every other sweep: `reconcileStuckDispatch` only re-drives
 * riderId-null work, and `sweepStaleMovers` flips isOnline but never clears
 * `currentOrderId` or touches the order. So the food sits READY, the
 * customer's map freezes, and nothing ever completes. Resolution by custody
 * stage, decided on the SAME order lock every money/cancel path takes:
 *   • goods still AT THE STORE (RIDER_ASSIGNED / EN_ROUTE_PICKUP /
 *     ARRIVED_PICKUP): controlled release — order re-opens to its honest
 *     pre-assignment stage, the rider's committed CASH float is released in
 *     the same transaction, the dark rider is excluded from the re-cascade,
 *     and dispatch re-runs. Exactly what a rider-cancel would have done.
 *   • goods WITH THE RIDER (PICKED_UP / EN_ROUTE_DELIVERY / ARRIVED): NEVER
 *     auto-release — the rider holds the goods and fronted the vendor cash.
 *     Page ops once and tell the customer, so a frozen map is not the only
 *     cue. The custody pointer stays.
 * Idempotent: a re-run finds the order already re-opened / already paged.
 */
export async function recoverStrandedDeliveries(
  prisma: PrismaClient,
  redis: Redis,
  io: Server,
  enqueue: (orderId: string) => Promise<void>,
  staleMinutes = STALE_LOCATION_MINUTES,
): Promise<{ recovered: string[]; flagged: string[] }> {
  const cutoff = new Date(Date.now() - staleMinutes * 60_000);
  const stale = await prisma.rider.findMany({
    where: {
      currentOrderId: { not: null },
      OR: [{ lastLocationUpdate: { lt: cutoff } }, { lastLocationUpdate: null }],
    },
    select: { id: true, currentOrderId: true },
  });
  if (stale.length === 0) return { recovered: [], flagged: [] };

  const notifications = new NotificationService(prisma, io);
  const PRE_CUSTODY: OrderStatus[] = ['RIDER_ASSIGNED', 'RIDER_EN_ROUTE_PICKUP', 'RIDER_ARRIVED_PICKUP'];
  const IN_CUSTODY: OrderStatus[] = ['PICKED_UP', 'EN_ROUTE_DELIVERY', 'ARRIVED'];
  const TERMINAL = TERMINAL_ORDER_STATUSES; // ONE definition [order/order-status.ts]
  const recovered: string[] = [];
  const flagged: string[] = [];

  for (const r of stale) {
    const orderId = r.currentOrderId!;
    const decision = await prisma.$transaction(async (tx) => {
      // The canonical orders row lock (the helper locks ANY order row).
      await lockTaxiOrderForCustodyDecision(tx, orderId);
      const order = await tx.order.findUnique({
        where: { id: orderId },
        select: {
          tenantId: true, // the ops page follows the order's tenant [NOC-A F45]
          id: true, status: true, orderType: true, customerId: true, orderNumber: true,
          riderId: true, paymentMethod: true, subtotalBase: true,
          preparingAt: true, readyAt: true, vendorId: true,
        },
      });

      const assignedLiveDelivery = order
        && order.orderType !== 'TAXI'
        && order.riderId === r.id
        && !TERMINAL.includes(order.status);

      if (assignedLiveDelivery && IN_CUSTODY.includes(order.status)) {
        return { kind: 'FLAGGED' as const, order };
      }

      // Terminal/foreign/non-live pointer is damage, not custody — heal it
      // under the same lock.
      if (!assignedLiveDelivery || !PRE_CUSTODY.includes(order.status)) {
        await tx.rider.updateMany({
          where: { id: r.id, currentOrderId: orderId },
          data: { currentOrderId: null },
        });
        return { kind: 'IGNORED' as const };
      }

      // Goods still at the store: controlled release + re-dispatch. Re-open to
      // the honest kitchen stage the order had before assignment.
      const reopenStatus: OrderStatus = order.readyAt ? 'READY_FOR_PICKUP' : order.preparingAt ? 'PREPARING' : 'ACCEPTED';
      await tx.order.update({
        where: { id: orderId },
        data: { status: reopenStatus, riderId: null },
      });
      await tx.rider.updateMany({
        where: { id: r.id, currentOrderId: orderId },
        data: { isAvailable: false, currentOrderId: null }, // gone dark → not free supply
      });
      // The rider fronted NOTHING yet (goods never left the store), but their
      // committed CASH float was reserved at claim — release it with the
      // assignment, atomically, or their headroom leaks forever.
      if (order.paymentMethod === 'CASH') {
        await new FloatService(tx).release(tx, r.id, Number(order.subtotalBase));
      }
      await tx.orderStatusLog.create({
        data: { orderId, status: reopenStatus, changedBy: 'system:delivery-watchdog', note: 'Rider went GPS-dark before pickup — auto-released and re-dispatched' },
      });
      return { kind: 'RELEASED' as const, order, reopenStatus };
    });

    if (decision.kind === 'IGNORED') continue;
    const order = decision.order;
    if (decision.kind === 'FLAGGED') {
      // Once-guard with the same claim-first/release-on-failure semantics as
      // opsPageOnce — deliberately NOT imported from jobs/queue: that module
      // carries BullMQ scheduling side effects that must never ride a
      // watchdog import (it broke the outbox suite's isolation).
      const pageKey = `ops_page:delivery_rider_dropped:${orderId}`;
      const claimed = await redis.set(pageKey, '1', 'EX', 1800, 'NX').catch(() => null);
      if (claimed === 'OK') {
        try {
          await notifyAdmins(prisma, notifications, {
            // Scoped to the order [NOC-A F45].
            tenantId: order.tenantId ?? null,
            title: 'Delivery rider lost signal with the goods',
            body: `Order ${order.orderNumber}: the rider's GPS went dark AFTER pickup — they hold the goods${order.paymentMethod === 'CASH' ? ' and fronted the vendor cash' : ''}. Contact both parties — do NOT auto-cancel.`,
            data: { kind: 'ops_delivery_rider_dropped', orderId },
          });
        } catch {
          await redis.del(pageKey).catch(() => {}); // failed page → let the next sweep re-page
        }
      }
      await notifications.send({
        userId: order.customerId,
        type: 'ORDER_UPDATE',
        title: 'Your rider lost signal',
        body: 'We’ve lost your rider’s live location after pickup. We’re reaching out to them — contact support if your order doesn’t arrive shortly.',
        data: { orderId, status: order.status },
      }).catch(() => {});
      flagged.push(orderId);
      continue;
    }

    // Exclude the dark rider from the re-cascade (same key the cascade reads;
    // module-private there, mirrored here by contract).
    await redis.sadd(`dispatch:declined:${orderId}`, r.id).catch(() => {});
    await redis.expire(`dispatch:declined:${orderId}`, 3600).catch(() => {});
    io.to(`order:${orderId}`).emit('order:status_changed', { orderId, status: decision.reopenStatus, reason: 'rider_dropped' });
    await notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: 'Finding you another rider',
      body: 'Your rider dropped off the map before pickup — we’re matching the nearest available rider now.',
      data: { orderId, status: decision.reopenStatus },
    }).catch(() => {});
    await enqueue(orderId).catch(() => {});
    log().info({ orderId, riderId: r.id }, 'delivery-watchdog: pre-custody release + redispatch');
    recovered.push(orderId);
  }

  return { recovered, flagged };
}
