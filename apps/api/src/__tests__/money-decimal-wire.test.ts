import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [S1] MONEY MUST LEAVE THE SERVER AS A NUMBER.
//
// Prisma `Decimal` is not a JS number — it serialises to a STRING ("1500.00").
// One backend feeds four clients (mobile, web, admin, Mission Control), so any
// route that returned RAW Prisma rows shipped money as a string to all four at
// once. Whether that broke was a property of the RENDER, not of the data:
// interpolation looked perfect, `.toFixed()` threw, and `a + b` produced
// "1500.00500.00" — which is how the web storefront started showing `$NaN`.
//
// These assertions are the thing that stops the NEXT raw-row route slipping
// through: every money field on every listed row, `typeof === 'number'`.
//
// Routes covered:
//   GET /api/v1/vendor/orders          — order totals + every line's snapshot
//   GET /api/v1/vendor/items           — basePrice + option additionalPrice
//   GET /api/v1/driver/rides/available — the fare the driver agrees to drive for
//   GET /api/v1/driver/rides           — fare / tip / total on ride history
//   GET /api/v1/driver/earnings        — the ROWS, not just the aggregate
//   GET /api/v1/driver/earnings/today  — same
//   GET /api/v1/rider/earnings         — the reference pattern, locked down
// ---------------------------------------------------------------------------

let app: FastifyInstance;

const userIds: string[] = [];
let vendorToken = '';
let driverToken = '';
let riderToken = '';
let vendorId = '';
let customerId = '';
let itemId = '';
let driverId = '';
let riderId = '';
let orderId = '';
let rideId = '';
let offerId = '';
const earningOrderIds: string[] = [];

/** Every `Decimal` money column on `model Order`. */
const ORDER_MONEY_FIELDS = [
  'subtotalBase', 'subtotalMarkup', 'subtotalCustomer',
  'deliveryFee', 'serviceFee', 'taxAmount', 'tipAmount', 'discount', 'totalAmount',
] as const;

/** Every `Decimal` money column on `model OrderItem`. */
const ORDER_ITEM_MONEY_FIELDS = [
  'basePrice', 'markedUpPrice', 'markupAmount',
  'totalBase', 'totalMarkup', 'totalCustomer',
] as const;

/** Asserts a number AND names the offender — a bare `typeof` failure on a
 *  13-field row tells you nothing about which column regressed. */
function expectNumbers(row: Record<string, unknown>, fields: readonly string[], where: string) {
  for (const field of fields) {
    expect(
      typeof row[field],
      `${where}.${field} must be a number on the wire, got ${JSON.stringify(row[field])}`,
    ).toBe('number');
  }
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.ready();

  // Phone pool: `+59205…` is used by no other test file (grepped) — the
  // unique-prefix rule exists because a shared pool birthday-flakes in CI.
  const phoneBase = 592_050_000_000 + Math.floor(Math.random() * 800_000);
  let pseq = 0;
  const nextPhone = () => `+${phoneBase + (pseq += 1)}`;

  async function signIn(userId: string, role: string) {
    const token = app.jwt.sign({ userId, role, jti: nanoid(8) });
    await app.prisma.session.create({
      data: {
        userId, token, refreshToken: nanoid(48), deviceId: 'mdw', deviceType: 'test',
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    return token;
  }

  // ── Vendor owner + store + menu ────────────────────────────────────────
  const owner = await app.prisma.user.create({
    data: {
      phone: nextPhone(), firstName: 'Wire', lastName: 'Owner',
      roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(owner.id);
  vendorToken = await signIn(owner.id, 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Wire Diner', slug: `wire-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920500000', addressLine1: '1 Wire St', city: 'Georgetown',
      region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  const category = await app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } });
  const item = await app.prisma.item.create({
    data: {
      vendorId, categoryId: category.id, name: 'Pepperpot', basePrice: 1800.5,
      isAvailable: true, dietaryTags: [], allergens: [],
      optionGroups: {
        create: [{
          name: 'Extras', isRequired: false, minSelect: 0, maxSelect: 2, sortOrder: 0,
          options: { create: [{ name: 'Extra bake', additionalPrice: 250.25, sortOrder: 0 }] },
        }],
      },
    },
  });
  itemId = item.id;

  // ── Customer + a store order with one priced line ──────────────────────
  const customer = await app.prisma.user.create({
    data: {
      phone: nextPhone(), firstName: 'Wire', lastName: 'Cust',
      roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(customer.id);
  customerId = customer.id;

  const order = await app.prisma.order.create({
    data: {
      orderNumber: `MDW-${nanoid(8)}`, orderType: 'FOOD_DELIVERY' as never, customerId, vendorId,
      status: 'DELIVERED' as never, fulfillment: 'DELIVERY' as never,
      deliveryAddress: '2 Wire St', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1800.5, subtotalMarkup: 0, subtotalCustomer: 1800.5,
      deliveryFee: 400, serviceFee: 25.75, taxAmount: 10.25, tipAmount: 100, discount: 50,
      totalAmount: 2286.5, paymentMethod: 'CASH' as never,
      items: {
        create: [{
          itemId, name: 'Pepperpot', quantity: 1,
          basePrice: 1800.5, markedUpPrice: 1800.5, markupAmount: 0,
          totalBase: 1800.5, totalMarkup: 0, totalCustomer: 1800.5,
        }],
      },
    },
  });
  orderId = order.id;

  // ── Driver + a completed ride + earnings ───────────────────────────────
  const driverUser = await app.prisma.user.create({
    data: {
      phone: nextPhone(), firstName: 'Wire', lastName: 'Driver',
      roles: ['DRIVER', 'CUSTOMER'] as UserRole[], activeRole: 'DRIVER', isPhoneVerified: true,
    },
  });
  userIds.push(driverUser.id);
  driverToken = await signIn(driverUser.id, 'DRIVER');
  const driver = await app.prisma.driver.create({
    data: {
      userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2021,
      vehicleColor: 'Silver', licensePlate: `MDW-${nanoid(4)}`, rideClass: 'ECONOMY',
      documentsVerified: true,
      driverLicenseUrl: 'storage://t/dl.jpg', vehicleInsuranceUrl: 'storage://t/ins.jpg',
    },
  });
  driverId = driver.id;

  const ride = await app.prisma.order.create({
    data: {
      orderNumber: `MDW-R-${nanoid(8)}`, orderType: 'TAXI' as never, customerId,
      driverId, status: 'DELIVERED' as never, fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'Stabroek', deliveryLat: 6.81, deliveryLng: -58.16,
      taxiPickupAddress: 'Kitty', taxiDropoffAddress: 'Stabroek',
      taxiFareBase: 500, taxiFarePerKm: 120.5, taxiFarePerMin: 15.25, taxiFareTotal: 1750.75,
      subtotalBase: 1750.75, subtotalMarkup: 0, subtotalCustomer: 1750.75,
      deliveryFee: 0, tipAmount: 200.5, totalAmount: 1951.25,
      paymentMethod: 'CASH' as never, deliveredAt: new Date(),
    },
  });
  rideId = ride.id;

  // A live, unclaimed request so the open board (/rides/available) has a row.
  // The board only runs for an online, available, located driver.
  await app.prisma.driver.update({
    where: { id: driverId },
    data: { isOnline: true, isAvailable: true, locationSessionId: `mdw-${nanoid(6)}`, currentLat: 6.8, currentLng: -58.15 },
  });
  const offer = await app.prisma.order.create({
    data: {
      orderNumber: `MDW-O-${nanoid(8)}`, orderType: 'TAXI' as never, customerId,
      status: 'PENDING' as never, fulfillment: 'DELIVERY' as never,
      deliveryAddress: 'Campbellville', deliveryLat: 6.82, deliveryLng: -58.14,
      taxiPickupAddress: 'Kitty', taxiDropoffAddress: 'Campbellville',
      pickupLat: 6.81, pickupLng: -58.15,
      taxiFareTotal: 1425.75,
      subtotalBase: 1425.75, subtotalMarkup: 0, subtotalCustomer: 1425.75,
      deliveryFee: 0, totalAmount: 1425.75,
      paymentMethod: 'CASH' as never, placedAt: new Date(),
    },
  });
  offerId = offer.id;

  const driverEarningOrderId = `mdw-d-${nanoid(8)}`;
  earningOrderIds.push(driverEarningOrderId);
  await app.prisma.earning.create({
    data: { driverId, orderId: driverEarningOrderId, type: 'TAXI_FARE' as never, amount: 1750.75, status: 'PENDING' as never },
  });

  // ── Rider (the route the fix was copied FROM — lock it down) ───────────
  const riderUser = await app.prisma.user.create({
    data: {
      phone: nextPhone(), firstName: 'Wire', lastName: 'Rider',
      roles: ['RIDER', 'CUSTOMER'] as UserRole[], activeRole: 'RIDER', isPhoneVerified: true,
    },
  });
  userIds.push(riderUser.id);
  riderToken = await signIn(riderUser.id, 'RIDER');
  const rider = await app.prisma.rider.create({
    data: { userId: riderUser.id, riderType: 'DELIVERY' as never, vehicleType: 'MOTORCYCLE' as never, documentsVerified: true },
  });
  riderId = rider.id;

  const riderEarningOrderId = `mdw-r-${nanoid(8)}`;
  earningOrderIds.push(riderEarningOrderId);
  await app.prisma.earning.create({
    data: { riderId, orderId: riderEarningOrderId, type: 'DELIVERY_FEE' as never, amount: 640.25, status: 'PENDING' as never },
  });
});

afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { OR: [{ driverId }, { riderId }] } });
  await app.prisma.orderItem.deleteMany({ where: { orderId } });
  await app.prisma.order.deleteMany({ where: { id: { in: [orderId, rideId, offerId] } } });
  await app.prisma.optionGroup.deleteMany({ where: { itemId } });
  await app.prisma.item.deleteMany({ where: { vendorId } });
  await app.prisma.category.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { id: driverId } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[S1] Prisma Decimal never reaches a client as a string', () => {
  it('GET /vendor/orders — order totals AND every line snapshot are numbers', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/orders',
      headers: { authorization: `Bearer ${vendorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>[] };
    const row = body.data.find((o) => o['id'] === orderId);
    expect(row, 'the seeded order must be on the board').toBeTruthy();

    expectNumbers(row!, ORDER_MONEY_FIELDS, 'order');
    // Values, not just types: a coercion that silently rounded or zeroed would
    // still be typeof number. `totalAmount` is the number someone agreed to pay.
    expect(row!['totalAmount']).toBe(2286.5);
    expect(row!['serviceFee']).toBe(25.75);

    const items = row!['items'] as Record<string, unknown>[];
    expect(items.length).toBe(1);
    expectNumbers(items[0]!, ORDER_ITEM_MONEY_FIELDS, 'order.items[0]');
    expect(items[0]!['totalCustomer']).toBe(1800.5);

    // LAW 1: a non-taxi order has no fare. Null stays null — never an
    // invented 0, which would read as "this ride was free".
    expect(row!['taxiFareTotal']).toBeNull();

    // LAW 8: coercing money re-builds the row, so prove nothing fell off it.
    expect(row!['orderNumber']).toBeTruthy();
    expect(row!['status']).toBe('DELIVERED');
    expect((row!['customer'] as { id: string }).id).toBe(customerId);
    expect((row!['vendor'] as { id: string }).id).toBe(vendorId);
    expect(items[0]!['name']).toBe('Pepperpot');
    expect(items[0]!['quantity']).toBe(1);
    // HND-003 still holds: the vendor board never carries handover secrets.
    expect(row!['pickupCode']).toBeUndefined();
    expect(row!['ridePin']).toBeUndefined();
  });

  it('GET /vendor/items — basePrice and every option additionalPrice are numbers', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/items',
      headers: { authorization: `Bearer ${vendorToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>[] };
    const row = body.data.find((i) => i['id'] === itemId);
    expect(row, 'the seeded item must be in the menu').toBeTruthy();

    expect(typeof row!['basePrice'], 'item.basePrice must be a number').toBe('number');
    expect(row!['basePrice']).toBe(1800.5);

    const groups = row!['optionGroups'] as { options: Record<string, unknown>[] }[];
    expect(groups.length).toBe(1);
    const option = groups[0]!.options[0]!;
    expect(typeof option['additionalPrice'], 'option.additionalPrice must be a number').toBe('number');
    expect(option['additionalPrice']).toBe(250.25);

    // LAW 8: the category join and the option-group shape must survive the map.
    expect((row!['category'] as { name: string }).name).toBe('Mains');
    expect(row!['name']).toBe('Pepperpot');
    expect(option['name']).toBe('Extra bake');
  });

  it('GET /driver/rides/available — the offered fare is a number, not a string', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/driver/rides/available',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>[] };
    const row = body.data.find((r) => r['id'] === offerId);
    expect(row, 'the seeded PENDING taxi request must be on the open board').toBeTruthy();

    // This is the number the driver accepts the job for. It left as "1425.75".
    expect(typeof row!['fareTotal'], 'offer.fareTotal must be a number').toBe('number');
    expect(row!['fareTotal']).toBe(1425.75);
  });

  it('GET /driver/rides — fare, tip and total are numbers on ride history', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/driver/rides',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>[] };
    const row = body.data.find((r) => r['id'] === rideId);
    expect(row, 'the seeded ride must be in history').toBeTruthy();

    expectNumbers(row!, ['taxiFareTotal', 'tipAmount', 'totalAmount'], 'ride');
    expect(row!['taxiFareTotal']).toBe(1750.75);
    expect(row!['tipAmount']).toBe(200.5);
    expect(row!['totalAmount']).toBe(1951.25);
  });

  it('GET /driver/earnings — the ROWS are numbers, not just the aggregate beside them', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/driver/earnings',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>[]; totalEarnings: unknown };
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(typeof row['amount'], 'earning.amount must be a number').toBe('number');
    }
    expect(body.data[0]!['amount']).toBe(1750.75);
    // The pair that used to disagree: total was a number, its own rows strings.
    expect(typeof body.totalEarnings).toBe('number');
  });

  it('GET /driver/earnings/today — same rows, same rule', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/driver/earnings/today',
      headers: { authorization: `Bearer ${driverToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: { earnings: Record<string, unknown>[]; total: unknown } };
    expect(body.data.earnings.length).toBeGreaterThan(0);
    for (const row of body.data.earnings) {
      expect(typeof row['amount'], 'earning.amount must be a number').toBe('number');
    }
    expect(typeof body.data.total).toBe('number');
  });

  it('GET /rider/earnings — the reference pattern stays correct', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/rider/earnings',
      headers: { authorization: `Bearer ${riderToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Record<string, unknown>[]; totalAmount: unknown };
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) {
      expect(typeof row['amount'], 'earning.amount must be a number').toBe('number');
    }
    expect(body.data[0]!['amount']).toBe(640.25);
    expect(typeof body.totalAmount).toBe('number');
  });
});
