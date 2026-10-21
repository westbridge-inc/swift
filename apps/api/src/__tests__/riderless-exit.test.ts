import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import {
  advance, ageWorld, buildWalkWorld, call, castWalk, drainDue, placeCashOrder, releaseWorld, runSweeps, type Cast, type WalkWorld,
} from './helpers/order-walk-world';
import { RIDERLESS_TOLD_OUTCOME, readTooLateToDeliver, settleTooOldOrder, sweepFoodAge } from '../modules/dispatch/rescue';
import { NotificationService, type NotificationPayload } from '../modules/notification/notification.service';

// ---------------------------------------------------------------------------
// [OF-01 / OF-17 · COORD ruling 19 Oct 2026] A riderless order ENDS, and is told
// once per change.
//
// Staging held a food order the store accepted and never marked ready, with no
// rider, for 19 days: dispatch re-searched it every ~6 h and the customer got
// 219 notices. A parcel nobody took had no cutoff at all. The ruling:
//   - food: cutoff = accepted + the store's prep promise + the vertical's
//     food-age limit (readyAt, when the store marked it ready, as before);
//     parcel: 60 min from its start;
//   - at the cutoff ONE honest notice ("you can cancel for free"), then 15 min
//     grace, then the system cancels — nothing to pay for cash, store and
//     customer told once, stock back through the canonical seam;
//   - never repeat a notice: one per order state.
//
// Everything here is the real route, the real sweep and the real dispatch
// engine on an aged world (helpers/order-walk-world.ts): time passes by moving
// the order's own rows and Redis TTLs into the past, never by faking Date.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const SWEEP = 5 * MIN;
// The ruling's numbers, written here (not imported) so a changed constant reds this file.
const COURIER_WAIT_LIMIT_MIN = 60;
const RIDERLESS_GRACE_MIN = 15;
const DEFAULT_PREP_PROMISE_MIN = 30; // the Vendor.estimatedPrepTime default
const FOOD_TOO_OLD_REASON = 'FOOD_TOO_OLD';
const NO_RIDER_FOR_PARCEL_REASON = 'NO_RIDER_FOR_PARCEL';
const CUTOFF_TITLES = ['Still no rider — you can cancel for free', 'No rider yet — you can cancel for free'];
const cutoffNotices = (rows: Array<{ title: string; body: string }>) => rows.filter((r) => CUTOFF_TITLES.includes(r.title));
let w: WalkWorld;

beforeAll(async () => {
  w = await buildWalkWorld();
}, 120_000);

afterAll(async () => {
  // Its stores, riders and unfinished orders must not outlive the suite.
  await releaseWorld(w);
  await w.app.close();
});

async function offline(cast: Cast) {
  for (const r of cast.riders) {
    await w.app.prisma.rider.update({ where: { id: r.riderId }, data: { isOnline: false, isAvailable: false } });
  }
}

async function noticesOf(orderId: string, userId: string) {
  return w.app.prisma.$queryRawUnsafe<Array<{ title: string; body: string; dedupeKey: string | null }>>(
    `SELECT title, body, "dedupeKey" FROM notifications WHERE data->>'orderId' = $1 AND "userId" = $2 ORDER BY "createdAt", id`,
    orderId, userId,
  );
}
const count = (rows: Array<{ title: string }>, title: string) => rows.filter((r) => r.title === title).length;

describe('[OF-01] a riderless store order nobody marks ready ends — one honest notice, a 15-minute grace, a cancel through the seam', () => {
  it('is told once at the cutoff, waits out the grace, then is cancelled with its stock put back', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    await w.app.prisma.item.update({ where: { id: cast.itemId }, data: { stockQuantity: 10 } });
    const { orderId } = await placeCashOrder(w, cast);
    expect(orderId).toBeTruthy();
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    expect((await w.app.prisma.item.findUniqueOrThrow({ where: { id: cast.itemId } })).stockQuantity).toBe(9);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    const cutoffMin = prep + 45; // FOOD_DELIVERY's food-age limit, from the prep promise

    // Short of the cutoff: still waiting, nothing said about cancelling.
    await advance(w, cast, (cutoffMin - 5) * MIN, SWEEP);
    let row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACCEPTED');
    let notes = await noticesOf(id, cast.customer.userId);
    expect(cutoffNotices(notes)).toHaveLength(0);
    expect(await readTooLateToDeliver(w.app.prisma, row)).toBe(false);

    // Past the cutoff: ONE notice that cancelling is free — and the cancel
    // predicate agrees at that moment (same clock, same limit).
    await advance(w, cast, 10 * MIN, SWEEP);
    row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACCEPTED');
    notes = await noticesOf(id, cast.customer.userId);
    const cutoffNotes = cutoffNotices(notes);
    expect(cutoffNotes).toHaveLength(1);
    expect(cutoffNotes[0]!.body).toContain('cancel it now for free');
    expect(cutoffNotes[0]!.body).toContain(`next ${RIDERLESS_GRACE_MIN} minutes`);
    expect(await readTooLateToDeliver(w.app.prisma, row)).toBe(true);

    // Inside the grace: nothing more.
    await advance(w, cast, (RIDERLESS_GRACE_MIN - 6) * MIN, SWEEP);
    row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('ACCEPTED');
    expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(1);

    // Grace over, still no rider: the system cancels, through the seam.
    await advance(w, cast, 10 * MIN, SWEEP);
    const cancelled = await w.app.prisma.order.findUniqueOrThrow({ where: { id }, include: { statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    expect(cancelled.status).toBe('CANCELLED');
    expect(cancelled.cancellationReason).toBe(FOOD_TOO_OLD_REASON);
    expect(cancelled.cancelledBy).toBe('system');
    expect(cancelled.statusHistory.filter((l) => l.status === 'CANCELLED')).toHaveLength(1);
    expect(cancelled.statusHistory.at(-1)!.note).toContain('never marked ready');
    // [OF-09] The canonical seam restocks what never left the store, and closes the searches.
    expect((await w.app.prisma.item.findUniqueOrThrow({ where: { id: cast.itemId } })).stockQuantity).toBe(10);
    expect(await w.app.prisma.dispatchSearch.count({ where: { subjectId: id, status: { in: ['SEARCHING', 'EXHAUSTED'] } } })).toBe(0);

    // Told once, in true words: never "was ready" about food nobody marked ready.
    notes = await noticesOf(id, cast.customer.userId);
    const gone = notes.filter((n) => n.title === 'We couldn’t find a rider in time');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.body).not.toContain('was ready');
    expect(gone[0]!.body).toContain('Nothing to pay.');
    const store = await noticesOf(id, cast.vendorOwner.userId);
    expect(count(store, 'Order cancelled — no rider in time')).toBe(1);
    expect(store.find((n) => n.title === 'Order cancelled — no rider in time')!.body).toContain('was not marked ready');

    // And a terminal order stays quiet.
    const before = (await noticesOf(id, cast.customer.userId)).length;
    await advance(w, cast, 12 * 60 * MIN, 30 * MIN);
    expect((await noticesOf(id, cast.customer.userId)).length).toBe(before);
  }, 300_000);

  it('the grace is exact: 14 minutes after the notice it still waits, at 15 it is cancelled — nothing paid, nothing owed', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    // To just past the cutoff, then ONE sweep: the notice is written now.
    await ageWorld(w, (prep + 46) * MIN);
    await runSweeps(w);
    await drainDue(w);
    // The notice's own row is aged with the world, so its age is read fresh each time.
    const sinceNotice = async () => {
      const told = await w.app.prisma.notification.findFirstOrThrow({
        where: { userId: cast.customer.userId, title: { in: CUTOFF_TITLES }, data: { path: ['orderId'], equals: id } },
        select: { createdAt: true },
      });
      return Date.now() - told.createdAt.getTime();
    };
    // Exactly 14 minutes after the notice: still waiting, still one notice.
    await ageWorld(w, 14 * MIN - await sinceNotice());
    await runSweeps(w);
    await drainDue(w);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
    expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(1);
    // 15 minutes after the notice (one second past, for the clocks' rounding): cancelled.
    expect(await sinceNotice()).toBeLessThan(15 * MIN);
    await ageWorld(w, 15 * MIN - await sinceNotice() + 1_000);
    await runSweeps(w);
    await drainDue(w);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, reason: row.cancellationReason }).toEqual({ status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON });
    // A cash order the rider never reached: no money was taken, so none is owed back.
    expect({ paymentStatus: row.paymentStatus, refundOwed: row.refundOwedAmount, refundPaid: row.refundPaidAmount })
      .toEqual({ paymentStatus: 'PENDING', refundOwed: null, refundPaid: null });
    const gone = (await noticesOf(id, cast.customer.userId)).filter((n) => n.title === 'We couldn’t find a rider in time');
    expect(gone).toHaveLength(1);
    expect(gone[0]!.body).toContain('Nothing to pay.');
  }, 300_000);

  it('under DISPATCH_TRIGGER=ON_READY nobody searches before ready, so the prep clock does not run: no "no rider" notice, no "too late", no cancel', async () => {
    const before = process.env['DISPATCH_TRIGGER'];
    process.env['DISPATCH_TRIGGER'] = 'ON_READY';
    try {
      const cast = await castWalk(w, 1);
      await offline(cast);
      const { orderId } = await placeCashOrder(w, cast);
      const id = orderId!;
      await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token);
      await ageWorld(w, (DEFAULT_PREP_PROMISE_MIN + 45 + RIDERLESS_GRACE_MIN + 30) * MIN);
      await runSweeps(w);
      await drainDue(w);
      await runSweeps(w);
      const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
      expect(row.status).toBe('ACCEPTED');
      expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(0);
      expect(await readTooLateToDeliver(w.app.prisma, row)).toBe(false);
    } finally {
      if (before === undefined) delete process.env['DISPATCH_TRIGGER'];
      else process.env['DISPATCH_TRIGGER'] = before;
    }
  }, 300_000);

  it('a rider who takes it during the grace keeps it — the cancel is a guarded transition, not a timer', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    await advance(w, cast, (prep + 50) * MIN, SWEEP);
    expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(1);
    const r = cast.riders[0]!;
    expect((await call(w, 'POST', '/api/v1/rider/go-online', r.token, { latitude: r.lat, longitude: r.lng })).statusCode).toBe(200);
    expect((await call(w, 'POST', `/api/v1/rider/orders/${id}/accept`, r.token)).statusCode).toBe(200);
    await advance(w, cast, 30 * MIN, SWEEP);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: r.riderId });
  }, 300_000);
});

describe('[OF-01 · REVIEW-G S3-1/S3-2] the grace never hangs on a notice, and money is never told "free" or cancelled away', () => {
  /** A notification service whose "cancel for free" notice can never be written —
   *  what send() answers when its row cannot be persisted. */
  class CutoffNoticeUnwritable extends NotificationService {
    override async send(payload: NotificationPayload): Promise<string> {
      if ((payload.data as Record<string, unknown> | undefined)?.['kind'] === 'riderless_cutoff') return '';
      return super.send(payload);
    }
  }

  it('a cutoff notice that can never be written still ends the order one grace later — the grace runs from a durable record', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    const deps = { prisma: w.app.prisma, redis: w.app.redis, io: w.app.io, notifications: new CutoffNoticeUnwritable(w.app.prisma, w.app.io) };
    // Just past the cutoff: the told-at is recorded even though the notice is not.
    await ageWorld(w, (prep + 46) * MIN);
    await sweepFoodAge(deps);
    expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(0);
    expect(await w.app.prisma.algoDecision.count({ where: { subjectId: id, outcome: RIDERLESS_TOLD_OUTCOME } })).toBe(1);
    // Inside the grace, ticks re-try the notice and keep one record.
    await ageWorld(w, 10 * MIN);
    await sweepFoodAge(deps);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('ACCEPTED');
    expect(await w.app.prisma.algoDecision.count({ where: { subjectId: id, outcome: RIDERLESS_TOLD_OUTCOME } })).toBe(1);
    // A grace after the record: cancelled, notice or no notice.
    await ageWorld(w, (RIDERLESS_GRACE_MIN - 10) * MIN + 1_000);
    await sweepFoodAge(deps);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, reason: row.cancellationReason }).toEqual({ status: 'CANCELLED', reason: FOOD_TOO_OLD_REASON });
  }, 300_000);

  it('a paid MMG order is never told it can cancel for free: past the cutoff it is held for a person, not cancelled', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    // The state a confirmed MMG payment leaves (set directly: the MMG doors are not what this case is about).
    await w.app.prisma.order.update({ where: { id }, data: { paymentMethod: 'MOBILE_MONEY', paymentStatus: 'CAPTURED' } });
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    await advance(w, cast, (prep + 45 + RIDERLESS_GRACE_MIN + 10) * MIN, SWEEP);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).not.toBe('CANCELLED');
    expect(row.foodAgeHeldAt).not.toBeNull();
    expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(0);
  }, 300_000);

  it('cash a rider took between the sweep’s read and its lock is never cancelled away (the locked re-read, OF-07)', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const order = await w.app.prisma.order.create({
      data: {
        orderNumber: `WALKP-${nanoid(8)}`, orderType: 'COURIER', customerId: cast.customer.userId,
        status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
        pickupAddress: 'Sender', pickupLat: 6.8013, pickupLng: -58.1551, deliveryAddress: 'Receiver', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 800, totalAmount: 800, paymentMethod: 'CASH', paymentStatus: 'PENDING',
      },
    });
    await w.app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'READY_FOR_PICKUP', changedBy: cast.customer.userId, note: 'Parcel booked' } });
    w.orderIds.add(order.id);
    // The sweep read it unpaid; then a rider collected the fee (a handback
    // leaves CAPTURED cash on a riderless parcel) before the cutoff took its lock.
    const seen = await w.app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    await w.app.prisma.order.update({ where: { id: order.id }, data: { paymentStatus: 'CAPTURED' } });
    const deps = { prisma: w.app.prisma, redis: w.app.redis, io: w.app.io, notifications: new NotificationService(w.app.prisma, w.app.io) };
    const outcome = await settleTooOldOrder(deps, seen as never, 80, 60, new Date(), 'PARCEL');
    expect(outcome).not.toBe('RETIRED');
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status).toBe('READY_FOR_PICKUP');
  }, 300_000);
});

describe('[OF-01] the dispatch notices are told once per order state, not once per search', () => {
  it('a waived order nobody delivers for a day tells each person each thing once; a handback (a new state) may tell once more', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token);
    await call(w, 'PUT', `/api/v1/vendor/orders/${id}/preparing`, cast.vendorOwner.token);
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/ready`, cast.vendorOwner.token)).statusCode).toBe(200);
    // An operator's "deliver anyway": no cutoff applies, so only the search loop runs.
    await w.app.prisma.order.update({ where: { id }, data: { foodAgeWaivedAt: new Date() } });

    await advance(w, cast, 24 * 60 * MIN, 30 * MIN);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_PICKUP');
    const customer = await noticesOf(id, cast.customer.userId);
    // Four 6-hour cycles ran (main: 8 "Still looking" + 4 "No movers").
    expect(count(customer, 'Still looking for a mover')).toBe(1);
    expect(count(customer, 'No movers available right now')).toBe(1);
    expect(count(await noticesOf(id, cast.vendorOwner.userId), 'No movers available')).toBe(1);
    expect(count(await noticesOf(id, w.admin.userId), 'Dispatch exhausted — no mover found')).toBe(1);

    // A real change of state: a rider takes it and hands it back.
    const r = cast.riders[0]!;
    await call(w, 'POST', '/api/v1/rider/go-online', r.token, { latitude: r.lat, longitude: r.lng });
    expect((await call(w, 'POST', `/api/v1/rider/orders/${id}/accept`, r.token)).statusCode).toBe(200);
    expect((await call(w, 'POST', `/api/v1/rider/orders/${id}/handback`, r.token, { reason: 'flat tyre, cannot ride' })).statusCode).toBe(200);
    await offline(cast);
    await advance(w, cast, 24 * 60 * MIN, 30 * MIN);
    const after = await noticesOf(id, cast.customer.userId);
    expect(count(after, 'Still looking for a mover')).toBeLessThanOrEqual(2);
    expect(count(after, 'No movers available right now')).toBeLessThanOrEqual(2);
  }, 600_000);
});

describe('[OF-17] a riderless parcel ends — one notice, a grace, a cancel; parcel words', () => {
  async function makeParcel(cast: Cast, paymentStatus: 'PENDING' | 'CAPTURED' = 'PENDING') {
    const order = await w.app.prisma.order.create({
      data: {
        orderNumber: `WALKP-${nanoid(8)}`, orderType: 'COURIER', customerId: cast.customer.userId,
        status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
        pickupAddress: 'Sender', pickupLat: 6.8013, pickupLng: -58.1551, deliveryAddress: 'Receiver', deliveryLat: 6.81, deliveryLng: -58.16,
        subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0, deliveryFee: 800, totalAmount: 800, paymentMethod: 'CASH', paymentStatus,
      },
    });
    await w.app.prisma.orderStatusLog.create({ data: { orderId: order.id, status: 'READY_FOR_PICKUP', changedBy: cast.customer.userId, note: 'Parcel booked' } });
    w.orderIds.add(order.id);
    return order.id;
  }

  it('a parcel nobody takes is told once after an hour, then cancelled 15 minutes later — nothing to pay', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const id = await makeParcel(cast);
    await advance(w, cast, (COURIER_WAIT_LIMIT_MIN - 5) * MIN, SWEEP);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_PICKUP');
    await advance(w, cast, 10 * MIN, SWEEP);
    let notes = await noticesOf(id, cast.customer.userId);
    const told = cutoffNotices(notes);
    expect(told).toHaveLength(1);
    expect(told[0]!.title).toBe('No rider yet — you can cancel for free');
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_PICKUP');
    await advance(w, cast, (RIDERLESS_GRACE_MIN + 5) * MIN, SWEEP);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, reason: row.cancellationReason, by: row.cancelledBy }).toEqual({ status: 'CANCELLED', reason: NO_RIDER_FOR_PARCEL_REASON, by: 'system' });
    notes = await noticesOf(id, cast.customer.userId);
    expect(count(notes, 'No rider for your parcel')).toBe(1);
    expect(notes.find((n) => n.title === 'No rider for your parcel')!.body).toContain('Nothing to pay.');
    // Never the store's words for a parcel.
    for (const n of notes) expect(n.body).not.toMatch(/vendor can hold|can hold it/i);
  }, 300_000);

  it('a parcel whose fee a rider already collected is never cancelled away by the timer (a person holds that cash — OF-07)', async () => {
    const cast = await castWalk(w, 1);
    await offline(cast);
    const id = await makeParcel(cast, 'CAPTURED');
    await advance(w, cast, (COURIER_WAIT_LIMIT_MIN + RIDERLESS_GRACE_MIN + 30) * MIN, SWEEP);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect(row.status).toBe('READY_FOR_PICKUP');
    expect(cutoffNotices(await noticesOf(id, cast.customer.userId))).toHaveLength(0);
  }, 300_000);
});
