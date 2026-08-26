import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { searchRoutes } from '../modules/search/search.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [B2] Search wears the ONE vendor-visibility predicate, on every door.
//
// The module carried five hand-rolled copies, each missing a different
// clause: the /search fallback item query took `status: 'ACTIVE'` alone,
// suggestions had NO vendor predicate at all (a banned store's dish names
// kept autocompleting), trending gated on the vendor-set `isPopular` checkbox
// instead of earned demand. This file forges one vendor per failure mode and
// proves each stays out — and that trending ranks on totalOrdered alone.
//
// Deterministic on purpose: MEILISEARCH_URL points at a dead port so the
// routes provably exercise the DB-fallback path these assertions describe.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
const NEEDLE = `svisneedle${nanoid(6).toLowerCase()}`;

const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdTenantIds: string[] = [];
const DAY = 24 * 60 * 60 * 1000;

let seq = 0;
async function makeVendorWithItem(opts: {
  status?: 'ACTIVE' | 'SUSPENDED';
  isVerified: boolean;
  tenantId: string;
  open?: boolean;
  itemName: string;
  totalOrdered?: number;
  isPopular?: boolean;
}) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200799${String(seq).padStart(2, '0')}`,
      firstName: 'Svis', lastName: `Owner${seq}`,
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(user.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      tenantId: opts.tenantId,
      name: `${NEEDLE} vendor ${seq}`,
      slug: `svis-${nanoid(6).toLowerCase()}-${seq}`,
      vendorType: 'RESTAURANT',
      phone: `+59200798${String(seq).padStart(2, '0')}`,
      addressLine1: '1 Search Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: opts.status ?? 'ACTIVE',
      acceptingOrders: true,
      isCurrentlyOpen: opts.open ?? true,
      isVerified: opts.isVerified,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: {
      vendorId: vendor.id, categoryId: category.id,
      name: opts.itemName, basePrice: 900,
      isAvailable: true,
      totalOrdered: opts.totalOrdered ?? 0,
      isPopular: opts.isPopular ?? false,
    },
  });
  return { vendorId: vendor.id, itemId: item.id };
}

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

let good!: { vendorId: string; itemId: string };
let unverified!: { vendorId: string; itemId: string };
let deadTenant!: { vendorId: string; itemId: string };
let suspended!: { vendorId: string; itemId: string };
let earned!: { vendorId: string; itemId: string };
let checkbox!: { vendorId: string; itemId: string };

beforeAll(async () => {
  // Dead port → SearchService.initialize() fails → routes provably take the
  // DB-fallback path under test.
  process.env['MEILISEARCH_URL'] = 'http://127.0.0.1:9';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(searchRoutes, { prefix: '/api/v1' });
  await app.ready();

  // Idempotent purge (house pattern: unique fixture phone prefix per file).
  const stale = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200799' } }, select: { id: true } });
  if (stale.length) {
    const staleOwners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: stale.map((u) => u.id) } }, select: { id: true } });
    const staleVendors = await app.prisma.vendor.findMany({ where: { ownerId: { in: staleOwners.map((o) => o.id) } }, select: { id: true } });
    await app.prisma.item.deleteMany({ where: { vendorId: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: staleVendors.map((v) => v.id) } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: staleOwners.map((o) => o.id) } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: stale.map((u) => u.id) } } });
    await app.prisma.user.deleteMany({ where: { id: { in: stale.map((u) => u.id) } } });
    await app.prisma.tenant.deleteMany({ where: { slug: { startsWith: 'svis-tenant-' } } });
  }

  const alive = `svis-tenant-${nanoid(8).toLowerCase()}`;
  const dead = `svis-tenant-${nanoid(8).toLowerCase()}`;
  await app.prisma.tenant.create({ data: { id: alive, name: 'Svis Alive', slug: alive } });
  await app.prisma.tenant.create({ data: { id: dead, name: 'Svis Dead', slug: dead, isActive: false } });
  createdTenantIds.push(alive, dead);

  good = await makeVendorWithItem({ isVerified: true, tenantId: alive, itemName: `${NEEDLE} good dish` });
  unverified = await makeVendorWithItem({ isVerified: false, tenantId: alive, itemName: `${NEEDLE} unverified dish` });
  deadTenant = await makeVendorWithItem({ isVerified: true, tenantId: dead, itemName: `${NEEDLE} deadtenant dish` });
  suspended = await makeVendorWithItem({ status: 'SUSPENDED', isVerified: true, tenantId: alive, itemName: `${NEEDLE} suspended dish` });
  // Trending honesty pair: demand vs the checkbox. Counts park far above any
  // real row so rank position is provable.
  earned = await makeVendorWithItem({ isVerified: true, tenantId: alive, itemName: `${NEEDLE} earned dish`, totalOrdered: 9_000_000, isPopular: false });
  checkbox = await makeVendorWithItem({ isVerified: true, tenantId: alive, itemName: `${NEEDLE} checkbox dish`, totalOrdered: 1, isPopular: true });

  const customer = await app.prisma.user.create({
    data: {
      phone: '+59200799' + '99',
      firstName: 'Svis', lastName: 'Cust',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      // The authenticate hook binds the request to the CALLER's tenant, and
      // the Prisma extension scopes tenant-owned reads to it — a swift-default
      // customer can't see `alive`-tenant fixtures at all. Same tenant, so
      // the include/exclude assertions test the PREDICATE, not the scoping.
      tenantId: alive,
      isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  createdUserIds.push(customer.id);
  token = app.jwt.sign({ userId: customer.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: customer.id, token, refreshToken: nanoid(48),
      deviceId: 'svis-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  const owners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: createdUserIds } }, select: { id: true } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: owners.map((o) => o.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.tenant.deleteMany({ where: { id: { in: createdTenantIds } } });
  await app.close();
});

describe('search wears the ONE visibility predicate [B2]', () => {
  it('/search (fallback) returns only the visible vendor and its dish', async () => {
    const res = await get(`/api/v1/search?q=${NEEDLE}&limit=50`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { vendors: { id: string }[]; items: { id: string; vendorId: string }[] } };
    const vendorIds = data.vendors.map((v) => v.id);
    expect(vendorIds).toContain(good.vendorId);
    expect(vendorIds).not.toContain(unverified.vendorId);
    expect(vendorIds).not.toContain(deadTenant.vendorId);
    expect(vendorIds).not.toContain(suspended.vendorId);
    const itemVendors = data.items.map((i) => i.vendorId);
    expect(itemVendors).toContain(good.vendorId);
    expect(itemVendors).not.toContain(unverified.vendorId);
    expect(itemVendors).not.toContain(deadTenant.vendorId);
    expect(itemVendors).not.toContain(suspended.vendorId);
  });

  it('/search/suggestions no longer autocompletes a hidden store’s dishes', async () => {
    const res = await get(`/api/v1/search/suggestions?q=${NEEDLE}`);
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { text: string; type: string }[] };
    const texts = data.map((s) => s.text);
    expect(texts.join(' ')).toContain('good dish');
    expect(texts.join(' ')).not.toContain('unverified dish');
    expect(texts.join(' ')).not.toContain('deadtenant dish');
    expect(texts.join(' ')).not.toContain('suspended dish');
  });

  it('/search/trending is EARNED: demand ranks, the vendor-set checkbox does not', async () => {
    const res = await get('/api/v1/search/trending');
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { id: string }[] };
    const ids = data.map((i) => i.id);
    // The most-ordered dish leads regardless of its isPopular flag…
    expect(ids[0]).toBe(earned.itemId);
    // …and ticking the checkbox buys a barely-ordered dish nothing.
    expect(ids.indexOf(checkbox.itemId) === -1 || ids.indexOf(checkbox.itemId) > 0).toBe(true);
    // Hidden operators stay out here too.
    expect(ids).not.toContain(deadTenant.itemId);
    expect(ids).not.toContain(unverified.itemId);
  });

  it('/search/nearby excludes the shut-off operator', async () => {
    const res = await get('/api/v1/search/nearby?lat=6.801&lng=-58.156&radius=10');
    expect(res.statusCode).toBe(200);
    const { data } = res.json() as { data: { id: string }[] };
    const ids = data.map((v) => v.id);
    expect(ids).toContain(good.vendorId);
    expect(ids).not.toContain(deadTenant.vendorId);
    expect(ids).not.toContain(unverified.vendorId);
  });
});
