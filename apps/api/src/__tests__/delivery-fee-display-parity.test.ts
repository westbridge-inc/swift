import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'fs';
import { join } from 'path';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { calculateDeliveryFee, deliveryFeeFromRates, mergeDeliveryRates } from '../utils/markup';
import { estimateDrivingDistance } from '../utils/distance';

// ---------------------------------------------------------------------------
// [FUL-003b completion] The fee a customer READS must be the fee they are
// CHARGED.
//
// FUL-003b moved the delivery fee to a per-country schedule and wired the cart
// preview and checkout to it — order.service.ts even says so: "The cart preview
// resolves the same schedule, so the fee shown and the fee charged never
// disagree." It did not wire the BROWSE surfaces. `enrichVendor` (every vendor
// card on home, browse and favourites) and the storefront header both kept
// calling `calculateDeliveryFee` with its hardcoded parameter defaults.
//
// The defaults ARE Georgetown's schedule, so the two agree in the launch market
// and diverge in the first market that sets its own rates — a fee that changes
// between the card and the cart. This forges exactly that market and pins the
// parity.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let token: string;
let vendorId: string;
const code = `QA${nanoid(4)}`.slice(0, 8).toUpperCase();
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];

// A schedule that is NOT the code default in any component.
const SECOND_MARKET = { baseFee: 900, perKmRate: 350, includedKm: 1, surgeMultiplier: 1.0 };

// Vendor and buyer coordinates, far enough apart that the two schedules give
// visibly different money.
const BUYER = { lat: 6.8013, lng: -58.1553 };
const VENDOR = { lat: 6.818, lng: -58.131 };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] =
    process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  // Deliberately no socketPlugin: these routes never emit, and its Redis
  // adapter readiness wait hangs an inject-only harness.
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  await app.prisma.countryConfig.create({
    data: {
      code,
      name: 'Parity Test Market',
      currencyCode: 'TST',
      usdExchangeRate: '1.0',
      subscriptionTiers: {},
      documentChecklists: {},
      deliveryRates: SECOND_MARKET,
    },
  });

  const user = await app.prisma.user.create({
    data: {
      phone: `+59200793${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Fee', lastName: 'Parity',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      countryCode: code,
      customer: { create: {} },
    },
  });
  createdUserIds.push(user.id);
  token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  // A signed JWT is not a signed-in user: authenticateOptional looks the raw
  // token up in `sessions` and silently falls back to GUEST on a miss.
  await app.prisma.session.create({
    data: {
      userId: user.id, token, refreshToken: nanoid(48),
      deviceId: `fee-${nanoid(6)}`, deviceType: 'test',
      expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const ownerUser = await app.prisma.user.create({
    data: {
      phone: `+59200793${String(Math.floor(Math.random() * 90) + 10)}9`,
      firstName: 'Fee', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER',
      isPhoneVerified: true, selfieCapturedAt: new Date(),
    },
  });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `feeparity ${nanoid(5)}`,
      slug: `feeparity-${nanoid(6).toLowerCase()}`,
      vendorType: 'RESTAURANT',
      phone: `+59200794${String(Math.floor(Math.random() * 90) + 10)}`,
      addressLine1: '1 Fee Row', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: VENDOR.lat, longitude: VENDOR.lng,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({
    data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 },
  });
  await app.prisma.item.create({
    data: { vendorId: vendor.id, categoryId: category.id, name: 'Parity dish', basePrice: 900, isAvailable: true },
  });
});

afterAll(async () => {
  await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.prisma.countryConfig.deleteMany({ where: { code } });
  await app.close();
});

const distanceKm = () => estimateDrivingDistance(BUYER.lat, BUYER.lng, VENDOR.lat, VENDOR.lng);

function get(url: string) {
  return app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
}

describe('the two schedules genuinely differ (or this test proves nothing)', () => {
  it('the forged market prices the same trip differently from the code defaults', () => {
    const km = distanceKm();
    const theirs = deliveryFeeFromRates(km, mergeDeliveryRates(SECOND_MARKET));
    const defaults = calculateDeliveryFee(km);
    expect(theirs).not.toBe(defaults);
  });
});

describe('a vendor CARD quotes the buyer’s own schedule', () => {
  it('browse returns the country fee, not the code default', async () => {
    const res = await get(`/api/v1/customer/vendors?lat=${BUYER.lat}&lng=${BUYER.lng}&limit=50`);
    expect(res.statusCode).toBe(200);
    const rows = res.json().data as Array<{ id: string; deliveryFee: number | null }>;
    const row = rows.find((r) => r.id === vendorId);
    expect(row, 'the seeded vendor should appear in browse').toBeTruthy();

    const km = distanceKm();
    expect(row!.deliveryFee).toBe(deliveryFeeFromRates(km, mergeDeliveryRates(SECOND_MARKET)));
    expect(row!.deliveryFee).not.toBe(calculateDeliveryFee(km));
  });
});

describe('the CARD and the STOREFRONT HEADER agree with each other', () => {
  it('quotes the same fee for the same vendor from both surfaces', async () => {
    // They used to disagree: the card priced from a distance rounded to 100 m,
    // the header from the exact one. Same vendor, same buyer, two fees — and at
    // this market's 350/km the rounding was worth real money.
    const [browse, detail] = await Promise.all([
      get(`/api/v1/customer/vendors?lat=${BUYER.lat}&lng=${BUYER.lng}&limit=50`),
      get(`/api/v1/customer/vendors/${vendorId}?lat=${BUYER.lat}&lng=${BUYER.lng}`),
    ]);
    const card = (browse.json().data as Array<{ id: string; deliveryFee: number | null }>)
      .find((r) => r.id === vendorId);
    expect(card!.deliveryFee).toBe(detail.json().data.deliveryFee);
  });
});

describe('the STOREFRONT HEADER quotes the same schedule', () => {
  it('vendor detail returns the country fee', async () => {
    // The fee a customer reads immediately before adding to the cart — of every
    // display site, the one most likely to be remembered and compared.
    const res = await get(`/api/v1/customer/vendors/${vendorId}?lat=${BUYER.lat}&lng=${BUYER.lng}`);
    expect(res.statusCode).toBe(200);
    const km = distanceKm();
    expect(res.json().data.deliveryFee).toBe(deliveryFeeFromRates(km, mergeDeliveryRates(SECOND_MARKET)));
  });
});

describe('no display path can quietly go back to the defaults', () => {
  const src = readFileSync(join(process.cwd(), 'src/modules/user/customer.routes.ts'), 'utf8');
  // Comments stripped: the explanation of this fix necessarily NAMES the banned
  // function, so scanning the raw file would fail on its own documentation.
  // (Standing hazard-matching rule — match declarations, not prose.)
  const code = src
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
    })
    .join('\n');

  it('customer.routes calls no default-parameter fee function', () => {
    expect(code).not.toMatch(/calculateDeliveryFee\s*\(/);
    // Guard the guard: the comments DO name it, so an empty strip would pass.
    expect(code).toContain('function enrichVendor');
    expect(src).toMatch(/calculateDeliveryFee/);
  });

  it('every display path resolves a schedule', () => {
    expect(code).toMatch(/getDeliveryRates\(/);
    expect(code).toMatch(/deliveryFeeFromRates\(/);
  });

  it('enrichVendor REQUIRES the schedule, so a new call site cannot forget it', () => {
    // Optional would make the omission silent and re-create the defect one
    // caller at a time. Required makes every construction site a build error —
    // the device the scheduled-cancel fix used for the same reason.
    expect(code).toMatch(/deliveryRates: DeliveryRates,\s*\n?\s*\)/);
  });
});
