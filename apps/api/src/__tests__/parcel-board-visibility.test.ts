import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// PARCELS WERE INVISIBLE ON EVERY RIDER'S BOARD.
//
// GET /rider/orders/available ranked jobs by how far the rider was from the
// PICKUP, and computed that pickup from the order's VENDOR with `?? 0` as the
// fallback.
//
// A parcel has no vendor. So every courier job's pickup resolved to (0, 0) —
// null island, in the Atlantic — which is 6,494 km from Georgetown. The radius
// filter then removed it from every board, on every request, forever.
//
// Parcels reached riders ONLY through the single push offer dispatch sends.
// Miss it, decline it, or have the app closed, and the job became invisible to
// everyone at once: the sender waits, every board is empty, and nothing in the
// system says why.
//
// The fix reads the pickup coordinates the courier route already stores.
// ---------------------------------------------------------------------------

// Georgetown, and a pickup ~1km away — well inside any sane radius.
const GT = { lat: 6.8013, lng: -58.1551 };
const PICKUP = { lat: 6.8100, lng: -58.1551 };

let app: FastifyInstance;
const userIds: string[] = [];
const orderIds: string[] = [];
let riderToken = '';
let customerId = '';

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  const rider = await app.prisma.user.create({
    data: {
      phone: `+59200962${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Parcel', lastName: 'Rider',
      roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true,
    },
  });
  userIds.push(rider.id);
  riderToken = app.jwt.sign({ userId: rider.id, role: 'MOVER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: rider.id, token: riderToken, refreshToken: nanoid(48),
      deviceId: 'parcel', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  await app.prisma.rider.create({
    data: {
      userId: rider.id, riderType: 'COURIER', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true, isAvailable: true,
      // The board refuses a rider with no live location session — going online
      // is what proves the coordinates are current rather than remembered.
      locationSessionId: nanoid(12),
      currentLat: GT.lat, currentLng: GT.lng,
    },
  });

  const cust = await app.prisma.user.create({
    data: {
      phone: `+59200963${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Parcel', lastName: 'Sender',
      roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(cust.id);
  customerId = cust.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('a parcel is visible on the rider board', () => {
  it('a COURIER order with no vendor appears, ranked by its real pickup distance', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `PB-${nanoid(8)}`,
        customerId,
        orderType: 'COURIER',
        status: 'READY_FOR_PICKUP',
        fulfillment: 'DELIVERY',
        // No vendorId — this is the whole point. A parcel has no store.
        pickupAddress: '14 Regent Street, Lacytown',
        pickupLat: PICKUP.lat,
        pickupLng: PICKUP.lng,
        deliveryAddress: '9 Sheriff Street, Campbellville',
        deliveryLat: 6.8200,
        deliveryLng: -58.1400,
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        totalAmount: 1500,
        deliveryFee: 1500,
        paymentMethod: 'CASH',
      },
    });
    orderIds.push(order.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/rider/orders/available',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as { data?: { orders?: any[] } | any[] };
    const rows: any[] = Array.isArray(body.data) ? body.data : (body.data?.orders ?? []);
    const mine = rows.find((o) => o.id === order.id);

    // Before the fix this was always undefined: 6,494 km failed the radius
    // filter on every request, so no rider ever saw a parcel on their board.
    expect(mine, 'the parcel must appear on the board').toBeTruthy();

    // And it must be ranked by where the parcel actually IS — roughly 1km,
    // not a number derived from a vendor that does not exist.
    expect(mine.pickupDistanceKm).toBeLessThan(5);
    expect(mine.pickupDistanceKm).toBeGreaterThanOrEqual(0);
  });

  it('an order with no usable pickup point is withheld, not placed in the Atlantic', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `PB-${nanoid(8)}`,
        customerId,
        orderType: 'COURIER',
        status: 'READY_FOR_PICKUP',
        fulfillment: 'DELIVERY',
        pickupAddress: 'Somewhere nobody geocoded',
        // deliberately no pickupLat/Lng and no vendor
        deliveryAddress: '9 Sheriff Street',
        deliveryLat: 6.82,
        deliveryLng: -58.14,
        subtotalBase: 0,
        subtotalMarkup: 0,
        subtotalCustomer: 0,
        totalAmount: 1500,
        deliveryFee: 1500,
        paymentMethod: 'CASH',
      },
    });
    orderIds.push(order.id);

    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/rider/orders/available',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    const body = res.json() as { data?: { orders?: any[] } | any[] };
    const rows: any[] = Array.isArray(body.data) ? body.data : (body.data?.orders ?? []);

    // Unknown distance is not the same as "6,494 km away". It stays off the
    // radius-filtered board rather than claiming a measurement we never made.
    expect(rows.find((o) => o.id === order.id)).toBeFalsy();
  });
});
