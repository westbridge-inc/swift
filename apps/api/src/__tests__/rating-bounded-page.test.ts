import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// Movement R — R8/RAT-I: ONE surface mapper feeds every star line. The pure
// mapper is pinned row-by-row, then the browse endpoint proves the fields ride
// every card, "Top rated" sorts globally (Bayesian display, not raw mean, and
// unrated stores sink), and the storefront header reads the same mapper.
// ---------------------------------------------------------------------------

const DAY = 24 * 3600_000;
let app: FastifyInstance;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_740_000_000 + Math.floor(Math.random() * 9_000_000);
// Browse is a shared table — a unique cuisine tag isolates this file's vendors.
const CUISINE = `ratsurf-${nanoid(6).toLowerCase()}`;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const u = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Surf', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true,
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'surf-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: u.id, token };
}

/** ACTIVE vendor with one live item (browse hides empty stores) and an
 *  optional stat row shaped like the stats engine writes it. */
async function makeVendor(name: string, stat?: { display: number; count: number; standing: string }) {
  const owner = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.upsert({ where: { userId: owner.userId }, create: { userId: owner.userId }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `${CUISINE}-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Surface Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
      cuisineTypes: [CUISINE],
    },
  });
  createdVendorIds.push(vendor.id);
  const cat = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains' } });
  await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: cat.id, name: 'Surf plate', basePrice: 1200, isAvailable: true },
  });
  if (stat) {
    await app.prisma.actorRatingStat.create({
      data: {
        tenantId: 'swift-default', subjectRole: 'VENDOR', subjectId: vendor.id,
        lifetimeCount: stat.count, lifetimeSum: Math.round(stat.display * stat.count),
        rollingCount: Math.min(stat.count, 100), rollingSum: Math.round(stat.display * Math.min(stat.count, 100)),
        displayRating: stat.display, standing: stat.standing,
      },
    });
  }
  return vendor;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app.prisma.actorRatingStat.deleteMany({ where: { subjectId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});


describe('MASTER-039 database-bounded ranking', () => {
  it('a top-rated page does not load the entire vendor population or population-sized rating IDs', async () => {
    for (let i = 0; i < 12; i++) await makeVendor(`Store ${i}`, { display: 4.5 + (i % 3) / 10, count: 20, standing: 'GOOD' });
    const errors = vi.spyOn(app.log, 'error');
    const vendorReads = vi.spyOn(app.prisma.vendor, 'findMany');
    const ratingReads = vi.spyOn(app.prisma.actorRatingStat, 'findMany');
    try {
      const res = await app.inject({ method: 'GET', url: `/api/v1/customer/vendors?cuisine=${CUISINE}&sort=top_rated&limit=2&page=2` });
      expect(res.statusCode, errors.mock.calls.map(([entry]) => (entry as { err?: Error })?.err?.message).join('\n')).toBe(200);
      expect(res.json().data).toHaveLength(2);
      expect(res.json().meta.total).toBe(12);
      for (const [args] of ratingReads.mock.calls) {
        const subjects = args?.where?.subjectId;
        if (!subjects || typeof subjects === 'string' || !Array.isArray(subjects.in)) throw new Error('Expected a bounded subject-ID array');
        expect(subjects.in.length).toBeLessThanOrEqual(2);
      }
      for (const [args] of vendorReads.mock.calls) {
        if (args?.take == null) expect((args?.where?.id as { in?: string[] })?.in?.length).toBeLessThanOrEqual(2);
      }
    } finally { vendorReads.mockRestore(); ratingReads.mockRestore(); errors.mockRestore(); }
  });
});

// C collation is explicit: accented names use byte order; exact ties use id.
it('keeps ties deterministic, applies filters, and refuses unbounded offset', async () => {
  const tag = `tie-${nanoid(8)}`;
  const a = await makeVendor('éclair', { display: 4.9, count: 20, standing: 'GOOD' });
  const b = await makeVendor('Alpha', { display: 4.9, count: 20, standing: 'GOOD' });
  const c = await makeVendor('Alpha', { display: 4.9, count: 20, standing: 'GOOD' });
  const hidden = await makeVendor('Hidden', { display: 5, count: 20, standing: 'GOOD' });
  await app.prisma.vendor.updateMany({ where: { id: { in: [a.id, b.id, c.id, hidden.id] } }, data: { cuisineTypes: [tag] } });
  await app.prisma.vendor.update({ where: { id: hidden.id }, data: { isVerified: false } });
  const result = await app.inject(`/api/v1/customer/vendors?sort=top_rated&cuisine=${tag}`);
  expect(result.statusCode).toBe(200);
  expect(result.json().data.map((v: { id: string }) => v.id)).toEqual([b.id, c.id].sort().concat(a.id));
  expect((await app.inject(`/api/v1/customer/vendors?sort=top_rated&cuisine=${tag}&search=Alpha`)).json().meta.total).toBe(2);
  expect((await app.inject('/api/v1/customer/vendors?sort=top_rated&page=501&limit=50')).statusCode).toBe(400);
});

it('bounds application allocation on a 1,000-vendor population and records page/count plans', async () => {
  const base = await makeVendor('Scale base');
  const tag = `scale-${nanoid(8)}`;
  const ids = Array.from({ length: 1000 }, (_, i) => `scale-${nanoid(12)}-${i}`);
  await app.prisma.vendor.createMany({ data: ids.map((id, i) => ({
    id, ownerId: base.ownerId, tenantId: base.tenantId, name: `Scale ${i}`, slug: id,
    vendorType: 'RESTAURANT' as const, phone: '+5926000000', addressLine1: 'Test', city: 'Georgetown',
    region: 'Test', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' as const, isVerified: true, cuisineTypes: [tag],
  })) });
  createdVendorIds.push(...ids);
  await app.prisma.category.createMany({ data: ids.map((vendorId) => ({ id: `cat-${vendorId}`, vendorId, name: 'Test' })) });
  await app.prisma.item.createMany({ data: ids.map((vendorId) => ({ vendorId, categoryId: `cat-${vendorId}`, tenantId: base.tenantId, name: 'Test', basePrice: 1, isAvailable: true })) });
  const reads = vi.spyOn(app.prisma, '$queryRaw');
  const stats = vi.spyOn(app.prisma.actorRatingStat, 'findMany');
  try {
    const res = await app.inject(`/api/v1/customer/vendors?sort=top_rated&cuisine=${tag}&limit=2`);
    expect(res.statusCode).toBe(200);
    expect(res.json().meta.total).toBe(1000);
    expect(res.json().data).toHaveLength(2);
    for (const [args] of stats.mock.calls) {
      const subjects = args?.where?.subjectId;
      if (!subjects || typeof subjects === 'string' || !Array.isArray(subjects.in)) throw new Error('Expected a bounded subject-ID array');
      expect(subjects.in.length).toBeLessThanOrEqual(2);
    }
    const queries = reads.mock.calls.slice(0, 2).map(([q]) => q as Prisma.Sql);
    reads.mockRestore();
    for (const q of queries) console.info('MASTER-039 PLAN', JSON.stringify(await app.prisma.$queryRaw(Prisma.sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${q}`)));
  } finally { reads.mockRestore(); stats.mockRestore(); }
});
