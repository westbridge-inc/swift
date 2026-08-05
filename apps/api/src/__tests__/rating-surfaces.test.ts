import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { surfaceOf, NEW_ACTOR_SURFACE } from '../modules/rating/rating-surface';

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

describe('the surface mapper (pure)', () => {
  it('maps display, bucket and the volume-gated Top-rated badge', () => {
    // Under min-display: null display, exact small bucket.
    expect(surfaceOf({ subjectId: 'x', displayRating: null, lifetimeCount: 3, standing: 'NEW' }, 'VENDOR'))
      .toEqual({ displayRating: null, ratingBucket: '(3)', ratingCount: 3, topRated: false });
    // Buckets: exact under 10, tens to 999, thousands with the comma.
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.7, lifetimeCount: 7, standing: 'GOOD' }, 'VENDOR').ratingBucket).toBe('(7)');
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.7, lifetimeCount: 47, standing: 'GOOD' }, 'VENDOR').ratingBucket).toBe('(40+)');
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.7, lifetimeCount: 5_200, standing: 'GOOD' }, 'VENDOR').ratingBucket).toBe('(5,000+)');
    // Vendors need EXCELLENT + volume for the badge…
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.9, lifetimeCount: 49, standing: 'EXCELLENT' }, 'VENDOR').topRated).toBe(false);
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.9, lifetimeCount: 50, standing: 'EXCELLENT' }, 'VENDOR').topRated).toBe(true);
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.6, lifetimeCount: 500, standing: 'GOOD' }, 'VENDOR').topRated).toBe(false);
    // …people need only the band (no volume gate).
    expect(surfaceOf({ subjectId: 'x', displayRating: 4.9, lifetimeCount: 25, standing: 'EXCELLENT' }, 'RIDER').topRated).toBe(true);
    // Prisma Decimal arrives as an object — Number() coercion is pinned.
    expect(surfaceOf({ subjectId: 'x', displayRating: '4.3', lifetimeCount: 12, standing: 'GOOD' }, 'VENDOR').displayRating).toBe(4.3);
    // The NEW face is the frozen default.
    expect(NEW_ACTOR_SURFACE).toEqual({ displayRating: null, ratingBucket: '(0)', ratingCount: 0, topRated: false });
  });
});

describe('browse + storefront surfaces (R8)', () => {
  it('every card carries the star fields; Top rated sorts by Bayesian display with unrated stores last', async () => {
    const { token } = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const good = await makeVendor('Surf Good', { display: 4.4, count: 60, standing: 'GOOD' });
    const best = await makeVendor('Surf Best', { display: 4.9, count: 80, standing: 'EXCELLENT' });
    const fresh = await makeVendor('Surf Fresh');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/vendors?cuisine=${CUISINE}&sort=top_rated&limit=50`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; displayRating: number | null; ratingBucket: string; topRated: boolean }>;
    const ids = rows.map((r) => r.id);
    expect(ids).toEqual([best.id, good.id, fresh.id]);

    const bestRow = rows[0]!;
    expect(bestRow.displayRating).toBe(4.9);
    expect(bestRow.ratingBucket).toBe('(80+)');
    expect(bestRow.topRated).toBe(true);
    const freshRow = rows[2]!;
    expect(freshRow.displayRating).toBeNull();
    expect(freshRow.ratingBucket).toBe('(0)');
    expect(freshRow.topRated).toBe(false);

    // Default sort carries the same fields (the star line is on EVERY card).
    const plain = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/vendors?cuisine=${CUISINE}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const plainRows = plain.json().data as Array<{ id: string; ratingBucket?: string }>;
    expect(plainRows.every((r) => typeof r.ratingBucket === 'string')).toBe(true);

    // Storefront header reads the same mapper.
    const store = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/vendors/${best.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    const data = store.json().data as { displayRating: number; ratingBucket: string; topRated: boolean };
    expect(data.displayRating).toBe(4.9);
    expect(data.ratingBucket).toBe('(80+)');
    expect(data.topRated).toBe(true);
  });

  it('the home feed rails carry the star fields too (RAT-I: EVERY card context — the sim pass caught these missing)', async () => {
    const { token } = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const starred = await makeVendor('Surf Home', { display: 4.8, count: 60, standing: 'EXCELLENT' });
    // Own cuisine tag: the browse tests filter by CUISINE and assert exact
    // order — this vendor belongs to the home-feed law only.
    await app.prisma.vendor.update({
      where: { id: starred.id },
      data: { isCurrentlyOpen: true, acceptingOrders: true, cuisineTypes: [`${CUISINE}-home`] },
    });
    const res = await app.inject({
      method: 'GET', url: '/api/v1/customer/home',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const open = res.json().data.openVendors as Array<{ id: string; displayRating: number | null; ratingBucket: string; topRated: boolean }>;
    const row = open.find((v) => v.id === starred.id);
    expect(row).toBeDefined();
    expect(row!.displayRating).toBe(4.8);
    expect(row!.ratingBucket).toBe('(60+)');
    expect(row!.topRated).toBe(true);
  });

  it('pagination math stays global for top_rated (page 2 continues the order)', async () => {
    const { token } = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const p1 = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/vendors?cuisine=${CUISINE}&sort=top_rated&limit=2&page=1`,
      headers: { authorization: `Bearer ${token}` },
    });
    const p2 = await app.inject({
      method: 'GET',
      url: `/api/v1/customer/vendors?cuisine=${CUISINE}&sort=top_rated&limit=2&page=2`,
      headers: { authorization: `Bearer ${token}` },
    });
    const page1 = p1.json();
    const names1 = (page1.data as Array<{ name: string }>).map((v) => v.name);
    const names2 = (p2.json().data as Array<{ name: string }>).map((v) => v.name);
    expect(names1).toEqual(['Surf Best', 'Surf Good']);
    expect(names2).toEqual(['Surf Fresh']);
    expect(page1.meta.total).toBe(3);
  });
});
