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
// THE AUDIT TRAIL WAS BLIND ON EXACTLY THE MOVES NOBODY WATCHES.
//
// `order_status_logs.note` is the evidence column. Elsewhere it carries GPS
// fixes on handover, the reason on a cancellation, the SOS text, the MMG
// UNATTESTED marker — and existing tests assert every one of those.
//
// Measured on the database before this change:
//
//     status                  rows  with_note
//     PENDING                  177    177
//     ACCEPTED                  76     75
//     READY_FOR_PICKUP          42     41
//     RIDER_ASSIGNED            35     34
//     ---------------------------------------
//     RIDER_EN_ROUTE_PICKUP     17      0
//     RIDER_ARRIVED_PICKUP      17      0
//     PICKED_UP                 17      0
//     EN_ROUTE_DELIVERY         17      0
//     ARRIVED                   17      0
//     DRIVER_EN_ROUTE            8      0
//     DRIVER_ARRIVED             7      0
//
// Vendor- and dispatch-driven transitions: noted on ~100% of rows. Every
// transition a courier performs alone, unobserved, from the cockpit: null, all
// of them. One hundred rows. Those are precisely the moves that get disputed —
// when a customer says nobody came and a rider says they waited, this is the
// record the enforcement ladder reads, and it said nothing at all.
//
// The cause was one missing argument: the generic rider handler called
// `updateStatus(id, to, userId)` and stopped, while `/delivered` four lines
// below it passed 'Delivery completed'. Nothing failed, nothing warned.
//
// This file grades the trail by DRIVING A REAL ORDER THROUGH IT and reading the
// rows back, not by checking the strings exist in the source.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let vendorId: string;

const PHONE_PREFIX = '+59200934';
const GPS = { lat: 6.8013, lng: -58.1551 };

let seq = 0;
function nextPhone(): string {
  seq += 1;
  return `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`;
}

async function makeRider() {
  const u = await app.prisma.user.create({
    data: {
      phone: nextPhone(), firstName: 'Trail', lastName: 'Rider',
      roles: ['RIDER' as UserRole, 'CUSTOMER' as UserRole], activeRole: 'RIDER' as UserRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(), countryCode: 'GY',
    },
  });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: 'RIDER', jti: nanoid(8) });
  const session = await app.prisma.session.create({
    data: {
      userId: u.id, token, refreshToken: nanoid(48),
      deviceId: `trail-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  const rider = await app.prisma.rider.create({
    data: {
      userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE',
      documentsVerified: true, isOnline: true,
      currentLat: GPS.lat, currentLng: GPS.lng,
      lastLocationUpdate: new Date(), locationSessionId: session.id,
    },
  });
  return { userId: u.id, riderId: rider.id, token };
}

async function makeCustomer(): Promise<string> {
  const u = await app.prisma.user.create({
    data: {
      phone: nextPhone(), firstName: 'Trail', lastName: 'Customer',
      roles: ['CUSTOMER' as UserRole], activeRole: 'CUSTOMER' as UserRole,
      isPhoneVerified: true, countryCode: 'GY',
      customer: { create: {} },
    },
  });
  createdUserIds.push(u.id);
  return u.id;
}

async function makeAssignedOrder(customerId: string, riderId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `SW-TRAIL-${nanoid(8).toUpperCase()}`,
      orderType: 'FOOD_DELIVERY',
      customerId, vendorId, riderId,
      status: 'RIDER_ASSIGNED',
      deliveryAddress: '1 Evidence Street, Georgetown',
      deliveryLat: GPS.lat, deliveryLng: GPS.lng,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 500, totalAmount: 1500,
      paymentMethod: 'CASH', paymentStatus: 'CAPTURED',
    },
  });
  createdOrderIds.push(order.id);
  return order;
}

/** The rider's whole leg, in the order the cockpit walks it. */
const LEG = [
  { slug: 'en-route-pickup', status: 'RIDER_EN_ROUTE_PICKUP' },
  { slug: 'arrived-pickup', status: 'RIDER_ARRIVED_PICKUP' },
  { slug: 'picked-up', status: 'PICKED_UP' },
  { slug: 'en-route-delivery', status: 'EN_ROUTE_DELIVERY' },
  { slug: 'arrived', status: 'ARRIVED' },
] as const;

async function walkTheLeg(token: string, orderId: string) {
  for (const { slug } of LEG) {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/rider/orders/${orderId}/${slug}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode, `${slug} should transition; got ${res.body}`).toBe(200);
  }
  return app.prisma.orderStatusLog.findMany({
    where: { orderId },
    orderBy: { createdAt: 'asc' },
    select: { status: true, note: true, changedBy: true },
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  registerErrorHandler(app);
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  const stale = await app.prisma.user.findMany({
    where: { phone: { startsWith: PHONE_PREFIX } },
    select: { id: true },
  });
  if (stale.length) {
    const orders = await app.prisma.order.findMany({
      where: { customerId: { in: stale.map((u) => u.id) } },
      select: { id: true },
    });
    // The log table is append-only by design, so a prior run's rows are cleared
    // through the raw path rather than the guarded client.
    if (orders.length) {
      await app.prisma.$executeRawUnsafe(
        `DELETE FROM "order_status_logs" WHERE "orderId" = ANY($1::text[])`,
        orders.map((o) => o.id),
      );
    }
    await app.prisma.order.deleteMany({ where: { customerId: { in: stale.map((u) => u.id) } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
  }

  const vendor = await app.prisma.vendor.findFirst({ select: { id: true } });
  if (!vendor) throw new Error('no vendor in the test database');
  vendorId = vendor.id;
});

afterAll(async () => {
  if (createdOrderIds.length) {
    await app.prisma.$executeRawUnsafe(
      `DELETE FROM "order_status_logs" WHERE "orderId" = ANY($1::text[])`,
      createdOrderIds,
    );
  }
  await app.prisma.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await app.prisma.rider.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('every rider transition leaves a note behind', () => {
  it('all five write a non-empty note, not one of them null', async () => {
    const rider = await makeRider();
    const order = await makeAssignedOrder(await makeCustomer(), rider.riderId);

    const logs = await walkTheLeg(rider.token, order.id);

    for (const { status } of LEG) {
      const row = logs.find((l) => l.status === status);
      expect(row, `${status} must be logged at all`).toBeDefined();
      expect(
        row!.note,
        `${status} logged with a null note — this is the row a dispute is decided on`,
      ).toBeTruthy();
      expect(String(row!.note).length).toBeGreaterThan(8);
    }
  });

  it('each note is distinct, so the trail reads as a sequence', async () => {
    // One note reused across five rows would satisfy "not null" while telling
    // a reader nothing about which move happened when.
    const rider = await makeRider();
    const order = await makeAssignedOrder(await makeCustomer(), rider.riderId);

    const logs = await walkTheLeg(rider.token, order.id);
    const notes = LEG.map(({ status }) => logs.find((l) => l.status === status)?.note);

    expect(new Set(notes).size, 'the five notes must differ from each other').toBe(LEG.length);
  });

  it('the note records the rider as the actor', async () => {
    const rider = await makeRider();
    const order = await makeAssignedOrder(await makeCustomer(), rider.riderId);

    const logs = await walkTheLeg(rider.token, order.id);

    for (const { status } of LEG) {
      const row = logs.find((l) => l.status === status)!;
      expect(row.note!.toLowerCase(), `${status} should name who moved it`).toContain('rider');
      expect(row.changedBy, 'and changedBy must still be the acting user').toBe(rider.userId);
    }
  });

  it('an arrival is recorded as a CLAIM, not as a fact', async () => {
    // `arrived` has no GPS check. Pressing the button is the rider's assertion
    // about the physical world, and the enforcement ladder reads these rows
    // when a customer says nobody came. A log that records an unverified claim
    // as a fact is worse than one that records nothing, so the arrival rows say
    // "reported" while the rows for deeds the press CONSTITUTES do not.
    const rider = await makeRider();
    const order = await makeAssignedOrder(await makeCustomer(), rider.riderId);

    const logs = await walkTheLeg(rider.token, order.id);
    const noteFor = (s: string) => logs.find((l) => l.status === s)!.note!.toLowerCase();

    expect(noteFor('RIDER_ARRIVED_PICKUP')).toContain('reported');
    expect(noteFor('ARRIVED')).toContain('reported');
    // …and the runs, which the press does constitute, are not hedged.
    expect(noteFor('RIDER_EN_ROUTE_PICKUP')).not.toContain('reported');
    expect(noteFor('EN_ROUTE_DELIVERY')).not.toContain('reported');
  });
});
