import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { DispatchService } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [G5 · P12] The offer card survives app death.
//
// OFFER_AND_LOAD §4.1 law 5: "Kill the app with a live offer, reopen inside
// the window, and the same card returns with the same offerAttemptId. If it
// cannot be recovered it must be cleanly gone, never a ghost card that fails
// on accept." The server had a recovery path and the app called it on mount;
// nobody had proven the two ends met. They did not, quite: the rebuilt card
// came back without `etaMinutes` ("N min away") and without `cashMath` — the
// cash box WS-6.0 put beside the Accept button so a rider sees what they are
// fronting. A rider who force-quit and reopened was offered the same CASH job
// with the exposure line missing. This file is the proof, driven over HTTP the
// way the app does it, with nothing client-side surviving the "death".
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PICKUP = { lat: 6.8, lng: -58.15 };
const PHONE_PREFIX = '+59200651';

let app: FastifyInstance;
let dispatch: DispatchService;
const scheduled: Array<{ orderId: string; riderId: string; delayMs: number; attemptId?: string }> = [];
const emitted: Array<{ room: string; event: string; payload: any }> = [];

const createdUserIds: string[] = [];
let customerId: string;
let vendorId: string;

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: ids } }, { rider: { userId: { in: ids } } }] },
    select: { id: true },
  });
  await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Recover', lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: true,
      locationSessionId: syntheticLocationOwner('offer-recovery'),
      currentLat: PICKUP.lat + 0.004, currentLng: PICKUP.lng + 0.004, lastLocationUpdate: new Date(),
      averageRating: 5, acceptanceRate: 100, currentOrderId: null,
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'recovery-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  await app.prisma.rider.update({ where: { id: rider.id }, data: { locationSessionId: session.id } });
  return { userId: user.id, riderId: rider.id, token };
}

async function makeOrder() {
  return app.prisma.order.create({
    data: {
      orderNumber: `RC-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId,
      status: 'READY_FOR_PICKUP', fulfillment: 'DELIVERY',
      pickupAddress: 'Vendor HQ', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'Customer place', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
}

async function parkAllRiders() {
  await app.prisma.rider.updateMany({
    where: { user: { phone: { startsWith: PHONE_PREFIX } } },
    data: { isOnline: false, isAvailable: false },
  });
}

const auth = (token: string) => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json' });
// The live payload as the APP received it — through the socket's JSON
// encoding, so Dates are strings on both sides of the comparison.
const liveOfferFor = (userId: string) => {
  const hit = [...emitted].reverse().find((e) => e.event === 'dispatch:offer' && e.room === `user:${userId}`);
  return hit ? JSON.parse(JSON.stringify(hit.payload)) : undefined;
};

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
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  // Capture what the LIVE card was built from. Nothing else about the socket
  // matters here — there is no client; that is the point.
  vi.spyOn(app.io, 'to').mockImplementation(((room: string) => ({
    emit: (event: string, payload: unknown) => { emitted.push({ room, event, payload }); return true; },
  })) as any);

  dispatch = new DispatchService(
    app.prisma, app.redis, app.io, new HaversineMapsProvider(),
    async (orderId, riderId, delayMs, attemptId?: string) => { scheduled.push({ orderId, riderId, delayMs, attemptId }); },
  );

  await purgeFixtures();
  const customer = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}90`, firstName: 'Recover', lastName: 'Customer',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(),
      customer: { create: {} },
    },
  });
  createdUserIds.push(customer.id);
  customerId = customer.id;
  const ownerUser = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}91`, firstName: 'Recover', lastName: 'Vendor',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name: 'Recovery Diner', slug: `recovery-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}92`,
      addressLine1: '1 Recovery Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: PICKUP.lat, longitude: PICKUP.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await purgeFixtures();
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.close();
});

describe('P12 — reopening inside the window rebuilds the SAME card', () => {
  it('same order, same attempt, same money, same facts — over HTTP, with nothing client-side surviving', async () => {
    await parkAllRiders();
    const r = await makeRider();
    const order = await makeOrder();
    emitted.length = 0;

    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(r.riderId);
    const live = liveOfferFor(r.userId);
    expect(live, 'the live card was emitted').toBeTruthy();
    expect(live.offerAttemptId).toBeTruthy();
    expect(live.cashMath).toEqual({ collectFromCustomer: 2500, payToVendor: 2000, youKeep: 500 });

    // — app death. Reopen. The app asks the server for the card. —
    const res = await app.inject({ method: 'GET', url: '/api/v1/rider/offers/current', headers: auth(r.token) });
    expect(res.statusCode).toBe(200);
    const rebuilt = res.json().data.offer;
    expect(rebuilt, 'the card is recoverable').not.toBeNull();

    expect(rebuilt.orderId).toBe(order.id);
    expect(rebuilt.offerAttemptId, 'the SAME generation — accept will echo it').toBe(live.offerAttemptId);
    expect(rebuilt.expiresInSeconds).toBeGreaterThan(0);
    expect(rebuilt.expiresInSeconds, 'a server-owned clock, never restarted').toBeLessThanOrEqual(live.expiresInSeconds);

    // Every fact the live card was built from is on the rebuilt card, equal.
    // The clock is the one thing allowed to differ; the ETA is re-measured
    // from where the rider is NOW rather than replayed from the ranking.
    for (const key of Object.keys(live)) {
      if (key === 'expiresInSeconds' || key === 'etaMinutes') continue;
      expect(rebuilt[key], `recovered card lost \`${key}\``).toEqual(live[key]);
    }
    expect(typeof rebuilt.etaMinutes, '"N min away" is on the rebuilt card').toBe('number');
    expect(rebuilt.cashMath, 'the cash box is on the rebuilt card').toEqual(live.cashMath);
  });

  it('accept binds to the recovered generation: a fabricated attempt is refused WITHOUT consuming the live card', async () => {
    await parkAllRiders();
    const r = await makeRider();
    const order = await makeOrder();
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(r.riderId);
    const rebuilt = (await app.inject({ method: 'GET', url: '/api/v1/rider/offers/current', headers: auth(r.token) })).json().data.offer;
    expect(rebuilt?.offerAttemptId).toBeTruthy();

    const wrong = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept', headers: auth(r.token),
      payload: { orderId: order.id, offerAttemptId: 'not-this-generation' },
    });
    expect(wrong.statusCode).toBe(409);
    expect(wrong.json().error?.code ?? wrong.json().code).toBe('OFFER_EXPIRED');
    // The refusal is not a retirement: the real card is still there to accept.
    const still = (await app.inject({ method: 'GET', url: '/api/v1/rider/offers/current', headers: auth(r.token) })).json().data.offer;
    expect(still?.offerAttemptId).toBe(rebuilt.offerAttemptId);

    const right = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept', headers: auth(r.token),
      payload: { orderId: order.id, offerAttemptId: rebuilt.offerAttemptId },
    });
    expect(right.statusCode, right.body).toBe(200);
    const claimed = await app.prisma.order.findUnique({ where: { id: order.id }, select: { riderId: true, status: true } });
    expect(claimed?.riderId).toBe(r.riderId);
    expect(claimed?.status).toBe('RIDER_ASSIGNED');
    // And the card is gone now — accepted by this actor is a retirement.
    const after = (await app.inject({ method: 'GET', url: '/api/v1/rider/offers/current', headers: auth(r.token) })).json().data.offer;
    expect(after).toBeNull();
  });

  it('a retired offer is cleanly gone: nothing to recover, and the old attempt cannot accept', async () => {
    await parkAllRiders();
    const r = await makeRider();
    const order = await makeOrder();
    expect((await dispatch.dispatchOrder(order.id)).offered).toBe(r.riderId);
    const job = scheduled[scheduled.length - 1]!;
    expect(job.orderId).toBe(order.id);

    // The window lapses server-side (the timeout worker fires for THIS attempt).
    await dispatch.handleOfferTimeout(order.id, r.riderId, job.attemptId);

    const gone = (await app.inject({ method: 'GET', url: '/api/v1/rider/offers/current', headers: auth(r.token) })).json().data.offer;
    expect(gone, 'no ghost card').toBeNull();

    const late = await app.inject({
      method: 'POST', url: '/api/v1/rider/offers/accept', headers: auth(r.token),
      payload: { orderId: order.id, offerAttemptId: job.attemptId },
    });
    expect(late.statusCode).toBe(409);
    const untouched = await app.prisma.order.findUnique({ where: { id: order.id }, select: { riderId: true } });
    expect(untouched?.riderId).toBeNull();
  });
});
