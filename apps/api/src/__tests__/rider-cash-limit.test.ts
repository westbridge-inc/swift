import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { makeDispatchService, type DispatchService } from '../modules/dispatch/dispatch.service';
import { desiredPlatformConfig, PLATFORM_CONFIG_VERSION, seedFxRate } from '../modules/ops/platform-config';
import { AUTO_REJECT_KEY, vendorResponseSlaMinutes } from '../modules/order/response-sla';
import { recordDispatchQueue } from './helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// [O1 · owner ruling 7 Nov 2026 ~04:10Z, replacing "no cap" of 5 Nov] Guyana's rider cash limit is GY$100,000 at every
// trust level (was GY$8,000 / 20,000 / 40,000); riders see the amount of every cash job and choose.
//
//  1. The seed plan sets Guyana's floatL1/L2/L3 to 100,000. The inactive pegged markets keep their figures.
//  2. A rider sized under the old setting moves to the new limit at their next go-online, and their float card says so.
//  3. Dispatch offers a GY$90,000 cash job to a rider with the new limit, never to one still on GY$8,000, and offers
//     a job above GY$100,000 to nobody.
//  4. Riders choose with the amount in view [reviewers A S2-1/S2-2]: the board and the offer card show the cash to pay
//     the store, the accept sends back the amount shown, and the claim refuses cash that went up since it was shown,
//     or more than GY$8,000 the card never showed (an older app, or an offer whose cash split the server cannot state,
//     e.g. a discount).
// [owner 7 Nov 2026 ~01:55Z] In the same seed: a store has 10 minutes (was 5) to accept a new order.
// ---------------------------------------------------------------------------

const LIMIT = 100_000;
const SPOT = { lat: 8.2, lng: -59.78 }; // Mabaruma, far from every other suite
const DAY = 24 * 60 * 60 * 1000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'rider-cash-limit-fixture');

describe('[O1] the seed plan: GY$100,000 rider cash limit; the store gets 10 minutes', () => {
  const spine = desiredPlatformConfig();
  const gy = spine.countries.find((c) => c.code === 'GY')!;

  it('floatL1, floatL2 and floatL3 are GY$100,000', () => {
    for (const level of ['floatL1', 'floatL2', 'floatL3'] as const) {
      expect(gy.policy[level], level).toBe(LIMIT);
      expect(gy.create[level], level).toBe(LIMIT);
    }
  });

  it('the inactive pegged markets keep the figures they were launched from', () => {
    const fx = seedFxRate();
    const nice = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n / 10) * 10 : n >= 10 ? Math.round(n) : Math.round(n * 100) / 100);
    const tt = spine.countries.find((c) => c.code === 'TT')!;
    expect([tt.policy['floatL1'], tt.policy['floatL2'], tt.policy['floatL3']])
      .toEqual([nice((8000 / fx) * 6.77), nice((20000 / fx) * 6.77), nice((40000 / fx) * 6.77)]);
  });

  it('a store has 10 minutes to accept a new order, and the deadline reader takes 10', async () => {
    expect(spine.platformConfig.find((c) => c.key === AUTO_REJECT_KEY)?.value).toBe(10);
    const fake = { platformConfig: { findUnique: async () => ({ key: AUTO_REJECT_KEY, value: 10 }) } };
    expect(await vendorResponseSlaMinutes(fake as never)).toBe(10);
  });

  it('is a new configuration version', () => {
    expect(PLATFORM_CONFIG_VERSION).toBe('2026-11-07.1');
    expect(spine.version).toBe(PLATFORM_CONFIG_VERSION);
  });
});

describe('[O1] dispatch, the board, the offer and the profile under the GY$100,000 limit', () => {
  let app: FastifyInstance;
  let dispatch: DispatchService;
  let vendorId = '';
  let itemId = '';
  let customerId = '';
  let seq = 0;
  let gyBefore: { floatL1: unknown; floatL2: unknown; floatL3: unknown } | null = null;
  const phoneBase = 592_610_000_000 + Math.floor(Math.random() * 800_000_000);
  const userIds: string[] = [];
  const riderIds: string[] = [];
  const orderIds: string[] = [];
  const envBefore = process.env['NODE_ENV'];

  async function makeUser(roles: UserRole[], activeRole: UserRole) {
    seq += 1;
    const user = await sys(() => app.prisma.user.create({
      data: {
        phone: `+${phoneBase + seq}`, firstName: 'Cash', lastName: `N${seq}`, roles, activeRole, countryCode: 'GY',
        isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L1',
        ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
      },
    }));
    userIds.push(user.id);
    const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
    const session = await sys(() => app.prisma.session.create({
      data: { userId: user.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `cash-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
    }));
    return { userId: user.id, token, sessionId: session.id };
  }

  /** A verified motorbike rider `meters` north of the store, online unless `online: false`. */
  async function makeRider(floatLimit: number, meters: number, online = true) {
    const u = await makeUser(['RIDER', 'CUSTOMER'], 'RIDER');
    const rider = await sys(() => app.prisma.rider.create({
      data: {
        userId: u.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true, floatLimit,
        isOnline: online, isAvailable: online, locationSessionId: online ? u.sessionId : null,
        currentLat: SPOT.lat + meters / 111_000, currentLng: SPOT.lng, lastLocationUpdate: new Date(), acceptanceRate: 50,
      },
    }));
    riderIds.push(rider.id);
    return { ...u, riderId: rider.id };
  }

  /** A cash food order ready at the store: the rider pays the store `goods` at pickup. */
  async function makeCashOrder(goods: number, discount = 0) {
    const order = await sys(() => app.prisma.order.create({
      data: {
        orderNumber: `CASH-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
        customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
        pickupAddress: 'Cash Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
        deliveryAddress: 'Mabaruma homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
        subtotalBase: goods, subtotalMarkup: 0, subtotalCustomer: goods, deliveryFee: 500, discount, totalAmount: goods + 500 - discount,
        paymentMethod: 'CASH',
        items: { create: [{ itemId, name: 'Party order', quantity: 1, basePrice: goods, markedUpPrice: goods, markupAmount: 0, totalBase: goods, totalMarkup: 0, totalCustomer: goods }] },
      },
    }));
    orderIds.push(order.id);
    return order;
  }

  const call = (method: 'GET' | 'POST', url: string, token: string, payload?: Record<string, unknown>) => app.inject({
    method, url, ...(payload ? { payload } : {}),
    headers: { authorization: `Bearer ${token}`, ...(payload ? { 'content-type': 'application/json' } : {}) },
  });
  const riderRow = (id: string) => sys(() => app.prisma.rider.findUniqueOrThrow({ where: { id } }));

  beforeAll(async () => {
    process.env['NODE_ENV'] = 'development';
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    await app.register(prismaPlugin);
    await app.register(redisPlugin);
    await app.register(authPlugin);
    await app.register(socketPlugin);
    recordDispatchQueue(app);
    await app.register(riderRoutes, { prefix: '/api/v1/rider' });
    await app.ready();
    dispatch = makeDispatchService(app);

    // The owner-signed seed has applied: Guyana's row carries the plan's values.
    gyBefore = await sys(() => app.prisma.countryConfig.findUnique({ where: { code: 'GY' }, select: { floatL1: true, floatL2: true, floatL3: true } }));
    const gy = desiredPlatformConfig().countries.find((c) => c.code === 'GY')!.policy;
    await sys(() => app.prisma.countryConfig.update({ where: { code: 'GY' }, data: { floatL1: gy['floatL1'] as number, floatL2: gy['floatL2'] as number, floatL3: gy['floatL3'] as number } }));

    const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    customerId = customer.userId;
    [vendorId, itemId] = await sys(async () => {
      const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
      const vendor = await app.prisma.vendor.create({
        data: {
          ownerId: vo.id, name: 'Cash Store', slug: `cash-store-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: '+5926998877',
          addressLine1: '1 Mabaruma Road', city: 'Mabaruma', region: 'Barima-Waini', latitude: SPOT.lat, longitude: SPOT.lng,
          status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true, minOrderAmount: 0,
        },
      });
      const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
      const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: cat.id, name: 'Party order', basePrice: 1000, isAvailable: true } });
      return [vendor.id, item.id] as const;
    });
  }, 120_000);

  // Every case leaves its riders offline and free, pass or fail, so no rider of one case is a candidate in the next.
  afterEach(async () => {
    await sys(() => app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { isOnline: false, isAvailable: false, locationSessionId: null, currentOrderId: null } }));
  });

  afterAll(async () => {
    await sys(async () => {
      if (gyBefore) await app.prisma.countryConfig.update({ where: { code: 'GY' }, data: gyBefore as never });
      await app.prisma.rider.updateMany({ where: { id: { in: riderIds } }, data: { currentOrderId: null } });
      await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
      await app.prisma.rider.deleteMany({ where: { id: { in: riderIds } } });
      await app.prisma.item.deleteMany({ where: { vendorId } });
      await app.prisma.category.deleteMany({ where: { vendorId } });
      await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
      await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.notification.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
      await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    });
    await app.close();
    if (envBefore === undefined) delete process.env['NODE_ENV'];
    else process.env['NODE_ENV'] = envBefore;
  }, 120_000);

  /** The rider's live offer card, read as the app reads it. */
  const currentOffer = async (token: string) => (await call('GET', '/api/v1/rider/offers/current', token)).json().data.offer as
    { orderId: string; offerAttemptId?: string; cashMath?: { payToVendor: number } | null } | null;
  /** Takes a rider out of the pool once their case is done, so the next case's offer goes where it says. */
  const park = (riderId: string) => sys(() => app.prisma.rider.update({ where: { id: riderId }, data: { isOnline: false, isAvailable: false, locationSessionId: null } }));
  const acceptOffer = (token: string, orderId: string, extra: Record<string, unknown> = {}) =>
    call('POST', '/api/v1/rider/offers/accept', token, { orderId, ...extra });

  it('a rider sized at GY$8,000 before the seed has GY$100,000 from their next go-online, and the float card says so', async () => {
    const r = await makeRider(8000, 50, false);
    const go = await call('POST', '/api/v1/rider/go-online', r.token, { latitude: SPOT.lat, longitude: SPOT.lng });
    expect(go.statusCode, go.body).toBe(200);
    expect(Number((await riderRow(r.riderId)).floatLimit)).toBe(LIMIT);
    const profile = (await call('GET', '/api/v1/rider/profile', r.token)).json().data;
    expect(profile.float).toMatchObject({ limit: LIMIT, committed: 0, available: LIMIT });
  });

  it('dispatch offers a GY$90,000 cash job to a rider with the new limit, never to a nearer rider on GY$8,000; above the limit, nobody', async () => {
    const capped = await makeRider(8000, 20);
    const open = await makeRider(LIMIT, 600);
    const big = await makeCashOrder(90_000);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(open.riderId);
    const small = await makeCashOrder(2_000);
    expect((await dispatch.dispatchOrder(small.id)).offered).toBe(capped.riderId);
    const free = await makeRider(LIMIT, 300);
    const tooBig = await makeCashOrder(LIMIT + 1_000);
    expect((await dispatch.dispatchOrder(tooBig.id)).offered).toBeUndefined();
    expect(Number((await riderRow(free.riderId)).committedFloat)).toBe(0);
  });

  it('the board shows the cash; a grab is refused when it went up since it was shown, or when none was shown above GY$8,000', async () => {
    const r = await makeRider(LIMIT, 40);
    const job = await makeCashOrder(90_000);
    const board = await call('GET', '/api/v1/rider/orders/available', r.token);
    expect(board.statusCode, board.body).toBe(200);
    const row = (board.json().data as Array<{ id: string; cashMath: unknown }>).find((o) => o.id === job.id);
    expect(row?.cashMath).toEqual({ collectFromCustomer: 90_500, payToVendor: 90_000, youKeep: 500 });

    const blind = await call('POST', `/api/v1/rider/orders/${job.id}/accept`, r.token, {});
    expect(blind.statusCode, blind.body).toBe(409);
    expect(blind.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(blind.json().error.message).toContain('GY$90,000');
    expect(blind.json().error.message).not.toContain('update');
    const stale = await call('POST', `/api/v1/rider/orders/${job.id}/accept`, r.token, { payToVendor: 80_000 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'CASH_AMOUNT_CHANGED' });
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: job.id } }))).riderId).toBeNull();
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(0);

    const take = await call('POST', `/api/v1/rider/orders/${job.id}/accept`, r.token, { payToVendor: 90_000 });
    expect(take.statusCode, take.body).toBe(200);
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(90_000);
  });

  it('an older app keeps the board it had: a cash job up to GY$8,000 is still taken without an amount', async () => {
    const r = await makeRider(LIMIT, 45);
    const order = await makeCashOrder(8_000);
    const take = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, r.token, {});
    expect(take.statusCode, take.body).toBe(200);
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(8_000);
  });

  it('[A S2-1] an offer whose cash went up while it was out is refused; the amount shown is taken', async () => {
    const r = await makeRider(LIMIT, 30);
    const job = await makeCashOrder(50_000);
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(r.riderId);
    const card = await currentOffer(r.token);
    expect(card?.cashMath?.payToVendor).toBe(50_000);
    // A dearer substitute approved while the card is out: the store cash goes up by 10,000.
    await sys(() => app.prisma.order.update({ where: { id: job.id }, data: { subtotalBase: 60_000, subtotalCustomer: 60_000, totalAmount: 60_500 } }));
    const up = await acceptOffer(r.token, job.id, { offerAttemptId: card!.offerAttemptId, payToVendor: 50_000 });
    expect(up.statusCode, up.body).toBe(409);
    expect(up.json().error).toMatchObject({ code: 'CASH_AMOUNT_CHANGED' });
    expect(up.json().error.message).toContain('GY$60,000');
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: job.id } }))).riderId).toBeNull();
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(0);

    await park(r.riderId);
    const r2 = await makeRider(LIMIT, 35);
    const shown = await makeCashOrder(50_000);
    expect((await dispatch.dispatchOrder(shown.id)).offered).toBe(r2.riderId);
    const card2 = await currentOffer(r2.token);
    const ok = await acceptOffer(r2.token, shown.id, { offerAttemptId: card2!.offerAttemptId, payToVendor: card2!.cashMath!.payToVendor });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(Number((await riderRow(r2.riderId)).committedFloat)).toBe(50_000);
  });

  it('[A S2-1] an older app that sends no amount takes an offer up to GY$8,000, never above', async () => {
    const r = await makeRider(LIMIT, 25);
    const job = await makeCashOrder(50_000);
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(r.riderId);
    const blind = await acceptOffer(r.token, job.id);
    expect(blind.statusCode, blind.body).toBe(409);
    expect(blind.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(0);

    await park(r.riderId);
    const r2 = await makeRider(LIMIT, 27);
    const small = await makeCashOrder(6_000);
    expect((await dispatch.dispatchOrder(small.id)).offered).toBe(r2.riderId);
    const ok = await acceptOffer(r2.token, small.id);
    expect(ok.statusCode, ok.body).toBe(200);
  });

  it('[A S2-2] an offer whose cash split cannot be shown (a discount) is never taken above GY$8,000', async () => {
    const r = await makeRider(LIMIT, 22);
    const job = await makeCashOrder(20_000, 1_000);
    expect((await dispatch.dispatchOrder(job.id)).offered).toBe(r.riderId);
    const card = await currentOffer(r.token);
    expect(card?.cashMath ?? null).toBeNull(); // the card shows no cash, so the app sends none back
    const res = await acceptOffer(r.token, job.id, { offerAttemptId: card!.offerAttemptId });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(res.json().error.message).toContain('GY$20,000');
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(0);
  });
});
