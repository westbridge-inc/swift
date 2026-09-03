import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client';
import type { Server } from 'socket.io';
import type Redis from 'ioredis';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { FloatService, riderFloatForOrder } from './float.service';
import { settleRiderLegs } from './concurrency-policy';
import { lockTaxiOrderForCustodyDecision } from '../rides/passenger-custody';
import { log } from '../../utils/logger';
import {
  TERMINAL_ORDER_STATUSES,
  RIDER_PRE_CUSTODY_STATUSES,
  RIDER_IN_CUSTODY_STATUSES,
  assertRecoveryTransition,
  releaseStageFor,
} from '../order/order-status';

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

/** The single-leg PRE-CUSTODY reopen kernel — ONE body, every caller.
 *
 *  Lives here because the watchdog shipped it first (#902); the rider-initiated
 *  handback (G14) is the second caller, and mover-authority's #904 rider branch
 *  is a third body that should fold into this on its next touch. Inside the
 *  caller's transaction: re-open to the honest kitchen stage, clear the
 *  assignment, release the CASH float WITH the assignment (or headroom leaks
 *  forever), and write the status-log marker. The caller settles the pointer
 *  through the seam and owns every post-commit effect (exclusion, sockets,
 *  notification, redispatch) — this kernel touches canonical rows only.
 */
export async function reopenPreCustodyLeg(
  tx: Prisma.TransactionClient,
  order: {
    id: string; status: OrderStatus; orderType: string | null;
    riderId: string | null; paymentMethod: string;
    subtotalBase: Prisma.Decimal | number; readyAt: Date | null; preparingAt: Date | null;
  },
  changedBy: string,
  note: string,
): Promise<OrderStatus> {
  const reopenStatus = releaseStageFor(order);
  // The kernel guards its OWN precondition. It used to take the order without
  // its status and trust every caller to have checked custody first — so a
  // third caller that forgot would have released an order whose goods were
  // already in the rider's bag, and freed the float they had fronted with it.
  assertRecoveryTransition(order.status, reopenStatus);
  await tx.order.update({
    where: { id: order.id },
    data: { status: reopenStatus, riderId: null },
  });
  if (order.riderId) {
    await new FloatService(tx).release(tx, order.riderId, riderFloatForOrder(order));
  }
  await tx.orderStatusLog.create({
    data: { orderId: order.id, status: reopenStatus, changedBy, note },
  });
  return reopenStatus;
}

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
  const PRE_CUSTODY = RIDER_PRE_CUSTODY_STATUSES;
  const IN_CUSTODY = RIDER_IN_CUSTODY_STATUSES;
  const TERMINAL = TERMINAL_ORDER_STATUSES; // ONE definition [order/order-status.ts]
  const recovered: string[] = [];
  const flagged: string[] = [];

  for (const r of stale) {
    // [B2 under stacking] The pointer found the rider; it is not the rider's
    // only leg. Since #899 a rider may carry up to `stacking.riderCapacity`
    // live orders and `currentOrderId` is only the PRIMARY one. Rescuing that
    // order and stopping left a stacked sibling assigned to a rider nobody can
    // reach — invisible to every other sweep, exactly the condition this
    // watchdog exists for. So every live delivery leg gets the same custody
    // decision, one lock each; at capacity 1 the list has one entry and the
    // behaviour is byte-identical to before.
    const legs = await prisma.order.findMany({
      where: { riderId: r.id, orderType: { not: 'TAXI' }, status: { notIn: TERMINAL } },
      select: { id: true },
      orderBy: { acceptedAt: 'asc' },
    });
    if (legs.length === 0) {
      // A pointer with no live leg behind it is damage, not custody — heal it
      // the same way a finished leg would, through the seam.
      await prisma.$transaction((tx) => settleRiderLegs(tx, r.id, { availability: 'offline' }));
      continue;
    }
    // QUARANTINE FIRST. Each rescue below frees headroom (the rescued leg no
    // longer counts against the rider), so between a rescue and the final
    // settle a cascade round could bind a NEW leg to a rider about to be
    // marked dark — recreating the exact state this sweep exists to end, one
    // transaction later. Marking the rider unavailable before touching any
    // leg closes that window. The pointer is untouched here (every leg is
    // still live) and is re-settled once the sweep is done.
    await prisma.$transaction((tx) => settleRiderLegs(tx, r.id, { availability: 'offline' }));
    let releasedAny = false;
    for (const leg of legs) {
    const orderId = leg.id;
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

      // Raced away between the select and the lock (completed, cancelled,
      // reassigned) — nothing to decide for this leg.
      if (!assignedLiveDelivery || !PRE_CUSTODY.includes(order.status)) {
        return { kind: 'IGNORED' as const };
      }

      // Goods still at the store: controlled release + re-dispatch through the
      // ONE reopen kernel above. The pointer and availability are NOT written
      // here: they are settled once, after every leg, through the seam — so a
      // dark rider and a finishing rider leave the pointer in the same shape.
      const reopenStatus = await reopenPreCustodyLeg(
        tx,
        order,
        'system:delivery-watchdog',
        'Rider went GPS-dark before pickup — auto-released and re-dispatched',
      );
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
    releasedAny = true;
    }
    // Settle the primary pointer and availability ONCE from what the rider
    // still holds. `offline` pins isAvailable false — gone dark is not free
    // supply, even with an empty hand — which is what the old per-order write
    // did; the pointer now re-points to a surviving in-custody leg instead of
    // being nulled under it.
    await prisma.$transaction((tx) => settleRiderLegs(tx, r.id, { availability: 'offline' }));
    if (releasedAny) log().info({ riderId: r.id, legs: legs.length }, 'delivery-watchdog: rider legs settled');
  }
  return { recovered, flagged };
}
