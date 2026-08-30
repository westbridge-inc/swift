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
import { reserveRiderLeg } from '../modules/dispatch/concurrency-policy';
import { FloatService } from '../modules/dispatch/float.service';
import { invalidateAlgoConfig } from '../modules/algo/algo-config';

// ---------------------------------------------------------------------------
// G14 — the rider handback valve.
//
// The delivery mirror of the driver's pre-custody cancel. The custody line is
// absolute: before pickup the order re-opens to its honest kitchen stage, the
// float returns, and dispatch finds the next-nearest rider; after pickup the
// rider holds goods (and on CASH has paid the vendor) — the button refuses and
// points at support. Discipline is deliberately absent (F11 founder-gated);
// the "Rider handback:" status-log marker is the history a future ladder reads.
// ---------------------------------------------------------------------------

const GEO = { lat: 6.8013, lng: -58.1553 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
let vendorId: string;
let seq = 0;

async function makeRider() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200091${String(seq).padStart(2, '0')}`,
      firstName: 'Hand',
      lastName: `Back${seq}`,
      roles: ['MOVER', 'CUSTOMER'] as UserRole[],
      activeRole: 'MOVER' as UserRole,
      countryCode: 'GY',
      isPhoneVerified: true,
      status: 'ACTIVE',
    },
  });
  createdUserIds.push(user.id);
  // SEC-8: authenticate looks the SESSION up BY the bearer token — the JWT
  // alone is not enough. Sign first, store it as the session's token.
  const token = app.jwt.sign({ userId: user.id, role: 'MOVER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(24), deviceId: `hb-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + 3600_000) },
  });
  const rider = await app.prisma.rider.create({
    data: {
      userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true, isAvailable: true,
      locationSessionId: session.id, currentLat: GEO.lat, currentLng: GEO.lng,
      floatLimit: 40_000,
    },
  });
  return { user, rider, token, sessionId: session.id };
}

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200092${String(seq).padStart(2, '0')}`,
      firstName: 'Cust', lastName: `Hb${seq}`,
      roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER' as UserRole,
      countryCode: 'GY', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  return user;
}

async function makeAssignedOrder(opts: {
  customerId: string; riderId: string; status?: string;
  readyAt?: Date | null; preparingAt?: Date | null; total?: number; subtotal?: number;
}) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `HB-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId: opts.customerId, vendorId,
      status: (opts.status ?? 'RIDER_ASSIGNED') as never,
      paymentMethod: 'CASH',
      subtotalBase: opts.subtotal ?? 3000, subtotalMarkup: 0, subtotalCustomer: opts.subtotal ?? 3000,
      deliveryFee: 500, serviceFee: 0, taxAmount: 0, tipAmount: 0, discount: 0,
      totalAmount: opts.total ?? 3500,
      deliveryAddress: '1 Handback St', deliveryLat: GEO.lat + 0.004, deliveryLng: GEO.lng + 0.004,
      riderId: opts.riderId, acceptedAt: new Date(),
      readyAt: opts.readyAt ?? null, preparingAt: opts.preparingAt ?? null,
    },
  });
  // Mirror the real claim: reservation + CASH float commit.
  expect(await reserveRiderLeg(app.prisma, opts.riderId, order.id, 2)).toBe(true);
  expect(await new FloatService(app.prisma).commit(app.prisma, opts.riderId, Number(order.subtotalBase))).toBe(true);
  return order;
}

const handback = (orderId: string, token: string, reason = 'vehicle broke down') =>
  app.inject({
    method: 'POST',
    url: `/api/v1/rider/orders/${orderId}/handback`,
    headers: { authorization: `Bearer ${token}` },
    payload: { reason },
  });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();
  invalidateAlgoConfig();

  const vendors = await app.prisma.vendor.findMany({ where: { status: 'ACTIVE' }, select: { id: true }, take: 1 });
  if (!vendors[0]) throw new Error('seeded ACTIVE vendor required');
  vendorId = vendors[0].id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { orderNumber: { startsWith: 'HB-' } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('G14 — pre-custody handback releases everything and re-opens honestly', () => {
  it('re-opens to READY_FOR_PICKUP when the kitchen had finished, frees the float, settles the pointer, excludes the rider from the re-cascade', async () => {
    const { rider, token } = await makeRider();
    const customer = await makeCustomer();
    const order = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id, readyAt: new Date() });

    const res = await handback(order.id, token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('READY_FOR_PICKUP');

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('READY_FOR_PICKUP');
    expect(fresh.riderId).toBeNull();

    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(Number(r.committedFloat)).toBe(0); // float came back with the assignment
    expect(r.currentOrderId).toBeNull(); // no sibling — seam settled to null
    expect(r.isAvailable).toBe(true);

    const log = await app.prisma.orderStatusLog.findFirst({
      where: { orderId: order.id, note: { startsWith: 'Rider handback:' } },
    });
    expect(log).not.toBeNull(); // the F11 ladder's future history

    const excluded = await app.redis.sismember(`dispatch:declined:${order.id}`, rider.id);
    expect(excluded).toBe(1); // next-nearest means not-this-rider
  });

  it('derives the honest kitchen stage: preparing → PREPARING, untouched → ACCEPTED', async () => {
    const { rider, token } = await makeRider();
    const customer = await makeCustomer();
    const prep = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id, preparingAt: new Date() });
    expect((await handback(prep.id, token)).json().data.status).toBe('PREPARING');

    const raw = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id });
    expect((await handback(raw.id, token)).json().data.status).toBe('ACCEPTED');
  });

  it('a stacked sibling survives: handing back leg B re-points the primary and leaves A untouched', async () => {
    const { rider, token } = await makeRider();
    const customer = await makeCustomer();
    const a = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id, status: 'RIDER_EN_ROUTE_PICKUP', subtotal: 2000, total: 2500 });
    const b = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id, readyAt: new Date(), subtotal: 3000, total: 3500 });

    const res = await handback(b.id, token, 'emergency');
    expect(res.statusCode).toBe(200);

    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(r.currentOrderId).toBe(a.id); // re-pointed, never nulled under a live sibling
    expect(Number(r.committedFloat)).toBe(2000); // only B's float released
    const aFresh = await app.prisma.order.findUniqueOrThrow({ where: { id: a.id } });
    expect(aFresh.status).toBe('RIDER_EN_ROUTE_PICKUP');
    expect(aFresh.riderId).toBe(rider.id);
  });
});

describe('G14 — the custody line is absolute', () => {
  it('after pickup the handback refuses, points at support, and changes NOTHING', async () => {
    const { rider, token } = await makeRider();
    const customer = await makeCustomer();
    const order = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id, status: 'PICKED_UP' });

    const res = await handback(order.id, token);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('CUSTODY');
    expect(res.json().error.message).toMatch(/support/i);

    const fresh = await app.prisma.order.findUniqueOrThrow({ where: { id: order.id } });
    expect(fresh.status).toBe('PICKED_UP');
    expect(fresh.riderId).toBe(rider.id);
    const r = await app.prisma.rider.findUniqueOrThrow({ where: { id: rider.id } });
    expect(Number(r.committedFloat)).toBe(3000); // custody keeps the float committed
  });

  it("another rider's order is not yours to hand back", async () => {
    const { rider } = await makeRider();
    const { token: otherToken } = await makeRider();
    const customer = await makeCustomer();
    const order = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id, readyAt: new Date() });
    expect((await handback(order.id, otherToken)).statusCode).toBe(404);
  });

  it('a reason is required — a silent handback is not a thing', async () => {
    const { rider, token } = await makeRider();
    const customer = await makeCustomer();
    const order = await makeAssignedOrder({ customerId: customer.id, riderId: rider.id });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/rider/orders/${order.id}/handback`,
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});
