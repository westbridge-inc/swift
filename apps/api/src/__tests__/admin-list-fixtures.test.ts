import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { assertNameNotReserved } from '../lib/fixture-filter';
import { loginWithOtp } from './helpers/otp';
import { purgeSensitiveReadLogs } from '../lib/audit-immutability';

// ---------------------------------------------------------------------------
// [MISSION CONTROL · PR-3] "Hide test data" is a server filter the console
// turns on by default.
//
// The journey suite's +5920 people and their stores live in staging's real
// tenant and were listed as real. Every admin list leaves them out when asked
// (`excludeFixtures=true`, which the console sends unless "Show test data" is
// ticked), in the query itself, so the pager's total counts only what is shown
// — and says how many it left out. With no parameter the API lists every row,
// as it always has, so no other caller changes behaviour.
//
// [security review] A fixture is keyed ONLY on the phone, a server-controlled
// fact. A real account or store NAMED "TEST-…" must stay visible (a name is
// something a user types, and could be used to hide from oversight), and the
// prefix itself is reserved for fixture accounts at the API boundary.
// Each list is searched by this run's marker so the assertions see only this
// file's rows.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const RUN = nanoid(6).replace(/[^a-zA-Z0-9]/g, 'x');
const DIGITS = String(Date.now()).slice(-4);
const userIds: string[] = [];
const vendorIds: string[] = [];
const orderIds: string[] = [];
let seq = 0;

const get = (url: string) => app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${adminToken}` } });

async function person(kind: 'real' | 'fixturePhone' | 'testName') {
  seq += 1;
  const phone = kind === 'fixturePhone' ? `+5920${DIGITS}${String(seq).padStart(2, '0')}` : `+59263${DIGITS}${String(seq).padStart(2, '0')}`;
  const user = await app.prisma.user.create({
    data: {
      phone, firstName: kind === 'testName' ? `TEST-Person${seq}` : `Real${seq}`, lastName: `List${RUN}`,
      roles: ['VENDOR_OWNER', 'MOVER', 'CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never, isPhoneVerified: true, countryCode: 'GY',
    },
  });
  userIds.push(user.id);
  return user;
}

async function store(ownerUserId: string, name: string) {
  seq += 1;
  const owner = await app.prisma.vendorOwner.upsert({ where: { userId: ownerUserId }, update: {}, create: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id, name, slug: `list-${RUN.toLowerCase()}-${seq}`, vendorType: 'RESTAURANT', phone: `+59262${DIGITS}${String(seq).padStart(2, '0')}`,
      addressLine1: '1 List Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true, acceptingOrders: true,
    },
  });
  vendorIds.push(vendor.id);
  return vendor;
}

async function order(customerId: string, vendorId: string) {
  const o = await app.prisma.order.create({
    data: {
      orderNumber: `LIST-${RUN}-${nanoid(5)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: 'DELIVERED',
      deliveryAddress: `${RUN} Delivery Lane`, deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    },
  });
  orderIds.push(o.id);
  return o;
}

let real: { id: string };
let fixturePhone: { id: string };
let testName: { id: string };
let realStore: { id: string };
let testStore: { id: string };
let fixtureOwnerStore: { id: string };
let realOrder: { id: string };
let fixtureOrder: { id: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken;

  real = await person('real');
  fixturePhone = await person('fixturePhone');
  testName = await person('testName');
  realStore = await store(real.id, `Real Kitchen ${RUN}`);
  testStore = await store(real.id, `TEST-Kitchen ${RUN}`);
  fixtureOwnerStore = await store(fixturePhone.id, `Plain Name ${RUN}`);
  for (const [u, kind] of [[real, 'r'], [fixturePhone, 'f'], [testName, 't']] as const) {
    await app.prisma.rider.create({ data: { userId: u.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: false } });
    await app.prisma.driver.create({ data: { userId: u.id, vehicleType: 'CAR', documentsVerified: false, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleYear: 2020, vehicleColor: 'Silver', licensePlate: `L${RUN}${kind}`, driverLicenseUrl: 'test/l', vehicleInsuranceUrl: 'test/i' } });
  }
  realOrder = await order(real.id, realStore.id);
  fixtureOrder = await order(fixturePhone.id, realStore.id);
  await order(real.id, testStore.id);
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } }).catch(() => {});
  await app.prisma.rider.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.driver.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await purgeSensitiveReadLogs(app.prisma, { action: { in: ['GET /users', 'GET /riders', 'GET /drivers', 'GET /orders'] }, at: { gte: new Date(Date.now() - 3_600_000) } }, 'test-cleanup:admin-list-fixtures').catch(() => 0);
  await app.close();
});

const ids = (res: { json: () => { data: Array<{ id: string }> } }) => res.json().data.map((r) => r.id).sort();

describe('[MC-PR3] test data is left out of every admin list when the console asks — keyed on the phone only', () => {
  it('people: a +5920 phone is hidden and counted; a real account NAMED "TEST-…" stays visible', async () => {
    const shown = await get(`/api/v1/admin/users?search=List${RUN}&excludeFixtures=true`);
    expect(shown.statusCode).toBe(200);
    expect(ids(shown)).toEqual([real.id, testName.id].sort());
    expect(shown.json().meta).toMatchObject({ total: 2, hiddenTestRecords: 1 });
    const all = await get(`/api/v1/admin/users?search=List${RUN}&excludeFixtures=false`);
    expect(ids(all)).toEqual([real.id, fixturePhone.id, testName.id].sort());
    expect(all.json().meta).toMatchObject({ total: 3, hiddenTestRecords: 0 });
  });

  it('stores: a fixture owner hides the store; a store of a real owner NAMED "TEST-…" stays visible', async () => {
    const shown = await get(`/api/v1/admin/vendors?search=${RUN}&excludeFixtures=true`);
    expect(ids(shown)).toEqual([realStore.id, testStore.id].sort());
    expect(shown.json().meta.hiddenTestRecords).toBe(1);
    expect(ids(await get(`/api/v1/admin/vendors?search=${RUN}&excludeFixtures=false`))).toEqual([realStore.id, testStore.id, fixtureOwnerStore.id].sort());
  });

  it('riders and drivers: only a +5920 person is a fixture mover', async () => {
    const riders = (await get(`/api/v1/admin/riders?search=List${RUN}&excludeFixtures=true`)).json();
    expect(riders.data.map((r: { userId: string }) => r.userId).sort()).toEqual([real.id, testName.id].sort());
    expect(riders.meta.hiddenTestRecords).toBe(1);
    const drivers = (await get(`/api/v1/admin/drivers?search=List${RUN}&excludeFixtures=false`)).json().data.map((r: { userId: string }) => r.userId).sort();
    expect(drivers).toEqual([real.id, fixturePhone.id, testName.id].sort());
    expect((await get(`/api/v1/admin/drivers?search=List${RUN}&excludeFixtures=true`)).json().meta).toMatchObject({ total: 2, hiddenTestRecords: 1 });
  });

  it('orders: an order a fixture placed is left out and counted; one at a real store named "TEST-…" stays', async () => {
    const shown = await get(`/api/v1/admin/orders?search=LIST-${RUN}&excludeFixtures=true`);
    expect(shown.json().data.map((o: { id: string }) => o.id)).not.toContain(fixtureOrder.id);
    expect(shown.json().data.map((o: { id: string }) => o.id)).toContain(realOrder.id);
    expect(shown.json().meta).toMatchObject({ total: 2, hiddenTestRecords: 1 });
    const all = await get(`/api/v1/admin/orders?search=LIST-${RUN}&excludeFixtures=false`);
    expect(all.json().meta.total).toBe(3);
  });

  it('with no parameter every list shows every row, as before — the console asks to hide; other callers are unchanged', async () => {
    const users = await get(`/api/v1/admin/users?search=List${RUN}`);
    expect(ids(users)).toEqual([real.id, fixturePhone.id, testName.id].sort());
    expect(users.json().meta).toMatchObject({ total: 3, hiddenTestRecords: 0 });
    expect(ids(await get(`/api/v1/admin/vendors?search=${RUN}`))).toEqual([realStore.id, testStore.id, fixtureOwnerStore.id].sort());
    expect((await get(`/api/v1/admin/riders?search=List${RUN}`)).json().meta).toMatchObject({ total: 3, hiddenTestRecords: 0 });
    expect((await get(`/api/v1/admin/drivers?search=List${RUN}`)).json().meta).toMatchObject({ total: 3, hiddenTestRecords: 0 });
    const orders = await get(`/api/v1/admin/orders?search=LIST-${RUN}`);
    expect(orders.json().data.map((o: { id: string }) => o.id)).toContain(fixtureOrder.id);
    expect(orders.json().meta).toMatchObject({ total: 3, hiddenTestRecords: 0 });
  });

  it('anything other than true/false is refused, not guessed', async () => {
    expect((await get('/api/v1/admin/users?excludeFixtures=maybe')).statusCode).toBe(400);
  });
});

describe('[MC-PR3 · security review] "TEST-" names are reserved for test accounts (+5920…) at the API boundary', () => {
  it('signup refuses a "TEST-" first name for a real number with 400 RESERVED_NAME — before any signup proof is spent', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { phone: `+59261${DIGITS}99`, firstName: 'TEST-Hidden', lastName: 'Person', acceptTerms: true, registrationProof: 'x'.repeat(43) } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESERVED_NAME');
    const fixture = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { phone: `+5920${DIGITS}99`, firstName: 'TEST-Journey', lastName: 'Person', acceptTerms: true, registrationProof: 'x'.repeat(43) } });
    expect(fixture.json().error?.code).not.toBe('RESERVED_NAME');
  });

  it('a real person cannot rename themselves "TEST-…"; an unchanged name re-sent by an older app is never re-judged', async () => {
    const someone = await person('real');
    await app.prisma.user.update({ where: { id: someone.id }, data: { activeRole: 'CUSTOMER' as never } });
    const token = (await loginWithOtp(app, (await app.prisma.user.findUniqueOrThrow({ where: { id: someone.id } })).phone)).json().data.tokens.accessToken;
    const rename = await app.inject({ method: 'PUT', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${token}` }, payload: { firstName: 'test-quiet' } });
    expect(rename.statusCode).toBe(400);
    expect(rename.json().error.code).toBe('RESERVED_NAME');
    expect((await app.prisma.user.findUniqueOrThrow({ where: { id: someone.id } })).firstName).not.toMatch(/^test-/i);
    // the existing name, re-sent unchanged with another field, passes (build-9-safe)
    const unchanged = await app.inject({ method: 'PUT', url: '/api/v1/customer/profile', headers: { authorization: `Bearer ${token}` }, payload: { firstName: (await app.prisma.user.findUniqueOrThrow({ where: { id: someone.id } })).firstName, lastName: 'Renamed' } });
    expect(unchanged.statusCode).toBe(200);
  });

  it('a real store cannot be renamed "TEST-…"', async () => {
    const owner = await person('real');
    await app.prisma.user.update({ where: { id: owner.id }, data: { activeRole: 'VENDOR_OWNER' as never } });
    const shop = await store(owner.id, `Owner Shop ${RUN}`);
    const token = (await loginWithOtp(app, (await app.prisma.user.findUniqueOrThrow({ where: { id: owner.id } })).phone)).json().data.tokens.accessToken;
    const res = await app.inject({ method: 'PUT', url: '/api/v1/vendor/profile', headers: { authorization: `Bearer ${token}` }, payload: { name: 'TEST-Not a test' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('RESERVED_NAME');
    expect((await app.prisma.vendor.findUniqueOrThrow({ where: { id: shop.id } })).name).toBe(`Owner Shop ${RUN}`);
  });

  it('the rule itself: prefix in any case, fixtures exempt, unchanged names exempt', () => {
    expect(() => assertNameNotReserved('Test-Shop', '+5926123456')).toThrow(/reserved/);
    expect(() => assertNameNotReserved('  TEST-Shop', '+5926123456')).toThrow(/reserved/);
    expect(() => assertNameNotReserved('TEST-Shop', '+5920123456')).not.toThrow();
    expect(() => assertNameNotReserved('TEST-Shop', '+5926123456', 'TEST-Shop')).not.toThrow();
    expect(() => assertNameNotReserved('Testing Shop', '+5926123456')).not.toThrow();
  });
});


it('equal creation times have a stable id order across every paged list', async () => {
  const createdAt = new Date('2026-01-01T00:00:00Z');
  await app.prisma.user.updateMany({ where: { id: { in: [real.id, fixturePhone.id, testName.id] } }, data: { createdAt } });
  await app.prisma.vendor.updateMany({ where: { id: { in: [realStore.id, testStore.id, fixtureOwnerStore.id] } }, data: { createdAt } });
  await app.prisma.rider.updateMany({ where: { userId: { in: [real.id, fixturePhone.id, testName.id] } }, data: { createdAt } });
  await app.prisma.driver.updateMany({ where: { userId: { in: [real.id, fixturePhone.id, testName.id] } }, data: { createdAt } });
  await app.prisma.order.updateMany({ where: { id: { in: orderIds } }, data: { createdAt } });
  for (const [kind, search] of [['users', `List${RUN}`], ['vendors', RUN], ['riders', `List${RUN}`], ['drivers', `List${RUN}`], ['orders', `LIST-${RUN}`]]) {
    const first = await get(`/api/v1/admin/${kind}?search=${search}&limit=100`);
    expect(first.statusCode).toBe(200);
    const all = first.json().data.map((row: { id: string }) => row.id);
    expect(all, kind).toEqual([...all].sort().reverse());
    const pages: string[] = [];
    for (let page = 1; page <= all.length; page++) {
      const response = await get(`/api/v1/admin/${kind}?search=${search}&limit=1&page=${page}`);
      expect(response.statusCode).toBe(200);
      pages.push(response.json().data[0].id);
    }
    expect(pages, kind).toEqual(all);
  }
});
it('orders at a fixture-owned store are hidden even when the customer is real', async () => {
  const vendorLeg = await order(real.id, fixtureOwnerStore.id);
  const shown = await get(`/api/v1/admin/orders?search=${vendorLeg.id}&excludeFixtures=true`);
  expect(shown.statusCode).toBe(200);
  expect(ids(shown)).not.toContain(vendorLeg.id);
  const all = await get(`/api/v1/admin/orders?search=LIST-${RUN}&excludeFixtures=false`);
  expect(ids(all)).toContain(vendorLeg.id);
  const filtered = await get(`/api/v1/admin/orders?search=LIST-${RUN}&excludeFixtures=true`);
  expect(ids(filtered)).not.toContain(vendorLeg.id);
  expect(filtered.json().meta.hiddenTestRecords).toBe(2);
});
