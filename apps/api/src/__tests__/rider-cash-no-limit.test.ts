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
import { floatAdvice } from '../modules/dispatch/float.service';
import { desiredPlatformConfig, PLATFORM_CONFIG_VERSION, seedFxRate } from '../modules/ops/platform-config';
import { AUTO_REJECT_KEY, vendorResponseSlaMinutes } from '../modules/order/response-sla';
import { recordDispatchQueue } from './helpers/dispatch-queue';

// ---------------------------------------------------------------------------
// [O1 · owner ruling 5 Nov 2026 05:00Z] "Rider cash limit OPEN, no cap; the business decides on huge orders; riders
// choose." Until now Guyana's riders could front at most GY$8,000 (L1) of store cash, so a cash delivery above it
// passed checkout and no rider could take it.
//
//  1. The seed plan sets Guyana's floatL1/L2/L3 to the no-cap value: one finite whole number that fits DECIMAL(12,2)
//     and an int32 (never Infinity, NaN or null). The inactive pegged markets keep their figures.
//  2. A rider sized under the old setting moves to no cap at their next go-online.
//  3. Dispatch offers a GY$250,000 cash job to a rider with no cap, never to one still capped at GY$8,000.
//  4. Riders choose with the amount in view: the board shows the cash to pay the store (as the offer card does), and
//     a board grab is refused when the amount changed since it was shown, or when an app that shows none grabs a job
//     above the old GY$8,000 board (it takes it from the offer card instead).
//  5. No surface states the stored number: the profile sends no float card and says cashNoLimit.
// [owner 7 Nov 2026 ~01:55Z] In the same seed: a store has 10 minutes (was 5) to accept a new order.
// ---------------------------------------------------------------------------

const NO_LIMIT = 1_000_000_000;
const DECIMAL_12_2_MAX = 9_999_999_999.99;
const SPOT = { lat: 8.2, lng: -59.78 }; // Mabaruma, far from every other suite
const DAY = 24 * 60 * 60 * 1000;
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'rider-cash-no-limit-fixture');

describe('[O1] the seed plan: Guyana has no rider cash limit; the store gets 10 minutes', () => {
  const spine = desiredPlatformConfig();
  const gy = spine.countries.find((c) => c.code === 'GY')!;

  it('floatL1, floatL2 and floatL3 are the no-cap value, a finite whole number that fits every float column', async () => {
    const { RIDER_CASH_NO_LIMIT } = (await import('../modules/dispatch/float.service')) as { RIDER_CASH_NO_LIMIT?: number };
    expect(RIDER_CASH_NO_LIMIT).toBe(NO_LIMIT);
    for (const level of ['floatL1', 'floatL2', 'floatL3'] as const) {
      const v = gy.policy[level] as number;
      expect(v, level).toBe(NO_LIMIT);
      expect(Number.isInteger(v)).toBe(true);
      // committedFloat never passes floatLimit (the guarded commit), so the sum stays in DECIMAL(12,2) too.
      expect(v).toBeLessThanOrEqual(DECIMAL_12_2_MAX);
      // the batch planner's integer capacity (Math.round(availableFloat))
      expect(v).toBeLessThan(2 ** 31);
      expect(gy.create[level]).toBe(v);
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
    expect(PLATFORM_CONFIG_VERSION).not.toBe('2026-11-01.1');
    expect(spine.version).toBe(PLATFORM_CONFIG_VERSION);
  });

  it('a rider with no cap is never told about a float', () => {
    expect(floatAdvice({ floatLimit: NO_LIMIT, committedFloat: NO_LIMIT - 1 })).toMatchObject({ level: 'ok', sentence: null });
    expect(floatAdvice({ floatLimit: NO_LIMIT, committedFloat: NO_LIMIT })).toMatchObject({ level: 'ok', sentence: null });
  });
});

describe('[O1] dispatch, the board, the grab and the profile with no cap', () => {
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
  async function makeCashOrder(goods: number) {
    const order = await sys(() => app.prisma.order.create({
      data: {
        orderNumber: `CASH-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
        customerId, vendorId, status: 'READY_FOR_PICKUP', readyAt: new Date(),
        pickupAddress: 'Cash Store', pickupLat: SPOT.lat, pickupLng: SPOT.lng,
        deliveryAddress: 'Mabaruma homes', deliveryLat: SPOT.lat + 0.004, deliveryLng: SPOT.lng + 0.004,
        subtotalBase: goods, subtotalMarkup: 0, subtotalCustomer: goods, deliveryFee: 500, totalAmount: goods + 500,
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

  it('a rider sized at GY$8,000 before the seed has no cap from their next go-online', async () => {
    const r = await makeRider(8000, 50, false);
    const go = await call('POST', '/api/v1/rider/go-online', r.token, { latitude: SPOT.lat, longitude: SPOT.lng });
    expect(go.statusCode, go.body).toBe(200);
    expect(Number((await riderRow(r.riderId)).floatLimit)).toBe(NO_LIMIT);
  });

  it('the profile shows no float card and says there is no cash limit; a capped rider keeps the card', async () => {
    const open = await makeRider(NO_LIMIT, 60);
    const res = await call('GET', '/api/v1/rider/profile', open.token);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data).toMatchObject({ cashNoLimit: true, float: null });
    // Nothing the app renders carries the stored number (the raw row column is data, never shown).
    expect(JSON.stringify(res.json().data.float)).not.toContain(String(NO_LIMIT));

    const capped = await makeRider(8000, 70);
    const old = (await call('GET', '/api/v1/rider/profile', capped.token)).json().data;
    expect(old.cashNoLimit).toBe(false);
    expect(old.float).toMatchObject({ limit: 8000, committed: 0, available: 8000 });
  });

  it('dispatch offers a GY$250,000 cash job to a rider with no cap, never to a nearer rider capped at GY$8,000', async () => {
    const capped = await makeRider(8000, 20);
    const open = await makeRider(NO_LIMIT, 600);
    const big = await makeCashOrder(250_000);
    expect((await dispatch.dispatchOrder(big.id)).offered).toBe(open.riderId);
    // …and a small one still goes to the nearest rider, capped or not.
    const small = await makeCashOrder(2_000);
    expect((await dispatch.dispatchOrder(small.id)).offered).toBe(capped.riderId);
  });

  it('riders choose with the amount in view: the board shows it, and a grab must match what was shown', async () => {
    const r = await makeRider(NO_LIMIT, 40);
    const big = await makeCashOrder(250_000);
    const board = await call('GET', '/api/v1/rider/orders/available', r.token);
    expect(board.statusCode, board.body).toBe(200);
    const row = (board.json().data as Array<{ id: string; cashMath: unknown }>).find((o) => o.id === big.id);
    expect(row?.cashMath).toEqual({ collectFromCustomer: 250_500, payToVendor: 250_000, youKeep: 500 });

    // An app that showed no amount (an older app) cannot take a job above the board it was built under.
    const blind = await call('POST', `/api/v1/rider/orders/${big.id}/accept`, r.token, {});
    expect(blind.statusCode, blind.body).toBe(409);
    expect(blind.json().error).toMatchObject({ code: 'CASH_AMOUNT_NOT_SHOWN' });
    expect(blind.json().error.message).toContain('GY$250,000');
    // An amount that is not the order's (the basket changed since it was shown) is refused with the new amount.
    const stale = await call('POST', `/api/v1/rider/orders/${big.id}/accept`, r.token, { payToVendor: 200_000 });
    expect(stale.statusCode, stale.body).toBe(409);
    expect(stale.json().error).toMatchObject({ code: 'CASH_AMOUNT_CHANGED' });
    expect((await sys(() => app.prisma.order.findUniqueOrThrow({ where: { id: big.id } }))).riderId).toBeNull();
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(0);

    // The amount shown: taken, with no cap in the way, and the cash committed exactly.
    const take = await call('POST', `/api/v1/rider/orders/${big.id}/accept`, r.token, { payToVendor: 250_000 });
    expect(take.statusCode, take.body).toBe(200);
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(250_000);
  });

  it('an older app keeps the board it had: a cash job up to GY$8,000 is still taken without an amount', async () => {
    const r = await makeRider(NO_LIMIT, 45);
    const order = await makeCashOrder(8_000);
    const take = await call('POST', `/api/v1/rider/orders/${order.id}/accept`, r.token, {});
    expect(take.statusCode, take.body).toBe(200);
    expect(Number((await riderRow(r.riderId)).committedFloat)).toBe(8_000);
  });
});
