import { emitToOrderRoom } from '../order/order-room-emission.service';
import type { PrismaClient, Prisma } from '@prisma/client';
import type { Redis } from 'ioredis';
import type { Server } from 'socket.io';
import { algoConfig } from '../algo/algo-config';
import { rescueIncentivePayable } from './rescue-incentive-guard';
import { recordDecision } from '../algo/decisions';
import { NotificationService, notifyAdmins } from '../notification/notification.service';
import { notSelfDeliveredFilter } from '../fulfillment/fulfillment-mode';
import { log } from '../../utils/logger';
import { runAsSystem, runWithTenant } from '../../plugins/tenant-context';
import { sweepPage } from '../../lib/sweep-cursor';
import { CHECKOUT_OUTBOX_VERSION, checkoutOutboxId } from '../order/checkout-outbox';
import { withdrawOfferOfClosedOrder } from './offer-withdrawal';
import { isStoreOrder } from '../order/cancel-policy';
import { dispatchTrigger } from './dispatch-trigger';
import {
  deliveryGenerationSuffix,
  dispatchDeclinedKey,
  dispatchExhaustKey,
  dispatchRoundKey,
} from './dispatch-generation-keys';

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
 * [RESCUE S1 · AUD-CX04-001] The cancellation is ONE transaction with its
 * record: the CANCELLED write, its status-log line, its decision row and a
 * durable obligation (an OrderOutbox row of kind `rescue-notice`) to clear the
 * offer, tell the customer, tell the store and page operations. A refused
 * record rolls the cancellation back; a crash after the commit leaves the
 * obligation owed, and the outbox sweep delivers it (`drainRescueNotices`),
 * each notice on its own dedupe key, so nothing is lost and nothing doubles.
 * [AUD-CX05-001] Both sweep passes walk a durable (time, id) keyset cursor
 * (`sweep_cursors`), so orders that share a timestamp never hide behind a
 * full page, and one order that fails is skipped for the pass, not the tick.
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

/** [hold v3] Page sizes for the sweep's two passes. Mutable so a test can
 *  shrink them and prove the cursors walk past a page across ticks. */
export const SWEEP_PAGE = { retire: 200, holds: 50 };
/** [RESCUE S1 · CX05] The two passes' durable cursors (`sweep_cursors` rows).
 *  The S-05 stalled-pass and repeat-poison pager covers them like every other
 *  sweep. */
export const RESCUE_SWEEPS = {
  retire: 'rescue.food-age.retire',
  holds: 'rescue.food-age.holds',
  /** [OF-01] Riderless store orders nobody has marked ready. */
  unready: 'rescue.food-age.unready',
  /** [OF-17] Riderless parcels. */
  parcel: 'rescue.parcel-wait',
} as const;

/**
 * [OF-01 · COORD ruling 19 Oct 2026] A riderless store order the store accepted
 * but never marked ready had NO exit: the cutoff read `readyAt` only, so on
 * staging one order re-searched for 19 days and told its customer 219 times.
 * It is now timed from the store's own promise — accepted + the order's prep
 * minutes (the Vendor default when the order carries none) — against the same
 * per-vertical limit a ready order meets.
 */
export const DEFAULT_PREP_PROMISE_MIN = 30;
/** [OF-17 · COORD ruling 19 Oct 2026] A parcel waits for a rider at most this
 *  long from its start — placing, the end of its hold or its slot, whichever is
 *  latest — the way a ride waits for a driver. Before, a parcel had no cutoff. */
export const COURIER_WAIT_LIMIT_MIN = 60;
/** [OF-01/17 · COORD ruling 19 Oct 2026] Past its cutoff the customer is told
 *  ONCE that they can cancel for free; if no rider has come this long after
 *  that notice, the system cancels. (A ready order keeps its immediate cutoff:
 *  the food is already getting cold.) */
export const RIDERLESS_GRACE_MIN = 15;
/** [OF-17] The cancellation reason of a parcel nobody would carry. */
export const NO_RIDER_FOR_PARCEL_REASON = 'NO_RIDER_FOR_PARCEL';

/** What a wait is measured from: the food being ready, the store's prep
 *  promise (never marked ready), or a parcel's start. */
export type WaitBasis = 'READY' | 'PREP_PROMISE' | 'PARCEL';

export interface WaitClockSubject {
  readyAt: Date | null;
  orderType?: string;
  acceptedAt?: Date | null;
  estimatedPrepTime?: number | null;
  placedAt?: Date | null;
  holdExpiresAt?: Date | null;
  scheduledFor?: Date | null;
}

/** [OF-01] The prep-promise clock is about a rider nobody found, so it runs
 *  only where riders are searched from acceptance (ON_ACCEPT, the default and
 *  what staging runs). Under ON_READY nobody searches before the store marks it
 *  ready: a never-ready order there is a late STORE, not a missing rider, and
 *  "we still haven't found a rider" would be false — it keeps its old rule. */
export function prepPromiseClockRuns(): boolean {
  return dispatchTrigger() !== 'ON_READY';
}

/** THE start of a riderless wait (see `WaitBasis`); null when nothing has started it. */
export function waitClock(order: WaitClockSubject): { start: Date; basis: WaitBasis } | null {
  if (order.orderType === 'COURIER') {
    const starts = [order.placedAt, order.holdExpiresAt, order.scheduledFor].filter((d): d is Date => d instanceof Date);
    if (starts.length === 0) return null;
    return { start: new Date(Math.max(...starts.map((d) => d.getTime()))), basis: 'PARCEL' };
  }
  if (order.readyAt) return { start: order.readyAt, basis: 'READY' };
  if (order.acceptedAt) {
    const prep = order.estimatedPrepTime != null && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    return { start: new Date(order.acceptedAt.getTime() + prep * 60_000), basis: 'PREP_PROMISE' };
  }
  return null;
}

/** A (time, id) keyset position, written as `<ISO time>|<id>`. */
function keysetCursor(at: Date | null, id: string): string {
  return `${(at ?? new Date(0)).toISOString()}|${id}`;
}
/** The rows strictly after a keyset position in (field, id) order. An
 *  unreadable cursor starts the pass from the top — never skips a row. */
function afterKeyset(field: 'readyAt' | 'foodAgeHeldAt' | 'acceptedAt' | 'placedAt', cursor: string | null): Prisma.OrderWhereInput {
  if (!cursor) return {};
  const bar = cursor.indexOf('|');
  const at = new Date(bar > 0 ? cursor.slice(0, bar) : Number.NaN);
  const id = bar > 0 ? cursor.slice(bar + 1) : '';
  if (Number.isNaN(at.getTime()) || !id) return {};
  return { OR: [{ [field]: { gt: at } }, { [field]: at, id: { gt: id } }] };
}

/** [TA-S0-001] The one predicate: money the store already holds on the MMG
 *  rail. Cancelling it would mint CANCELLED+CAPTURED — the state the canonical
 *  cancel seam refuses (`MMG_CANCEL_UNAVAILABLE`, order.service). */
export function isCapturedMmg(order: { paymentMethod: string; paymentStatus: string }): boolean {
  return order.paymentMethod === 'MOBILE_MONEY' && (order.paymentStatus === 'CAPTURED' || order.paymentStatus === 'CLAIMED');
}

/** What one cutoff call did to the order. */
export type RetireOutcome = 'RETIRED' | 'HELD_PAID' | 'UNTOUCHED';

// Key formats mirror dispatch.service's private keys — pinned by test.
export const incentiveKey = (orderId: string, deliveryAuthorityVersion?: number | null) =>
  `dispatch:rescue-incentive:${orderId}${deliveryGenerationSuffix(deliveryAuthorityVersion)}`;
const dispatchKeys = (orderId: string, deliveryAuthorityVersion?: number | null) => [
  `dispatch:offer:${orderId}`,
  dispatchDeclinedKey(orderId, deliveryAuthorityVersion),
  dispatchExhaustKey(orderId, deliveryAuthorityVersion),
  dispatchRoundKey(orderId, deliveryAuthorityVersion),
  incentiveKey(orderId, deliveryAuthorityVersion),
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

export function foodAge(order: WaitClockSubject, limitMinutes: number | null, now = new Date()): { tooOld: boolean; ageMinutes: number | null; basis: WaitBasis | null } {
  const clock = waitClock(order);
  if (!clock || limitMinutes == null) return { tooOld: false, ageMinutes: null, basis: null };
  const ageMinutes = Math.floor((now.getTime() - clock.start.getTime()) / 60_000);
  return { tooOld: ageMinutes > limitMinutes, ageMinutes, basis: clock.basis };
}

/** The fields the one-order cutoff reads; full order rows fit. */
export interface TooOldSubject {
  status: string;
  orderType: string;
  tenantId: string;
  riderId: string | null;
  driverId: string | null;
  fulfillment: string;
  fulfillmentMode: string | null;
  readyAt: Date | null;
  /** [OF-01] Required, not optional: a never-ready order is timed from these,
   *  and a caller that omits them must fail to compile rather than tell the
   *  customer "not free" while the sweep says "too late". */
  acceptedAt: Date | null;
  estimatedPrepTime: number | null;
  foodAgeWaivedAt: Date | null;
}

/**
 * [owner #46] The food-age cutoff as a fact about ONE order — "too late to
 * deliver". The same scope `sweepFoodAge` selects (riderless, still waiting,
 * platform-rider delivery, cutoff not waived by an operator) and the same
 * tenant cutoff and age arithmetic — from `readyAt`, or [OF-01] from the
 * store's prep promise when nobody marked it ready — so the customer's free
 * cancel and the system's cancel can never disagree about which orders are
 * too old. (It is what makes the OF-01 "cancel free now" notice true.)
 */
export async function isTooOldToDeliver(prisma: PrismaClient, order: TooOldSubject, now = new Date()): Promise<boolean> {
  if (order.riderId != null || order.driverId != null) return false;
  if (!(WAITING_STATUSES as readonly string[]).includes(order.status)) return false;
  if (order.fulfillment !== 'DELIVERY' || order.fulfillmentMode === 'VENDOR_DELIVERY') return false;
  if (order.foodAgeWaivedAt != null) return false;
  if (order.readyAt == null && !prepPromiseClockRuns()) return false;
  const limit = await foodAgeLimitMinutes(prisma, order.orderType, order.tenantId);
  // A store order's wait: ready, or (never marked ready) the store's prep promise.
  return foodAge({ readyAt: order.readyAt, acceptedAt: order.acceptedAt, estimatedPrepTime: order.estimatedPrepTime }, limit, now).tooOld;
}

/**
 * [owner #46] Is this store order too late to deliver, for the ONE cancel
 * predicate (order/cancel-policy.ts)? Only a store order can be; any other
 * kind is never read, so a ride or a parcel never touches the cutoff's
 * configuration. `config` reads the tenant's cutoff; the order fields come
 * from the caller's row (the cancel path's is the locked one). Lives here,
 * not in cancel-policy, so that file stays importable by the boot checks.
 */
export async function readTooLateToDeliver(
  config: PrismaClient,
  order: TooOldSubject,
  now: Date = new Date(),
): Promise<boolean> {
  if (!isStoreOrder(order)) return false;
  return isTooOldToDeliver(config, order, now);
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
  fulfillmentModeVersion?: number;
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
export async function settleTooOldOrder(
  deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, now = new Date(), basis: WaitBasis = 'READY',
): Promise<RetireOutcome> {
  const notice: RescueNotice = {
    orderId: order.id, tenantId: order.tenantId, effect: 'RETIRED', ageMinutes, limitMinutes,
    deliveryAuthorityVersion: order.fulfillmentModeVersion ?? null, basis,
  };
  const reason = basis === 'PARCEL' ? NO_RIDER_FOR_PARCEL_REASON : FOOD_TOO_OLD_REASON;
  const sentence = basis === 'PARCEL'
    ? `Waited ${ageMinutes} min for a rider against a ${limitMinutes}-min limit with none found: cancelled by the system and handed to a person — nobody is marked.`
    : basis === 'PREP_PROMISE'
      ? `Never marked ready; ${ageMinutes} min past the store's prep promise against a ${limitMinutes}-min limit with no rider found: cancelled by the system and handed to a person — nobody is marked.`
      : `Ready ${ageMinutes} min ago against a ${limitMinutes}-min limit with no rider found: too old to deliver, cancelled by the system and handed to a person — nobody is marked.`;
  const note = basis === 'PARCEL'
    ? `Parcel wait cutoff: waited ${ageMinutes} min, limit ${limitMinutes} min, no rider found — routed to a human. Nobody is marked.`
    : basis === 'PREP_PROMISE'
      ? `Food-age cutoff: never marked ready, ${ageMinutes} min past the prep promise, limit ${limitMinutes} min, no rider found — routed to a human. Nobody is marked.`
      : `Food-age cutoff: ready ${ageMinutes} min ago, limit ${limitMinutes} min, no rider found — routed to a human. Nobody is marked.`;
  // [OF-09] The cancellation goes through THE canonical seam (restock, the
  // dispatch searches and booking closed, the case synced, the MMG-unattested
  // marker on the log), staged inside this transaction so it still commits
  // with its decision row and its notice obligation or not at all. Imported
  // lazily: order.service imports this module (the cancel predicate's
  // too-late read).
  const { OrderService } = await import('../order/order.service');
  const orders = new OrderService(deps.prisma, deps.io, undefined, undefined, deps.redis);
  // [RESCUE S1 · CX04] The cancellation, its log line, its decision row and the
  // obligation to tell everyone commit together or not at all. A refused
  // record rolls the cancellation back: the order stays waiting and the next
  // tick (or dispatch pass) settles it again, whole.
  const outboxId = await deps.prisma.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "orders" WHERE id = ${order.id} FOR UPDATE`;
    // The cutoff's own scope, re-read on the LOCKED row (the seam re-checks
    // status, rider and fulfillment itself):
    const live = await tx.order.findFirst({
      where: {
        id: order.id, tenantId: order.tenantId, riderId: null, status: { in: [...WAITING_STATUSES] },
        // [REPORT-070 F-06] "No rider found" is only a fact about work that
        // NEEDS a platform rider: a pickup order or a store's own delivery is
        // riderless by design and must never be retired for it.
        fulfillment: 'DELIVERY',
        foodAgeHeldAt: null,
        AND: [
          notSelfDeliveredFilter(),
          // [TA-S0-001] Money captured between the caller's read and this write
          // is respected under the lock, not by luck: paid MMG is HELD for a
          // person (below), and [OF-17] cash a rider already collected (a
          // parcel fee taken before a handback) is never cancelled away.
          { NOT: { paymentMethod: 'MOBILE_MONEY', paymentStatus: { in: ['CAPTURED', 'CLAIMED'] } } },
          { NOT: { paymentMethod: 'CASH', paymentStatus: 'CAPTURED' } },
        ],
      },
      select: { id: true },
    });
    if (!live) return null;
    await orders.stageCanonicalOrderTransition(tx, {
      orderId: order.id, target: 'CANCELLED', allowedFrom: [...WAITING_STATUSES],
      changedBy: 'system', note,
      cancellation: { by: 'system', reason },
      expectedRiderId: null, expectedFulfillment: 'DELIVERY',
    });
    // recordDecision never throws on a database refusal (it returns null); for
    // the cutoff a missing decision is a missing record, so it rolls back.
    const decisionId = await recordDecision(tx, {
      algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId,
      outcome: basis === 'PARCEL' ? 'PARCEL_NO_RIDER' : 'FOOD_TOO_OLD',
      sentence,
      inputs: { ageMinutes, limitMinutes, basis, orderType: order.orderType, readyAt: order.readyAt?.toISOString() ?? null },
    });
    if (!decisionId) throw new Error('rescue: the cutoff decision row was refused; the cancellation rolls back with it');
    return persistRescueNotice(tx, notice, now);
  });
  if (!outboxId) return holdPaidTooOldOrder(deps, order, ageMinutes, limitMinutes, now);

  // [DISPATCH 1/3 · B4] The live card first, as a pair, once the cancellation
  // is committed. (The obligation below withdraws again on every retry; the
  // compare-and-delete makes a second pass a no-op.)
  await withdrawOfferOfClosedOrder(deps, order.id);
  // The fast path. Anything it cannot finish stays owed on the outbox row and
  // the checkout-outbox sweep delivers it: the verdict never depends on a notice.
  await completeRescueNotice(deps, { outboxId, notice })
    .catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: notices after the cutoff are owed; the outbox sweep retries them'));
  return 'RETIRED';
}

// ---------------------------------------------------------------------------
// [RESCUE S1 · CX04] The cutoff's durable obligation
// ---------------------------------------------------------------------------

/** The outbox kind. In-process only: the generic publisher must never claim it
 *  (checkout-outbox IN_PROCESS_OUTBOX_KINDS), because a published row closes
 *  the moment a queue accepts it — and this one stays owed until every notice
 *  it names is held by its recipient. */
export const RESCUE_NOTICE_KIND = 'rescue-notice' as const;

export interface RescueNotice {
  orderId: string;
  tenantId: string;
  effect: 'RETIRED';
  ageMinutes: number;
  limitMinutes: number;
  /** The delivery generation whose dispatch keys the cleanup drops. */
  deliveryAuthorityVersion: number | null;
  /** [OF-01/17] What the wait was measured from; an obligation written before
   *  it existed reads as READY (the only cutoff there was). */
  basis?: WaitBasis;
}

export interface RescueDelivery {
  /** Every notice the obligation owes is held by its recipient. */
  complete: boolean;
  sent: Array<'customer' | 'business' | 'admin'>;
  failed: Array<'customer' | 'business' | 'admin'>;
}

/** One obligation per cancellation: the order's CANCELLED is terminal, so the
 *  cutoff can commit it once. */
export function rescueNoticeDedupeKey(orderId: string): string {
  return `order:${orderId}:${RESCUE_NOTICE_KIND}`;
}

async function persistRescueNotice(tx: Prisma.TransactionClient, notice: RescueNotice, now: Date): Promise<string> {
  const dedupeKey = rescueNoticeDedupeKey(notice.orderId);
  const id = checkoutOutboxId(dedupeKey);
  await tx.orderOutbox.create({
    data: {
      id, tenantId: notice.tenantId, dedupeKey, orderId: notice.orderId, kind: RESCUE_NOTICE_KIND, queue: 'notification',
      payload: { version: CHECKOUT_OUTBOX_VERSION, ...notice } as Prisma.InputJsonValue, delayMs: 0, availableAt: now,
    },
  });
  return id;
}

/** The worker's payload, parsed strictly: a malformed obligation fails closed. */
export function parseRescueNoticePayload(raw: unknown): RescueNotice {
  const p = (raw ?? {}) as Record<string, unknown>;
  const text = (v: unknown) => typeof v === 'string' && v.length > 0;
  const minutes = (v: unknown) => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  if (!text(p['orderId']) || !text(p['tenantId'])) throw new Error('rescue-notice: orderId and tenantId are required');
  if (p['effect'] !== 'RETIRED') throw new Error('rescue-notice: unknown effect');
  if (!minutes(p['ageMinutes']) || !minutes(p['limitMinutes'])) throw new Error('rescue-notice: ageMinutes and limitMinutes must be whole minutes');
  const version = p['deliveryAuthorityVersion'];
  if (version != null && !(typeof version === 'number' && Number.isInteger(version))) throw new Error('rescue-notice: deliveryAuthorityVersion must be an integer');
  return {
    orderId: p['orderId'] as string, tenantId: p['tenantId'] as string, effect: 'RETIRED',
    ageMinutes: p['ageMinutes'] as number, limitMinutes: p['limitMinutes'] as number,
    deliveryAuthorityVersion: (version as number | null | undefined) ?? null,
    basis: p['basis'] === 'PREP_PROMISE' || p['basis'] === 'PARCEL' ? p['basis'] : 'READY',
  };
}

/**
 * Deliver one obligation against the CURRENT row. Each step is idempotent, so
 * the fast path, the sweep and any retry collapse into one delivery: the card
 * withdrawal is a compare-and-delete, the search memory a plain delete, and
 * every notice carries a stable key (the customer and store keys are the ones
 * the cutoff always used; operations get one per admin). Every notice is tried
 * even when another fails — one recipient's outage never silences the rest —
 * and the obligation is complete only when all of them are held.
 */
export async function deliverRescueNotice(deps: RescueDeps, notice: RescueNotice): Promise<RescueDelivery> {
  return runWithTenant(notice.tenantId, async () => {
    const sent: RescueDelivery['sent'] = [];
    const failed: RescueDelivery['failed'] = [];
    const order = await deps.prisma.order.findFirst({
      where: { id: notice.orderId, tenantId: notice.tenantId },
      select: {
        id: true, orderNumber: true, customerId: true, status: true, cancellationReason: true, cancelledAt: true, paymentMethod: true,
        vendor: { select: { name: true, owner: { select: { userId: true } } } },
      },
    });
    // The cutoff's cancellation, still in its cancelled family: an operator may
    // have moved it on to REFUNDED (a declared edge) before an owed notice was
    // drained, and the notices are still owed then. Anything else — the order
    // gone, or not cancelled by the cutoff — closes the obligation, loudly.
    const deliverable = !!order
      && (order.cancellationReason === FOOD_TOO_OLD_REASON || order.cancellationReason === NO_RIDER_FOR_PARCEL_REASON)
      && (order.status === 'CANCELLED' || order.status === 'REFUNDED');
    if (!order || !deliverable) {
      log().warn({ orderId: notice.orderId, status: order?.status ?? null, reason: order?.cancellationReason ?? null }, 'rescue: an owed food-age notice was closed undelivered — the order is gone or no longer the cutoff\'s cancellation');
      return { complete: true, sent, failed };
    }

    await withdrawOfferOfClosedOrder(deps, order.id);
    await deps.redis.del(...dispatchKeys(order.id, notice.deliveryAuthorityVersion)).catch(() => {});
    // A hint for open screens: they re-read the order, so a repeat is harmless.
    await emitToOrderRoom(deps.prisma, deps.io, order.id, 'order:status_changed', { orderId: order.id, status: order.status, timestamp: (order.cancelledAt ?? new Date()).toISOString() });

    const attempt = async (role: 'customer' | 'business' | 'admin', deliver: () => Promise<boolean>) => {
      try {
        if (await deliver()) sent.push(role); else failed.push(role);
      } catch (err) {
        failed.push(role);
        log().warn({ err, orderId: order.id, role }, 'rescue: a food-age notice was not delivered; it stays owed');
      }
    };
    const money = order.paymentMethod === 'CASH'
      ? 'Nothing to pay.'
      : order.paymentMethod === 'MOBILE_MONEY'
        ? 'If you already paid by MMG, the store refunds you.'
        : 'Nothing is charged for it.';
    // send() answers '' when the inbox row could not be written: not delivered.
    // [OF-01/17] The words follow what the wait was measured from: a ready
    // order, an order the store never marked ready, or a parcel.
    const basis = notice.basis ?? 'READY';
    const reason = order.cancellationReason ?? FOOD_TOO_OLD_REASON;
    await attempt('customer', async () => Boolean(await deps.notifications.send({
      userId: order.customerId,
      type: 'ORDER_UPDATE',
      title: basis === 'PARCEL' ? 'No rider for your parcel' : 'We couldn’t find a rider in time',
      body: basis === 'PARCEL'
        ? `No rider could be found for your parcel ${order.orderNumber} in time, so we cancelled it. ${money} You can send it again any time.`
        : basis === 'PREP_PROMISE'
          ? `No rider could be found for order ${order.orderNumber} in time, so we cancelled it. ${money} We’re sorry.`
          : `Order ${order.orderNumber} was ready but no rider could be found, so we cancelled it rather than deliver it cold. ${money} We’re sorry.`,
      audience: 'customer',
      data: { orderId: order.id, orderNumber: order.orderNumber, status: 'CANCELLED', reason },
      dedupeKey: `food-too-old:customer:${order.id}`,
    })));
    const ownerUserId = order.vendor?.owner.userId;
    if (ownerUserId) {
      await attempt('business', async () => Boolean(await deps.notifications.send({
        userId: ownerUserId,
        type: 'ORDER_UPDATE',
        title: basis === 'PREP_PROMISE' ? 'Order cancelled — no rider in time' : 'Order cancelled — too old to deliver',
        body: basis === 'PREP_PROMISE'
          ? `${order.orderNumber} was not marked ready and no rider could be found ${notice.ageMinutes} min after your prep time. It has been cancelled; it has been flagged for a Swift operator.`
          : `${order.orderNumber} was ready ${notice.ageMinutes} min ago and no rider could be found. It has been cancelled; it has been flagged for a Swift operator.`,
        audience: 'business',
        data: { orderId: order.id, orderNumber: order.orderNumber, status: 'CANCELLED', reason },
        dedupeKey: `food-too-old:vendor:${order.id}`,
      })));
    }
    // [REPORT-070 F-02] "Ops paged" means an operator inbox holds it: the page
    // must reach every admin it names (requireAll throws otherwise), and the
    // per-admin key collapses a retry into the first delivery.
    await attempt('admin', async () => {
      await notifyAdmins(deps.prisma, deps.notifications, {
        title: basis === 'PARCEL'
          ? 'Parcel found no rider — cancelled, needs a person'
          : basis === 'PREP_PROMISE' ? 'No rider in time — cancelled, needs a person' : 'Food too old to deliver — cancelled, needs a person',
        body: basis === 'PARCEL'
          ? `Parcel ${order.orderNumber} waited ${notice.ageMinutes} min with no rider. Check courier supply in that area.`
          : basis === 'PREP_PROMISE'
            ? `Order ${order.orderNumber} (${order.vendor?.name ?? 'store'}) was never marked ready and had no rider ${notice.ageMinutes} min past the prep promise. Check supply in that area and whether the store should be paid.`
            : `Order ${order.orderNumber} (${order.vendor?.name ?? 'store'}) was ready ${notice.ageMinutes} min with no rider. Check supply in that area and whether the store should be paid.`,
        data: { kind: 'ops_food_too_old', orderId: order.id, basis },
        tenantId: notice.tenantId,
        dedupeKey: `food-too-old:ops:${order.id}`,
        requireAll: true,
      });
      return true;
    });
    return { complete: failed.length === 0, sent, failed };
  });
}

/** The cutoff's own fast path: deliver now, and close the obligation only when
 *  nothing it owes is outstanding. Anything left stays owed for the sweep. */
export async function completeRescueNotice(deps: RescueDeps, input: { outboxId: string; notice: RescueNotice }): Promise<RescueDelivery> {
  const result = await deliverRescueNotice(deps, input.notice);
  if (result.complete) {
    await runWithTenant(input.notice.tenantId, () => deps.prisma.orderOutbox.updateMany({
      where: { id: input.outboxId, processedAt: null },
      data: { processedAt: new Date(), claimedAt: null, lastError: null },
    }));
  }
  return result;
}

const NOTICE_DRAIN_LEASE_MS = 60_000;
const NOTICE_RETRY_BASE_MS = 30_000;
const NOTICE_RETRY_MAX_MS = 15 * 60_000;

/** How long an obligation still owed after `attempts` tries waits before the
 *  next: 30 s, doubling, never more than 15 minutes apart — and never dropped. */
export function rescueNoticeRetryDelayMs(attempts: number): number {
  return Math.min(NOTICE_RETRY_MAX_MS, NOTICE_RETRY_BASE_MS * 2 ** Math.min(Math.max(0, attempts - 1), 10));
}

/**
 * The checkout-outbox sweep's drain of the cutoff's obligations (the same
 * shape as the direct-MMG claim notices). Each row is leased by
 * compare-and-set on its attempt counter (two sweeps never hold one; a crashed
 * drain's lease lapses), delivered against the current row, and closed only
 * when the delivery was complete. Anything still owed is released with its
 * reason and backed off; it is never dead-lettered away.
 */
export async function drainRescueNotices(
  deps: RescueDeps & { now?: () => Date },
  options: { limit?: number; leaseMs?: number } = {},
): Promise<{ delivered: number; owed: number; failed: number }> {
  const limit = Math.max(1, options.limit ?? 50);
  const leaseMs = Math.max(1_000, options.leaseMs ?? NOTICE_DRAIN_LEASE_MS);
  const outbox = deps.prisma.orderOutbox;
  const clock = () => deps.now?.() ?? new Date();
  const system = <T>(fn: () => Promise<T>) => runAsSystem('rescue-notice-drain', fn);
  let delivered = 0;
  let owed = 0;
  let failed = 0;
  for (let i = 0; i < limit; i += 1) {
    const now = clock();
    const due = {
      kind: RESCUE_NOTICE_KIND,
      processedAt: null,
      availableAt: { lte: now },
      OR: [{ claimedAt: null }, { claimedAt: { lt: new Date(now.getTime() - leaseMs) } }],
    };
    const row = await system(() => outbox.findFirst({
      where: due,
      orderBy: [{ availableAt: 'asc' }, { id: 'asc' }],
      select: { id: true, payload: true, attempts: true },
    }));
    if (!row) break;
    const lease = await system(() => outbox.updateMany({
      where: { ...due, id: row.id, attempts: row.attempts },
      data: { claimedAt: now, attempts: { increment: 1 } },
    }));
    if (lease.count !== 1) continue; // another sweep took it first
    const attempts = row.attempts + 1;
    const settle = (data: Prisma.OrderOutboxUpdateManyArgs['data']) =>
      system(() => outbox.updateMany({ where: { id: row.id, processedAt: null, attempts }, data }));
    const retryLater = (lastError: string) =>
      settle({ claimedAt: null, lastError: lastError.slice(0, 2_000), availableAt: new Date(clock().getTime() + rescueNoticeRetryDelayMs(attempts)) });
    try {
      const result = await deliverRescueNotice(deps, parseRescueNoticePayload(row.payload));
      if (result.complete) {
        await settle({ processedAt: clock(), claimedAt: null, lastError: null });
        delivered += 1;
      } else {
        await retryLater(`incomplete: sent ${result.sent.join(',') || 'none'}; owed ${result.failed.join(',')}`);
        owed += 1;
      }
    } catch (err) {
      failed += 1;
      await retryLater(`failed: ${err instanceof Error ? err.message : String(err)}`).catch(() => undefined);
    }
  }
  return { delivered, owed, failed };
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
  // [hold v3 · N-02] The claim and its audit are ONE transaction: the column,
  // the decision row and the status-log note commit together, so a crash
  // after the claim can never leave a hold that no record explains. A failed
  // audit write rolls the claim back and the next tick claims again.
  const won = await deps.prisma.$transaction(async (tx) => {
    const claimed = await tx.order.updateMany({
      where: {
        id: order.id, tenantId: order.tenantId, riderId: null, status: { in: [...WAITING_STATUSES] },
        fulfillment: 'DELIVERY', AND: [notSelfDeliveredFilter()],
        paymentMethod: 'MOBILE_MONEY', paymentStatus: { in: ['CAPTURED', 'CLAIMED'] },
        foodAgeHeldAt: null, foodAgeWaivedAt: null,
      },
      data: { foodAgeHeldAt: now },
    });
    if (claimed.count === 0) return false;
    await recordHoldAudit(tx, order, ageMinutes, limitMinutes);
    return true;
  });
  if (!won) {
    // Not ours — unless it is ALREADY held, in which case the effects may
    // still owe delivery (a crash after the claim, a page nobody took).
    const row = await deps.prisma.order.findUnique({
      where: { id: order.id }, select: { foodAgeHeldAt: true, riderId: true, status: true },
    });
    if (!row?.foodAgeHeldAt || row.riderId || !(WAITING_STATUSES as readonly string[]).includes(row.status)) return 'UNTOUCHED';
    await deliverHoldEffects(deps, order, ageMinutes, limitMinutes);
    return 'HELD_PAID';
  }
  await deliverHoldEffects(deps, order, ageMinutes, limitMinutes);
  return 'HELD_PAID';
}

/** [hold v3 · N-02] The hold's record: the decision row and the status-log
 *  note. Written inside the claim transaction by the winner; written by the
 *  sweep's repair pass for any hold found without them (the column proves
 *  the hold happened, so an existence check is a safe idempotency key). */
async function recordHoldAudit(tx: Prisma.TransactionClient | PrismaClient, order: RetireableOrder, ageMinutes: number, limitMinutes: number): Promise<void> {
  const decision = await tx.algoDecision.findFirst({
    where: { algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, outcome: FOOD_TOO_OLD_PAID_HELD_OUTCOME }, select: { id: true },
  });
  if (!decision) {
    await recordDecision(tx, {
      algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId, outcome: FOOD_TOO_OLD_PAID_HELD_OUTCOME,
      sentence: `Ready ${ageMinutes} min ago against a ${limitMinutes}-min limit with no rider found, but the store already holds the MMG payment: held for review, not cancelled — nobody is marked.`,
      inputs: { ageMinutes, limitMinutes, orderType: order.orderType, paymentMethod: order.paymentMethod, paymentStatus: order.paymentStatus, readyAt: order.readyAt?.toISOString() ?? null },
    });
  }
  const note = await tx.orderStatusLog.findFirst({ where: { orderId: order.id, changedBy: 'system', note: { startsWith: 'Food-age cutoff:' } }, select: { id: true } });
  if (!note) {
    await tx.orderStatusLog.create({
      data: {
        orderId: order.id, status: order.status as never, changedBy: 'system',
        note: `Food-age cutoff: ready ${ageMinutes} min ago, limit ${limitMinutes} min, no rider found — but the customer already paid by MMG, so it is HELD for review, not cancelled. Nobody is marked at fault.`,
      },
    });
  }
}

/**
 * The effects of a hold, each idempotent so any tick may re-run them: the
 * live offer keys cleared (a crash between claim and clear must not leave a
 * card on a phone — N-10), the ops page on its once-key, and the two notices
 * on dedupe keys. [hold v3 · N-05] The page runs FIRST, and the notices only
 * promise what is true whether or not it reached anyone: the order is
 * flagged for review — never "someone is looking at it".
 */
async function deliverHoldEffects(deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number): Promise<void> {
  await deps.redis.del(...dispatchKeys(order.id, order.fulfillmentModeVersion)).catch(() => {});
  const { opsPageOnce } = await import('../../jobs/queue');
  await opsPageOnce({ redis: deps.redis }, `food_too_old_paid:${order.id}`, 6 * 3600, () =>
    pageOperators(deps, {
      title: 'Paid MMG order too old to deliver — held for review, NOT cancelled',
      body: `Order ${order.orderNumber} (${order.vendor?.name ?? 'store'}) ${order.readyAt ? 'was ready' : 'was never marked ready and is'} ${ageMinutes} min ${order.readyAt ? '' : 'past its prep promise '}against a ${limitMinutes}-min limit with no rider, and the customer already paid by MMG. The system did not cancel it; it is held. Decide in the admin console (Orders → Held for review): deliver it anyway, which waives the cutoff for this order and sends it back to dispatch, or have the store refund the customer directly.`,
      data: { kind: 'ops_food_too_old', orderId: order.id, held: true },
      tenantId: order.tenantId,
    }),
  ).catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: paid-hold ops page failed'));
  await deps.notifications.send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: 'We couldn’t find a rider in time',
    body: `Order ${order.orderNumber} ${order.readyAt ? 'was ready but no rider could be found' : 'found no rider in time'}. You’ve already paid the store by MMG, so it was NOT cancelled automatically — it is flagged for review by Swift, and nothing more is charged. If it can’t be delivered, the store refunds you directly.`,
    audience: 'customer',
    data: { orderId: order.id, orderNumber: order.orderNumber, reason: FOOD_TOO_OLD_REASON, held: true },
    dedupeKey: `food-too-old-paid:customer:${order.id}`,
  });
  if (order.vendor?.owner.userId) {
    await deps.notifications.send({
      userId: order.vendor.owner.userId,
      type: 'ORDER_UPDATE',
      title: 'No rider found — the customer has already paid',
      body: `${order.orderNumber} ${order.readyAt ? `was ready ${ageMinutes} min ago and no rider could be found` : `was not marked ready and no rider could be found ${ageMinutes} min after the prep time`}. The customer paid you by MMG, so it is NOT cancelled: it is flagged for a Swift operator to review. Keep it ready until Swift decides; if it cannot be delivered, you refund the customer directly.`,
      audience: 'business',
      data: { orderId: order.id, orderNumber: order.orderNumber, reason: FOOD_TOO_OLD_REASON, held: true },
      dedupeKey: `food-too-old-paid:vendor:${order.id}`,
    });
  }
}

/**
 * [hold v3 · N-01/N-12] An OPERATOR's decision on a held paid order: deliver
 * it anyway. Bound to the order's tenant and to the live lifecycle (still
 * waiting, no rider), it clears the hold AND records a durable waiver of the
 * cutoff for this order — without the waiver, dispatch would simply re-hold
 * a still-too-old order on its next tick. The caller re-enqueues dispatch.
 */
export async function releaseFoodAgeHold(
  deps: Pick<RescueDeps, 'prisma' | 'redis'>,
  input: { orderId: string; tenantId: string; byUserId: string },
): Promise<'RELEASED' | 'NOT_HELD' | 'NOT_RELEASABLE'> {
  const row = await deps.prisma.order.findFirst({
    where: { id: input.orderId, tenantId: input.tenantId },
    select: { foodAgeHeldAt: true, riderId: true, status: true },
  });
  if (!row?.foodAgeHeldAt) return 'NOT_HELD';
  if (row.riderId || !(WAITING_STATUSES as readonly string[]).includes(row.status)) return 'NOT_RELEASABLE';
  const now = new Date();
  const released = await deps.prisma.$transaction(async (tx) => {
    const r = await tx.order.updateMany({
      where: { id: input.orderId, tenantId: input.tenantId, foodAgeHeldAt: { not: null }, riderId: null, status: { in: [...WAITING_STATUSES] } },
      data: { foodAgeHeldAt: null, foodAgeWaivedAt: now, foodAgeWaivedBy: input.byUserId },
    });
    if (r.count === 0) return false;
    await tx.orderStatusLog.create({
      data: { orderId: input.orderId, status: row.status as never, changedBy: input.byUserId, note: 'Food-age hold released by an operator: deliver anyway — the cutoff is waived for this order and it goes back to dispatch.' },
    });
    return true;
  });
  if (!released) return 'NOT_HELD';
  await deps.redis.del(`ops_page:food_too_old_paid:${input.orderId}`).catch(() => {});
  return 'RELEASED';
}

/** The watchdog tick: retire every waiting, riderless platform-delivery
 *  order past its tenant's cutoff — HOLD, un-cancelled, the ones whose money
 *  the store already holds ([TA-S0-001]) — and re-deliver the effects of
 *  every existing hold whose notices may still be owed. */
/** [OF-01/17] The one "cancel free now" notice's key: at most one per order, ever. */
export function riderlessCutoffNoticeKey(orderId: string): string {
  return `riderless-cutoff:customer:${orderId}`;
}

/**
 * [OF-01/17 · COORD ruling 19 Oct 2026] Past its cutoff, a riderless order is
 * not cancelled at once: the customer is told ONCE that they can cancel for
 * free (true at this moment — the cancel predicate reads the same cutoff, and
 * a parcel nobody took is always free), and the system cancels only when that
 * customer was told RIDERLESS_GRACE_MIN ago and still no rider has come. The
 * durable "told at" is the cutoff's decision row, written before the notice
 * (whose key makes a re-send collapse), so a restart never re-tells, never
 * skips the grace, and a notice that cannot be written never stalls the exit
 * (REVIEW-G S3-1). A paid MMG order is never
 * told "free" (the store holds the money): it goes straight to the paid hold.
 */
async function settleAfterGrace(
  deps: RescueDeps, order: RetireableOrder, ageMinutes: number, limitMinutes: number, basis: WaitBasis, now: Date,
): Promise<RetireOutcome | 'NOTIFIED' | 'WAITING'> {
  if (isCapturedMmg(order)) return settleTooOldOrder(deps, order, ageMinutes, limitMinutes, now, basis);
  // [REVIEW-G S3-1] The grace runs from a DURABLE "told at": the cutoff's own
  // decision row, written before the notice. The notice itself is best-effort
  // (send() writes no row and answers '' when it fails), so it is re-sent,
  // deduped, on every tick until it lands — but its failure can never hold the
  // order past the grace, the 19-day class the cutoff exists to end.
  const told = await deps.prisma.algoDecision.findFirst({
    where: { algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, outcome: RIDERLESS_TOLD_OUTCOME },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  });
  if (!told) {
    const recorded = await recordDecision(deps.prisma, {
      algo: ALGO_ID, subjectType: 'ORDER', subjectId: order.id, tenantId: order.tenantId,
      outcome: RIDERLESS_TOLD_OUTCOME,
      sentence: `No rider ${ageMinutes - limitMinutes} min past the cutoff: the customer is told they can cancel for free, and the system cancels ${RIDERLESS_GRACE_MIN} min from now if no rider comes.`,
      inputs: { ageMinutes, limitMinutes, basis, graceMinutes: RIDERLESS_GRACE_MIN },
    });
    // No durable "told at" means no grace has started: say nothing yet, try next tick.
    if (!recorded) return 'WAITING';
    await sendRiderlessCutoffNotice(deps, order, basis);
    return 'NOTIFIED';
  }
  await sendRiderlessCutoffNotice(deps, order, basis); // a no-op once its row exists (deduped)
  if (now.getTime() - told.createdAt.getTime() < RIDERLESS_GRACE_MIN * 60_000) return 'WAITING';
  return settleTooOldOrder(deps, order, ageMinutes, limitMinutes, now, basis);
}

/** [OF-01/17] The decision row whose time starts the grace. */
export const RIDERLESS_TOLD_OUTCOME = 'RIDERLESS_CUTOFF_TOLD';

/** The ONE "you can cancel for free" notice (deduped per order, so a re-send of a
 *  delivered notice collapses into it). */
async function sendRiderlessCutoffNotice(deps: RescueDeps, order: RetireableOrder, basis: WaitBasis): Promise<void> {
  const dedupeKey = riderlessCutoffNoticeKey(order.id);
  // [#1890 owner wall · COORD 13:56Z] A system read of someone's inbox names its
  // capability. Nothing is DECIDED on this read (the grace runs from the
  // decision row): an empty read only re-sends a notice whose key collapses it
  // into the one already held, and a failed read sends nothing this tick.
  let held: { id: string } | null;
  try {
    held = await runAsSystem('rescue-riderless-notice-held', () => deps.prisma.notification.findUnique({
      where: { userId_dedupeKey: { userId: order.customerId, dedupeKey } },
      select: { id: true },
    }));
  } catch (err) {
    log().warn({ err, orderId: order.id }, 'rescue: could not read whether the cutoff notice is held; not re-sending this tick');
    return;
  }
  if (held) return;
  const money = order.paymentMethod === 'CASH' ? ' You won’t pay anything.' : order.paymentMethod === 'MOBILE_MONEY' ? '' : ' Nothing is charged for it.';
  await deps.notifications.send({
    userId: order.customerId,
    type: 'ORDER_UPDATE',
    title: basis === 'PARCEL' ? 'No rider yet — you can cancel for free' : 'Still no rider — you can cancel for free',
    body: basis === 'PARCEL'
      ? `No rider has taken your parcel ${order.orderNumber} yet. You can cancel it now for free. If no rider takes it in the next ${RIDERLESS_GRACE_MIN} minutes, we’ll cancel it for you.${money}`
      : `We still haven’t found a rider for order ${order.orderNumber}. You can cancel it now for free. If no rider is found in the next ${RIDERLESS_GRACE_MIN} minutes, we’ll cancel it for you.${money}`,
    audience: 'customer',
    data: { orderId: order.id, orderNumber: order.orderNumber, kind: 'riderless_cutoff', canCancelFree: true, cancelsInMinutes: RIDERLESS_GRACE_MIN },
    dedupeKey,
  }).catch((err: unknown) => log().warn({ err, orderId: order.id }, 'rescue: the riderless cutoff notice was not delivered; it is re-sent next tick'));
}

export async function sweepFoodAge(deps: RescueDeps, now = new Date()): Promise<{ retired: string[]; held: string[]; notified: string[] }> {
  const retired: string[] = [];
  const held: string[] = [];
  const notified: string[] = [];
  const select = {
    id: true, orderNumber: true, customerId: true, tenantId: true, orderType: true, status: true, paymentMethod: true, paymentStatus: true, readyAt: true,
    fulfillmentModeVersion: true, acceptedAt: true, estimatedPrepTime: true, placedAt: true, holdExpiresAt: true, scheduledFor: true,
    vendor: { select: { name: true, owner: { select: { userId: true } } } },
  } as const;
  type WaitingRow = Prisma.OrderGetPayload<{ select: typeof select }>;
  // [REPORT-070 F-04/F-06] Oldest first, a bounded page, held rows excluded,
  // and only work that needs a platform rider — so a shelf of held paid
  // orders can never occupy the page, and a pickup order is never "no rider".
  // [hold v3 · N-07/N-08] Keyset cursors carried across ticks: a page that
  // could not be retired this tick (a tenant with no cutoff, a row not yet
  // old enough) never occupies the page forever — the next tick continues
  // past it and wraps to the start when the set is exhausted.
  // [RESCUE S1 · CX05] The cursor is (readyAt, id), durable in sweep_cursors:
  // a timestamp-only cursor jumped past every row sharing the last row's time,
  // so a tie that straddled a page starved its tail forever. A row that throws
  // is recorded and skipped for this pass; the rest of the page is served.
  await sweepPage<WaitingRow>(deps.prisma, RESCUE_SWEEPS.retire, {
    pageSize: SWEEP_PAGE.retire,
    cursorOf: (o) => keysetCursor(o.readyAt, o.id),
    fetch: (after, limit) => deps.prisma.order.findMany({
      where: {
        riderId: null, status: { in: [...WAITING_STATUSES] }, readyAt: { not: null },
        fulfillment: 'DELIVERY', foodAgeHeldAt: null, foodAgeWaivedAt: null,
        AND: [notSelfDeliveredFilter(), afterKeyset('readyAt', after)],
      },
      select,
      orderBy: [{ readyAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
    handle: async (o) => {
      // [REPORT-070 F-05] The order's own tenant decides its cutoff.
      const limit = await foodAgeLimitMinutes(deps.prisma, o.orderType, o.tenantId);
      if (limit == null) return;
      const age = foodAge(o, limit, now);
      if (!age.tooOld || age.ageMinutes == null) return;
      const outcome = await settleTooOldOrder(deps, o, age.ageMinutes, limit, now);
      if (outcome === 'RETIRED') retired.push(o.id);
      else if (outcome === 'HELD_PAID') held.push(o.id);
    },
    now,
  });
  // [REPORT-070 F-01/F-02] Existing holds: every effect is idempotent, so
  // re-running them repairs a crash after the claim or a page nobody took.
  // [RESCUE S1 · CX05] (foodAgeHeldAt, id): one tick holds many orders at the
  // same `now`, so held times tie by construction.
  // [OF-01] A riderless store order the store accepted but never marked
  // ready: timed from its prep promise; past the cutoff the customer is told
  // ONCE that they can cancel for free, and the system cancels when no rider
  // has come RIDERLESS_GRACE_MIN after that notice. An MMG order nobody has
  // marked paid is not here: it is never dispatched, and its own 30-minute
  // acceptance expiry closes it.
  if (prepPromiseClockRuns()) await sweepPage<WaitingRow>(deps.prisma, RESCUE_SWEEPS.unready, {
    pageSize: SWEEP_PAGE.retire,
    cursorOf: (o) => keysetCursor(o.acceptedAt, o.id),
    fetch: (after, limit) => deps.prisma.order.findMany({
      where: {
        riderId: null, status: { in: ['ACCEPTED', 'PREPARING'] }, readyAt: null, acceptedAt: { not: null },
        fulfillment: 'DELIVERY', foodAgeHeldAt: null, foodAgeWaivedAt: null,
        NOT: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'PENDING' },
        AND: [notSelfDeliveredFilter(), afterKeyset('acceptedAt', after)],
      },
      select,
      orderBy: [{ acceptedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
    handle: async (o) => {
      const limit = await foodAgeLimitMinutes(deps.prisma, o.orderType, o.tenantId);
      if (limit == null) return;
      const age = foodAge(o, limit, now);
      if (!age.tooOld || age.ageMinutes == null || age.basis == null) return;
      const outcome = await settleAfterGrace(deps, o, age.ageMinutes, limit, age.basis, now);
      if (outcome === 'RETIRED') retired.push(o.id);
      else if (outcome === 'HELD_PAID') held.push(o.id);
      else if (outcome === 'NOTIFIED') notified.push(o.id);
    },
    now,
  });
  // [OF-17] A riderless parcel: at most COURIER_WAIT_LIMIT_MIN from its start,
  // then the same one notice and grace. A parcel whose fee a rider already
  // collected (CAPTURED before a handback) is never cancelled here: a person
  // holds that cash (OF-07).
  await sweepPage<WaitingRow>(deps.prisma, RESCUE_SWEEPS.parcel, {
    pageSize: SWEEP_PAGE.retire,
    cursorOf: (o) => keysetCursor(o.placedAt, o.id),
    fetch: (after, limit) => deps.prisma.order.findMany({
      where: {
        orderType: 'COURIER', riderId: null, status: 'READY_FOR_PICKUP',
        fulfillment: 'DELIVERY', foodAgeHeldAt: null, foodAgeWaivedAt: null,
        paymentStatus: { notIn: ['CAPTURED', 'CLAIMED'] },
        AND: [notSelfDeliveredFilter(), afterKeyset('placedAt', after)],
      },
      select,
      orderBy: [{ placedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
    handle: async (o) => {
      const age = foodAge(o, COURIER_WAIT_LIMIT_MIN, now);
      if (!age.tooOld || age.ageMinutes == null || age.basis == null) return;
      const outcome = await settleAfterGrace(deps, o, age.ageMinutes, COURIER_WAIT_LIMIT_MIN, age.basis, now);
      if (outcome === 'RETIRED') retired.push(o.id);
      else if (outcome === 'NOTIFIED') notified.push(o.id);
    },
    now,
  });
  await sweepPage<WaitingRow & { foodAgeHeldAt: Date | null }>(deps.prisma, RESCUE_SWEEPS.holds, {
    pageSize: SWEEP_PAGE.holds,
    cursorOf: (h) => keysetCursor(h.foodAgeHeldAt, h.id),
    fetch: (after, limit) => deps.prisma.order.findMany({
      where: {
        foodAgeHeldAt: { not: null }, riderId: null, status: { in: [...WAITING_STATUSES] },
        AND: [afterKeyset('foodAgeHeldAt', after)],
      },
      select: { ...select, foodAgeHeldAt: true },
      orderBy: [{ foodAgeHeldAt: 'asc' }, { id: 'asc' }],
      take: limit,
    }),
    handle: async (h) => {
      const limit = (await foodAgeLimitMinutes(deps.prisma, h.orderType, h.tenantId)) ?? 0;
      const age = foodAge(h, limit, now);
      // The repair pass: a hold whose audit never landed (pre-v3 code, or a
      // decision write that was refused) gets its record now, idempotently.
      await recordHoldAudit(deps.prisma, h, age.ageMinutes ?? 0, limit).catch((err: unknown) => log().warn({ err, orderId: h.id }, 'rescue: hold audit repair failed'));
      await deliverHoldEffects(deps, h, age.ageMinutes ?? 0, limit);
      if (!held.includes(h.id)) held.push(h.id);
    },
    now,
  });
  return { retired, held, notified };
}

// ---------------------------------------------------------------------------
// ① The incentive — Swift's own money
// ---------------------------------------------------------------------------

export async function rescueIncentiveGyd(prisma: PrismaClient, cascade: number, tenantId: string): Promise<number> {
  const [amount, from] = await Promise.all([algoConfig(prisma, 'rescue.incentiveGyd', tenantId), algoConfig(prisma, 'rescue.incentiveFromCascade', tenantId)]);
  const gyd = Math.max(0, Math.round(Number(amount.value) || 0));
  const fromCascade = Math.max(1, Math.round(Number(from.value) || 2));
  // [Row 208 guard] Production pays no incentive until a payout path and a deletion block ship.
  return gyd > 0 && cascade >= fromCascade ? rescueIncentivePayable(gyd) : 0;
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
