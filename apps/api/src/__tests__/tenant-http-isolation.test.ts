import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, beginRequestTenantContext, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { customerRoutes } from '../modules/user/customer.routes';

// ---------------------------------------------------------------------------
// Tenant isolation END-TO-END over HTTP (launch-readiness §1.2): a customer in
// tenant B, authenticating through the REAL authenticate flow, sees ONLY their
// tenant's marketplace — never the default tenant's vendors. This exercises the
// whole chain: onRequest fresh store → authenticate binds the caller's tenant →
// the Prisma scope extension filters the vendor list.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let tokenB: string;
let tokenDefault: string;
const userIds: string[] = [];
const TENANT_B = `tenant-b-${nanoid(6)}`;

async function customer(tenantId: string) {
  return runWithoutTenant(async () => {
    const u = await app.prisma.user.create({
      data: {
        phone: `+59269${String(Math.floor(Math.random() * 90000) + 10000)}`,
        firstName: 'Http', lastName: 'Tenant',
        roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
        isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId,
        customer: { create: {} },
      },
    });
    userIds.push(u.id);
    const token = app.jwt.sign({ userId: u.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({
      data: {
        userId: u.id, token, refreshToken: nanoid(48),
        deviceId: 'http-tenant', deviceType: 'test',
        expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
      },
    });
    return token;
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  // The production onRequest hook — a fresh tenant store per request.
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  await runWithoutTenant(async () => {
    await app.prisma.tenant.upsert({
      where: { id: TENANT_B }, update: {},
      create: { id: TENANT_B, name: 'Tenant B', slug: `tenant-b-${nanoid(6)}`, isActive: true },
    });
  });
  tokenB = await customer(TENANT_B);
  tokenDefault = await customer('swift-default');
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.prisma.tenant.deleteMany({ where: { id: TENANT_B } });
  });
  await app.close();
});

describe('tenant isolation over HTTP', () => {
  it("a default-tenant customer sees the default tenant's vendors", async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/customer/vendors',
      headers: { authorization: `Bearer ${tokenDefault}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.length).toBeGreaterThan(0); // the seed cohort
  });

  it("a tenant-B customer sees NONE of the default tenant's vendors", async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/customer/vendors',
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(res.statusCode).toBe(200);
    // Tenant B has its own (empty) marketplace — the default tenant's vendors
    // are invisible to it. This is the cross-tenant isolation the spec demands,
    // proven through the real authenticate → tenant-bind → scoped-query chain.
    expect(res.json().data).toHaveLength(0);
  });
});
