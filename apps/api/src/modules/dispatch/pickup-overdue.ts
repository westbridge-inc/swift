import type { OrderStatus, Prisma, PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { emitToOrderRoom } from '../order/order-room-emission.service';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
import { RIDER_PRE_CUSTODY_STATUSES } from '../order/order-status';
import { lockTaxiOrderForCustodyDecision } from '../rides/passenger-custody';
import { algoConfig } from '../algo/algo-config';
import { sweepPage } from '../../lib/sweep-cursor';
import { log } from '../../utils/logger';
import { haversineDistance } from '../../utils/distance';
import { recordDecision } from '../algo/decisions';
import { openOpsAlert } from '../safety/ops-alert';
import { reopenPreCustodyLeg } from './delivery-watchdog';
import { settleRiderLegs } from './concurrency-policy';
import { dispatchDeclinedKey } from './dispatch-generation-keys';
import { waitClock } from './rescue';

/**
 * [OF-33 · COORD ruling 21 Oct 2026] A rider who accepted an order and then
 * never picks it up, with GPS alive, held it forever: the food-age sweep reads
 * riderless orders only, and the delivery watchdog acts only when GPS goes
 * dark. Now, built the way OF-01 was:
 *
 *   pickupDue = the later of the order's ready time (readyAt, else the store's
 *               accept + its prep promise; a parcel's start) and the rider's
 *               accept + `rescue.pickupTravelMinutes`.
 *   pickupDue + `rescue.pickupNudgeMinutes`: ONE push to the rider.
 *   pickupDue + `rescue.pickupReleaseMinutes`, no pickup confirmed: the leg
 *               goes BACK TO DISPATCH through the one pre-custody reopen
 *               kernel and the stacking seam — never cancelled. The rider's
 *               acceptance is a no-show (their completion rate takes a miss),
 *               nothing is paid (a mover is paid only at DELIVERED), the
 *               customer and the store are told once each, ops is paged once.
 *
 * Only a leg with NO goods in the rider's hands qualifies: a confirmed pickup
 * is a custody status and never matches, and a cash order whose money a rider
 * already took (CAPTURED before pickup: a courier sender's fee) is excluded —
 * a person holds that cash (OF-07). On a stacked run only the overdue leg is
 * released; `settleRiderLegs` re-points the rider at the leg they keep.
 */

export const PICKUP_OVERDUE_SWEEP = 'rescue.pickup-overdue';
const PAGE_SIZE = 200;

export interface PickupOverdueDeps {
  prisma: PrismaClient;
  redis: Redis;
  io: Server;
  notifications: NotificationService;
}

export interface PickupClock {
  /** When the rider took the current assignment (its RIDER_ASSIGNED log). */
  riderAcceptedAt: Date;
  pickupDue: Date;
  nudgeAt: Date;
  releaseAt: Date;
}

export interface PickupMinutes { travel: number; nudge: number; release: number }

export async function pickupMinutes(prisma: PrismaClient, tenantId: string): Promise<PickupMinutes> {
  const [travel, nudge, release] = await Promise.all([
    algoConfig(prisma, 'rescue.pickupTravelMinutes', tenantId),
    algoConfig(prisma, 'rescue.pickupNudgeMinutes', tenantId),
    algoConfig(prisma, 'rescue.pickupReleaseMinutes', tenantId),
  ]);
  return { travel: Number(travel.value), nudge: Number(nudge.value), release: Number(release.value) };
}

/** THE pickup clock of one assignment (pure, so the ruling's arithmetic is testable). */
export function pickupClock(
  order: Parameters<typeof waitClock>[0],
  riderAcceptedAt: Date,
  minutes: PickupMinutes,
): PickupClock {
  const ready = waitClock(order)?.start ?? riderAcceptedAt;
  const travelDue = riderAcceptedAt.getTime() + minutes.travel * 60_000;
  const due = Math.max(ready.getTime(), travelDue);
  return {
    riderAcceptedAt,
    pickupDue: new Date(due),
    nudgeAt: new Date(due + minutes.nudge * 60_000),
    releaseAt: new Date(due + minutes.release * 60_000),
  };
}

/** One nudge per rider assignment, ever. */
export function pickupNudgeKey(orderId: string, assignmentVersion: number): string {
  return `pickup-overdue:rider:${orderId}:${assignmentVersion}`;
}
/** One release notice per person per released assignment, ever. */
export function pickupReleaseKey(who: 'customer' | 'store' | 'ops' | 'store-waiting' | 'ops-waiting', orderId: string, assignmentVersion: number): string {
  return `pickup-overdue:${who}:${orderId}:${assignmentVersion}`;
}

const select = {
  id: true, orderNumber: true, tenantId: true, orderType: true, status: true, customerId: true,
  riderId: true, riderAssignmentVersion: true, paymentMethod: true, paymentStatus: true,
  subtotalBase: true, fulfillmentModeVersion: true,
  readyAt: true, preparingAt: true, acceptedAt: true, estimatedPrepTime: true, placedAt: true, holdExpiresAt: true, scheduledFor: true,
  vendorId: true, pickupLat: true, pickupLng: true,
  rider: { select: { userId: true, currentLat: true, currentLng: true, lastLocationUpdate: true } },
  vendor: { select: { owner: { select: { userId: true } } } },
} as const;
type Leg = Prisma.OrderGetPayload<{ select: typeof select }>;

export interface ArrivalProof { maxFixAgeMinutes: number; maxMetres: number }

export async function arrivalProof(prisma: PrismaClient, tenantId: string): Promise<ArrivalProof> {
  const [age, metres] = await Promise.all([
    algoConfig(prisma, 'rescue.arrivedFixMaxAgeMinutes', tenantId),
    algoConfig(prisma, 'rescue.arrivedFixMaxMetres', tenantId),
  ]);
  return { maxFixAgeMinutes: Number(age.value), maxMetres: Number(metres.value) };
}

/** Once exempt this many release windows since arrival, a person must decide. */
export const ARRIVED_WAIT_ESCALATION_FACTOR = 3;

/**
 * The rider is at the counter of a STORE that has not marked the order ready —
 * and their own GPS says so. [COORD security ruling 21 Oct] The exemption fails
 * closed: (a) store orders only (a courier leg has no store "ready", so it would
 * never release); (b) a tap is not proof — the rider's last fix must be fresh
 * and near the pickup point, or the leg is treated as NOT arrived.
 */
function riderWaitingOnStore(
  o: {
    status: string; readyAt: Date | null; orderType: string; vendorId: string | null;
    pickupLat: number | null; pickupLng: number | null;
    rider: { currentLat: number | null; currentLng: number | null; lastLocationUpdate: Date | null } | null;
  },
  proof: ArrivalProof,
  now: Date,
): boolean {
  if (o.status !== 'RIDER_ARRIVED_PICKUP' || o.readyAt != null) return false;
  if (o.orderType === 'COURIER' || !o.vendorId) return false;
  const fix = o.rider;
  if (!fix?.lastLocationUpdate || fix.currentLat == null || fix.currentLng == null || o.pickupLat == null || o.pickupLng == null) return false;
  if (now.getTime() - fix.lastLocationUpdate.getTime() > proof.maxFixAgeMinutes * 60_000) return false;
  return haversineDistance(fix.currentLat, fix.currentLng, o.pickupLat, o.pickupLng) * 1000 <= proof.maxMetres;
}

/** A cash order whose money a rider already took is goods-in-hand (OF-07). */
function cashInHand(o: { paymentMethod: string; paymentStatus: string }): boolean {
  return o.paymentMethod === 'CASH' && o.paymentStatus === 'CAPTURED';
}

async function riderAcceptedAt(prisma: PrismaClient | Prisma.TransactionClient, orderId: string, status: 'RIDER_ASSIGNED' | 'RIDER_ARRIVED_PICKUP' = 'RIDER_ASSIGNED'): Promise<Date | null> {
  const row = await prisma.orderStatusLog.findFirst({
    where: { orderId, status },
    orderBy: { createdAt: 'desc' },
    select: { createdAt: true },
  });
  return row?.createdAt ?? null;
}

export type PickupOutcome = 'NOT_DUE' | 'NUDGED' | 'WAITING' | 'RELEASED' | 'STORE_PAGED' | 'IGNORED';

export async function sweepPickupOverdue(
  deps: PickupOverdueDeps,
  enqueue: (orderId: string) => Promise<void>,
  now = new Date(),
): Promise<{ nudged: string[]; released: string[] }> {
  const nudged: string[] = [];
  const released: string[] = [];
  await sweepPage<Leg>(deps.prisma, PICKUP_OVERDUE_SWEEP, {
    pageSize: PAGE_SIZE,
    fetch: (after, limit) => deps.prisma.order.findMany({
      where: {
        riderId: { not: null }, status: { in: [...RIDER_PRE_CUSTODY_STATUSES] }, orderType: { not: 'TAXI' },
        fulfillment: 'DELIVERY',
        NOT: { paymentMethod: 'CASH', paymentStatus: 'CAPTURED' },
        AND: [notSelfDeliveredFilter(), ...(after ? [{ id: { gt: after } }] : [])],
      },
      select,
      orderBy: { id: 'asc' },
      take: limit,
    }),
    handle: async (leg) => {
      const outcome = await settlePickupLeg(deps, enqueue, leg, now);
      if (outcome === 'NUDGED') nudged.push(leg.id);
      if (outcome === 'RELEASED') released.push(leg.id);
    },
    now,
  });
  return { nudged, released };
}

export async function settlePickupLeg(
  deps: PickupOverdueDeps,
  enqueue: (orderId: string) => Promise<void>,
  leg: Leg,
  now: Date,
): Promise<PickupOutcome> {
  if (!leg.riderId || !leg.rider) return 'IGNORED';
  const acceptedAt = await riderAcceptedAt(deps.prisma, leg.id);
  if (!acceptedAt) return 'IGNORED';
  const clock = pickupClock(leg, acceptedAt, await pickupMinutes(deps.prisma, leg.tenantId));
  if (now < clock.nudgeAt) return 'NOT_DUE';
  const version = leg.riderAssignmentVersion;
  // [COORD ruling 21 Oct · REVIEW-G S2-1] A rider AT the counter whose order the
  // store has not marked ready is waiting on the store, not failing to come:
  // never released, never a no-show, never "didn't come" to the customer. At the
  // release time ops is paged once and the store is told once. Once the store
  // marks it ready, the ordinary clock runs from readyAt (waitClock reads it
  // first), so an arrived rider is never released before readyAt + the release
  // window.
  if (riderWaitingOnStore(leg, await arrivalProof(deps.prisma, leg.tenantId), now)) {
    if (now < clock.releaseAt) return 'WAITING';
    // (c) A hard bound: exempt for ARRIVED_WAIT_ESCALATION_FACTOR release windows
    // since arrival, ops is paged loudly once more and must decide. Still no
    // automatic no-show while the store has not marked the order ready.
    const arrivedAt = await riderAcceptedAt(deps.prisma, leg.id, 'RIDER_ARRIVED_PICKUP');
    const releaseMin = (clock.releaseAt.getTime() - clock.pickupDue.getTime()) / 60_000;
    if (arrivedAt && now.getTime() - arrivedAt.getTime() >= ARRIVED_WAIT_ESCALATION_FACTOR * releaseMin * 60_000) {
      await escalateLongStoreWait(deps, leg, version, arrivedAt, now);
    }
    return pageWaitingOnStore(deps, leg, version);
  }
  if (now < clock.releaseAt) {
    const nudgeKey = pickupNudgeKey(leg.id, version);
    const told = await deps.prisma.notification.findUnique({
      where: { userId_dedupeKey: { userId: leg.rider.userId, dedupeKey: nudgeKey } }, select: { id: true },
    });
    if (told) return 'WAITING';
    const left = Math.max(1, Math.round((clock.releaseAt.getTime() - now.getTime()) / 60_000));
    await deps.notifications.send({
      userId: leg.rider.userId,
      type: 'ORDER_UPDATE',
      title: 'Pick up now or release the order',
      body: `Order ${leg.orderNumber} was due for pickup at the store. Pick it up now, or hand it back so another rider can take it. In ${left} minutes we’ll give it to another rider.`,
      audience: 'earner',
      data: { orderId: leg.id, orderNumber: leg.orderNumber, kind: 'pickup_overdue', releasesInMinutes: left },
      dedupeKey: nudgeKey,
    });
    return 'NUDGED';
  }
  return releaseOverdueLeg(deps, enqueue, leg.id, leg.riderId, version);
}

/** [COORD ruling 21 Oct] The rider waits at an unready store: ops paged once and
 *  the store told once, per assignment. No release, no no-show, nothing to the customer. */
async function pageWaitingOnStore(deps: PickupOverdueDeps, leg: Leg, version: number): Promise<PickupOutcome> {
  const storeUserId = leg.vendor?.owner.userId;
  if (storeUserId) {
    await deps.notifications.send({
      userId: storeUserId,
      type: 'ORDER_UPDATE',
      title: 'Your rider is waiting',
      body: `The rider for order ${leg.orderNumber} is at your counter. Please mark the order ready and hand it over.`,
      audience: 'business',
      data: { orderId: leg.id, orderNumber: leg.orderNumber, kind: 'rider_waiting' },
      dedupeKey: pickupReleaseKey('store-waiting', leg.id, version),
    }).catch(() => {});
  }
  await notifyAdmins(deps.prisma, deps.notifications, {
    tenantId: leg.tenantId ?? null,
    title: 'Rider waiting at a store that is not ready',
    body: `Order ${leg.orderNumber}: the rider is at the store past the pickup time and the store has not marked the order ready. The rider is not released; check the store.`,
    data: { kind: 'ops_rider_waiting', orderId: leg.id, riderId: leg.riderId },
    dedupeKey: pickupReleaseKey('ops-waiting', leg.id, version),
  }).catch(() => {});
  return 'STORE_PAGED';
}

/** The durable mark that a long store wait was put to a person (one per assignment). */
export const RIDER_WAITING_ESCALATED_OUTCOME = 'RIDER_WAITING_ESCALATED';

/** [COORD security ruling (c)] A LOUD page (the ops-alert obligation: every
 *  admin pushed, the on-call list texted, escalating until a person
 *  acknowledges it) for the order a person must now decide, once per assignment. */
async function escalateLongStoreWait(deps: PickupOverdueDeps, leg: Leg, version: number, arrivedAt: Date, now: Date): Promise<void> {
  const already = await deps.prisma.algoDecision.findFirst({
    where: { algo: 'OF-33', subjectType: 'ORDER', subjectId: leg.id, outcome: RIDER_WAITING_ESCALATED_OUTCOME, inputs: { path: ['assignmentVersion'], equals: version } },
    select: { id: true },
  });
  if (already) return;
  const waited = Math.round((now.getTime() - arrivedAt.getTime()) / 60_000);
  await openOpsAlert(deps.prisma, deps.notifications, {
    kind: 'PLATFORM',
    tenantId: leg.tenantId ?? null,
    title: 'Rider stuck at a store that is not ready — decide now',
    body: `Order ${leg.orderNumber}: the rider has been at the store for ${waited} min and the store has still not marked the order ready. Nothing is released automatically: decide whether to cancel, reassign or wait.`,
    data: { kind: 'ops_rider_waiting_long', orderId: leg.id, riderId: leg.riderId, waitedMinutes: waited },
    now,
  });
  await recordDecision(deps.prisma, {
    algo: 'OF-33', subjectType: 'ORDER', subjectId: leg.id, tenantId: leg.tenantId,
    outcome: RIDER_WAITING_ESCALATED_OUTCOME,
    sentence: `The rider waited ${waited} min at a store that never marked the order ready: put to an operator to decide; no automatic no-show.`,
    inputs: { assignmentVersion: version, waitedMinutes: waited },
  });
}

/** The release, decided on the order lock every custody decision takes.
 *  Exported for the race cases: it re-checks everything under the lock. */
export async function releaseOverdueLeg(
  deps: PickupOverdueDeps,
  enqueue: (orderId: string) => Promise<void>,
  orderId: string,
  riderId: string,
  version: number,
): Promise<PickupOutcome> {
  const tenant = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { tenantId: true } });
  const proof = await arrivalProof(deps.prisma, tenant?.tenantId ?? 'swift-default');
  const decision = await deps.prisma.$transaction(async (tx) => {
    await lockTaxiOrderForCustodyDecision(tx, orderId);
    const order = await tx.order.findUnique({ where: { id: orderId }, select });
    // Raced away between the page and the lock: picked up, handed back,
    // reassigned (a new version), cancelled, or the cash was taken.
    if (!order || order.riderId !== riderId || order.riderAssignmentVersion !== version) return null;
    if (!RIDER_PRE_CUSTODY_STATUSES.includes(order.status as OrderStatus) || cashInHand(order)) return null;
    // Arrived at the counter since the page was read, and the store has not
    // marked it ready: the store is late, not the rider (next tick pages the store).
    if (riderWaitingOnStore(order, proof, new Date())) return null;
    const reopenStatus = await reopenPreCustodyLeg(
      tx, order, 'system:pickup-overdue',
      'Rider no-show: not picked up by the pickup deadline — released back to dispatch',
    );
    // The no-show on the rider's record: a miss on the completion rate, as
    // ONE atomic EMA under the row lock (the same shape as acceptanceRate).
    await tx.$executeRaw`UPDATE "riders" SET "completionRate" = "completionRate" * 0.8 WHERE "id" = ${riderId}`;
    // Only this leg leaves the rider: the seam re-points them at a sibling.
    await settleRiderLegs(tx, riderId, { prisma: deps.prisma, excludeOrderId: orderId });
    return { order, reopenStatus };
  });
  if (!decision) return 'IGNORED';
  const { order, reopenStatus } = decision;

  // Post-commit, each step caught: none may undo a committed release.
  const declinedKey = dispatchDeclinedKey(orderId, order.fulfillmentModeVersion);
  await deps.redis.sadd(declinedKey, riderId).catch(() => {});
  await deps.redis.expire(declinedKey, 3600).catch(() => {});
  await emitToOrderRoom(deps.prisma, deps.io, orderId, 'order:status_changed', { orderId, status: reopenStatus, reason: 'rider_no_show' }).catch(() => {});
  const parcel = order.orderType === 'COURIER';
  await deps.notifications.send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: 'Finding you a new rider',
    body: parcel
      ? `The rider for your parcel ${order.orderNumber} didn’t come to collect it, so we’re finding you a new rider now.`
      : `Your rider didn’t pick up order ${order.orderNumber} in time, so we’re finding you a new rider now.`,
    audience: 'customer',
    data: { orderId, orderNumber: order.orderNumber, status: reopenStatus, kind: 'rider_no_show' },
    dedupeKey: pickupReleaseKey('customer', orderId, version),
  }).catch(() => {});
  const storeUserId = order.vendor?.owner.userId;
  if (storeUserId) {
    await deps.notifications.send({
      userId: storeUserId,
      type: 'ORDER_UPDATE',
      title: 'A new rider is coming',
      body: `The rider for order ${order.orderNumber} didn’t come to pick it up. We’re sending another rider — please keep the order ready.`,
      audience: 'business',
      data: { orderId, orderNumber: order.orderNumber, status: reopenStatus, kind: 'rider_no_show' },
      dedupeKey: pickupReleaseKey('store', orderId, version),
    }).catch(() => {});
  }
  await notifyAdmins(deps.prisma, deps.notifications, {
    tenantId: order.tenantId ?? null,
    title: 'Rider no-show before pickup',
    body: `Order ${order.orderNumber}: the rider accepted but did not pick up by the deadline. The order went back to dispatch; the rider’s acceptance was recorded as a no-show.`,
    data: { kind: 'ops_rider_no_show', orderId, riderId },
    dedupeKey: pickupReleaseKey('ops', orderId, version),
  }).catch(() => {});
  await enqueue(orderId).catch(() => {});
  log().info({ orderId, riderId, version }, 'pickup-overdue: rider no-show released back to dispatch');
  return 'RELEASED';
}
