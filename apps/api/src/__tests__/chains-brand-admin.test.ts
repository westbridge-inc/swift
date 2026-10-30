import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { purgeFixtureAuditTrail } from './helpers/audit-fixture-purge';
import { testPhone, wordFreeTag } from './helpers/fixture-ids';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';

// ---------------------------------------------------------------------------
// [CHAINS PR3 · owner 29 Oct 2026] A person at Swift sets a chain's brand (the name customers see once for all its
// branches) and may list one branch on its own ("split"). No money moves, but it changes which branch a customer
// reaches first: C3, a stated reason, an audit row. The tenant wall holds; a brand name that IS banned goods is
// refused like a store name.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const RUN = wordFreeTag(8);
const userIds: string[] = [];
const ownerIds: string[] = [];
const vendorIds: string[] = [];
let token = '';
const REASON = 'Head office asked for one brand card, letter on file';

const put = (url: string, payload: Record<string, unknown>, reason: string | null = REASON) => app.inject({
  method: 'PUT', url, payload,
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(reason ? { 'x-swift-reason': reason } : {}) },
});

async function chain() {
  const u = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Brand', lastName: `Head${RUN}${nanoid(3)}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true } });
  userIds.push(u.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: u.id } });
  ownerIds.push(owner.id);
  const v = await app.prisma.vendor.create({ data: {
    ownerId: owner.id, name: `Brand Branch ${RUN} ${wordFreeTag(6)}`, slug: `brand-adm-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
    phone: testPhone(), addressLine1: '1 Brand Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
    status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
  vendorIds.push(v.id);
  return { ownerId: owner.id, vendorId: v.id };
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app); registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin); await app.register(redisPlugin);
  await app.register(authPlugin); await app.register(socketPlugin);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  const admin = await app.prisma.user.create({ data: {
    phone: testPhone(), firstName: 'Brand', lastName: `Admin${RUN}`, roles: ['SUPER_ADMIN', 'CUSTOMER'],
    activeRole: 'SUPER_ADMIN', status: 'ACTIVE', isPhoneVerified: true, admin: { create: { permissions: ['*'] } } } });
  userIds.push(admin.id);
  token = app.jwt.sign({ userId: admin.id, role: 'SUPER_ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: {
    userId: admin.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: 'brand', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: ownerIds } } }).catch(() => {});
    await purgeFixtureAuditTrail(app.prisma, userIds, 'chains-brand-admin');
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  }, 'chains-brand');
  await app.close();
});

describe('[CHAINS] the brand routes are classified', () => {
  it('C3 with a reason (no money), capability vendor.brand', () => {
    expect(ADMIN_ROUTE_AUTHORITY['PUT /vendor-owners/:id/brand']).toMatchObject({ cls: 'C3', capability: 'vendor.brand' });
    expect(ADMIN_ROUTE_AUTHORITY['PUT /vendors/:id/brand-listing']).toMatchObject({ cls: 'C3', capability: 'vendor.brand' });
  });
});

describe('[CHAINS] PUT /admin/vendor-owners/:id/brand', () => {
  it('sets the brand with a reason (audited), shows it on the chain view, and clears it with null', async () => {
    const c = await chain();
    const res = await put(`/api/v1/admin/vendor-owners/${c.ownerId}/brand`, { brandName: '  Royal Brandt  ', reason: REASON });
    expect(res.statusCode, res.body).toBe(200);
    expect((await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: c.ownerId } })).brandName).toBe('Royal Brandt');
    const audit = await runWithoutTenant(() => app.prisma.auditLog.findFirst({ where: { entityId: c.ownerId, userId: { in: userIds } } }), 'read');
    expect(audit, 'an audit row names the owner').not.toBeNull();
    const view = await app.inject({ method: 'GET', url: `/api/v1/admin/vendor-owners/${c.ownerId}/chain`, headers: { authorization: `Bearer ${token}` } });
    expect(view.json().data).toMatchObject({ brandName: 'Royal Brandt', branches: [{ vendorId: c.vendorId, brandListedAlone: false }] });
    const clear = await put(`/api/v1/admin/vendor-owners/${c.ownerId}/brand`, { brandName: null, reason: REASON });
    expect(clear.statusCode, clear.body).toBe(200);
    expect((await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: c.ownerId } })).brandName).toBeNull();
  });

  it('no reason: refused, nothing written', async () => {
    const c = await chain();
    const res = await put(`/api/v1/admin/vendor-owners/${c.ownerId}/brand`, { brandName: 'Royal Quiet' }, null);
    expect(res.statusCode).not.toBe(200);
    expect((await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: c.ownerId } })).brandName).toBeNull();
  });

  it('a brand name that is banned goods is refused', async () => {
    const c = await chain();
    const res = await put(`/api/v1/admin/vendor-owners/${c.ownerId}/brand`, { brandName: 'Hennessy VS', reason: REASON });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('PROHIBITED_ITEM');
    expect((await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: c.ownerId } })).brandName).toBeNull();
  });

  it('an owner of another market (tenant) is a 404; so is one that does not exist', async () => {
    const tenantB = `brand-b-${nanoid(6).toLowerCase()}`;
    await runWithoutTenant(() => app.prisma.tenant.create({ data: { id: tenantB, name: 'Brand tenant B', slug: tenantB, isActive: true } }), 'test-fixture:chains');
    try {
      const u = await runWithoutTenant(() => app.prisma.user.create({ data: {
        phone: testPhone(), firstName: 'Other', lastName: `Market${RUN}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', status: 'ACTIVE', isPhoneVerified: true, tenantId: tenantB } }), 'test-fixture:chains');
      userIds.push(u.id);
      const owner = await runWithoutTenant(() => app.prisma.vendorOwner.create({ data: { userId: u.id } }), 'test-fixture:chains');
      ownerIds.push(owner.id);
      const v = await runWithoutTenant(() => app.prisma.vendor.create({ data: {
        ownerId: owner.id, tenantId: tenantB, name: `Other Branch ${RUN}`, slug: `brand-b-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
        phone: testPhone(), addressLine1: '1 Other Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
        status: 'ACTIVE', acceptingOrders: true, isVerified: true } }), 'test-fixture:chains');
      vendorIds.push(v.id);
      const res = await put(`/api/v1/admin/vendor-owners/${owner.id}/brand`, { brandName: 'Royal Elsewhere', reason: REASON });
      expect(res.statusCode, res.body).toBe(404);
      const split = await put(`/api/v1/admin/vendors/${v.id}/brand-listing`, { alone: true, reason: REASON });
      expect(split.statusCode, split.body).toBe(404);
      const rows = await runWithoutTenant(async () => ({
        owner: await app.prisma.vendorOwner.findUniqueOrThrow({ where: { id: owner.id } }),
        vendor: await app.prisma.vendor.findUniqueOrThrow({ where: { id: v.id } }),
      }), 'read');
      expect(rows.owner.brandName).toBeNull();
      expect(rows.vendor.brandListedAlone).toBe(false);
    } finally {
      await runWithoutTenant(async () => {
        await app.prisma.vendor.deleteMany({ where: { tenantId: tenantB } });
        await app.prisma.vendorOwner.deleteMany({ where: { user: { tenantId: tenantB } } });
        await app.prisma.user.deleteMany({ where: { tenantId: tenantB } });
        await app.prisma.tenant.deleteMany({ where: { id: tenantB } });
      }, 'test-fixture:chains');
    }
    expect((await put(`/api/v1/admin/vendor-owners/nope${nanoid(6)}/brand`, { brandName: 'Royal Nobody', reason: REASON })).statusCode).toBe(404);
  });
});

describe('[CHAINS] PUT /admin/vendors/:id/brand-listing', () => {
  it('lists a branch on its own and back, with a reason', async () => {
    const c = await chain();
    const alone = await put(`/api/v1/admin/vendors/${c.vendorId}/brand-listing`, { alone: true, reason: REASON });
    expect(alone.statusCode, alone.body).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: c.vendorId } })).brandListedAlone).toBe(true);
    const back = await put(`/api/v1/admin/vendors/${c.vendorId}/brand-listing`, { alone: false, reason: REASON });
    expect(back.statusCode, back.body).toBe(200);
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: c.vendorId } })).brandListedAlone).toBe(false);
  });
});
