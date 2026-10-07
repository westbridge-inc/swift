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
import { retainedCohort, retainedPhonePrefix, retireKeptScaffolding, without } from './helpers/retained-evidence';

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
// [SAFE-B · retained history] An issued drop-off proof is immutable evidence: its job and the people it names
// are kept after the suite, so the phones live in a namespace no other suite uses or purges, unique to the run.
const PHONE_PREFIX = retainedPhonePrefix('12');

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
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
  return { userId: user.id, token, phone: user.phone };
}

function inject(method: 'GET' | 'POST' | 'DELETE', url: string, payload?: unknown, token?: string) {
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
    where: { phone: { startsWith: PHONE_PREFIX } },
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
  // [SAFE-B · retained history] A job with an issued proof is kept with the people it names; the rest goes as
  // before, in one transaction, and what stays is taken out of service.
  await app.prisma.$transaction(async (tx) => {
    const kept = await retainedCohort(tx, { orderIds: ids });
    await tx.order.deleteMany({ where: { id: { in: without(ids, kept.orderIds) } } });
    await tx.user.deleteMany({ where: { id: { in: without(userIds, kept.userIds) } } });
    await retireKeptScaffolding(tx, kept);
  }, { timeout: 60_000 });
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


describe('MASTER-034 public courier capability', () => {
  it('terminal links never disclose recipient, addresses or courier position', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const created = await inject('POST', '/api/v1/courier/order', ORDER_BODY, customer.token);
    expect(created.statusCode).toBe(201);
    const { orderId, trackingToken } = created.json().data;
    const before = await inject('GET', `/api/v1/courier/track/${trackingToken}`);
    expect(before.statusCode).toBe(200);
    await app.prisma.order.update({ where: { id: orderId }, data: { status: 'CANCELLED' } });
    const terminal = await inject('GET', `/api/v1/courier/track/${trackingToken}`);
    expect(terminal.statusCode).toBe(200);
    const data = terminal.json().data;
    expect(data.courierRecipientName).toBeUndefined();
    expect(data.pickupAddress).toBeUndefined();
    expect(data.deliveryAddress).toBeUndefined();
    expect(data.rider).toBeNull();
  });
});

describe('MASTER-034 expiry and sender controls', () => {
  it('stores no secret; rotation invalidates the previous grant and strangers cannot control it', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const other = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const { orderId, trackingToken } = (await inject('POST', '/api/v1/courier/order', ORDER_BODY, customer.token)).json().data;
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id: orderId } });
    expect(row.courierTrackingToken).not.toBe(trackingToken);
    expect((await inject('GET', `/api/v1/courier/track/${row.courierTrackingToken}`)).statusCode).toBe(404);
    expect((await inject('POST', `/api/v1/courier/order/${orderId}/tracking`, {}, other.token)).statusCode).toBe(404);
    const replacement = await inject('POST', `/api/v1/courier/order/${orderId}/tracking`, {}, customer.token);
    expect(replacement.statusCode).toBe(200);
    const next = replacement.json().data.trackingToken;
    expect((await inject('GET', `/api/v1/courier/track/${trackingToken}`)).statusCode).toBe(404);
    expect((await inject('GET', `/api/v1/courier/track/${next}`)).statusCode).toBe(200);
    expect((await inject('DELETE', `/api/v1/courier/order/${orderId}/tracking`, undefined, other.token)).statusCode).toBe(404);
    expect((await inject('DELETE', `/api/v1/courier/order/${orderId}/tracking`, undefined, customer.token)).statusCode).toBe(200);
    expect((await inject('GET', `/api/v1/courier/track/${next}`)).statusCode).toBe(404);
  });
  it('absolute expiry and terminal grace are enforced without cleanup', async () => {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const { orderId, trackingToken } = (await inject('POST', '/api/v1/courier/order', ORDER_BODY, customer.token)).json().data;
    await app.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED', deliveredAt: new Date(Date.now() - 3_600_001) } });
    expect((await inject('GET', `/api/v1/courier/track/${trackingToken}`)).statusCode).toBe(404);
    await app.prisma.order.update({ where: { id: orderId }, data: { status: 'READY_FOR_PICKUP', placedAt: new Date(Date.now() - 12 * 3_600_000) } });
    expect((await inject('GET', `/api/v1/courier/track/${trackingToken}`)).statusCode).toBe(404);
    expect((await inject('POST', `/api/v1/courier/order/${orderId}/tracking`, {}, customer.token)).statusCode).toBe(404);
  });
});
