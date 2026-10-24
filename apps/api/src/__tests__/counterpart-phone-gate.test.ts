/**
 * [O-1 · owner 22 Oct 2026] The census of counterpart PERSONAL phones on the
 * real routes, asserted on the SERIALIZED response body.
 *
 * A client that knows the Swift call bridge (it sends `x-swift-call-bridge`)
 * is never sent another person's personal number: not the driver's to the
 * passenger, not the passenger's to the driver, not the rider's to the
 * customer, the sender or the store, not the customer's to the rider or the
 * store. The store builds already installed (no header) keep receiving the
 * number they dial today until COUNTERPART_PHONES_TO_OLD_APPS=0 retires it.
 *
 * Three fields no build ever read are gone for EVERY client: the store's
 * account/OTP line and the parcel recipient's number on the rider's live
 * order, and (static, counterpart-phone-census.test.ts) the driver's phone on
 * the accept socket event and both phones on the cash-settlement ledger.
 *
 * Every party here has a REAL, distinct phone, so a leak shows as that string
 * in the body. Every number comes from testPhone() (the run-wide fictional
 * +59206nnnnn block no subscriber holds), so parallel files never collide.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { riderRoutes } from '../modules/rider/rider.routes';
import { driverRoutes } from '../modules/driver/driver.routes';
import { ridesRoutes } from '../modules/rides/rides.routes';
import courierRoutes from '../modules/courier/courier.routes';
import { runWithTenant, runWithoutTenant } from '../plugins/tenant-context';
import { grantSuiteCapability } from '../lib/test-target-lock';
import { testPhone } from './helpers/fixture-ids';

grantSuiteCapability('unscoped-mutation');

/** The wire marker, written out: the gate must answer to exactly this name. */
const BRIDGE = { 'x-swift-call-bridge': '1' };
const NUM = String(Date.now()).slice(-5);
const DAY = 86_400_000;
const PICKUP = { lat: 6.8021, lng: -58.1561 };
const system = <T>(fn: () => Promise<T>) => runWithoutTenant(fn, 'counterpart-phone-gate-test');

let app: FastifyInstance;
const users: string[] = [];
const orderIds: string[] = [];
const phones: Record<string, string> = {};

type Person = { id: string; token: string; phone: string };
async function person(n: number, roles: string[], active: string, extra: Record<string, unknown> = {}): Promise<Person> {
  const phone = testPhone();
  const u = await runWithTenant('swift-default', () => app.prisma.user.create({ data: {
    phone, firstName: 'Gate', lastName: `Party${n}`, roles: roles as never, activeRole: active as never,
    countryCode: 'GY', status: 'ACTIVE', isPhoneVerified: true, selfieCapturedAt: new Date(), tenantId: 'swift-default', ...extra,
  } as never }));
  users.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: active, jti: nanoid(8) });
  await system(() => app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), authMethod: 'OTP', deviceId: `cp-gate-${n}-${NUM}`, deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } }));
  return { id: u.id, token, phone };
}

const money = { subtotalBase: 3000, subtotalMarkup: 0, subtotalCustomer: 3000, deliveryFee: 500, tipAmount: 0, totalAmount: 3500, paymentMethod: 'CASH' };
async function order(data: Record<string, unknown>) {
  const o = await system(() => app.prisma.order.create({ data: {
    orderNumber: `CPG${NUM}${nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`,
    pickupAddress: 'Gate Pickup', pickupLat: PICKUP.lat, pickupLng: PICKUP.lng,
    deliveryAddress: '1 Gate St', deliveryLat: PICKUP.lat + 0.01, deliveryLng: PICKUP.lng + 0.01,
    ...money, ...data,
  } as never }));
  orderIds.push(o.id);
  return o;
}

const get = (url: string, token: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...headers } });

let passenger: Person, driverP: Person, diner: Person, riderP: Person, sender: Person, courierP: Person, owner: Person;
let driverId = '', riderId = '', courierRiderId = '', vendorId = '';
let rideId = '', foodId = '', parcelId = '';
const RECIPIENT = testPhone();
const STORE_ACCOUNT_LINE = testPhone();

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(riderRoutes, { prefix: '/api/v1/rider' });
  await app.register(driverRoutes, { prefix: '/api/v1/driver' });
  await app.register(ridesRoutes, { prefix: '/api/v1/rides' });
  await app.register(courierRoutes, { prefix: '/api/v1/courier' });
  await app.ready();

  passenger = await person(1, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  diner = await person(2, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  sender = await person(3, ['CUSTOMER'], 'CUSTOMER', { customer: { create: {} } });
  driverP = await person(4, ['MOVER', 'CUSTOMER'], 'MOVER');
  riderP = await person(5, ['RIDER', 'CUSTOMER'], 'RIDER');
  courierP = await person(6, ['RIDER', 'CUSTOMER'], 'RIDER');
  owner = await person(7, ['VENDOR_OWNER'], 'VENDOR_OWNER');
  Object.assign(phones, { passenger: passenger.phone, diner: diner.phone, sender: sender.phone, driver: driverP.phone, rider: riderP.phone, courier: courierP.phone });

  driverId = (await system(() => app.prisma.driver.create({ data: {
    userId: driverP.id, vehicleMake: 'Toyota', vehicleModel: 'Allion', vehicleYear: 2018, vehicleColor: 'Silver',
    licensePlate: `PGT ${NUM}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } }))).id;
  riderId = (await system(() => app.prisma.rider.create({ data: { userId: riderP.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  courierRiderId = (await system(() => app.prisma.rider.create({ data: { userId: courierP.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } }))).id;
  const vo = await runWithTenant('swift-default', () => app.prisma.vendorOwner.create({ data: { userId: owner.id, vendors: { create: {
    name: `Gate Diner ${NUM}`, slug: `gate-diner-${NUM}-${nanoid(4).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, vendorType: 'RESTAURANT',
    phone: STORE_ACCOUNT_LINE, addressLine1: '2 Gate St', city: 'Georgetown', region: 'Demerara-Mahaica',
    latitude: PICKUP.lat, longitude: PICKUP.lng, status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
  } } }, include: { vendors: true } }));
  vendorId = vo.vendors[0]!.id;

  rideId = (await order({ orderType: 'TAXI', customerId: passenger.id, driverId, status: 'DRIVER_EN_ROUTE', ridePin: '123456' })).id;
  await system(() => app.prisma.driver.update({ where: { id: driverId }, data: { currentRideId: rideId } }));
  foodId = (await order({ orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', customerId: diner.id, vendorId, riderId, status: 'PICKED_UP', acceptedAt: new Date() })).id;
  await system(() => app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: foodId } }));
  parcelId = (await order({ orderType: 'COURIER', customerId: sender.id, riderId: courierRiderId, status: 'PICKED_UP', courierRecipientPhone: RECIPIENT, acceptedAt: new Date() })).id;
  await system(() => app.prisma.rider.update({ where: { id: courierRiderId }, data: { currentOrderId: parcelId } }));
});

afterEach(() => { delete process.env['COUNTERPART_PHONES_TO_OLD_APPS']; });

afterAll(async () => {
  await system(async () => {
    await app.prisma.driver.updateMany({ where: { userId: { in: users } }, data: { currentRideId: null } });
    await app.prisma.rider.updateMany({ where: { userId: { in: users } }, data: { currentOrderId: null } });
    if (orderIds.length) {
      await app.prisma.orderStatusLog.deleteMany({ where: { orderId: { in: orderIds } } }).catch(() => undefined);
      await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    }
    await app.prisma.driver.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.rider.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.vendor.deleteMany({ where: { owner: { userId: { in: users } } } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.notification.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: users } } });
    await app.prisma.user.deleteMany({ where: { id: { in: users } } });
  });
  await app.close();
});

/** Each surface: who asks, and whose personal number it carries today. */
type Surface = { name: string; url: () => string; token: () => string; counterpart: () => string; headers?: () => Record<string, string> };
const vendorHeaders = () => ({ 'x-vendor-id': vendorId });
const SURFACES: Surface[] = [
  { name: 'GET /rides/active (passenger sees driver)', url: () => '/api/v1/rides/active', token: () => passenger.token, counterpart: () => phones['driver']! },
  { name: 'GET /driver/rides/active (driver sees passenger)', url: () => '/api/v1/driver/rides/active', token: () => driverP.token, counterpart: () => phones['passenger']! },
  { name: 'GET /customer/orders/:id (customer sees rider)', url: () => `/api/v1/customer/orders/${foodId}`, token: () => diner.token, counterpart: () => phones['rider']! },
  { name: 'GET /courier/order/:id (sender sees courier)', url: () => `/api/v1/courier/order/${parcelId}`, token: () => sender.token, counterpart: () => phones['courier']! },
  { name: 'GET /rider/orders/active (rider sees customer)', url: () => '/api/v1/rider/orders/active', token: () => riderP.token, counterpart: () => phones['diner']! },
  { name: 'GET /rider/orders/active-legs (rider sees customer)', url: () => '/api/v1/rider/orders/active-legs', token: () => riderP.token, counterpart: () => phones['diner']! },
  { name: 'GET /vendor/orders/:id (store sees customer)', url: () => `/api/v1/vendor/orders/${foodId}`, token: () => owner.token, counterpart: () => phones['diner']!, headers: vendorHeaders },
  { name: 'GET /vendor/orders/:id (store sees rider)', url: () => `/api/v1/vendor/orders/${foodId}`, token: () => owner.token, counterpart: () => phones['rider']!, headers: vendorHeaders },
  { name: 'GET /vendor/orders (store board sees rider)', url: () => '/api/v1/vendor/orders', token: () => owner.token, counterpart: () => phones['rider']!, headers: vendorHeaders },
];

describe('[O-1] a bridge-aware client is sent no counterpart personal phone', () => {
  for (const s of SURFACES) {
    it(`${s.name}: absent with the header`, async () => {
      const res = await get(s.url(), s.token(), { ...(s.headers?.() ?? {}), ...BRIDGE });
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.body.includes(s.counterpart()), `${s.name} sent the counterpart's number to a bridge-aware client`).toBe(false);
    });
  }
});

describe('[O-1 · builds 9-12] an installed store build keeps the number it dials today', () => {
  for (const s of SURFACES) {
    it(`${s.name}: present without the header`, async () => {
      const res = await get(s.url(), s.token(), s.headers?.() ?? {});
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.body.includes(s.counterpart()), `${s.name} stopped sending an old build its Call number`).toBe(true);
    });
  }
});

describe('[O-1 retirement] COUNTERPART_PHONES_TO_OLD_APPS=0: no client is sent one', () => {
  for (const s of SURFACES) {
    it(`${s.name}: absent without the header once retired`, async () => {
      process.env['COUNTERPART_PHONES_TO_OLD_APPS'] = '0';
      const res = await get(s.url(), s.token(), s.headers?.() ?? {});
      expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
      expect(res.body.includes(s.counterpart())).toBe(false);
    });
  }
});

describe('[O-1] fields no build reads are gone for every client', () => {
  for (const headers of [{}, BRIDGE]) {
    const who = Object.keys(headers).length ? 'bridge-aware' : 'old build';
    it(`the rider's live parcel carries no recipient number (${who})`, async () => {
      for (const url of ['/api/v1/rider/orders/active', '/api/v1/rider/orders/active-legs']) {
        const res = await get(url, courierP.token, headers);
        expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
        expect(res.body.includes(parcelId), `${url} did not return the parcel at all`).toBe(true);
        expect(res.body.includes(RECIPIENT), `${url} sent the recipient's number`).toBe(false);
        expect(res.body.includes('courierRecipientPhone'), `${url} still names the recipient field`).toBe(false);
      }
    });
    it(`the rider's live store order carries no store account line (${who})`, async () => {
      for (const url of ['/api/v1/rider/orders/active', '/api/v1/rider/orders/active-legs']) {
        const res = await get(url, riderP.token, headers);
        expect(res.statusCode, res.body.slice(0, 300)).toBe(200);
        expect(res.body.includes(foodId), `${url} did not return the order at all`).toBe(true);
        expect(res.body.includes(STORE_ACCOUNT_LINE), `${url} sent the store's account/OTP line`).toBe(false);
      }
    });
  }
});
