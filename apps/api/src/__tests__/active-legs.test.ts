import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { riderRoutes } from '../modules/rider/rider.routes';
import { syntheticLocationOwner } from './helpers/online-mover';

// ---------------------------------------------------------------------------
// [B6] The device that delivers a stacked run can see every leg of it.
//
// Under stacking (capacity 2, #899) a rider may hold two deliveries. The app's
// only view of "my job" was GET /orders/active — the POINTER's leg, one row.
// The second leg existed on the server, was committed against the rider's
// float, and was invisible on the one screen that has to deliver it.
//
// /orders/active-legs is the additive list beside the pointer: the same
// projection, oldest accepted first (the order settleRiderLegs re-points in,
// so "stop 1" is always the leg the pointer would land on), and a run summary
// computed HERE. The strip on the phone renders `cashToCollect`; it does not
// add money.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200652';
const PICKUP = { lat: 6.8, lng: -58.15 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
let customerId: string;
let vendorAId: string;
let vendorBId: string;

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  const orders = await app.prisma.order.findMany({ where: { OR: [{ customerId: { in: ids } }, { rider: { userId: { in: ids } } }] }, select: { id: true } });
  await app.prisma.order.deleteMany({ where: { id: { in: orders.map((o) => o.id) } } });
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

let seq = 0;
async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Run', lastName: `Rider${seq}`,
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true,
      floatLimit: 1_000_000, isOnline: true, isAvailable: true,
      locationSessionId: syntheticLocationOwner('active-legs'),
      currentLat: PICKUP.lat, currentLng: PICKUP.lng, lastLocationUpdate: new Date(),
      averageRating: 5, acceptanceRate: 100, currentOrderId: null,
    },
  });
  const token = app.jwt.sign({ userId: user.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'legs-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  await app.prisma.rider.update({ where: { id: rider.id }, data: { locationSessionId: session.id } });
  return { userId: user.id, riderId: rider.id, token };
}

async function makeLeg(opts: { riderId: string; vendorId: string; status: string; acceptedAt: Date; total: number; paymentMethod?: 'CASH' | 'MOBILE_MONEY' }) {
  return app.prisma.order.create({
    data: {
      orderNumber: `RUN-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId: opts.vendorId,
      status: opts.status as any, fulfillment: 'DELIVERY', riderId: opts.riderId, acceptedAt: opts.acceptedAt,
      pickupAddress: 'Store', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
      deliveryAddress: 'Customer place', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
      subtotalBase: opts.total - 500, subtotalMarkup: 0, subtotalCustomer: opts.total - 500,
      deliveryFee: 500, totalAmount: opts.total, paymentMethod: opts.paymentMethod ?? 'CASH',
      ridePin: '123456',
    },
  });
}

const get = (url: string, token: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

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
  await purge();

  const customer = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}90`, firstName: 'Run', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(customer.id);
  customerId = customer.id;
  const ownerUser = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}91`, firstName: 'Run', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const shop = (name: string) => app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name, slug: `${name.toLowerCase().replace(/[^a-z]+/g, '-')}-${nanoid(5)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}92`, addressLine1: '1 Run Road', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: PICKUP.lat, longitude: PICKUP.lng, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorAId = (await shop('Craft and Kind')).id;
  vendorBId = (await shop('Oasis Cafe')).id;
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('GET /rider/orders/active-legs', () => {
  it('a stacked rider sees BOTH legs, oldest accepted first, with the run summary the strip renders', async () => {
    const r = await makeRider();
    const t0 = new Date(Date.now() - 10 * 60_000);
    const a = await makeLeg({ riderId: r.riderId, vendorId: vendorAId, status: 'PICKED_UP', acceptedAt: t0, total: 2500 });
    const b = await makeLeg({ riderId: r.riderId, vendorId: vendorBId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(t0.getTime() + 60_000), total: 900 });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: a.id, isAvailable: false } });

    const res = await get('/api/v1/rider/orders/active-legs', r.token);
    expect(res.statusCode).toBe(200);
    const { legs, run } = res.json().data;
    expect(legs.map((l: any) => l.id)).toEqual([a.id, b.id]);
    expect(legs.map((l: any) => l.isPrimary)).toEqual([true, false]);
    expect(legs[0].vendor.name).toBe('Craft and Kind');
    expect(legs[1].vendor.name).toBe('Oasis Cafe');
    // The strip's numbers come from here, and only from here.
    expect(run).toEqual({
      drops: 2,
      cashToCollect: 3400,
      next: { orderId: a.id, vendorName: 'Craft and Kind', status: 'PICKED_UP' },
    });
  });

  it('an MMG leg collects nothing at the door — the sum says so', async () => {
    const r = await makeRider();
    const t0 = new Date(Date.now() - 10 * 60_000);
    const a = await makeLeg({ riderId: r.riderId, vendorId: vendorAId, status: 'RIDER_ASSIGNED', acceptedAt: t0, total: 2500 });
    await makeLeg({ riderId: r.riderId, vendorId: vendorBId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(t0.getTime() + 1000), total: 900, paymentMethod: 'MOBILE_MONEY' });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: a.id } });
    const { run } = (await get('/api/v1/rider/orders/active-legs', r.token)).json().data;
    expect(run.cashToCollect).toBe(2500);
  });

  it('one leg is one leg: no run, and the projection is byte-identical to /orders/active', async () => {
    const r = await makeRider();
    const a = await makeLeg({ riderId: r.riderId, vendorId: vendorAId, status: 'EN_ROUTE_DELIVERY', acceptedAt: new Date(), total: 1800 });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: a.id } });

    const list = (await get('/api/v1/rider/orders/active-legs', r.token)).json().data;
    const single = (await get('/api/v1/rider/orders/active', r.token)).json().data;
    expect(list.run).toBeNull();
    expect(list.legs).toHaveLength(1);
    const { isPrimary, ...leg } = list.legs[0];
    expect(isPrimary).toBe(true);
    expect(leg).toEqual(single);
  });

  it('a terminal leg is not a stop, and the handover secrets never ride the list [F-0011]', async () => {
    const r = await makeRider();
    const t0 = new Date(Date.now() - 10 * 60_000);
    const a = await makeLeg({ riderId: r.riderId, vendorId: vendorAId, status: 'DELIVERED', acceptedAt: t0, total: 2500 });
    const b = await makeLeg({ riderId: r.riderId, vendorId: vendorBId, status: 'RIDER_ASSIGNED', acceptedAt: new Date(t0.getTime() + 1000), total: 900 });
    await app.prisma.rider.update({ where: { id: r.riderId }, data: { currentOrderId: b.id } });
    const res = await get('/api/v1/rider/orders/active-legs', r.token);
    const { legs, run } = res.json().data;
    expect(legs.map((l: any) => l.id)).toEqual([b.id]);
    expect(run).toBeNull();
    expect(a.id).toBeTruthy();
    for (const secret of ['ridePin', 'pickupCode', 'pickupCodeAttempts']) {
      expect(res.payload, `${secret} leaked`).not.toContain(`"${secret}"`);
    }
  });

  it('no live leg: an empty list, no run', async () => {
    const r = await makeRider();
    const { legs, run } = (await get('/api/v1/rider/orders/active-legs', r.token)).json().data;
    expect(legs).toEqual([]);
    expect(run).toBeNull();
  });
});
