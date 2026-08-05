import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { DispatchService, EXHAUST_CAP, TAXI_RESCAN_MS, TAXI_WAIT_LIMIT_MIN } from '../modules/dispatch/dispatch.service';
import { HaversineMapsProvider } from '../providers/maps/maps-provider';

// ---------------------------------------------------------------------------
// [R-05 certification catch] The taxi slow lane. The rider's exhausted card
// says "we're still trying every minute as drivers come online" — before this
// fix the search went TERMINAL after EXHAUST_CAP fast retries and a driver who
// came online minutes later was never asked, while the card kept promising.
// Past the cap a WAITING taxi request re-sweeps every TAXI_RESCAN_MS until
// TAXI_WAIT_LIMIT_MIN from placement, then releases the ride honestly.
// ---------------------------------------------------------------------------

const EXHAUST_AT = { lat: 7.63, lng: -59.63 }; // empty map — no drivers here, ever
let app: FastifyInstance;

const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_780_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Slow', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  return u;
}

async function makeTaxiRide(customerId: string, placedMinAgo = 0) {
  const placedAt = new Date(Date.now() - placedMinAgo * 60_000);
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SLW-${nanoid(10)}`, orderType: 'TAXI', customerId,
      status: 'PENDING', rideClass: 'ECONOMY',
      pickupAddress: 'Empty Flats', pickupLat: EXHAUST_AT.lat, pickupLng: EXHAUST_AT.lng,
      deliveryAddress: 'Nowhere Lane', deliveryLat: EXHAUST_AT.lat + 0.01, deliveryLng: EXHAUST_AT.lng,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0,
      deliveryFee: 0, totalAmount: 1500, taxiFareTotal: 1500, paymentMethod: 'CASH',
      placedAt,
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

function makeDispatch(redispatches: Array<{ orderId: string; delayMs: number }>) {
  return new DispatchService(
    app.prisma,
    app.redis,
    app.io,
    new HaversineMapsProvider(),
    async () => {},
    async (orderId: string, delayMs: number) => {
      redispatches.push({ orderId, delayMs });
      return true;
    },
  );
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.ready();
}, 30_000);

afterAll(async () => {
  for (const id of createdOrderIds) await app.redis.del(`dispatch:exhausts:${id}`, `dispatch:declined:${id}`);
  // order_status_logs is append-only (audit law) — order deletion cascades it.
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('the taxi slow lane past the fast cap', () => {
  it('keeps re-sweeping every minute (quietly) while the ride is young', async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ride = await makeTaxiRide(customer.id, 2);
    // The fast retries are already spent.
    await app.redis.set(`dispatch:exhausts:${ride.id}`, String(EXHAUST_CAP));

    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    const res = await makeDispatch(redispatches).dispatchOrder(ride.id);
    expect(res.exhausted).toBe(true);

    // Slow-lane re-sweep at the promised cadence — the card's "every minute" is true.
    expect(redispatches).toHaveLength(1);
    expect(redispatches[0]).toMatchObject({ orderId: ride.id, delayMs: TAXI_RESCAN_MS });
    // The ride is still live and waiting; no release happened.
    const row = await app.prisma.order.findUnique({ where: { id: ride.id }, select: { status: true } });
    expect(row?.status).toBe('PENDING');
    const released = await app.prisma.notification.findFirst({
      where: { userId: customer.id, data: { path: ['kind'], equals: 'ride_released_no_drivers' } },
    });
    expect(released).toBeNull();
  });

  it(`releases the ride honestly after ${TAXI_WAIT_LIMIT_MIN} minutes — cancelled, told, keys cleared`, async () => {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const ride = await makeTaxiRide(customer.id, TAXI_WAIT_LIMIT_MIN + 1);
    await app.redis.set(`dispatch:exhausts:${ride.id}`, String(EXHAUST_CAP));

    const redispatches: Array<{ orderId: string; delayMs: number }> = [];
    const res = await makeDispatch(redispatches).dispatchOrder(ride.id);
    expect(res.exhausted).toBe(true);

    // No further sweeps — the wait is over.
    expect(redispatches).toHaveLength(0);
    const row = await app.prisma.order.findUnique({
      where: { id: ride.id },
      select: { status: true, cancellationReason: true, cancelledAt: true },
    });
    expect(row?.status).toBe('CANCELLED');
    expect(row?.cancellationReason).toBe('NO_DRIVERS_AVAILABLE');
    expect(row?.cancelledAt).not.toBeNull();
    const log = await app.prisma.orderStatusLog.findFirst({ where: { orderId: ride.id, status: 'CANCELLED' } });
    expect(log?.changedBy).toBe('system');
    const released = await app.prisma.notification.findFirst({
      where: { userId: customer.id, data: { path: ['kind'], equals: 'ride_released_no_drivers' } },
    });
    expect(released).not.toBeNull();
    expect(await app.redis.exists(`dispatch:exhausts:${ride.id}`)).toBe(0);
  });
});
