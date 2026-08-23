import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { nanoid } from 'nanoid';
import Fastify, { type FastifyInstance } from 'fastify';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// Browsing is open to everyone; only ordering/personal data needs an account.
// Guests (no token) must see Home / vendors / menus / reviews, but be 401'd on
// cart, profile, favourites, orders, etc.
let app: FastifyInstance;
let vendorId: string;

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const v = await app.prisma.vendor.findFirst({ where: { status: 'ACTIVE' }, select: { id: true } });
  vendorId = v!.id;
});

afterAll(async () => {
  await app.close();
});

const get = (url: string) => app.inject({ method: 'GET', url });

describe('guest browsing (no account)', () => {
  it('lets guests see Home', async () => {
    expect((await get('/api/v1/customer/home')).statusCode).toBe(200);
  });
  it('returns a bounded discovery feed — sections never exceed their caps [SWIFT-163]', async () => {
    // The Home scan is capped (HOME_DISCOVERY_SCAN_CAP) so a growing catalogue
    // can't load unboundedly per request. Whatever the vendor count, the feed
    // stays within its documented section sizes.
    await app.redis.del('t:_notenant:home:guest:x:x');
    const d = (await get('/api/v1/customer/home')).json().data;
    expect(d.openVendors.length).toBeLessThanOrEqual(30);
    expect(d.closedVendors.length).toBeLessThanOrEqual(10);
    expect(d.featured.length).toBeLessThanOrEqual(8);
    expect(d.orderAgain.length).toBeLessThanOrEqual(6);
  });
  it('keeps not-accepting vendors out of orderable feeds (no checkout dead-end)', async () => {
    // A vendor that's open-by-hours but paused (acceptingOrders=false) must not
    // surface where it can be ordered, else it dead-ends at checkout (VENDOR_CLOSED).
    const v = await app.prisma.vendor.findFirst({
      where: { status: 'ACTIVE', isCurrentlyOpen: true },
      select: { id: true },
    });
    if (!v) return;
    try {
      await app.prisma.vendor.update({ where: { id: v.id }, data: { acceptingOrders: false } });
      await app.redis.del('t:_notenant:home:guest:x:x');
      const res = await get('/api/v1/customer/home');
      expect(res.statusCode).toBe(200);
      const d = res.json().data;
      const has = (list: { id: string }[]) => (list ?? []).some((x) => x.id === v.id);
      expect(has(d.openVendors)).toBe(false);
      expect(has(d.featured)).toBe(false);
      expect(has(d.nearby)).toBe(false);
    } finally {
      await app.prisma.vendor.update({ where: { id: v.id }, data: { acceptingOrders: true } });
      await app.redis.del('t:_notenant:home:guest:x:x');
    }
  });
  it('keeps EMPTY stores (no orderable item) out of browse + home, adds them back once stocked', async () => {
    // An ACTIVE, verified store with zero available items must not surface in
    // discovery — tapping it dead-ends on an empty menu. Once it has one
    // available item, it appears.
    const rnd = 592_700_000_000 + Math.floor(Math.random() * 900_000_000);
    const user = await app.prisma.user.create({ data: { phone: `+${rnd}`, firstName: 'Empty', lastName: 'Store', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
    const owner = await app.prisma.vendorOwner.create({ data: { userId: user.id } });
    const v = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: `Empty Store ${nanoid(6)}`, slug: `empty-${nanoid(8).toLowerCase()}`, vendorType: 'STORE', phone: `+${rnd + 1}`, addressLine1: '1 Empty', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
    const inBody = (body: unknown) => JSON.stringify(body).includes(v.id);
    try {
      await app.redis.del('t:_notenant:home:guest:x:x');
      // Empty → excluded from both the browse list and Home.
      expect(inBody((await get('/api/v1/customer/vendors')).json())).toBe(false);
      expect(inBody((await get('/api/v1/customer/home')).json())).toBe(false);
      // Stock one available item → now discoverable.
      const cat = await app.prisma.category.create({ data: { vendorId: v.id, name: 'Menu', sortOrder: 0 } });
      await app.prisma.item.create({ data: { vendorId: v.id, categoryId: cat.id, name: 'Thing', basePrice: 1000, isAvailable: true } });
      await app.redis.del('t:_notenant:home:guest:x:x');
      expect(inBody((await get('/api/v1/customer/vendors')).json())).toBe(true);
    } finally {
      await app.prisma.item.deleteMany({ where: { vendorId: v.id } });
      await app.prisma.category.deleteMany({ where: { vendorId: v.id } });
      await app.prisma.vendor.delete({ where: { id: v.id } });
      await app.prisma.vendorOwner.delete({ where: { id: owner.id } });
      await app.prisma.user.delete({ where: { id: user.id } });
      await app.redis.del('t:_notenant:home:guest:x:x');
    }
  });

  it('lets guests see the vendor list', async () => {
    expect((await get('/api/v1/customer/vendors')).statusCode).toBe(200);
  });
  it('lets guests open a vendor (menu)', async () => {
    expect((await get(`/api/v1/customer/vendors/${vendorId}`)).statusCode).toBe(200);
  });

  it('[F-028-07] a DEACTIVATED TENANT vanishes from every guest surface — list, home, and direct id', async () => {
    // A guest carries no tenant context, which the Prisma extension defines as
    // an UNSCOPED query — so before the relational predicate, a deactivated
    // operator's whole catalog kept serving here, and a guest who knew an id
    // could still pull the store's address and menu. Tenant deactivation is
    // the platform's kill switch; nothing of a dead tenant may serve.
    const dead = `dead-${nanoid(8).toLowerCase()}`;
    await app.prisma.tenant.create({ data: { id: dead, name: 'Dead operator', slug: dead, isActive: false } });
    const owner = await app.prisma.user.create({
      data: {
        phone: `+5926360${String(Math.floor(Math.random() * 9000) + 1000)}`,
        firstName: 'Dead', lastName: 'Owner', tenantId: dead,
        roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true,
      },
    });
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const v = await app.prisma.vendor.create({
      data: {
        tenantId: dead, ownerId: vo.id, name: 'Dead Tenant Store', slug: `dead-store-${nanoid(6).toLowerCase()}`,
        vendorType: 'RESTAURANT' as never, status: 'ACTIVE', isVerified: true,
        addressLine1: '1 Gone St', city: 'Georgetown', region: 'Demerara-Mahaica', phone: owner.phone,
        latitude: 6.8, longitude: -58.15,
      },
    });
    try {
      // Direct id — the sharpest edge: ACTIVE + verified vendor, dead tenant.
      expect((await get(`/api/v1/customer/vendors/${v.id}`)).statusCode).toBe(404);
      // And the enumerating surfaces never list it.
      const list = (await get('/api/v1/customer/vendors?limit=100')).json();
      expect((list.data as Array<{ id: string }>).some((row) => row.id === v.id)).toBe(false);
      const home = (await get('/api/v1/customer/home')).json();
      const homeVendors = [
        ...(home.data.openVendors ?? []), ...(home.data.closedVendors ?? []),
        ...(home.data.featured ?? []), ...(home.data.nearby ?? []),
      ] as Array<{ id: string }>;
      expect(homeVendors.some((row) => row.id === v.id)).toBe(false);
    } finally {
      await app.prisma.vendor.delete({ where: { id: v.id } });
      await app.prisma.vendorOwner.delete({ where: { id: vo.id } });
      await app.prisma.user.delete({ where: { id: owner.id } });
      await app.prisma.tenant.delete({ where: { id: dead } });
    }
  });
  it('treats suspended, banned, and deactivated browse tokens as guests', async () => {
    const nonce = nanoid(12);
    const user = await app.prisma.user.create({
      data: {
        phone: `+592${Date.now()}${Math.floor(Math.random() * 1000)}`,
        firstName: 'Disabled',
        lastName: 'Browser',
        roles: ['CUSTOMER'],
        activeRole: 'CUSTOMER',
        isPhoneVerified: true,
      },
    });
    const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nonce });

    try {
      await app.prisma.customer.create({
        data: { userId: user.id, favoriteVendors: { connect: { id: vendorId } } },
      });
      await app.prisma.session.create({
        data: {
          userId: user.id,
          token,
          refreshToken: `disabled-browser-${nonce}`,
          deviceId: `disabled-browser-${nonce}`,
          deviceType: 'test',
          expiresAt: new Date(Date.now() + 86_400_000),
        },
      });

      const whileActive = await app.inject({
        method: 'GET',
        url: `/api/v1/customer/vendors/${vendorId}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(whileActive.statusCode).toBe(200);
      expect(whileActive.json().data.isFavorite).toBe(true);

      for (const status of ['SUSPENDED', 'BANNED', 'DEACTIVATED'] as const) {
        await app.prisma.user.update({ where: { id: user.id }, data: { status } });
        const response = await app.inject({
          method: 'GET',
          url: `/api/v1/customer/vendors/${vendorId}`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        expect(response.json().data.isFavorite).toBe(false);
      }
    } finally {
      await app.prisma.session.deleteMany({ where: { userId: user.id } });
      await app.prisma.customer.deleteMany({ where: { userId: user.id } });
      await app.prisma.user.deleteMany({ where: { id: user.id } });
    }
  });
  it('lets guests read reviews', async () => {
    expect((await get(`/api/v1/customer/vendors/${vendorId}/reviews`)).statusCode).toBe(200);
  });

  it('still blocks the cart for guests (401)', async () => {
    expect((await get('/api/v1/customer/cart')).statusCode).toBe(401);
  });
  it('still blocks profile for guests (401)', async () => {
    expect((await get('/api/v1/customer/profile')).statusCode).toBe(401);
  });
  it('still blocks orders for guests (401)', async () => {
    expect((await get('/api/v1/customer/orders')).statusCode).toBe(401);
  });
  it('still blocks favouriting for guests (401)', async () => {
    const r = await app.inject({
      method: 'POST',
      url: `/api/v1/customer/favorites/${vendorId}`,
      headers: { 'content-type': 'application/json' },
      payload: '{}',
    });
    expect(r.statusCode).toBe(401);
  });
});
