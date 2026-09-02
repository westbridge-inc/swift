import type { PrismaClient } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { algoConfig } from '../algo/algo-config';
import { recordDecision } from '../algo/decisions';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
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
 * [TA-S0-001] PAID MMG MONEY IS NEVER CANCELLED BY THE SYSTEM. The canonical
 * cancel seam (order.service, MMG_CANCEL_UNAVAILABLE) refuses to mint
 * CANCELLED+CAPTURED: the store already holds the customer's payment and no
 * refund-obligation rail exists, so a cancel would close money with no path
 * back. The cutoff must obey the same law — an order that is too old AND
 * already paid by MMG is HELD for a person, un-cancelled: ops paged, the
 * store and the customer told the truth, a decision row that says so. The
 * guard sits inside the CAS itself, so a capture that lands between a
 * caller's read and the write is respected.
 *
 * [REPORT-070] The hold is DURABLE and ENFORCEABLE, not a log line:
 * `Order.foodAgeHeldAt` is the claim (one UPDATE wins it; no decision row
 * or notice is ever the gate), every rider-claim predicate excludes a held
 * row (board, direct accept, offer accept, the dispatch loop), the notices
 * are re-delivered idempotently on later ticks so a crash after the claim
 * cannot lose them, an ops page that reaches nobody is a FAILED page (the
 * claim is released and the next tick tries again), thresholds are read
 * per tenant, the sweep only ever touches platform-rider delivery orders,
 * walks oldest-first past already-held rows, and copy never claims a person
 * is already handling what nobody has acknowledged. An operator releases the
 * hold through `releaseFoodAgeHold`.
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
/** [TA-S0-001] The decision row for an order too old to deliver whose money the store already holds. */
export const FOOD_TOO_OLD_PAID_HELD_OUTCOME = 'FOOD_TOO_OLD_PAID_HELD';

/** [TA-S0-001] The one predicate: money the store already holds on the MMG
 *  rail. Cancelling it would mint CANCELLED+CAPTURED — the state the canonical
 *  cancel seam refuses (`MMG_CANCEL_UNAVAILABLE`, order.service). */
export function isCapturedMmg(order: { paymentMethod: string; paymentStatus: string }): boolean {
  return order.paymentMethod === 'MOBILE_MONEY' && order.paymentStatus === 'CAPTURED';
}

/** What one cutoff call did to the order. */
export type RetireOutcome = 'RETIRED' | 'HELD_PAID' | 'UNTOUCHED';

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

/** [REPORT-070 F-05] The tenant is mandatory: sweeps carry no request
 *  context, and one operator's cutoff must never retire another's orders. */
export async function foodAgeLimitMinutes(prisma: PrismaClient, orderType: string, tenantId: string): Promise<number | null> {
  const cfg = await algoConfig(prisma, 'rescue.foodAgeMaxMinutes', tenantId);
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
  /** The status at read time — the hold's log note records the true state, never a guess. */
  status: string;
  paymentMethod: string;
  /** [TA-S0-001] Required, not optional: a caller that forgets to SELECT it
   *  fails to compile instead of silently cancelling paid money. */
  paymentStatus: string;
  readyAt: Date | null;
  vendor: { name: string; owner: { userId: string } } | null;
}

/**
 * Cancel an order nobody could deliver in time, by the SYSTEM, marking
 * nobody. CAS on "still waiting, still no rider, and NOT paid MMG money": a
 * rider who claimed it in the meantime keeps it; captured MMG money is never
 * cancelled — that order is HELD for a person instead. Returns whether this
 * call retired it (the held case is `false`: nothing was cancelled).
 */
export async function retireTooOldOrder(deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, now = new Date()): Promise<boolean> {
  return (await settleTooOldOrder(deps, order, ageMinutes, limitMinutes, now)) === 'RETIRED';
}

/** The cutoff's full verdict: RETIRED (cancelled by the system), HELD_PAID
 *  (too old, but the store already holds the money — a person decides) or
 *  UNTOUCHED (a rider claimed it, or it moved on). */
export async function settleTooOldOrder(deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, now = new Date()): Promise<RetireOutcome> {
  const r = await deps.prisma.order.updateMany({
    where: {
      id: order.id, tenantId: order.tenantId, riderId: null, status: { in: [...WAITING_STATUSES] },
      // [REPORT-070 F-06] "No rider found" is only a fact about work that
      // NEEDS a platform rider: a pickup order or a store's own delivery is
      // riderless by design and must never be retired for it.
      fulfillment: 'DELIVERY',
      foodAgeHeldAt: null,
      AND: [notSelfDeliveredFilter()],
      // [TA-S0-001] The guard lives in the CAS, not only in the caller's
      // snapshot: money captured between the caller's read and this write is
      // respected by the database, not by luck.
      NOT: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' },
    },
    data: { status: 'CANCELLED', cancelledAt: now, cancelledBy: 'system', cancellationReason: FOOD_TOO_OLD_REASON },
  });
  if (r.count === 0) return holdPaidTooOldOrder(deps, order, ageMinutes, limitMinutes, now);

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
    pageOperators(deps, {
      title: 'Food too old to deliver — cancelled, needs a person',
      body: `Order ${order.orderNumber} (${order.vendor?.name ?? 'store'}) was ready ${ageMinutes} min with no rider. Check supply in that area and whether the store should be paid.`,
      data: { kind: 'ops_food_too_old', orderId: order.id },
      tenantId: order.tenantId,
    }),
  ).catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: ops page failed'));
  return 'RETIRED';
}

/**
 * [REPORT-070 F-02] "Ops paged" must mean a person can see it. notifyAdmins
 * returns how many operator inboxes took the row; zero is a FAILED page, and
 * throwing here makes opsPageOnce release its claim so the next tick tries
 * again instead of recording success for six hours over an empty room.
 */
async function pageOperators(deps: RescueDeps, page: Parameters<typeof notifyAdmins>[2]): Promise<number> {
  const reached = await notifyAdmins(deps.prisma, deps.notifications, page);
  if (reached === 0) {
    log().error({ orderId: page.data?.['orderId'], tenantId: page.tenantId }, 'rescue: ops page reached NOBODY — no operator inbox took it; the claim is released and the next tick retries');
    throw new Error('ops page reached no operator');
  }
  return reached;
}

/**
 * [TA-S0-001] The CAS refused. Either the order moved on (a rider claimed
 * it, it left the waiting states, it is not platform-rider delivery work)
 * — nothing to do — or it is still waiting AND its money is captured MMG:
 * too old to deliver, and NOT ours to cancel. That order is HELD for a
 * person, un-cancelled.
 *
 * [REPORT-070 F-01/F-03] The claim is the ROW: one UPDATE sets
 * `foodAgeHeldAt` for exactly one caller (overlapping dispatch and sweep
 * ticks cannot both win), and while it is set no rider-claim predicate in
 * the product accepts the order. The notices, the decision row and the ops
 * page are EFFECTS of the claim, delivered idempotently — a crash between
 * the claim and the notices is repaired on the next tick, never lost.
 */
async function holdPaidTooOldOrder(deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, now: Date): Promise<RetireOutcome> {
  const claimed = await deps.prisma.order.updateMany({
    where: {
      id: order.id, tenantId: order.tenantId, riderId: null, status: { in: [...WAITING_STATUSES] },
      fulfillment: 'DELIVERY', AND: [notSelfDeliveredFilter()],
      paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED',
      foodAgeHeldAt: null,
    },
    data: { foodAgeHeldAt: now },
  });
  if (claimed.count === 0) {
    // Not ours — unless it is ALREADY held, in which case the effects may
    // still owe delivery (a crash after the claim, a page nobody took).
    const row = await deps.prisma.order.findUnique({
      where: { id: order.id }, select: { foodAgeHeldAt: true, riderId: true, status: true },
    });
    if (!row?.foodAgeHeldAt || row.riderId || !(WAITING_STATUSES as readonly string[]).includes(row.status)) return 'UNTOUCHED';
    await deliverHoldEffects(deps, order, ageMinutes, limitMinutes, { winner: false });
    return 'HELD_PAID';
  }
  // A live offer card for this order must not survive the hold: the accept
  // CAS refuses it anyway, but the card should vanish, not fail on tap.
  await deps.redis.del(...dispatchKeys(order.id)).catch(() => {});
  await deliverHoldEffects(deps, order, ageMinutes, limitMinutes, { winner: true });
  return 'HELD_PAID';
}

/**
 * The effects of a hold. The decision row and the log note are written by
 * the claim WINNER only — the one caller whose UPDATE set the column — so
 * overlapping callers can never duplicate them (neither table has a unique
 * key to lean on). The two notices ride dedupe keys and the ops page its
 * once-key, so the repair path (a later tick over an existing hold) may
 * re-run them freely: a crash after the claim loses no notice and no page.
 */
async function deliverHoldEffects(deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, opts: { winner: boolean }): Promise<void> {
  if (opts.winner) {
    const decisionId = await recordDecision(deps.prisma, {
      algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId, outcome: FOOD_TOO_OLD_PAID_HELD_OUTCOME,
      sentence: `Ready ${ageMinutes} min ago against a ${limitMinutes}-min limit with no rider found, but the store already holds the MMG payment: held for review, not cancelled — nobody is marked.`,
      inputs: { ageMinutes, limitMinutes, orderType: order.orderType, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, readyAt: order.readyAt?.toISOString() ?? null },
    });
    if (decisionId) {
      await deps.prisma.orderStatusLog.create({
        data: {
          orderId: order.id, status: order.status as never, changedBy: 'system',
          note: `Food-age cutoff: ready ${ageMinutes} min ago, limit ${limitMinutes} min, no rider found — but the customer already paid by MMG, so it is HELD for review, not cancelled. Nobody is marked.`,
        },
      }).catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: hold log note failed (the decision row stands; retried next tick)'));
    }
  }

  // [REPORT-070 F-13] Nobody has acknowledged anything yet: say "sent for
  // review", never that a person is already sorting it out.
  await deps.notifications.send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: 'We couldn’t find a rider in time',
    body: `Order ${order.orderNumber} was ready but no rider could be found. You’ve already paid the store by MMG, so it was NOT cancelled automatically — it has been sent to Swift for review, and nothing more is charged. If it can’t be delivered, the store refunds you directly.`,
    audience: 'customer',
    data: { orderId: order.id, orderNumber: order.orderNumber, reason: FOOD_TOO_OLD_REASON, held: true },
    dedupeKey: `food-too-old-paid:customer:${order.id}`,
  });
  if (order.vendor?.owner.userId) {
    await deps.notifications.send({
      userId: order.vendor.owner.userId,
      type: 'ORDER_UPDATE',
      title: 'No rider found — the customer has already paid',
      body: `${order.orderNumber} was ready ${ageMinutes} min ago and no rider could be found. The customer paid by MMG, so it is NOT cancelled: it has been sent to Swift for review. Keep the order until you hear from us.`,
      audience: 'business',
      data: { orderId: order.id, orderNumber: order.orderNumber, reason: FOOD_TOO_OLD_REASON, held: true },
      dedupeKey: `food-too-old-paid:vendor:${order.id}`,
    });
  }
  const { opsPageOnce } = await import('../../jobs/queue');
  await opsPageOnce({ redis: deps.redis }, `food_too_old_paid:${order.id}`, 6 * 3600, () =>
    pageOperators(deps, {
      title: 'Paid MMG order too old to deliver — held for review, NOT cancelled',
      body: `Order ${order.orderNumber} (${order.vendor?.name ?? 'store'}) was ready ${ageMinutes} min with no rider and the customer already paid by MMG. The system did not cancel it; it is held. Decide with the store: deliver it now (release the hold), or the store refunds the customer directly.`,
      data: { kind: 'ops_food_too_old', orderId: order.id, held: true },
      tenantId: order.tenantId,
    }),
  ).catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: paid-hold ops page failed'));
}

/** [REPORT-070 F-03] An operator's decision: the hold comes off and the order
 *  is dispatchable again. The only writer that clears `foodAgeHeldAt`. */
export async function releaseFoodAgeHold(deps: Pick<RescueDeps, 'prisma' | 'redis'>, orderId: string, byUserId: string): Promise<boolean> {
  const r = await deps.prisma.order.updateMany({ where: { id: orderId, foodAgeHeldAt: { not: null } }, data: { foodAgeHeldAt: null } });
  if (r.count === 0) return false;
  const row = await deps.prisma.order.findUnique({ where: { id: orderId }, select: { status: true } });
  await deps.prisma.orderStatusLog.create({
    data: { orderId, status: (row?.status ?? 'READY_FOR_PICKUP') as never, changedBy: byUserId, note: 'Food-age hold released by an operator — back to dispatch.' },
  }).catch(() => {});
  await deps.redis.del(`ops_page:food_too_old_paid:${orderId}`).catch(() => {});
  return true;
}

/** The watchdog tick: retire every waiting, riderless platform-delivery
 *  order past its tenant's cutoff — HOLD, un-cancelled, the ones whose money
 *  the store already holds ([TA-S0-001]) — and re-deliver the effects of
 *  every existing hold whose notices may still be owed. */
export async function sweepFoodAge(deps: RescueDeps, now = new Date()): Promise<{ retired: string[]; held: string[] }> {
  const retired: string[] = [];
  const held: string[] = [];
  const select = {
    id: true, orderNumber: true, customerId: true, tenantId: true, orderType: true, status: true, paymentMethod: true, paymentStatus: true, readyAt: true,
    vendor: { select: { name: true, owner: { select: { userId: true } } } },
  } as const;
  // [REPORT-070 F-04/F-06] Oldest first, a bounded page, held rows excluded,
  // and only work that needs a platform rider — so a shelf of held paid
  // orders can never occupy the page, and a pickup order is never "no rider".
  const waiting = await deps.prisma.order.findMany({
    where: {
      riderId: null, status: { in: [...WAITING_STATUSES] }, readyAt: { not: null },
      fulfillment: 'DELIVERY', foodAgeHeldAt: null,
      AND: [notSelfDeliveredFilter()],
    },
    select,
    orderBy: { readyAt: 'asc' },
    take: 200,
  });
  for (const o of waiting) {
    // [REPORT-070 F-05] The order's own tenant decides its cutoff.
    const limit = await foodAgeLimitMinutes(deps.prisma, o.orderType, o.tenantId);
    if (limit == null) continue;
    const age = foodAge(o, limit, now);
    if (!age.tooOld || age.ageMinutes == null) continue;
    const outcome = await settleTooOldOrder(deps, o, age.ageMinutes, limit, now);
    if (outcome === 'RETIRED') retired.push(o.id);
    else if (outcome === 'HELD_PAID') held.push(o.id);
  }
  // [REPORT-070 F-01/F-02] Existing holds: every effect is idempotent, so
  // re-running them repairs a crash after the claim or a page nobody took.
  const holds = await deps.prisma.order.findMany({
    where: { foodAgeHeldAt: { not: null }, riderId: null, status: { in: [...WAITING_STATUSES] } },
    select,
    orderBy: { foodAgeHeldAt: 'asc' },
    take: 50,
  });
  for (const h of holds) {
    const limit = (await foodAgeLimitMinutes(deps.prisma, h.orderType, h.tenantId)) ?? 0;
    const age = foodAge(h, limit, now);
    await deliverHoldEffects(deps, h, age.ageMinutes ?? 0, limit, { winner: false });
    if (!held.includes(h.id)) held.push(h.id);
  }
  return { retired, held };
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
