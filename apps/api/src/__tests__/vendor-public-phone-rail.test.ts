import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { homeCacheKey } from '../modules/user/home-cache';
import { VENDOR_CARD_PUBLIC_FIELDS } from '../utils/vendor-card';

// ---------------------------------------------------------------------------
// A store publishing a number a customer can call BEFORE ordering.
//
// The unit tests next door prove the validator. These prove the RAIL: that the
// number a vendor types on their dashboard is the number a customer is offered,
// that `Vendor.phone` never becomes that number by accident, and that the two
// states where Swift must not advertise a way to reach a store are honoured.
//
// The last point is the one worth a database: `phone` and `publicPhone` are two
// string columns one line apart on the same model, and the only thing keeping
// the account/OTP line out of a stranger's dialler is which one the projection
// names. That is a single-character mistake, so it gets a test that fails.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200644${String(seq).padStart(2, '0')}`,
      firstName: 'Call',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true,
      selfieCapturedAt: new Date(),
      avatar: '/uploads/avatars/call.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP',
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'call-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

/** ACCOUNT phone and PUBLISHED number are deliberately different here, so any
 *  test that sees the account phone reach a customer is seeing a real leak and
 *  not a coincidence of fixture data. */
const ACCOUNT_PHONE_PREFIX = '+59200645';

async function makeVendor(ownerUserId: string, name: string, status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_APPROVAL' | 'CLOSED' = 'ACTIVE') {
  seq += 1;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id,
      name, slug: `${name.toLowerCase().replace(/\s+/g, '-')}-${nanoid(6)}`,
      vendorType: 'RESTAURANT',
      phone: `${ACCOUNT_PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      addressLine1: '5 Regent Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status, acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  return { vendorId: vendor.id, accountPhone: vendor.phone };
}

/** VendorOwner.userId is @unique, so every store needs its own owner account. */
async function makeStore(name: string, status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_APPROVAL' | 'CLOSED') {
  const o = await makeUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
  return makeVendor(o.userId, name, status);
}

function inject(method: 'GET' | 'PUT', url: string, payload?: unknown, token?: string, vendorId?: string) {
  return app.inject({
    method,
    url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(vendorId ? { 'x-vendor-id': vendorId } : {}),
    },
  });
}

let owner: { userId: string; token: string };
let customer: { userId: string; token: string };
let shop: { vendorId: string; accountPhone: string };

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  shop = await makeVendor(owner.userId, 'Call Me Diner');
});

afterAll(async () => {
  if (createdVendorIds.length > 0) {
    await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  }
  if (createdUserIds.length > 0) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('a store publishes a number and a customer is offered it', () => {
  it('a landline typed on the dashboard reaches the customer, canonicalized', async () => {
    // A fixed GTT line, typed the way a shopkeeper types it.
    const put = await inject('PUT', '/api/v1/vendor/profile', { publicPhone: '+592 225 1234' }, owner.token, shop.vendorId);
    expect(put.statusCode).toBe(200);
    expect(put.json().data.publicPhone).toBe('+5922251234');

    const get = await inject('GET', `/api/v1/customer/vendors/${shop.vendorId}`, undefined, customer.token);
    expect(get.statusCode).toBe(200);
    expect(get.json().data.publicPhone).toBe('+5922251234');
  });

  it('the ACCOUNT phone is never what the customer receives', async () => {
    // The whole point of a second column. `phone` and `publicPhone` are one
    // line apart on the model and this is the mistake that would matter.
    const get = await inject('GET', `/api/v1/customer/vendors/${shop.vendorId}`, undefined, customer.token);
    const body = JSON.stringify(get.json());
    expect(body).not.toContain(shop.accountPhone);
    expect(get.json().data.phone).toBeUndefined();
  });

  it('a guest browsing the store is offered it too — asking before ordering is the point', async () => {
    // No token: a stranger deciding whether to order at all is exactly the
    // person this feature exists for.
    const get = await inject('GET', `/api/v1/customer/vendors/${shop.vendorId}`);
    expect(get.statusCode).toBe(200);
    expect(get.json().data.publicPhone).toBe('+5922251234');
    expect(JSON.stringify(get.json())).not.toContain(shop.accountPhone);
  });

  it('a store can take its number down again', async () => {
    // Opt-out must never require supplying a valid number first.
    const down = await inject('PUT', '/api/v1/vendor/profile', { publicPhone: '' }, owner.token, shop.vendorId);
    expect(down.statusCode).toBe(200);
    expect(down.json().data.publicPhone).toBeNull();

    const get = await inject('GET', `/api/v1/customer/vendors/${shop.vendorId}`, undefined, customer.token);
    expect(get.json().data.publicPhone).toBeNull();

    // Restore for the remaining cases.
    await inject('PUT', '/api/v1/vendor/profile', { publicPhone: '+5922251234' }, owner.token, shop.vendorId);
  });

  it('an unpublishable number is refused at the dashboard, not discovered by a caller', async () => {
    const bad = await inject('PUT', '/api/v1/vendor/profile', { publicPhone: '911' }, owner.token, shop.vendorId);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_PUBLIC_PHONE');

    // And the previously-good value is untouched by the failed write.
    const get = await inject('GET', `/api/v1/customer/vendors/${shop.vendorId}`, undefined, customer.token);
    expect(get.json().data.publicPhone).toBe('+5922251234');
  });
});

describe('the two states where Swift must not advertise a way to reach a store', () => {
  it('a SUSPENDED store keeps its number but stops being given out', async () => {
    // The store did not withdraw it — the PLATFORM suspended them. Swift must
    // not keep handing customers a line to a store it has just stopped.
    const suspended = await makeStore('Suspended Grill', 'SUSPENDED');
    await app.prisma.vendor.update({ where: { id: suspended.vendorId }, data: { publicPhone: '+5922255678' } });

    const get = await inject('GET', `/api/v1/customer/vendors/${suspended.vendorId}`, undefined, customer.token);
    expect(get.statusCode).toBe(200);
    expect(get.json().data.publicPhone).toBeNull();

    // Still on the row: this is withholding, not deletion. Reinstatement must
    // not cost the vendor their number.
    const row = await app.prisma.vendor.findUnique({ where: { id: suspended.vendorId }, select: { publicPhone: true } });
    expect(row?.publicPhone).toBe('+5922255678');
  });

  it('a store still awaiting approval is not given out either', async () => {
    // Nobody has checked this business exists yet.
    const pending = await makeStore('Pending Shop', 'PENDING_APPROVAL');
    await app.prisma.vendor.update({ where: { id: pending.vendorId }, data: { publicPhone: '+5922259999' } });

    const get = await inject('GET', `/api/v1/customer/vendors/${pending.vendorId}`, undefined, customer.token);
    expect(get.json().data.publicPhone).toBeNull();
  });

  it('a CLOSED store DOES keep its number — "when do you reopen?" is the call', async () => {
    // Deliberately not withheld. A closed store is closed by its own choice and
    // is exactly who a customer wants to ask about reopening.
    const closed = await makeStore('Closed Cafe', 'CLOSED');
    await app.prisma.vendor.update({ where: { id: closed.vendorId }, data: { publicPhone: '+5922254321' } });

    const get = await inject('GET', `/api/v1/customer/vendors/${closed.vendorId}`, undefined, customer.token);
    expect(get.json().data.publicPhone).toBe('+5922254321');
  });

  it('a row that was never valid degrades to no button, not to a wrong call', async () => {
    // Written by a migration, a script, or a hand-edit. The read boundary is
    // the last thing standing between it and a customer's dialler.
    const legacy = await makeStore('Legacy Store', 'ACTIVE');
    await app.prisma.vendor.update({ where: { id: legacy.vendorId }, data: { publicPhone: '911' } });

    const get = await inject('GET', `/api/v1/customer/vendors/${legacy.vendorId}`, undefined, customer.token);
    expect(get.json().data.publicPhone).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// [S1 response-shaping · High #6] Discovery used to hand the WHOLE Vendor row
// to the client — `phone` (the account/OTP line), `email`, `ownerId`, `qrSlug`
// and the staged MMG fields. The card is an allow-list now; these tests pin
// the exact wire keys so a new sensitive Vendor column fails by default.
// ---------------------------------------------------------------------------

describe('discovery publishes the public card, never the account row', () => {
  it('the anonymous directory and Home rails carry exactly the public card fields', async () => {
    await app.prisma.vendor.update({
      where: { id: shop.vendorId },
      data: { email: 'owner-email@example.test', publicPhone: '+5922251234', cuisineTypes: ['priv1-rail-test'] },
    });
    const category = await app.prisma.category.create({ data: { vendorId: shop.vendorId, name: 'Menu', sortOrder: 0 } });
    await app.prisma.item.create({
      data: { vendorId: shop.vendorId, categoryId: category.id, name: 'Call-me special', basePrice: 1000, isAvailable: true },
    });
    process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.mmg.gy';
    try {
      await app.prisma.vendor.update({
        where: { id: shop.vendorId },
        data: { mmgPayUrl: 'https://pay.mmg.gy/merchant/call-me-diner' },
      });

      const cardKeys = [
        ...VENDOR_CARD_PUBLIC_FIELDS,
        'distanceKm', 'etaMin', 'deliveryFee', 'isFavorite',
        'displayRating', 'ratingBucket', 'ratingCount', 'topRated',
      ].sort();

      const browse = await inject('GET', '/api/v1/customer/vendors?cuisine=priv1-rail-test&limit=50');
      expect(browse.statusCode).toBe(200);
      const card = browse.json().data.find((v: any) => v.id === shop.vendorId);
      expect(card, 'the seeded store should be in browse').toBeTruthy();
      expect(Object.keys(card).sort()).toEqual(cardKeys);
      expect(card.phone).toBeUndefined();
      expect(card.email).toBeUndefined();
      expect(card.publicPhone).toBe('+5922251234');
      expect(card.mmgPayUrl).toBe('https://pay.mmg.gy/merchant/call-me-diner');
      expect(JSON.stringify(browse.json())).not.toContain(shop.accountPhone);
      expect(JSON.stringify(browse.json())).not.toContain('owner-email@example.test');

      await app.redis.del(homeCacheKey(undefined, undefined, undefined));
      const home = await inject('GET', '/api/v1/customer/home');
      expect(home.statusCode).toBe(200);
      const homeCard = home.json().data.openVendors.find((v: any) => v.id === shop.vendorId);
      expect(homeCard, 'the seeded store should be on a Home rail').toBeTruthy();
      expect(Object.keys(homeCard).sort()).toEqual([...cardKeys, 'categories'].sort());
      expect(homeCard.phone).toBeUndefined();
      expect(homeCard.email).toBeUndefined();
      expect(homeCard.publicPhone).toBe('+5922251234');
      expect(JSON.stringify(home.json())).not.toContain(shop.accountPhone);
      expect(JSON.stringify(home.json())).not.toContain('owner-email@example.test');

      // The RIGHT party keeps the account contact: the owner's own dashboard
      // still reads the operational phone and email the store registered.
      const profile = await inject('GET', '/api/v1/vendor/profile', undefined, owner.token, shop.vendorId);
      expect(profile.statusCode).toBe(200);
      const own = profile.json().data.vendors.find((v: any) => v.id === shop.vendorId);
      expect(own.phone).toBe(shop.accountPhone);
      expect(own.email).toBe('owner-email@example.test');
    } finally {
      delete process.env['MMG_PAY_URL_ALLOWED_HOSTS'];
      await app.prisma.vendor.update({
        where: { id: shop.vendorId },
        data: { email: null, mmgPayUrl: null },
      });
    }
  });

  it('a customer\'s favourites are the same card', async () => {
    await app.prisma.vendor.update({
      where: { id: shop.vendorId },
      data: { publicPhone: '+5922251234' },
    });
    await app.prisma.customer.update({
      where: { userId: customer.userId },
      data: { favoriteVendors: { connect: { id: shop.vendorId } } },
    });
    try {
      const fav = await inject('GET', '/api/v1/customer/favorites', undefined, customer.token);
      expect(fav.statusCode).toBe(200);
      const card = fav.json().data.find((v: any) => v.id === shop.vendorId);
      expect(card, 'the favourite should be in the list').toBeTruthy();
      // Favourites carry the card + the distance/eta/fee enrichments +
      // isFavorite (this surface has no rating spread today).
      expect(Object.keys(card).sort()).toEqual(
        [...VENDOR_CARD_PUBLIC_FIELDS, 'distanceKm', 'etaMin', 'deliveryFee', 'isFavorite'].sort(),
      );
      expect(card.phone).toBeUndefined();
      expect(card.email).toBeUndefined();
      expect(card.publicPhone).toBe('+5922251234');
      expect(JSON.stringify(fav.json())).not.toContain(shop.accountPhone);
    } finally {
      await app.prisma.customer.update({
        where: { userId: customer.userId },
        data: { favoriteVendors: { disconnect: { id: shop.vendorId } } },
      });
    }
  });

  it('a feed cached before the deploy is never served: the discovery key is versioned past the leak', async () => {
    // The guest feed was cached WITH the whole row for up to HOME_CACHE_TTL.
    // A rolling deploy must not serve that entry for even one minute, so the
    // key version moved and the old entry is simply never read again. Poison
    // the previous version's key with a card carrying the account phone and
    // prove Home does not pick it up. On the old code the two keys are the
    // same key, and the poisoned card comes straight back.
    const liveKey = homeCacheKey(undefined, undefined, undefined);
    const legacyKey = liveKey.replace(/:discovery:v\d+:/, ':discovery:v2:');
    const poisoned = {
      vendors: [{
        id: shop.vendorId, name: 'Call Me Diner', vendorType: 'RESTAURANT',
        latitude: 6.801, longitude: -58.156, averageRating: 5, totalOrders: 0,
        isCurrentlyOpen: true, acceptingOrders: true, isFavorite: false,
        distanceKm: null, etaMin: null, deliveryFee: null,
        displayRating: null, ratingBucket: 'NEW', ratingCount: 0, topRated: false,
        categories: [],
        phone: shop.accountPhone, email: 'owner-email@example.test',
      }],
      popularItems: [],
      categories: [],
    };
    await app.redis.del(liveKey);
    await app.redis.set(legacyKey, JSON.stringify(poisoned), 'EX', 120);
    try {
      const home = await inject('GET', '/api/v1/customer/home');
      expect(home.statusCode).toBe(200);
      // The route must be reading the key this test reasons about, or a key
      // mismatch would pass it vacuously: after the request the live key holds
      // the feed the route just built.
      expect(await app.redis.get(liveKey), 'Home should have written the live discovery key').not.toBeNull();
      expect(JSON.stringify(home.json())).not.toContain(shop.accountPhone);
      expect(JSON.stringify(home.json())).not.toContain('owner-email@example.test');
      const card = home.json().data.openVendors.find((v: any) => v.id === shop.vendorId);
      expect(card, 'the seeded store should be on a Home rail').toBeTruthy();
      expect(card.phone).toBeUndefined();
    } finally {
      await app.redis.del(legacyKey, liveKey);
    }
  });

  it("a customer's order detail names the store but never its account phone", async () => {
    // Same class as the card leak, on the one surface every customer keeps:
    // the order detail selected `vendor.phone` — the account/OTP line — and
    // returned it on every order, for good. The vendor block is an allow-list.
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `SW-RAIL-${nanoid(8).toUpperCase()}`,
        orderType: 'FOOD_DELIVERY',
        vendorId: shop.vendorId,
        customerId: customer.userId,
        status: 'PENDING',
        deliveryAddress: '5 Buyer Street, Georgetown',
        deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
        deliveryFee: 500, totalAmount: 1500,
        paymentMethod: 'CASH',
      },
    });
    try {
      const res = await inject('GET', `/api/v1/customer/orders/${order.id}`, undefined, customer.token);
      expect(res.statusCode).toBe(200);
      const vendor = res.json().data.vendor;
      expect(vendor.name).toBe('Call Me Diner');
      expect(Object.keys(vendor).sort()).toEqual(
        ['coverImageUrl', 'id', 'latitude', 'logoUrl', 'longitude', 'name', 'slug', 'vendorType'],
      );
      expect(vendor.phone).toBeUndefined();
      expect(JSON.stringify(res.json())).not.toContain(shop.accountPhone);
    } finally {
      await app.prisma.order.delete({ where: { id: order.id } });
    }
  });
});
