import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// FUL-004 (fulfillment Part 4) — foundation slice: a vendor can be marked
// self-delivery-capable (its own courier fulfils DELIVERY orders vs a platform
// rider). This proves the additive schema field + the settings toggle, end to
// end. The fulfillment-choice-at-Ready logic + rows-3/4 settlement + the
// fallback build on this in follow-on slices.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const u = await app.prisma.user.create({
    data: { phone: `+59200906${String(Math.floor(Math.random() * 90) + 10)}`, firstName: 'Self', lastName: 'Deliver', roles: ['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true },
  });
  userIds.push(u.id);
  vendorToken = app.jwt.sign({ userId: u.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token: vendorToken, refreshToken: nanoid(48), deviceId: 'fd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  const vo = await app.prisma.vendorOwner.create({ data: { userId: u.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Self Diner', slug: `self-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920090600', addressLine1: '2 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
  });
  vendorId = vendor.id;
});

afterAll(async () => {
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

const putProfile = (body: unknown) =>
  app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: body as Record<string, unknown> });

const readVendor = () => app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId }, select: { selfDeliveryEnabled: true } });

describe('FUL-004: vendor self-delivery capability', () => {
  it('defaults OFF — a new vendor is platform-rider-only until it opts in', async () => {
    expect((await readVendor()).selfDeliveryEnabled).toBe(false);
  });

  it('a vendor can turn self-delivery ON via its settings, and it persists', async () => {
    const res = await putProfile({ selfDeliveryEnabled: true });
    expect(res.statusCode).toBe(200);
    expect((await readVendor()).selfDeliveryEnabled).toBe(true);
  });

  it('and back OFF again', async () => {
    const res = await putProfile({ selfDeliveryEnabled: false });
    expect(res.statusCode).toBe(200);
    expect((await readVendor()).selfDeliveryEnabled).toBe(false);
  });
});
