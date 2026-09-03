import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { registerErrorHandler } from '../middleware/error-handler';
import { discoveryRoutes, CATEGORY_DISCOVERY_FLAG, resetDiscoveryCacheForTests } from '../modules/discovery/discovery.routes';
import { seedDiscoveryTaxonomy } from '../modules/discovery/taxonomy.seed';
import { grantSuiteCapability } from '../lib/test-target-lock';

// [R048-001] this suite installs its partial unique index by raw DDL on a db-push database (migrations carry it in CI) — a stated, reviewable capability.
grantSuiteCapability('ddl');

// ---------------------------------------------------------------------------
// The rail's data source (#17 6.1/8): flag OFF → {enabled:false} and the Home
// seam renders exactly as before (CAT-G's server half); flag ON → only
// categories with live, open, in-range vendors return (law D — no dead taps);
// closed or suspended vendors never count; the availability truth is ONE
// query, cached.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
let seq = 0;
const phoneBase = 592_780_000_000 + Math.floor(Math.random() * 9_000_000);

async function makeMemberVendor(slug: string, over: { open?: boolean; status?: 'ACTIVE' | 'SUSPENDED'; lat?: number; lng?: number; radius?: number } = {}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`, firstName: 'Rail', lastName: `U${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: user.id }, create: { userId: user.id }, update: {} });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Rail Vendor ${seq}`, slug: `rail-vendor-${nanoid(8).toLowerCase()}`,
      vendorType: 'RESTAURANT', phone: `+${phoneBase + 500_000 + seq}`,
      addressLine1: '1 Chip Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: over.lat ?? 6.8, longitude: over.lng ?? -58.15,
      deliveryRadius: over.radius ?? 10,
      status: over.status ?? 'ACTIVE', isVerified: true,
      isCurrentlyOpen: over.open ?? true,
    },
  });
  createdVendorIds.push(vendor.id);
  const cat = await app.prisma.discoveryCategory.findUniqueOrThrow({
    where: { tenantId_slug: { tenantId: 'swift-default', slug } },
  });
  await app.prisma.vendorDiscoveryCategory.create({
    data: { tenantId: 'swift-default', vendorId: vendor.id, categoryId: cat.id, role: 'PRIMARY', source: 'VENDOR' },
  });
  return vendor;
}

const rail = (qs = '') => app.inject({ method: 'GET', url: `/api/v1/discovery/categories${qs}` });

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  registerErrorHandler(app);
  await app.register(discoveryRoutes, { prefix: '/api/v1/discovery' });
  await app.ready();
  await app.prisma.$executeRawUnsafe(
    `CREATE UNIQUE INDEX IF NOT EXISTS "one_primary_discovery_category_per_vendor" ON "vendor_discovery_categories"("vendorId") WHERE role = 'PRIMARY'`,
  );
  await seedDiscoveryTaxonomy(app.prisma);
  await app.prisma.platformConfig.deleteMany({ where: { key: CATEGORY_DISCOVERY_FLAG } });
});

afterAll(async () => {
  await app.prisma.platformConfig.deleteMany({ where: { key: CATEGORY_DISCOVERY_FLAG } });
  await app.prisma.vendorDiscoveryCategory.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('flag gate (CAT-G server half)', () => {
  it('flag absent/false → enabled:false, empty; flipping the config flips behavior', async () => {
    resetDiscoveryCacheForTests();
    const off = (await rail()).json().data;
    expect(off).toEqual({ enabled: false, categories: [] });

    await app.prisma.platformConfig.upsert({
      where: { key: CATEGORY_DISCOVERY_FLAG },
      create: { key: CATEGORY_DISCOVERY_FLAG, value: true },
      update: { value: true },
    });
    const on = (await rail()).json().data;
    expect(on.enabled).toBe(true);
  });
});

describe('law D: no dead taps', () => {
  it('only categories with live+open membership return; closed and suspended never count', async () => {
    resetDiscoveryCacheForTests();
    await makeMemberVendor('chinese', { open: true });
    await makeMemberVendor('pizza', { open: false }); // closed → chip absent
    await makeMemberVendor('wings', { status: 'SUSPENDED' }); // dead → absent

    const data = (await rail('?vertical=FOOD')).json().data;
    const slugs = (data.categories as Array<{ slug: string }>).map((c) => c.slug);
    expect(slugs).toContain('chinese');
    expect(slugs).not.toContain('pizza');
    expect(slugs).not.toContain('wings');
    const chinese = (data.categories as Array<{ slug: string; availableVendors: number }>).find((c) => c.slug === 'chinese')!;
    expect(chinese.availableVendors).toBeGreaterThanOrEqual(1);
  });

  it('geo filtering respects the vendor\'s own delivery radius', async () => {
    resetDiscoveryCacheForTests();
    // A bakery ~50km away with a 10km radius: in the anywhere view, absent nearby.
    await makeMemberVendor('bakery-pastries', { lat: 7.25, lng: -58.15, radius: 10 });

    const near = (await rail('?vertical=FOOD&lat=6.80&lng=-58.15')).json().data;
    expect((near.categories as Array<{ slug: string }>).map((c) => c.slug)).not.toContain('bakery-pastries');

    resetDiscoveryCacheForTests();
    const anywhere = (await rail('?vertical=FOOD')).json().data;
    expect((anywhere.categories as Array<{ slug: string }>).map((c) => c.slug)).toContain('bakery-pastries');
  });
});
