import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [REPORT-014 F-014-04/05/06/10] Offer ATTEMPT identity. The Redis offer pair,
// the delayed timeout job, and the delivery-evidence row all carry an opaque
// attempt id, so a stale generation-1 actor can never destroy, decline, or
// decay a later attempt that serializes to the same (order, mover) pair.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PICKUP = { lat: 6.8, lng: -58.15 };

let app: FastifyInstance;
let dispatch: DispatchService;
const scheduled: Array<{ orderId: string; riderId: string; delayMs: number; attemptId?: string }> = [];
let failNextSchedule = false; // [F-014-10] simulates a BullMQ add failure

const createdUserIds: string[] = [];
let customerId: string;
let vendorId: string;

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200087' } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { rider: { userId: { in: ids } } }] },
    select: { id: true },
  });
  await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeRider(opts: { lat?: number; lng?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200087${String(seq).padStart(3, '0')}`,
      firstName: 'Attempt',
      lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole],
      activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id,
      riderType: 'DELIVERY',
      vehicleType: 'MOTORCYCLE',
      documentsVerified: true,
      floatLimit: 1_000_000,
      isOnline: true,
      locationSessionId: syntheticLocationOwner('dispatch-offer'),
      isAvailable: true,
      currentLat: opts.lat ?? PICKUP.lat,
      currentLng: opts.lng ?? PICKUP.lng,
      lastLocationUpdate: new Date(),
      averageRating: 5,
      acceptanceRate: 100,
      currentOrderId: null,
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'attempt-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  await app.prisma.rider.update({ where: { id: rider.id }, data: { locationSessionId: session.id } });
  return { userId: user.id, riderId: rider.id };
}

async function makeOrder() {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `AI-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      customerId,
      vendorId,
      status: 'READY_FOR_PICKUP',
      fulfillment: 'DELIVERY',
      pickupAddress: 'Vendor HQ',
      pickupLat: PICKUP.lat,
      pickupLng: PICKUP.lng,
      deliveryAddress: 'Customer place',
      deliveryLat: PICKUP.lat + 0.01,
      deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
  return order;
}

const offerKey = (orderId: string) => `dispatch:offer:${orderId}`;
const moverOfferKey = (moverId: string) => `dispatch:mover-offer:${moverId}`;

/** Each test works with exactly the riders it creates: park everyone else so
 *  a cascade can never wander onto a previous test's leftover supply. */
async function parkAllRiders() {
  await app.prisma.rider.updateMany({
    where: { user: { phone: { startsWith: '+59200087' } } },
    data: { isOnline: false, isAvailable: false },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();

  dispatch = new DispatchService(
    app.prisma,
    app.redis,
    app.io,
    new HaversineMapsProvider(),
    async (orderId, riderId, delayMs, attemptId?: string) => {
      if (failNextSchedule) {
        failNextSchedule = false;
        throw new Error('bullmq down');
      }
      scheduled.push({ orderId, riderId, delayMs, attemptId });
    },
  );

  await purgeFixtures();

  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920008790', firstName: 'Attempt', lastName: 'Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  createdUserIds.push(customer.id);
  customerId = customer.id;

  const ownerUser = await app.prisma.user.create({
    data: {
      phone: '+5920008791', firstName: 'Attempt', lastName: 'Vendor',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'Attempt Diner', slug: `attempt-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920008792',
      addressLine1: '1 Attempt Alley', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('offer attempt identity [REPORT-014 F-014-04]', () => {
  it('a stale generation-1 timeout never destroys the live generation-2 offer for the same (order, mover)', async () => {
    await parkAllRiders();
    const a = await makeRider();
    const order = await makeOrder();

    // Generation 1: offer lands on A; its delayed timeout is captured.
    const g1 = await dispatch.dispatchOrder(order.id);
    expect(g1.offered).toBe(a.riderId);
    const j1 = scheduled[scheduled.length - 1]!;
    expect(j1.orderId).toBe(order.id);

    // A declines; the cascade exhausts (A was the only candidate).
    await dispatch.declineOffer(order.id, a.userId);

    // Vendor retry wipes cascade memory and re-offers the SAME order to the
    // SAME mover: generation 2.
    const g2 = await dispatch.retryDispatch(order.id);
    expect(g2.offered).toBe(a.riderId);

    // The old generation-1 timeout job fires late. It must be a NO-OP: the
    // authoritative pair still belongs to generation 2.
    await dispatch.handleOfferTimeout(order.id, a.riderId, j1.attemptId);

    const recovered = await dispatch.currentOfferFor(a.riderId);
    expect(recovered).not.toBeNull();
    expect(recovered!.orderId).toBe(order.id);
    // And generation 2 was not marked declined by the stale job.
    const declined = await app.redis.smembers(`dispatch:declined:${order.id}`);
    expect(declined).not.toContain(a.riderId);
  });

  it('offer recovery carries the attempt id of the live generation', async () => {
    await parkAllRiders();
    const a = await makeRider();
    const order = await makeOrder();

    const res = await dispatch.dispatchOrder(order.id);
    expect(res.offered).toBe(a.riderId);
    const job = scheduled[scheduled.length - 1]!;
    expect(job.attemptId).toBeTruthy();

    const recovered = await dispatch.currentOfferFor(a.riderId);
    expect(recovered).not.toBeNull();
    expect((recovered as { offerAttemptId?: string }).offerAttemptId).toBe(job.attemptId);
  });

  it('one mover never holds two live offers — the second order cascades to the next candidate [REPORT-014 F-014-05]', async () => {
    await parkAllRiders();
    const m = await makeRider(); // closest — would be top for BOTH orders
    const n = await makeRider({ lat: PICKUP.lat + 0.01 }); // backup ~1.1 km out
    const o1 = await makeOrder();
    const o2 = await makeOrder();

    const r1 = await dispatch.dispatchOrder(o1.id);
    expect(r1.offered).toBe(m.riderId);

    // M is reserved by o1's live offer: o2 must skip M without declining them
    // and land on N.
    const r2 = await dispatch.dispatchOrder(o2.id);
    expect(r2.offered).toBe(n.riderId);
    expect(await app.redis.sismember(`dispatch:declined:${o2.id}`, m.riderId)).toBe(0);

    // The singular reverse pointer still names M's ONE live offer (o1).
    expect((await app.redis.get(moverOfferKey(m.riderId)))!.split(':')[0]).toBe(o1.id);
    expect((await app.redis.get(offerKey(o2.id)))!.split(':')[0]).toBe(n.riderId);
  });

  it('with every candidate reserved, the cascade exhausts honestly instead of double-carding [REPORT-014 F-014-05]', async () => {
    await parkAllRiders();
    const m = await makeRider();
    const o1 = await makeOrder();
    const o2 = await makeOrder();

    await dispatch.dispatchOrder(o1.id); // M reserved by o1
    const r2 = await dispatch.dispatchOrder(o2.id);

    expect(r2.offered).toBeUndefined();
    expect(r2.exhausted).toBe(true);
    // No partial install: o2 has no offer key, and M's reservation is intact.
    expect(await app.redis.get(offerKey(o2.id))).toBeNull();
    expect((await app.redis.get(moverOfferKey(m.riderId)))!.split(':')[0]).toBe(o1.id);
  });

  it('concurrent empty-pool dispatches exhaust exactly ONCE [REPORT-014 F-014-06]', async () => {
    await parkAllRiders();
    const order = await makeOrder();

    const [a, b] = await Promise.all([
      dispatch.dispatchOrder(order.id),
      dispatch.dispatchOrder(order.id),
    ]);
    expect(a.exhausted).toBe(true);
    expect(b.exhausted).toBe(true);

    // One logical search consumed ONE lifecycle attempt, not two.
    expect(await app.redis.get(`dispatch:exhausts:${order.id}`)).toBe('1');
    // And the customer was told exactly once.
    const notices = await app.prisma.notification.findMany({
      where: { userId: customerId },
    });
    const mine = notices.filter((n) => {
      const d = n.data as { kind?: string; orderId?: string } | null;
      return d?.kind === 'dispatch_exhausted' && d?.orderId === order.id;
    });
    expect(mine).toHaveLength(1);
  });

  it('a timeout with NO evidence row spares the acceptance rate — absence is not proof of delivery [REPORT-014 F-014-10]', async () => {
    await parkAllRiders();
    const r = await makeRider();
    const order = await makeOrder();

    const res = await dispatch.dispatchOrder(order.id);
    expect(res.offered).toBe(r.riderId);
    const job = scheduled[scheduled.length - 1]!;

    // The fire-and-caught evidence insert "failed": no row exists for this attempt.
    await app.prisma.alertDelivery.deleteMany({ where: { subjectId: order.id } });

    await dispatch.handleOfferTimeout(order.id, r.riderId, job.attemptId);

    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(Number(after.acceptanceRate)).toBe(100); // spared — no render proof
    // The cascade still advanced honestly.
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, r.riderId)).toBe(1);
  });

  it('a release racing the publish tail retires the attempt: no ghost card, no stale timeout, no unfair miss [REPORT-014 F-014-10]', async () => {
    await parkAllRiders();
    const r = await makeRider();
    const order = await makeOrder();

    // The mover goes offline in the window between offer install and the
    // publish tail (the awaited trust read). The publish must observe the
    // retirement and emit/schedule NOTHING.
    const svc = dispatch as unknown as { canReceiveOffer: (...args: unknown[]) => Promise<boolean> };
    const original = svc.canReceiveOffer.bind(dispatch);
    vi.spyOn(svc, 'canReceiveOffer').mockImplementationOnce(async (...args: unknown[]) => {
      const ok = await original(...args);
      await dispatch.releaseHeldOffer(r.riderId);
      return ok;
    });

    const res = await dispatch.dispatchOrder(order.id);
    expect(res).toEqual({}); // the retiring path owns the cascade now

    // No stale timeout was armed for the retired attempt...
    expect(scheduled.filter((j) => j.orderId === order.id)).toHaveLength(0);
    // ...no evidence row was written for a card that never rendered...
    expect(await app.prisma.alertDelivery.count({ where: { subjectId: order.id } })).toBe(0);
    // ...and the mover was NOT charged a miss for it (no render proof).
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(Number(after.acceptanceRate)).toBe(100);
  });

  it('a timeout-scheduling failure rolls the install back instead of stranding a card with no cascade [REPORT-014 F-014-10]', async () => {
    await parkAllRiders();
    const r = await makeRider();
    const order = await makeOrder();

    failNextSchedule = true;
    const res = await dispatch.dispatchOrder(order.id);

    expect(res).toEqual({}); // honest: no offer stands
    expect(await app.redis.get(offerKey(order.id))).toBeNull();
    expect(await app.redis.get(moverOfferKey(r.riderId))).toBeNull();
    // The mover did nothing wrong: not declined, not decayed.
    expect(await app.redis.sismember(`dispatch:declined:${order.id}`, r.riderId)).toBe(0);
    const after = await app.prisma.rider.findUniqueOrThrow({ where: { id: r.riderId } });
    expect(Number(after.acceptanceRate)).toBe(100);
  });

  it('recovery refuses a card whose order is already assigned in the database [REPORT-014 F-014-09]', async () => {
    await parkAllRiders();
    const a = await makeRider();
    const b = await makeRider({ lat: PICKUP.lat + 0.01 });
    const order = await makeOrder();

    const res = await dispatch.dispatchOrder(order.id);
    expect(res.offered).toBe(a.riderId);

    // The board/direct seam assigned rider B while A's Redis pair lingers
    // (the exact canonical-vs-cache divergence of F-014-09).
    await app.prisma.order.update({
      where: { id: order.id },
      data: { riderId: b.riderId, status: 'RIDER_ASSIGNED' },
    });

    // A's recovery must NOT resurrect the card — PostgreSQL already has a
    // winner; acting on the recovered card could only end in ALREADY_TAKEN.
    expect(await dispatch.currentOfferFor(a.riderId)).toBeNull();
  });

  it("board retirement removes the OFFERED mover's pair and never the winner's unrelated offer [REPORT-019 F-019-01]", async () => {
    await parkAllRiders();
    const a = await makeRider();                        // will hold O1's offer
    const b = await makeRider({ lat: PICKUP.lat + 0.2 }); // far away — gets O2 only
    const o1 = await makeOrder();
    const o2 = await makeOrder();

    // O1's cascade offers to A (B is out of ring at 5 km).
    expect((await dispatch.dispatchOrder(o1.id)).offered).toBe(a.riderId);
    // B holds a live offer for the UNRELATED order O2 (seeded at B's location).
    await app.prisma.order.update({
      where: { id: o2.id },
      data: { pickupLat: PICKUP.lat + 0.2, pickupLng: PICKUP.lng },
    });
    expect((await dispatch.dispatchOrder(o2.id)).offered).toBe(b.riderId);

    // B grabs O1 off the open board (bypassing A's offer): retirement must
    // retire A's pair — and must NOT touch B's reverse pointer for O2.
    await dispatch.retireAfterAssignment(o1.id, b.riderId);

    expect(await app.redis.get(offerKey(o1.id))).toBeNull();          // O1 offer gone
    expect(await app.redis.get(moverOfferKey(a.riderId))).toBeNull(); // A's pointer gone (was dangling before)
    expect((await app.redis.get(moverOfferKey(b.riderId)))!.split(':')[0]).toBe(o2.id); // B's O2 pointer INTACT
    expect((await app.redis.get(offerKey(o2.id)))!.split(':')[0]).toBe(b.riderId);      // O2 offer INTACT
  });

  it('a redispatch scheduling failure releases the exhaust lock so the queue retry can finish the job [REPORT-021 F-021-03]', async () => {
    await parkAllRiders();
    const order = await makeOrder();
    let calls = 0;
    const svc = new DispatchService(
      app.prisma, app.redis, app.io, new HaversineMapsProvider(),
      async () => {},
      async () => { calls += 1; if (calls === 1) throw new Error('queue down'); return true; },
    );

    await expect(svc.dispatchOrder(order.id)).rejects.toThrow('queue down');
    // The single-flight lock must NOT survive the failure: BullMQ retries the
    // job in ~5s and that retry must be able to run the exhaust for real —
    // a surviving lock turned one transient enqueue error into an order the
    // reconciler skips for the whole terminal window.
    expect(await app.redis.get(`dispatch:exhaust-lock:${order.id}`)).toBeNull();

    const retry = await svc.dispatchOrder(order.id);
    expect(retry.exhausted).toBe(true);
    expect(calls).toBe(2); // the retry really scheduled the re-sweep
  });

  it('legacy bare Redis values (pre-attempt deploys) still time out and advance', async () => {
    await parkAllRiders();
    const a = await makeRider();
    const order = await makeOrder();

    // Simulate an offer installed by a PRE-ATTEMPT deploy: bare ids, no token.
    await app.redis.set(offerKey(order.id), a.riderId, 'EX', 30);
    await app.redis.set(moverOfferKey(a.riderId), order.id, 'EX', 30);

    // A legacy delayed job (no attemptId) fires: wildcard removal must work.
    await dispatch.handleOfferTimeout(order.id, a.riderId);

    expect(await app.redis.get(offerKey(order.id))).toBeNull();
    expect(await app.redis.get(moverOfferKey(a.riderId))).toBeNull();
    const declined = await app.redis.smembers(`dispatch:declined:${order.id}`);
    expect(declined).toContain(a.riderId);
  });
});
