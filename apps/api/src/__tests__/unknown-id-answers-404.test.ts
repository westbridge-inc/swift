/**
 * An id that names nothing the caller can see is a 404, never a 500.
 *
 * The cross-tenant attack matrix (row 300) found eight routes that failed
 * closed, leaking nothing, but answered 500:
 *   (c) both logins: admin POST /verification/cases/:id/claim, /:id/release
 *       and PUT /verification/legal-holds/:id/release with an unknown id;
 *   (b) the walled login: vendor PUT/DELETE /option-groups/:id,
 *       POST /option-groups/:groupId/options and PUT/DELETE /options/:id with
 *       another tenant's id. Row-level security hides the item behind the
 *       option group, so `existing.item` came back null and the ownership
 *       check threw a TypeError. Simulated here by a read that returns the
 *       group with its item hidden, which is exactly what the wall returns.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { randomUUID } from 'node:crypto';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';

const RUN = nanoid(8).replace(/[^a-zA-Z0-9]/g, '0');
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;

let app: FastifyInstance;
let adminApp: FastifyInstance;
let vendorApp: FastifyInstance;
let adminToken = '';
let ownerToken = '';
let vendorId = '';
let groupId = '';
let optionId = '';
const users: string[] = [];
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'unknown-id-404-test');

async function session(userId: string, role: 'SUPER_ADMIN' | 'VENDOR_OWNER') {
  const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `u404-${role}-${RUN}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return token;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin); await app.register(redisPlugin); await app.register(authPlugin); await app.register(socketPlugin);
  await app.ready();
  adminApp = Fastify({ logger: false });
  registerErrorHandler(adminApp); registerEmptyJsonBodyParser(adminApp);
  await adminApp.register(prismaPlugin); await adminApp.register(redisPlugin); await adminApp.register(authPlugin); await adminApp.register(socketPlugin);
  await adminApp.register(adminRoutes, { prefix: '/api/v1/admin' });
  await adminApp.ready();
  vendorApp = Fastify({ logger: false });
  registerErrorHandler(vendorApp); registerEmptyJsonBodyParser(vendorApp);
  await vendorApp.register(prismaPlugin); await vendorApp.register(redisPlugin); await vendorApp.register(authPlugin); await vendorApp.register(socketPlugin);
  await vendorApp.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await vendorApp.ready();

  const admin = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59274${NUM}1`, firstName: 'Probe', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'], activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true,
    admin: { create: { permissions: ['*'] } },
  } }));
  users.push(admin.id);
  adminToken = await session(admin.id, 'SUPER_ADMIN');

  const owner = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone: `+59274${NUM}2`, firstName: 'Probe', lastName: `Owner${RUN}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true,
    selfieCapturedAt: new Date(), avatar: '/uploads/avatars/probe.jpg',
  } }));
  users.push(owner.id);
  ownerToken = await session(owner.id, 'VENDOR_OWNER');
  await runWithTenant('swift-default', async () => {
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const vendor = await app.prisma.vendor.create({ data: {
      ownerId: vo.id, name: `Probe Diner ${RUN}`, slug: `probe-${RUN.toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+59274${NUM}3`,
      addressLine1: '1 Probe St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    } });
    vendorId = vendor.id;
    const category = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
    const item = await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Probe Bowl', basePrice: 1000 } });
    const group = await app.prisma.optionGroup.create({ data: { itemId: item.id, name: 'Size' } });
    groupId = group.id;
    const option = await app.prisma.option.create({ data: { optionGroupId: group.id, name: 'Large', additionalPrice: 100 } });
    optionId = option.id;
  });
});

afterAll(async () => {
  vi.restoreAllMocks();
  await system(async () => {
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.admin.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await vendorApp.close();
  await adminApp.close();
  await app.close();
});

describe('(c) admin: an unknown review case or legal hold is a 404', () => {
  const unknown = `nothing-${RUN}`;
  const headers = () => ({ authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'x-swift-reason': `Matrix probe ${RUN}: an id that names nothing` });

  it.each([
    ['POST', `/verification/cases/${unknown}/claim`],
    ['POST', `/verification/cases/${unknown}/release`],
    ['PUT', `/verification/legal-holds/${unknown}/release`],
    // A well-formed UUID that names no row is the same answer.
    ['POST', `/verification/cases/${randomUUID()}/claim`],
    ['POST', `/verification/cases/${randomUUID()}/release`],
    ['PUT', `/verification/legal-holds/${randomUUID()}/release`],
  ] as const)('%s %s', async (method, path) => {
    const res = await adminApp.inject({ method, url: `/api/v1/admin${path}`, payload: { reason: `Matrix probe ${RUN}: an id that names nothing` }, headers: headers() });
    expect(res.statusCode, res.body).toBe(404);
    expect(res.json().error.code).toBe('NOT_FOUND');
  });
});

describe('(b) vendor: an option group whose item the wall hides is a 404', () => {
  const headers = () => ({ authorization: `Bearer ${ownerToken}`, 'content-type': 'application/json', 'x-vendor-id': vendorId });

  it.each([
    ['PUT', () => `/option-groups/${groupId}`, { name: 'Renamed' }],
    ['DELETE', () => `/option-groups/${groupId}`, undefined],
    ['POST', () => `/option-groups/${groupId}/options`, { name: 'Huge', additionalPrice: 200 }],
  ] as const)('%s option group route', async (method, path, payload) => {
    const real = vendorApp.prisma.optionGroup.findUnique.bind(vendorApp.prisma.optionGroup);
    const spy = vi.spyOn(vendorApp.prisma.optionGroup, 'findUnique').mockImplementation((async (args: never) => {
      const row = await real(args);
      return row ? { ...(row as object), item: null } : row; // what row-level security returns for another tenant's item
    }) as never);
    try {
      const res = await vendorApp.inject({ method, url: `/api/v1/vendor${path()}`, ...(payload ? { payload } : {}), headers: headers() });
      expect(res.statusCode, res.body).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    ['PUT', () => `/options/${optionId}`, { name: 'Renamed' }],
    ['DELETE', () => `/options/${optionId}`, undefined],
  ] as const)('%s option route', async (method, path, payload) => {
    const real = vendorApp.prisma.option.findUnique.bind(vendorApp.prisma.option);
    const spy = vi.spyOn(vendorApp.prisma.option, 'findUnique').mockImplementation((async (args: never) => {
      const row = await real(args) as (Record<string, unknown> & { optionGroup?: Record<string, unknown> }) | null;
      return row ? { ...row, optionGroup: { ...(row.optionGroup ?? {}), item: null } } : row;
    }) as never);
    try {
      const res = await vendorApp.inject({ method, url: `/api/v1/vendor${path()}`, ...(payload ? { payload } : {}), headers: headers() });
      expect(res.statusCode, res.body).toBe(404);
    } finally {
      spy.mockRestore();
    }
  });

  it('the owner\'s own option group is still theirs (control)', async () => {
    const res = await vendorApp.inject({ method: 'PUT', url: `/api/v1/vendor/option-groups/${groupId}`, payload: { name: 'Size' }, headers: headers() });
    expect(res.statusCode, res.body).toBe(200);
  });
});
