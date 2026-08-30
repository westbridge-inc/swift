import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { algoConfig } from '../algo/algo-config';
import { recordDecision } from '../algo/decisions';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { log } from '../../utils/logger';

/**
 * [ALG-06] Rescue — the missing half of a real watchdog.
 *
 * delivery-watchdog.ts already resolves a GPS-dark rider by custody stage,
 * releases the float in the same transaction and keeps the dark rider out
 * of the re-cascade. That is not rebuilt. Two things are added:
 *
 *   ② FOOD-AGE CUTOFF. From `readyAt`, once an order with no rider is older
 *      than `rescue.foodAgeMaxMinutes[vertical]` (45 FOOD, 90 GROCERY; no
 *      cutoff for COURIER), dispatch stops re-offering and routes it to a
 *      human: the order is cancelled by the SYSTEM with a reason that marks
 *      nobody — no customer strike, no rider rate (there is no rider), the
 *      customer told what is true for their rail, the store told, ops paged
 *      once. Recorded as an ALG-06 row.
 *   ① ESCALATING RE-OFFER. From the cascade `rescue.incentiveFromCascade`
 *      (2) on, an offer carries `rescue.incentiveGyd` — Swift's OWN money
 *      as a marketing expense (L12 / ALG-INV-19): an earning of its own
 *      type, a PAYABLE Swift settles, never order money, never charged to
 *      the customer or the vendor. Ships at 0 — nothing is granted until
 *      the founder sets an amount.
 *
 * Conflict registered, not decided here: the algorithm document widens the
 * rescue radius by 500 m per cascade capped at 4 km; the shipped ladder
 * already goes 5 → 10 → 15 km per round (BASE_RADIUS_KM / RADIUS_STEP_KM in
 * dispatch.service). The measured behaviour stands until the founder rules.
 */

export const ALGO_ID = 'ALG-06';
export const FOOD_TOO_OLD_REASON = 'FOOD_TOO_OLD';
/** Statuses an order with no rider can be waiting in. */
export const WAITING_STATUSES = ['ACCEPTED', 'PREPARING', 'READY_FOR_PICKUP'] as const;

// Key formats mirror dispatch.service's private keys — pinned by test.
export const incentiveKey = (orderId: string) => `dispatch:rescue-incentive:${orderId}`;
const dispatchKeys = (orderId: string) => [
  `dispatch:offer:${orderId}`, `dispatch:declined:${orderId}`, `dispatch:exhausts:${orderId}`, `dispatch:round:${orderId}`,
];

export interface RescueDeps {
  prisma: PrismaClient;
  redis: Redis;
  io: Server;
  notifications: NotificationService;
}

// ---------------------------------------------------------------------------
// ② Food age
// ---------------------------------------------------------------------------

export async function foodAgeLimitMinutes(prisma: PrismaClient, orderType: string): Promise<number | null> {
  const cfg = await algoConfig(prisma, 'rescue.foodAgeMaxMinutes');
  const map = (cfg.value ?? {}) as Record<string, unknown>;
  const v = Number(map[orderType]);
  return Number.isFinite(v) && v > 0 ? v : null;
}

export function foodAge(order: { readyAt: Date | null }, limitMinutes: number | null, now = new Date()): { tooOld: boolean; ageMinutes: number | null } {
  if (!order.readyAt || limitMinutes == null) return { tooOld: false, ageMinutes: null };
  const ageMinutes = Math.floor((now.getTime() - order.readyAt.getTime()) / 60_000);
  return { tooOld: ageMinutes > limitMinutes, ageMinutes };
}

export interface RetireableOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  tenantId: string;
  orderType: string;
  paymentMethod: string;
  readyAt: Date | null;
  vendor: { name: string; owner: { userId: string } } | null;
}

/**
 * Cancel an order nobody could deliver in time, by the SYSTEM, marking
 * nobody. CAS on "still waiting, still no rider": a rider who claimed it in
 * the meantime keeps it. Returns whether this call retired it.
 */
export async function retireTooOldOrder(deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, now = new Date()): Promise<boolean> {
  const r = await deps.prisma.order.updateMany({
    where: { id: order.id, riderId: null, status: { in: [...WAITING_STATUSES] } },
    data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'system', cancellationReason: FOOD_TOO_OLD_REASON },
  });
  if (r.count === 0) return false;

  await deps.prisma.orderStatusLog.create({
    data: {
      orderId: order.id, status: 'CANCELLED', changedBy: 'system',
      note: `Food-age cutoff: ready ${ageMinutes} min ago, limit ${limitMinutes} min, no rider found — routed to a human. Nobody is marked.`,
    },
  }).catch(() => {});
  await deps.redis.del(...dispatchKeys(order.id)).catch(() => {});
  await recordDecision(deps.prisma, {
    algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId, outcome: 'FOOD_TOO_OLD',
    sentence: `Ready ${ageMinutes} min ago against a ${limitMinutes}-min limit with no rider found: too old to deliver, cancelled by the system and handed to a person — nobody is marked.`,
    inputs: { ageMinutes, limitMinutes, orderType: order.orderType, readyAt: order.readyAt?.toISOString() ?? null },
  });

  deps.io.to(`order:${order.id}`).emit('order:status_changed', { orderId: order.id, status: 'CANCELLED', timestamp: now.toISOString() });
  const money = order.paymentMethod === 'CASH'
    ? 'Nothing to pay.'
    : order.paymentMethod === 'MOBILE_MONEY'
      ? 'If you already paid by MMG, the store refunds you.'
      : 'Nothing is charged for it.';
  await deps.notifications.send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: 'We couldn’t find a rider in time',
    body: `Order ${order.orderNumber} was ready but no rider could be found, so we cancelled it rather than deliver it cold. ${money} We’re sorry.`,
    audience: 'customer',
    data: { orderId: order.id, orderNumber: order.orderNumber, status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON },
    dedupeKey: `food-too-old:customer:${order.id}`,
  });
  if (order.vendor?.owner.userId) {
    await deps.notifications.send({
      userId: order.vendor.owner.userId,
      type: 'ORDER_UPDATE',
      title: 'Order cancelled — too old to deliver',
      body: `${order.orderNumber} was ready ${ageMinutes} min ago and no rider could be found. It has been cancelled; a person at Swift is looking at it.`,
      audience: 'business',
      data: { orderId: order.id, orderNumber: order.orderNumber, status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON },
      dedupeKey: `food-too-old:vendor:${order.id}`,
    });
  }
  // Dynamic like dispatch.service does it: jobs/queue imports this module's neighbours.
  const { opsPageOnce } = await import('../../jobs/queue');
  await opsPageOnce({ redis: deps.redis }, `food_too_old:${order.id}`, 6 * 3600, () =>
    notifyAdmins(deps.prisma, deps.notifications, {
      title: 'Food too old to deliver — cancelled, needs a person',
      body: `Order ${order.orderNumber} (${order.vendor?.name ?? 'store'}) was ready ${ageMinutes} min with no rider. Check supply in that area and whether the store should be paid.`,
      data: { kind: 'ops_food_too_old', orderId: order.id },
      tenantId: order.tenantId,
    }),
  ).catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: ops page failed'));
  return true;
}

/** The watchdog tick: retire every waiting, riderless order past its vertical's cutoff. */
export async function sweepFoodAge(deps: RescueDeps, now = new Date()): Promise<{ retired: string[] }> {
  const retired: string[] = [];
  const cfg = await algoConfig(deps.prisma, 'rescue.foodAgeMaxMinutes');
  const limits = (cfg.value ?? {}) as Record<string, unknown>;
  for (const [orderType, raw] of Object.entries(limits)) {
    const limit = Number(raw);
    if (!Number.isFinite(limit) || limit <= 0) continue;
    const cutoff = new Date(now.getTime() - limit * 60_000);
    const waiting = await deps.prisma.order.findMany({
      where: { orderType: orderType as never, riderId: null, status: { in: [...WAITING_STATUSES] }, readyAt: { lt: cutoff } },
      select: {
        id: true, orderNumber: true, customerId: true, tenantId: true, orderType: true, paymentMethod: true, readyAt: true,
        vendor: { select: { name: true, owner: { select: { userId: true } } } },
      },
      take: 100,
    });
    for (const o of waiting) {
      const age = foodAge(o, limit, now);
      if (!age.tooOld || age.ageMinutes == null) continue;
      if (await retireTooOldOrder(deps, o, age.ageMinutes, limit, now)) retired.push(o.id);
    }
  }
  return { retired };
}

// ---------------------------------------------------------------------------
// ① The incentive — Swift's own money
// ---------------------------------------------------------------------------

export async function rescueIncentiveGyd(prisma: PrismaClient, cascade: number): Promise<number> {
  const [amount, from] = await Promise.all([algoConfig(prisma, 'rescue.incentiveGyd'), algoConfig(prisma, 'rescue.incentiveFromCascade')]);
  const gyd = Math.max(0, Math.round(Number(amount.value) || 0));
  const fromCascade = Math.max(1, Math.round(Number(from.value) || 2));
  return gyd > 0 && cascade >= fromCascade ? gyd : 0;
}

/** The offer carried an incentive and the rider accepted: the payable exists now. Idempotent per order. */
export async function grantRescueIncentive(prisma: PrismaClient, input: { orderId: string; riderId: string; amountGyd: number; cascade: number; tenantId?: string }): Promise<boolean> {
  if (!(input.amountGyd > 0)) return false;
  const r = await prisma.earning.createMany({
    data: [{ orderId: input.orderId, riderId: input.riderId, type: 'RESCUE_INCENTIVE', amount: input.amountGyd, status: 'PENDING' }],
    skipDuplicates: true,
  });
  if (r.count === 0) return false;
  await recordDecision(prisma, {
    algo: ALGO_ID, subjectType: 'RIDER', subjectId: input.riderId, ...(input.tenantId ? { tenantId: input.tenantId } : {}), outcome: 'INCENTIVE_GRANTED',
    sentence: `A GYD ${input.amountGyd} rescue incentive from Swift’s own money for taking a job on cascade ${input.cascade} — a payable Swift settles, never the customer’s or the store’s money.`,
    inputs: { orderId: input.orderId, amountGyd: input.amountGyd, cascade: input.cascade, source: 'PLATFORM' },
  });
  return true;
}
