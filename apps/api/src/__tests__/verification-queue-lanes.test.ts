import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [G6] The verification queue keeps customer identity in its own lane.
//
// `where = { status }` — no role filter. A customer's national ID (uploaded
// for the L2 high-value gate) sat interleaved with rider police clearances and
// vendor business registrations, ordered by arrival. Two failures in one:
// with two hundred mover documents in review a customer ID is unfindable, and
// — worse — the standing invariant that customer ID is "never exposed to
// ordinary dashboards" was broken by the default view, one page at a time,
// even though every individual document VIEW is audited.
//
// The fix is one additive parameter. The operator lane is the default; the
// customer lane is asked for by name; `all` exists for a deliberate sweep.
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200653';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let adminToken: string;
const userIds: string[] = [];
let customerDocId: string;
let moverDocId: string;
let vendorDocId: string;

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeUser(n: number, roles: Array<'CUSTOMER' | 'MOVER' | 'VENDOR_OWNER' | 'ADMIN'>) {
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(n).padStart(2, '0')}`, firstName: 'Lane', lastName: `User${n}`,
      roles, activeRole: roles[0]!, isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(roles.includes('ADMIN') ? { admin: { create: { permissions: ['*'] } } } : {}),
    },
  });
  userIds.push(user.id);
  return user;
}

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });

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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purge();

  const admin = await makeUser(1, ['ADMIN']);
  adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: admin.id, token: adminToken, refreshToken: nanoid(40), deviceId: 'lanes', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  const customer = await makeUser(2, ['CUSTOMER']);
  const mover = await makeUser(3, ['MOVER']);
  const vendor = await makeUser(4, ['VENDOR_OWNER']);
  const doc = (userId: string, role: 'CUSTOMER' | 'MOVER' | 'VENDOR_OWNER', docType: string) =>
    app.prisma.verificationDocument.create({ data: { userId, role, docType, fileUrl: `storage://t/${nanoid(6)}.jpg`, status: 'PENDING' } });
  customerDocId = (await doc(customer.id, 'CUSTOMER', 'national_id')).id;
  moverDocId = (await doc(mover.id, 'MOVER', 'police_clearance')).id;
  vendorDocId = (await doc(vendor.id, 'VENDOR_OWNER', 'business_registration')).id;
});

afterAll(async () => {
  await purge();
  await app.close();
});

const idsIn = async (url: string) => {
  const res = await get(url);
  expect(res.statusCode, res.body).toBe(200);
  return new Set((res.json().data as Array<{ id: string }>).map((d) => d.id));
};

describe('GET /admin/verification/queue lanes', () => {
  it('the default view is the operator lane — a customer ID is not in it', async () => {
    const ids = await idsIn('/api/v1/admin/verification/queue?limit=200');
    expect(ids.has(moverDocId)).toBe(true);
    expect(ids.has(vendorDocId)).toBe(true);
    expect(ids.has(customerDocId), 'customer identity interleaved with routine work').toBe(false);
  });

  it('the customer lane is asked for by name, and holds only customer identity', async () => {
    const ids = await idsIn('/api/v1/admin/verification/queue?limit=200&role=customer');
    expect(ids.has(customerDocId)).toBe(true);
    expect(ids.has(moverDocId)).toBe(false);
    expect(ids.has(vendorDocId)).toBe(false);
  });

  it('`all` is the deliberate sweep — every lane, on purpose', async () => {
    const ids = await idsIn('/api/v1/admin/verification/queue?limit=200&role=all');
    for (const id of [customerDocId, moverDocId, vendorDocId]) expect(ids.has(id)).toBe(true);
  });

  it('an unknown lane is refused, never silently widened to everything', async () => {
    const res = await get('/api/v1/admin/verification/queue?role=everyone');
    expect(res.statusCode).toBe(400);
  });
});
