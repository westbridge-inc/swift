import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  ageWorld, buildWalkWorld, call, castWalk, drainDue, placeCashOrder, releaseWorld, runSweeps, type Cast, type WalkWorld,
} from './helpers/order-walk-world';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';
import { dispatchDeclinedKey } from '../modules/dispatch/dispatch-generation-keys';
import { releaseOverdueLeg } from '../modules/dispatch/pickup-overdue';
import { NotificationService } from '../modules/notification/notification.service';

// ---------------------------------------------------------------------------
// [OF-33 · COORD ruling 21 Oct 2026] A rider who accepts and then never picks
// up — GPS alive — no longer holds the order forever.
//
// Found by the order random walk: the food-age sweep reads riderless orders
// only and the delivery watchdog acts only on a dark GPS, so an assigned rider
// who simply never moved held the order for good. The ruling:
//   - pickupDue = the later of the ready time (readyAt, else the store's
//     accept + its prep promise) and the rider's accept + 20 min;
//   - pickupDue + 10 min: ONE push to the rider ("pick up now or release");
//   - pickupDue + 20 min with no pickup confirmed: the order goes BACK TO
//     DISPATCH (never cancelled) through the release edge; the customer and
//     the store are told once each; the rider's acceptance is a no-show and
//     earns nothing; ops is paged once;
//   - goods in the rider's hands (pickup confirmed, or cash already taken)
//     are never released by a timer; on a stacked run only the overdue leg is;
//   - the minute values are settings.
// Everything is the real route, the real sweep and the real dispatch engine on
// an aged world (helpers/order-walk-world.ts): never a faked Date.
// ---------------------------------------------------------------------------

const MIN = 60_000;
// The ruling's numbers, written here (not imported) so a changed default reds this file.
const TRAVEL_MIN = 20;
const NUDGE_MIN = 10;
const RELEASE_MIN = 20;
const DEFAULT_PREP_PROMISE_MIN = 30;
const NUDGE_TITLE = 'Pick up now or release the order';
const CUSTOMER_TITLE = 'Finding you a new rider';
const STORE_TITLE = 'A new rider is coming';
const OPS_TITLE = 'Rider no-show before pickup';
const STORE_WAITING_TITLE = 'Your rider is waiting';
const OPS_WAITING_TITLE = 'Rider waiting at a store that is not ready';

let w: WalkWorld;

beforeAll(async () => {
  w = await buildWalkWorld();
}, 120_000);

afterAll(async () => {
  await releaseWorld(w);
  await w.app.close();
});

async function noticesOf(orderId: string, userId: string) {
  return w.app.prisma.$queryRawUnsafe<Array<{ title: string; body: string }>>(
    `SELECT title, body FROM notifications WHERE data->>'orderId' = $1 AND "userId" = $2 ORDER BY "createdAt", id`,
    orderId, userId,
  );
}
const count = (rows: Array<{ title: string }>, title: string) => rows.filter((r) => r.title === title).length;

/** Online, then the rider takes the order through the real board-grab door. */
async function riderTakes(cast: Cast, orderId: string, r = cast.riders[0]!) {
  expect((await call(w, 'POST', '/api/v1/rider/go-online', r.token, { latitude: r.lat, longitude: r.lng })).statusCode).toBe(200);
  expect((await call(w, 'POST', `/api/v1/rider/orders/${orderId}/accept`, r.token)).statusCode).toBe(200);
}

/** A ready order (the store's whole path), so pickup is due at accept + travel. */
async function readyOrder(cast: Cast): Promise<string> {
  const { orderId } = await placeCashOrder(w, cast);
  const id = orderId!;
  expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
  expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/preparing`, cast.vendorOwner.token)).statusCode).toBe(200);
  expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/ready`, cast.vendorOwner.token)).statusCode).toBe(200);
  return id;
}

/** Real ms since the rider's accept (its log row is aged with the world). */
async function sinceAccept(orderId: string): Promise<number> {
  const log = await w.app.prisma.orderStatusLog.findFirstOrThrow({
    where: { orderId, status: 'RIDER_ASSIGNED' }, orderBy: { createdAt: 'desc' }, select: { createdAt: true },
  });
  return Date.now() - log.createdAt.getTime();
}

/** Age the world to exactly `atMin` minutes after the accept (+1 s past it), then one sweep tick. */
async function tickAt(cast: Cast, orderId: string, atMin: number, past = 1_000) {
  const ms = atMin * MIN - await sinceAccept(orderId) + past;
  if (ms > 0) await ageWorld(w, ms);
  for (const r of cast.riders) {
    await call(w, 'PUT', '/api/v1/rider/location', r.token, { latitude: r.lat, longitude: r.lng, accuracy: 8 });
  }
  await runSweeps(w);
  await drainDue(w);
}

async function withSetting<T>(key: string, value: unknown, run: () => Promise<T>): Promise<T> {
  const tenantId = (await w.app.prisma.vendor.findFirstOrThrow({ select: { tenantId: true } })).tenantId;
  const top = await w.app.prisma.algoConfig.findFirst({ where: { tenantId, key }, orderBy: { version: 'desc' }, select: { version: true } });
  const row = await w.app.prisma.algoConfig.create({
    data: { tenantId, key, value: value as never, version: (top?.version ?? 0) + 1, updatedBy: 'pickup-overdue.test' },
  });
  invalidateAlgoConfig(tenantId, key);
  try {
    return await run();
  } finally {
    await w.app.prisma.algoConfig.delete({ where: { id: row.id } });
    invalidateAlgoConfig(tenantId, key);
  }
}

describe('[OF-33] a rider who accepts and never picks up: one nudge, then back to dispatch as a no-show', () => {
  it('nudges once at due + 10, releases at due + 20 — not cancelled, told once each, no pay, a no-show on the record', async () => {
    const cast = await castWalk(w, 1);
    const id = await readyOrder(cast);
    await riderTakes(cast, id);
    const r = cast.riders[0]!;
    const due = TRAVEL_MIN; // ready already: due = accept + travel

    // One minute short of the nudge: nothing.
    await tickAt(cast, id, due + NUDGE_MIN - 1);
    expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(0);

    // The nudge, once — a second tick inside the window adds nothing.
    await tickAt(cast, id, due + NUDGE_MIN);
    await tickAt(cast, id, due + NUDGE_MIN + 5);
    const nudges = (await noticesOf(id, r.userId)).filter((n) => n.title === NUDGE_TITLE);
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!.body).toContain('hand it back');

    // One minute short of the release: still the rider's.
    await tickAt(cast, id, due + RELEASE_MIN - 1);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: r.riderId });

    // The release: back to its honest kitchen stage, never cancelled.
    const jobsBefore = w.sched.pending.filter((j) => j.name === 'dispatch-order' && j.data['orderId'] === id).length;
    await ageWorld(w, (due + RELEASE_MIN) * MIN - await sinceAccept(id) + 1_000);
    await runSweeps(w);
    const released = await w.app.prisma.order.findUniqueOrThrow({ where: { id }, include: { statusHistory: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } } });
    expect({ status: released.status, riderId: released.riderId }).toEqual({ status: 'READY_FOR_PICKUP', riderId: null });
    expect(released.statusHistory.filter((l) => l.status === 'CANCELLED')).toHaveLength(0);
    expect(released.statusHistory.at(-1)!.note).toContain('Rider no-show');
    // Re-dispatched, and not back to the rider who did not come.
    expect(w.sched.pending.filter((j) => j.name === 'dispatch-order' && j.data['orderId'] === id).length).toBeGreaterThan(jobsBefore);
    expect(await w.app.redis.sismember(dispatchDeclinedKey(id, released.fulfillmentModeVersion), r.riderId)).toBe(1);
    const rider = await w.app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(rider.currentOrderId).toBeNull();
    expect(rider.completionRate).toBeCloseTo(80, 5); // 100 * 0.8: one no-show
    expect(await w.app.prisma.earning.count({ where: { orderId: id } })).toBe(0);

    // Told once each — and again a later tick says nothing new.
    await drainDue(w);
    await runSweeps(w);
    expect(count(await noticesOf(id, cast.customer.userId), CUSTOMER_TITLE)).toBe(1);
    expect(count(await noticesOf(id, cast.vendorOwner.userId), STORE_TITLE)).toBe(1);
    expect(count(await noticesOf(id, w.admin.userId), OPS_TITLE)).toBe(1);
    expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(1);
  }, 300_000);

  it('pickup is due at the LATER of the ready time and accept + 20: an order not ready yet waits for its prep promise', async () => {
    const cast = await castWalk(w, 1);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    expect(prep).toBeGreaterThan(TRAVEL_MIN); // else this case would not tell the two apart
    await riderTakes(cast, id); // accepted at once: ready time (accept + prep) is the later one
    const r = cast.riders[0]!;

    // Where accept + travel would already nudge, the prep promise still holds.
    await tickAt(cast, id, TRAVEL_MIN + NUDGE_MIN);
    expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(0);
    await tickAt(cast, id, prep + NUDGE_MIN);
    expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(1);
    await tickAt(cast, id, prep + RELEASE_MIN - 1);
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('RIDER_ASSIGNED');
    await tickAt(cast, id, prep + RELEASE_MIN);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    // Never marked ready: back to ACCEPTED, the kitchen's own honest stage.
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'ACCEPTED', riderId: null });
  }, 300_000);

  it('goods in the rider’s hands are never released by the timer: a confirmed pickup holds', async () => {
    const cast = await castWalk(w, 1);
    const id = await readyOrder(cast);
    await riderTakes(cast, id);
    const r = cast.riders[0]!;
    for (const step of ['en-route-pickup', 'arrived-pickup', 'picked-up']) {
      expect((await call(w, 'PUT', `/api/v1/rider/orders/${id}/${step}`, r.token)).statusCode).toBe(200);
    }
    await tickAt(cast, id, 3 * 60);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'PICKED_UP', riderId: r.riderId });
    expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(0);
    expect(count(await noticesOf(id, cast.customer.userId), CUSTOMER_TITLE)).toBe(0);
  }, 300_000);

  it('cash already in the rider’s hands (CAPTURED before pickup) is never released by the timer', async () => {
    const cast = await castWalk(w, 1);
    const id = await readyOrder(cast);
    await riderTakes(cast, id);
    // The state a courier sender's collected fee leaves (OF-07): CAPTURED cash
    // on a leg not yet picked up. Set directly — the door that writes it is
    // courier-only and is not what this case is about.
    await w.app.prisma.order.update({ where: { id }, data: { paymentStatus: 'CAPTURED' } });
    await tickAt(cast, id, 3 * 60);
    const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: cast.riders[0]!.riderId });
    expect(count(await noticesOf(id, cast.customer.userId), CUSTOMER_TITLE)).toBe(0);
    // Leave the world as other cases expect: nobody's cash is outstanding.
    await w.app.prisma.order.update({ where: { id }, data: { paymentStatus: 'PENDING' } });
  }, 300_000);

  it('the minutes are settings: a shorter nudge and release window act before the defaults would', async () => {
    // Shorter, not longer: a ready order is also on the food-age clock (45 min
    // from ready), which would cancel it before a long release could be seen.
    await withSetting('rescue.pickupNudgeMinutes', 5, () => withSetting('rescue.pickupReleaseMinutes', 12, async () => {
      const cast = await castWalk(w, 1);
      const id = await readyOrder(cast);
      await riderTakes(cast, id);
      const r = cast.riders[0]!;
      await tickAt(cast, id, TRAVEL_MIN + 4);
      expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(0);
      await tickAt(cast, id, TRAVEL_MIN + 5);
      expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(1); // the default would wait for + 10
      await tickAt(cast, id, TRAVEL_MIN + 11);
      expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('RIDER_ASSIGNED');
      await tickAt(cast, id, TRAVEL_MIN + 12);
      expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_PICKUP'); // the default would wait for + 20
    }));
  }, 300_000);

  it('a stacked rider loses only the overdue leg; the pointer lands on the leg they keep', async () => {
    await withSetting('stacking.riderCapacity', 2, async () => {
      const first = await castWalk(w, 1);
      const second = await castWalk(w, 0);
      const r = first.riders[0]!;
      const a = await readyOrder(first);
      await riderTakes(first, a, r);
      await ageWorld(w, 15 * MIN);
      const b = await readyOrder(second);
      await riderTakes(first, b, r); // the same rider takes a second leg 15 minutes later
      // A is overdue (accept + 20 + 20); B, accepted 15 minutes later, is not.
      await tickAt(first, a, TRAVEL_MIN + RELEASE_MIN);
      const [rowA, rowB] = await Promise.all([a, b].map((id) => w.app.prisma.order.findUniqueOrThrow({ where: { id } })));
      expect({ status: rowA!.status, riderId: rowA!.riderId }).toEqual({ status: 'READY_FOR_PICKUP', riderId: null });
      expect({ status: rowB!.status, riderId: rowB!.riderId }).toEqual({ status: 'RIDER_ASSIGNED', riderId: r.riderId });
      expect((await w.app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).currentOrderId).toBe(b);
    });
  }, 300_000);
});

/** Real ms since the store marked the order ready (aged with the world). */
async function sinceReady(orderId: string): Promise<number> {
  const row = await w.app.prisma.order.findUniqueOrThrow({ where: { id: orderId }, select: { readyAt: true } });
  return Date.now() - row.readyAt!.getTime();
}

/** Rider en route, then at the counter, through the real doors. */
async function riderArrives(cast: Cast, orderId: string, r = cast.riders[0]!) {
  for (const step of ['en-route-pickup', 'arrived-pickup']) {
    expect((await call(w, 'PUT', `/api/v1/rider/orders/${orderId}/${step}`, r.token)).statusCode).toBe(200);
  }
}

const deps = () => ({ prisma: w.app.prisma, redis: w.app.redis, io: w.app.io, notifications: new NotificationService(w.app.prisma, w.app.io) });
const noEnqueue = async () => {};

describe('[OF-33 · COORD ruling 21 Oct] a rider AT the counter of a store that has not marked the order ready is waiting on the store', () => {
  it('is never released or marked a no-show: the store is told once and ops paged once; from the store’s ready the ordinary clock runs', async () => {
    const cast = await castWalk(w, 1);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    const order = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    const prep = order.estimatedPrepTime && order.estimatedPrepTime > 0 ? order.estimatedPrepTime : DEFAULT_PREP_PROMISE_MIN;
    await riderTakes(cast, id);
    await riderArrives(cast, id);
    const r = cast.riders[0]!;

    // Past the release time (prep promise + 20) and well beyond: still the rider's, nobody blamed.
    await tickAt(cast, id, prep + RELEASE_MIN + 1);
    await tickAt(cast, id, prep + RELEASE_MIN + 15);
    let row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'RIDER_ARRIVED_PICKUP', riderId: r.riderId });
    expect((await w.app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).completionRate).toBe(100);
    expect(count(await noticesOf(id, r.userId), NUDGE_TITLE)).toBe(0);
    expect(count(await noticesOf(id, cast.customer.userId), CUSTOMER_TITLE)).toBe(0);
    expect(count(await noticesOf(id, cast.vendorOwner.userId), STORE_WAITING_TITLE)).toBe(1);
    expect(count(await noticesOf(id, w.admin.userId), OPS_WAITING_TITLE)).toBe(1);
    expect(count(await noticesOf(id, w.admin.userId), OPS_TITLE)).toBe(0);

    // The store marks it ready: now the rider has the ordinary window from readyAt.
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/ready`, cast.vendorOwner.token)).statusCode).toBe(200);
    const tickFromReady = async (atMin: number) => {
      await ageWorld(w, atMin * MIN - await sinceReady(id) + 1_000);
      await runSweeps(w);
      await drainDue(w);
    };
    await tickFromReady(RELEASE_MIN - 1);
    row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'RIDER_ARRIVED_PICKUP', riderId: r.riderId });
    await tickFromReady(RELEASE_MIN);
    row = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect({ status: row.status, riderId: row.riderId }).toEqual({ status: 'READY_FOR_PICKUP', riderId: null });
    expect((await w.app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } })).completionRate).toBeCloseTo(80, 5);
    expect(count(await noticesOf(id, cast.customer.userId), CUSTOMER_TITLE)).toBe(1);
  }, 300_000);
});

describe('[OF-33 · REVIEW-G S3-1] the release re-checks everything under the lock (state changed after the sweep read it)', () => {
  it('a new assignment of the same rider since the read is not released (the version guard)', async () => {
    const cast = await castWalk(w, 1);
    const id = await readyOrder(cast);
    await riderTakes(cast, id);
    const r = cast.riders[0]!;
    const seen = (await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).riderAssignmentVersion;
    expect((await call(w, 'POST', `/api/v1/rider/orders/${id}/handback`, r.token, { reason: 'flat tyre, cannot ride' })).statusCode).toBe(200);
    // The handback keeps this rider off the re-cascade; clear that so the SAME
    // rider can take it again (a new assignment, a new version).
    const fmv = (await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).fulfillmentModeVersion;
    await w.app.redis.del(dispatchDeclinedKey(id, fmv));
    await riderTakes(cast, id);
    const now = await w.app.prisma.order.findUniqueOrThrow({ where: { id } });
    expect(now.riderAssignmentVersion).not.toBe(seen);
    expect(await releaseOverdueLeg(deps(), noEnqueue, id, r.riderId, seen)).toBe('IGNORED');
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('RIDER_ASSIGNED');
    // Control: the current assignment, unchanged since read, IS released.
    expect(await releaseOverdueLeg(deps(), noEnqueue, id, r.riderId, now.riderAssignmentVersion)).toBe('RELEASED');
  }, 300_000);

  it('cash taken since the read is never released (the cash-in-hand guard, OF-07)', async () => {
    const cast = await castWalk(w, 1);
    const id = await readyOrder(cast);
    await riderTakes(cast, id);
    const r = cast.riders[0]!;
    const version = (await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).riderAssignmentVersion;
    await w.app.prisma.order.update({ where: { id }, data: { paymentStatus: 'CAPTURED' } });
    expect(await releaseOverdueLeg(deps(), noEnqueue, id, r.riderId, version)).toBe('IGNORED');
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('RIDER_ASSIGNED');
    await w.app.prisma.order.update({ where: { id }, data: { paymentStatus: 'PENDING' } });
    expect(await releaseOverdueLeg(deps(), noEnqueue, id, r.riderId, version)).toBe('RELEASED');
  }, 300_000);

  it('a rider who reached the counter of an unready store since the read is not released', async () => {
    const cast = await castWalk(w, 1);
    const { orderId } = await placeCashOrder(w, cast);
    const id = orderId!;
    expect((await call(w, 'PUT', `/api/v1/vendor/orders/${id}/accept`, cast.vendorOwner.token)).statusCode).toBe(200);
    await riderTakes(cast, id);
    await riderArrives(cast, id);
    const r = cast.riders[0]!;
    const version = (await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).riderAssignmentVersion;
    expect(await releaseOverdueLeg(deps(), noEnqueue, id, r.riderId, version)).toBe('IGNORED');
    expect((await w.app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('RIDER_ARRIVED_PICKUP');
  }, 300_000);
});
