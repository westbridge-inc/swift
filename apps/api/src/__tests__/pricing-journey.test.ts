import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { nanoid } from 'nanoid';
import { Prisma, type Order, type UserRole } from '@prisma/client';
import { beginRequestTenantContext, prismaPlugin, runWithoutTenant } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { ridesRoutes } from '../modules/rides/rides.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { cashMathForOffer } from '../modules/dispatch/dispatch.service';
import { renderReceiptHtml } from '../modules/order/receipt';
import { formatMoney } from '../utils/currency-amount';
import { desiredPlatformConfig } from '../modules/ops/platform-config';
import { recordDispatchQueue } from './helpers/dispatch-queue';
import { currentMoverDocuments } from './helpers/current-mover-documents';

// ---------------------------------------------------------------------------
// [PRICING phase 2 · owner, 13 Oct: "ensure the pricing — per km, base fee etc.
// — actually works and that's how it's charged, same for delivery"]
//
// ONE TABLE PER VERTICAL, the owner's own examples, each walked through the
// real routes on real rows:
//
//   the number on the QUOTE screen (rides estimate · cart quote · courier estimate)
//   = the number STORED on the ride / order (and the client's quoted number is
//     sent with the booking, so a price that moved is refused, never charged)
//   = the mover's OFFER (the offer card's cash triple; for taxi also the open
//     board and the recovered offer card)
//   = the RECEIPT total (rendered from the stored row, as the receipt route does)
//   = the mover's EARNING (taxi, walked to "Fare collected").
//
// Owner rulings (OWNER-DECISIONS 1 Oct ~21:10 / ~22:00, 8 Oct ~23:45):
//   Taxi      800 covers the first 3 km, then 175/km; no per-minute; minimum
//             800; rounded to the nearest 100. A trip to or from an airport
//             zone (CJIA, Ogle) pays 295/km after 3 km. Class multipliers
//             apply. No fixed fares; the server ignores any mover-sent fare.
//   Delivery  500 covers 3 km, then 100/km, surge 1.0 (rounded up to a whole
//             dollar); express ×1.5; pickup orders pay no delivery fee.
//   Courier   800 + 120/km + the size surcharge, × the speed; nearest dollar.
//
// Route distances are fixed per destination by a stand-in routing engine, so
// each row prices exactly the kilometres the owner named. Everything else —
// zones, rates, rounding, the routes and the rows — is the real code over the
// seeded Guyana configuration (asserted first, so a stale database fails loud).
// ---------------------------------------------------------------------------

const KM = vi.hoisted(() => new Map<string, number>());
vi.mock('../providers/maps/maps-provider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../providers/maps/maps-provider')>();
  const key = (p: { lat: number; lng: number }) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
  return {
    ...actual,
    getMapsProvider: () => {
      const base = actual.getMapsProvider();
      return Object.assign(Object.create(base) as object, {
        async routeKm(origin: { lat: number; lng: number }, dest: { lat: number; lng: number }) {
          const km = KM.get(key(dest));
          return km === undefined ? base.routeKm(origin, dest) : { km, minutes: null, source: 'haversine' as const };
        },
      });
    },
  };
});

type Point = { lat: number; lng: number };
type Actor = { userId: string; token: string; sessionId: string };

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+5923471';
const FIXTURE = 'pricing-journey';
const sys = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, FIXTURE);
const keyOf = (p: Point) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`;
/** A destination this suite's routing engine answers with exactly `km` from anywhere. */
function at(p: Point, km: number): Point {
  KM.set(keyOf(p), km);
  return p;
}

// Stabroek, in the Georgetown Central zone (no per-km of its own, no fixed fare).
const STABROEK = { lat: 6.8065, lng: -58.1625 };
// Destinations east of Ogle: outside every zone, so the market formula prices them.
const EAST = (i: number) => ({ lat: 6.79 - i * 0.001, lng: -58.05 });
// Inside the seeded airport zones (platform-config: cjia-airport, ogle-airport).
const CJIA = { lat: 6.5, lng: -58.25 };
const OGLE = { lat: 6.806, lng: -58.105 };

let app: FastifyInstance;
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole): Promise<Actor> {
  seq += 1;
  const user = await sys(() => app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(4, '0')}`, firstName: 'Journey', lastName: `U${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), trustLevel: 'L2',
      ...(roles.includes('CUSTOMER') ? { customer: { create: {} } } : {}),
    } as never,
  }));
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  const session = await sys(() => app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: `journey-${seq}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  }));
  return { userId: user.id, token, sessionId: session.id };
}

function call(method: 'GET' | 'POST' | 'PUT', url: string, token: string, payload?: unknown): Promise<LightMyRequestResponse> {
  return app.inject({
    method, url,
    headers: { authorization: `Bearer ${token}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}) },
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
  });
}

const row = (id: string) => sys(() => app.prisma.order.findUniqueOrThrow({ where: { id } }));
const money = (n: number) => formatMoney(n, 'GYD', { code: true, whole: true });

/** The receipt the customer is handed, rendered from the stored row exactly as
 *  GET /customer/orders/:id/receipt renders it once the order completes. */
function receiptOf(order: Order, items: Array<{ name: string; quantity: number; totalCustomer: unknown }> = []) {
  return renderReceiptHtml({ ...order, status: 'DELIVERED', vendor: null, customer: null, items } as never);
}
const receiptTotal = (html: string) => /<tr class="grand"><td>Total<\/td><td class="num">([^<]+)<\/td>/.exec(html)?.[1];
const receiptDeliveryPay = (html: string) => /Delivery pay for your rider<\/td><td class="num">([^<]+)<\/td>/.exec(html)?.[1] ?? null;

async function purge() {
  await sys(async () => {
    const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
    const ids = users.map((u) => u.id);
    if (ids.length === 0) return;
    const driverIds = (await app.prisma.driver.findMany({ where: { userId: { in: ids } }, select: { id: true } })).map((d) => d.id);
    const vendorOwners = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vendorOwners.map((v) => v.id);
    const orderIds = (await app.prisma.order.findMany({
      where: { OR: [{ customerId: { in: ids } }, { driverId: { in: driverIds } }, { vendor: { ownerId: { in: voIds } } }] },
      select: { id: true },
    })).map((o) => o.id);
    await app.prisma.alertDelivery.deleteMany({ where: { OR: [{ subjectId: { in: orderIds } }, { recipientId: { in: ids } }] } });
    await app.prisma.algoDecision.deleteMany({ where: { subjectId: { in: [...orderIds, ...driverIds] } } });
    await app.prisma.dispatchSearch.deleteMany({ where: { subjectId: { in: orderIds } } });
    if (orderIds.length > 0) await app.prisma.$executeRaw`DELETE FROM "notifications" WHERE "data"->>'orderId' IN (${Prisma.join(orderIds)})`;
    await app.prisma.notification.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.checkoutReceipt.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.item.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.category.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: voIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: voIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.driver.deleteMany({ where: { id: { in: driverIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
    for (const id of [...ids, ...driverIds, ...orderIds]) {
      const keys = [...await app.redis.keys(`dispatch:*${id}*`), ...await app.redis.keys(`*idem:${id}:*`)];
      if (keys.length > 0) await app.redis.del(...keys);
    }
  });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['FARE_ZONE_TABLE_KILL'];
  delete process.env['MAPS_PROVIDER'];
  delete process.env['OSRM_URL'];
  delete process.env['DISPATCH_AVAILABILITY'];
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  app.addHook('onRequest', async () => { beginRequestTenantContext(); });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  recordDispatchQueue(app, true);
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await purge();
});

afterAll(async () => {
  await purge();
  await app.close();
});

// ===========================================================================
describe('the database prices with the owner settings', () => {
  it('Guyana taxi rates and classes, no delivery or courier override, the airport zones at 295/km, no fixed fare on any of them', async () => {
    const spine = desiredPlatformConfig().countries.find((c) => c.code === 'GY')!.policy as Record<string, unknown>;
    const gy = await sys(() => app.prisma.countryConfig.findUniqueOrThrow({ where: { code: 'GY' } }));
    expect(gy.taxiRates, 'GY taxi rates — re-run the seed if this fails').toEqual(spine['taxiRates']);
    expect(gy.taxiRates).toEqual({ base: 800, includedKm: 3, perKm: 175, perMin: 0, minimum: 800 });
    expect(gy.taxiClassRates).toEqual(spine['taxiClassRates']);
    // Null means the code defaults: delivery 500/3 km/100, courier 800 + 120.
    expect([gy.deliveryRates, gy.courierRates]).toEqual([null, null]);
    const airports = await sys(() => app.prisma.zone.findMany({ where: { id: { in: ['cjia-airport', 'ogle-airport'] } }, select: { id: true, taxiPerKm: true, isActive: true } }));
    expect(airports.map((z) => [z.id, Number(z.taxiPerKm), z.isActive]).sort()).toEqual([['cjia-airport', 295, true], ['ogle-airport', 295, true]]);
    const airportFares = await sys(() => app.prisma.zoneFare.count({ where: { OR: [{ fromZoneId: { in: ['cjia-airport', 'ogle-airport'] } }, { toZoneId: { in: ['cjia-airport', 'ogle-airport'] } }] } }));
    expect(airportFares).toBe(0);
  });
});

// ===========================================================================
describe('taxi — quote = booked = driver offer = receipt = earning', () => {
  async function quoteFare(token: string, dropoff: Point, rideClass = 'ECONOMY') {
    const res = await call('POST', '/api/v1/rides/estimate', token, { pickup: STABROEK, dropoff });
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data as { tiers: { rideClass: string; fare: number; source: string }[]; billableKm: number };
    const tier = data.tiers.find((t) => t.rideClass === rideClass)!;
    return { fare: tier.fare, source: tier.source, billableKm: data.billableKm };
  }
  async function book(token: string, dropoff: Point, expectedFare: number, rideClass = 'ECONOMY') {
    const res = await call('POST', '/api/v1/rides/request', token, {
      pickup: STABROEK, dropoff, pickupAddress: 'Stabroek Market', dropoffAddress: 'Journey destination',
      passengerCount: 1, rideClass, expectedFare,
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json().data.ride as { id: string; fare: number; ridePin: string };
  }

  it('the whole journey at 10 km: quote 2,000 → booked 2,000 → board, offer card and cash triple 2,000 kept → "Fare collected" → earning 2,000 → receipt 2,000', async () => {
    const dropoff = at(EAST(0), 10);
    const driverUser = await makeUser(['MOVER', 'CUSTOMER'], 'MOVER');
    const driver = await sys(() => app.prisma.driver.create({
      data: {
        userId: driverUser.userId, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2019, vehicleColor: 'White',
        licensePlate: `HJ ${5000 + seq}`, driverLicenseUrl: 'storage://journey/dl.jpg', vehicleInsuranceUrl: 'storage://journey/ins.jpg',
        vehiclePhotoUrl: 'https://cdn.test/allion.jpg', documentsVerified: true,
        isOnline: true, isAvailable: true, locationSessionId: driverUser.sessionId,
        currentLat: STABROEK.lat, currentLng: STABROEK.lng, lastLocationUpdate: new Date(), averageRating: 4.9, acceptanceRate: 90,
      } as never,
    }));
    await sys(() => currentMoverDocuments(app.prisma, driverUser.userId, 'CAR', true));
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');

    const quoted = await quoteFare(customer.token, dropoff);
    expect(quoted).toEqual({ fare: 2000, source: 'formula', billableKm: 10 });
    const ride = await book(customer.token, dropoff, quoted.fare);
    expect(Number(ride.fare)).toBe(2000);
    const stored = await row(ride.id);
    expect([Number(stored.taxiFareTotal), Number(stored.subtotalCustomer), Number(stored.totalAmount), Number(stored.deliveryFee), Number(stored.billableKm)]).toEqual([2000, 2000, 2000, 0, 10]);

    // What the driver is shown: the open board, the offer card rebuilt from
    // the server, and its cash triple — collect the fare, no store, keep it all.
    const board = (await call('GET', '/api/v1/driver/rides/available', driverUser.token)).json().data as Array<{ id: string; fareTotal: number }>;
    expect(board.find((r) => r.id === ride.id)?.fareTotal).toBe(2000);
    const offer = (await call('GET', '/api/v1/driver/offers/current', driverUser.token)).json().data?.offer as { orderId: string; taxiFareTotal: number; cashMath: unknown } | null;
    expect(offer?.orderId).toBe(ride.id);
    expect(offer?.taxiFareTotal).toBe(2000);
    expect(offer?.cashMath).toEqual({ collectFromCustomer: 2000, payToVendor: 0, youKeep: 2000 });

    // The driver cannot set the price: a fare sent with the accept is ignored.
    expect((await call('POST', `/api/v1/driver/rides/${ride.id}/accept`, driverUser.token, { fare: 1 })).statusCode).toBe(200);
    for (const leg of ['en-route', 'arrived']) expect((await call('PUT', `/api/v1/driver/rides/${ride.id}/${leg}`, driverUser.token, {})).statusCode, leg).toBe(200);
    expect((await call('PUT', `/api/v1/driver/rides/${ride.id}/verify-pin`, driverUser.token, { pin: ride.ridePin })).statusCode).toBe(200);
    expect((await call('PUT', `/api/v1/driver/rides/${ride.id}/start`, driverUser.token, {})).statusCode).toBe(200);
    const paid = await call('POST', `/api/v1/driver/rides/${ride.id}/handover`, driverUser.token, { outcome: 'paid', gps: dropoff });
    expect(paid.statusCode, paid.body).toBe(200);

    const done = await row(ride.id);
    expect([done.status, done.paymentStatus, Number(done.taxiFareTotal), Number(done.totalAmount)]).toEqual(['DELIVERED', 'CAPTURED', 2000, 2000]);
    const earnings = await sys(() => app.prisma.earning.findMany({ where: { orderId: ride.id }, select: { type: true, amount: true, driverId: true } }));
    expect(earnings.map((e) => [e.type, Number(e.amount), e.driverId])).toEqual([['TAXI_FARE', 2000, driver.id]]);
    const receipt = await call('GET', `/api/v1/customer/orders/${ride.id}/receipt`, customer.token);
    expect(receipt.statusCode, receipt.body).toBe(200);
    expect(receiptTotal(receipt.body)).toBe(money(2000));
    await sys(() => app.prisma.driver.update({ where: { id: driver.id }, data: { isOnline: false, isAvailable: false } }));
  });

  // The owner's examples. Booked with the fare the quote showed; the offer card
  // and the receipt are read from the stored ride.
  it.each([
    ['up to 3 km pays the 800 base', 2.6, 'ECONOMY', 800],
    ['4 km', 4, 'ECONOMY', 1000],
    ['5 km (1,150 rounds up to 1,200)', 5, 'ECONOMY', 1200],
    ['7 km', 7, 'ECONOMY', 1500],
    ['10 km (2,025 rounds to 2,000)', 10, 'ECONOMY', 2000],
    ['20 km', 20, 'ECONOMY', 3800],
    ['10 km Comfort (×1.35)', 10, 'COMFORT', 2700],
  ] as const)('%s → %s', async (_label, km, rideClass, fare) => {
    const dropoff = at(EAST(Math.round(km * 10) + (rideClass === 'COMFORT' ? 500 : 0)), km);
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const quoted = await quoteFare(customer.token, dropoff, rideClass);
    expect(quoted.fare).toBe(fare);
    const ride = await book(customer.token, dropoff, quoted.fare, rideClass);
    const stored = await row(ride.id);
    expect([Number(ride.fare), Number(stored.taxiFareTotal), Number(stored.totalAmount)]).toEqual([fare, fare, fare]);
    expect(cashMathForOffer(stored)).toEqual({ collectFromCustomer: fare, payToVendor: 0, youKeep: fare });
    expect(receiptTotal(receiptOf(stored))).toBe(money(fare));
  });

  it.each([
    ['Georgetown → CJIA, 41 km at the airport rate (800 + 38 × 295 = 12,010)', CJIA, 41, 12000],
    ['Georgetown → Ogle, 9 km at the airport rate (800 + 6 × 295 = 2,570)', OGLE, 9, 2600],
  ] as const)('%s → %s', async (_label, airport, km, fare) => {
    const dropoff = at(airport, km);
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const quoted = await quoteFare(customer.token, dropoff);
    expect(quoted).toEqual({ fare, source: 'formula', billableKm: km });
    const ride = await book(customer.token, dropoff, quoted.fare);
    const stored = await row(ride.id);
    expect([Number(stored.taxiFareTotal), Number(stored.totalAmount)]).toEqual([fare, fare]);
    expect(cashMathForOffer(stored)).toEqual({ collectFromCustomer: fare, payToVendor: 0, youKeep: fare });
    expect(receiptTotal(receiptOf(stored))).toBe(money(fare));
  });

  it('a fare that moved after the quote is refused with the fare now, never charged', async () => {
    const dropoff = at(EAST(900), 7);
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    expect((await quoteFare(customer.token, dropoff)).fare).toBe(1500);
    KM.set(keyOf(dropoff), 10); // the road changed between the quote and the tap
    const res = await call('POST', '/api/v1/rides/request', customer.token, {
      pickup: STABROEK, dropoff, pickupAddress: 'Stabroek Market', dropoffAddress: 'Journey destination', passengerCount: 1, rideClass: 'ECONOMY', expectedFare: 1500,
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'FARE_CHANGED', details: { expectedFare: 1500, fare: 2000 } });
    expect(await sys(() => app.prisma.order.count({ where: { customerId: customer.userId } }))).toBe(0);
  });

  it.todo('waiting: 500 per FULL 10 minutes, summed over every wait, itemised on the receipt — NOT on main; built only in #1443 (behind TAXI_WAITING_CHARGE, conflicting)');
});

// ===========================================================================
describe('delivery — cart quote = order = rider offer = receipt', () => {
  const SHOP = { lat: 6.8073, lng: -58.1611 };
  let shop: { vendorId: string; itemId: string };

  beforeAll(async () => {
    const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    shop = await sys(async () => {
      const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
      const vendor = await app.prisma.vendor.create({
        data: {
          ownerId: vo.id, name: 'Journey Kitchen', slug: `journey-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT',
          phone: `${PHONE_PREFIX}9999`, addressLine1: '9 Water Street', city: 'Georgetown', region: 'Demerara-Mahaica',
          latitude: SHOP.lat, longitude: SHOP.lng, deliveryRadius: 25, minOrderAmount: 0,
          status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
        },
      });
      const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Menu', sortOrder: 0 } });
      const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Cook-up rice', basePrice: 1000 } });
      return { vendorId: vendor.id, itemId: item.id };
    });
  });

  async function shopperWithBasket(drop: Point) {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await sys(() => app.prisma.address.create({
      data: { userId: customer.userId, label: 'Home', addressLine1: '3 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: drop.lat, longitude: drop.lng, isDefault: true },
    }));
    const added = await call('POST', '/api/v1/customer/cart/items', customer.token, { vendorId: shop.vendorId, itemId: shop.itemId, quantity: 1 });
    expect([200, 201], added.body).toContain(added.statusCode);
    return customer;
  }

  // [km, express, fulfillment, the delivery fee the owner's rule gives]
  it.each([
    ['3 km pays the 500 base', 3, false, 'DELIVERY', 500],
    ['5 km', 5, false, 'DELIVERY', 700],
    ['10 km', 10, false, 'DELIVERY', 1200],
    ['4.37 km (637, a whole dollar)', 4.37, false, 'DELIVERY', 637],
    ['5 km express (×1.5)', 5, true, 'DELIVERY', 1050],
    ['pickup: no delivery fee, however far', 10, false, 'PICKUP', 0],
  ] as const)('%s → fee %s', async (_label, km, express, fulfillment, fee) => {
    const drop = at({ lat: 6.8095 + Math.round(km * 100) * 0.00001 + (express ? 0.0005 : 0) + (fulfillment === 'PICKUP' ? 0.001 : 0), lng: -58.159 }, km);
    const customer = await shopperWithBasket(drop);
    const qs = new URLSearchParams({ tipAmount: '0', fulfillmentSelections: JSON.stringify({ [shop.vendorId]: fulfillment }) });
    if (express) qs.set('express', 'true');
    const quoted = await call('GET', `/api/v1/customer/cart?${qs}`, customer.token);
    expect(quoted.statusCode, quoted.body).toBe(200);
    const q = quoted.json().data as { deliveryFee: number; totalAmount: number; subtotalCustomer: number };
    expect([q.subtotalCustomer, q.deliveryFee, q.totalAmount]).toEqual([1000, fee, 1000 + fee]);

    const placed = await call('POST', '/api/v1/customer/checkout', customer.token, {
      paymentMethod: 'CASH', tipAmount: 0, fulfillmentSelections: { [shop.vendorId]: fulfillment }, ...(express ? { express: true } : {}), expectedTotal: q.totalAmount,
    });
    expect([200, 201], placed.body).toContain(placed.statusCode);
    const [summary] = placed.json().data.orders as Array<{ id: string }>;
    const stored = await row(summary!.id);
    expect([stored.fulfillment, Number(stored.deliveryFee), Number(stored.totalAmount), Number(stored.tipAmount)]).toEqual([fulfillment, fee, 1000 + fee, 0]);
    if (fulfillment === 'DELIVERY') {
      expect(Number(stored.billableKm)).toBe(km);
      // The rider's card: collect the total, pay the store its goods, keep the fee.
      expect(cashMathForOffer(stored)).toEqual({ collectFromCustomer: 1000 + fee, payToVendor: 1000, youKeep: fee });
    }
    const receipt = receiptOf(stored, [{ name: 'Cook-up rice', quantity: 1, totalCustomer: 1000 }]);
    expect(receiptDeliveryPay(receipt)).toBe(fee > 0 ? money(fee) : null);
    expect(receiptTotal(receipt)).toBe(money(1000 + fee));
  });
});

// ===========================================================================
describe('courier — estimate = job = rider offer = receipt', () => {
  // [km, size, speed, fee] — round((800 + 120 × km + size) × speed)
  it.each([
    ['5 km small, standard', 5, 'SMALL', 'STANDARD', 1400],
    ['10 km medium (+500), standard', 10, 'MEDIUM', 'STANDARD', 2500],
    ['3 km large (+1,000), express ×1.5', 3, 'LARGE', 'EXPRESS', 3240],
    ['8 km extra large (+2,000), rush ×2', 8, 'EXTRA_LARGE', 'RUSH', 7520],
    ['2.37 km small (1,084.40 → 1,084)', 2.37, 'SMALL', 'STANDARD', 1084],
  ] as const)('%s → %s', async (_label, km, packageSize, speed, fee) => {
    const dropoff = at({ lat: 6.775 - Math.round(km * 100) * 0.00001, lng: -58.05 - (speed === 'STANDARD' ? 0 : 0.001) }, km);
    const sender = await makeUser(['CUSTOMER'], 'CUSTOMER');
    const est = await call('POST', '/api/v1/courier/estimate', sender.token, { pickup: STABROEK, dropoff, packageSize, speed });
    expect(est.statusCode, est.body).toBe(200);
    expect(est.json().data.totalFee).toBe(fee);
    const job = await call('POST', '/api/v1/courier/order', sender.token, {
      pickup: STABROEK, dropoff, pickupAddress: 'Stabroek Market', dropoffAddress: 'Journey parcel stop', packageSize, speed,
      recipientName: 'Aunty Pat', recipientPhone: '+5926001234', expectedFee: fee,
    });
    expect(job.statusCode, job.body).toBe(201);
    expect(job.json().data.fee).toBe(fee);
    const stored = await row(job.json().data.orderId);
    expect([Number(stored.deliveryFee), Number(stored.totalAmount), Number(stored.subtotalBase), Number(stored.billableKm)]).toEqual([fee, fee, 0, km]);
    expect(cashMathForOffer(stored)).toEqual({ collectFromCustomer: fee, payToVendor: 0, youKeep: fee });
    const receipt = receiptOf(stored);
    expect(receiptDeliveryPay(receipt)).toBe(money(fee));
    expect(receiptTotal(receipt)).toBe(money(fee));
  });
});
