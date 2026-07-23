import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import courierRoutes from '../modules/courier/courier.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Courier (spec §4.3). Send a parcel person-to-person: pickup != dropoff,
// third-party recipient, size-based fee, dispatched to the rider pool, proof of
// delivery. No vendor, no cart.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const CENTRAL = { lat: 6.81, lng: -58.155 };
const SOUTH = { lat: 6.755, lng: -58.155 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200166${String(seq).padStart(2, '0')}`,
      firstName: 'Courier',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'step19', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function purgeFixtures() {
  // Key off the phone prefix so leftovers from a crashed run are cleaned too.
  const users = await app.prisma.user.findMany({
    where: { phone: { startsWith: '+59200166' } },
    select: { id: true },
  });
  const userIds = users.map((u) => u.id);
  createdUserIds.length = 0;
  if (userIds.length === 0) return;
  const orders = await app.prisma.order.findMany({
    where: { OR: [{ customerId: { in: userIds } }, { rider: { userId: { in: userIds } } }] },
    select: { id: true },
  });
  const ids = orders.map((o) => o.id);
  await app.prisma.order.deleteMany({ where: { id: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

const ORDER_BODY = {
  pickup: CENTRAL,
  dropoff: SOUTH,
  pickupAddress: '12 Sender Street',
  dropoffAddress: '34 Recipient Avenue',
  packageSize: 'MEDIUM' as const,
  speed: 'STANDARD' as const,
  recipientName: 'Aunty Pat',
  recipientPhone: '+5926001234',
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
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();

  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Courier — quote', () => {
  it('prices by size + distance + speed', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('POST', '/api/v1/courier/estimate', {
      pickup: CENTRAL, dropoff: SOUTH, packageSize: 'MEDIUM', speed: 'STANDARD',
    }, sender.token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.currency).toBe('GYD');
    expect(data.sizeSurcharge).toBe(500); // MEDIUM
    expect(data.distanceKm).toBeGreaterThan(0);
    expect(data.totalFee).toBeGreaterThan(1500); // base 1000 + surcharge 500 + distance
  });
});

describe('Courier — create, track, deliver', () => {
  it('creates a courier job (pickup != dropoff) and returns a tracking link', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const res = await inject('POST', '/api/v1/courier/order', ORDER_BODY, sender.token);
    expect(res.statusCode).toBe(201);
    const data = res.json().data;
    expect(data.fee).toBeGreaterThan(0);
    expect(data.trackingToken).toBeTruthy();

    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: data.orderId } });
    expect(order.orderType).toBe('COURIER');
    expect(order.pickupLat).toBe(CENTRAL.lat);
    expect(order.deliveryLat).toBe(SOUTH.lat);
    expect(order.courierRecipientName).toBe('Aunty Pat');
    expect(order.courierPackageSize).toBe('MEDIUM');
    // Created ready for a rider; a concurrently-online rider may already be
    // assigned, so accept either early state.
    expect(['READY_FOR_PICKUP', 'RIDER_ASSIGNED']).toContain(order.status);
  });

  it('exposes a public recipient tracking link (no auth)', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const created = (await inject('POST', '/api/v1/courier/order', ORDER_BODY, sender.token)).json().data;

    const res = await inject('GET', `/api/v1/courier/track/${created.trackingToken}`);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(typeof data.status).toBe('string');
    expect(data.courierRecipientName).toBe('Aunty Pat');
    expect(data.deliveryAddress).toBe('34 Recipient Avenue');
  });

  it('lets the assigned rider close the job with proof of delivery', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const created = (await inject('POST', '/api/v1/courier/order', ORDER_BODY, sender.token)).json().data;

    const moverUser = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await app.prisma.rider.create({
      data: { userId: moverUser.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
    });
    await app.prisma.order.update({
      where: { id: created.orderId },
      data: { riderId: rider.id, status: 'PICKED_UP' },
    });

    const res = await inject('POST', `/api/v1/courier/order/${created.orderId}/proof`, { proofPhotoUrl: 'storage://t/proof.jpg' }, moverUser.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('DELIVERED');
    expect(res.json().data.courierProofPhotoUrl).toBe('storage://t/proof.jpg');
  });

  it('lets the sender cancel before delivery', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const created = (await inject('POST', '/api/v1/courier/order', ORDER_BODY, sender.token)).json().data;

    const res = await inject('POST', `/api/v1/courier/order/${created.orderId}/cancel`, { reason: 'Changed my mind' }, sender.token);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.status).toBe('CANCELLED');
  });

  it('cancel vs proof race: exactly one wins, one terminal state [SWIFT-AUD-D2-03]', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const created = (await inject('POST', '/api/v1/courier/order', ORDER_BODY, sender.token)).json().data;
    const moverUser = await makeUserWithSession(['MOVER', 'CUSTOMER'], 'MOVER');
    const rider = await app.prisma.rider.create({ data: { userId: moverUser.userId, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true } });
    await app.prisma.order.update({ where: { id: created.orderId }, data: { riderId: rider.id, status: 'PICKED_UP' } });

    // Sender cancels while the rider submits proof — same instant.
    const [a, b] = await Promise.allSettled([
      inject('POST', `/api/v1/courier/order/${created.orderId}/cancel`, { reason: 'race' }, sender.token),
      inject('POST', `/api/v1/courier/order/${created.orderId}/proof`, { proofPhotoUrl: 'storage://t/p.jpg' }, moverUser.token),
    ]);
    const codes = [a, b].map((r) => (r.status === 'fulfilled' ? r.value.statusCode : 0));
    expect(codes.filter((c) => c === 200)).toHaveLength(1); // exactly one terminal transition wins
    expect(codes.filter((c) => c >= 400)).toHaveLength(1);

    // The order lands in ONE clean terminal state — never delivered-and-paid
    // while also cancelled.
    const final = await app.prisma.order.findUniqueOrThrow({ where: { id: created.orderId } });
    expect(['DELIVERED', 'CANCELLED']).toContain(final.status);
    // The invariant that matters: a job that ended CANCELLED never paid the rider.
    if (final.status === 'CANCELLED') {
      expect(await app.prisma.earning.count({ where: { orderId: created.orderId } })).toBe(0);
    }
  });
});

describe('Courier — first-pass dispatch is enqueued, not inline [SWIFT-097]', () => {
  it('enqueues a dispatch-order job when a queue is up (like taxi), instead of blocking on the cascade', async () => {
    const added: Array<{ name: string; data: unknown }> = [];
    const app2 = Fastify({ logger: false });
    registerErrorHandler(app2);
    await app2.register(prismaPlugin);
    await app2.register(redisPlugin);
    await app2.register(authPlugin);
    await app2.register(socketPlugin);
    app2.decorate('dispatchQueue', { add: async (name: string, data: unknown) => { added.push({ name, data }); } } as never);
    await app2.register(courierRoutes, { prefix: '/api/v1/courier' });
    await app2.ready();

    const rnd = 592_840_000_000 + Math.floor(Math.random() * 90_000_000);
    const u = await app2.prisma.user.create({ data: { phone: `+${rnd}`, firstName: 'Enq', lastName: 'Sender', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
    const token = app2.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app2.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'enq', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });

    try {
      const res = await app2.inject({ method: 'POST', url: '/api/v1/courier/order', payload: ORDER_BODY, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
      expect(res.statusCode).toBe(201);
      const orderId = res.json().data.orderId;
      // A dispatch-order job was enqueued for the worker...
      expect(added.some((j) => j.name === 'dispatch-order' && (j.data as { orderId?: string }).orderId === orderId)).toBe(true);
      // ...and the cascade did NOT run inline — the mock queue never processes it,
      // so no search journal exists yet. (Pre-fix, inline dispatchOrder created one.)
      expect(await app2.prisma.dispatchSearch.count({ where: { subjectId: orderId } })).toBe(0);
    } finally {
      await app2.prisma.order.deleteMany({ where: { customerId: u.id } });
      await app2.prisma.session.deleteMany({ where: { userId: u.id } });
      await app2.prisma.user.deleteMany({ where: { id: u.id } });
      await app2.close();
    }
  });
});

describe('Courier — priority dispatch is REAL [SWIFT-061]', () => {
  it('EXPRESS/RUSH map to isExpress (12s offers / 45s redispatch / sort-first); STANDARD does not', async () => {
    const sender = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const mk = async (speed: 'STANDARD' | 'EXPRESS' | 'RUSH') => {
      const res = await inject('POST', '/api/v1/courier/order', { ...ORDER_BODY, speed }, sender.token);
      expect(res.statusCode).toBe(201);
      return app.prisma.order.findUniqueOrThrow({
        where: { id: res.json().data.orderId },
        select: { isExpress: true, courierSpeed: true },
      });
    };
    // The surcharge was already charged; now the priority is mechanically real —
    // isExpress is the single flag the dispatch cascade + board sort read.
    expect((await mk('RUSH')).isExpress).toBe(true);
    expect((await mk('EXPRESS')).isExpress).toBe(true);
    expect((await mk('STANDARD')).isExpress).toBe(false);
  });
});
