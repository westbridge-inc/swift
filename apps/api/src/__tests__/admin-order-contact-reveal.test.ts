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
import { loginWithOtp } from './helpers/otp';
import { testPhone } from './helpers/fixture-ids';
import { runWithoutTenant } from '../plugins/tenant-context';
import { purgeAuditLogs, purgeSensitiveReadLogs } from '../lib/audit-immutability';
import { ADMIN_ROUTE_AUTHORITY } from '../modules/admin/admin-authority';
import { maskOrderPartyPhones, revealOrderPartyPhone } from '../modules/admin/order-contact';

// ---------------------------------------------------------------------------
// [O-1 · COORD ruling 22 Oct 2026] The admin order desk shows every party's
// phone MASKED; the full number of ONE party is an audited reveal: a stated
// reason, and an audit row written BEFORE the number leaves.
//
// Asserted on the SERIALIZED body: every party has a real, distinct number, so
// a full number anywhere in the response is a leak. Numbers come from
// testPhone(), the run-wide fictional +59206 block.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken = '';
let customerToken = '';
let vendorOwnerId = '';
let vendorId = '';
let riderId = '';
let driverId = '';
const userIds: string[] = [];
const orderIds: string[] = [];
const phones = { customer: testPhone(), store: testPhone(), rider: testPhone(), driver: testPhone(), owner: testPhone() };
const REASON = 'Customer rang support: the rider cannot find the gate';
const tail = (phone: string) => phone.slice(-4);

async function makeUser(phone: string, roles: string[], active: string) {
  const user = await app.prisma.user.create({ data: { phone, firstName: 'Contact', lastName: 'Party', roles: roles as never, activeRole: active as never, isPhoneVerified: true } });
  userIds.push(user.id);
  return user;
}

async function makeOrder(extra: Record<string, unknown>) {
  const order = await app.prisma.order.create({ data: {
    orderNumber: `OCR-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY', status: 'PICKED_UP',
    deliveryAddress: '1 Gate St', deliveryLat: 6.801, deliveryLng: -58.156,
    subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    ...extra,
  } as never });
  orderIds.push(order.id);
  return order;
}

const adminGet = (url: string, headers: Record<string, string> = {}, token = adminToken) =>
  app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}`, ...headers } });
const reveal = (orderId: string, party: string, reason?: string, token = adminToken) =>
  adminGet(`/api/v1/admin/orders/${orderId}/party-phone?party=${party}`, reason === undefined ? {} : { 'x-swift-reason': reason }, token);
const auditRows = (orderId: string) => app.prisma.auditLog.findMany({ where: { entityId: orderId, action: { startsWith: 'REVEAL_PARTY_PHONE' } }, orderBy: { createdAt: 'asc' } });

let foodId = '';
let rideId = '';
let riderlessId = '';

beforeAll(async () => {
  const server = Fastify({ logger: false });
  registerErrorHandler(server);
  registerEmptyJsonBodyParser(server);
  await server.register(prismaPlugin);
  await server.register(redisPlugin);
  await server.register(authPlugin);
  await server.register(socketPlugin);
  await server.register(authRoutes, { prefix: '/api/v1/auth' });
  await server.register(adminRoutes, { prefix: '/api/v1/admin' });
  await server.ready();
  app = server;

  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken; // seeded SUPER_ADMIN

  const customer = await makeUser(phones.customer, ['CUSTOMER'], 'CUSTOMER');
  customerToken = (await loginWithOtp(app, phones.customer)).json().data.tokens.accessToken;
  const owner = await makeUser(phones.owner, ['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  vendorOwnerId = (await app.prisma.vendorOwner.create({ data: { userId: owner.id } })).id;
  vendorId = (await app.prisma.vendor.create({ data: {
    ownerId: vendorOwnerId, name: 'Contact Counter', slug: `contact-${nanoid(6).toLowerCase().replace(/[^a-z0-9]/g, 'x')}`, vendorType: 'RESTAURANT',
    phone: phones.store, addressLine1: '1 Counter St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.801, longitude: -58.156,
    status: 'ACTIVE', isVerified: true, acceptingOrders: true, isCurrentlyOpen: true,
  } as never })).id;
  const riderUser = await makeUser(phones.rider, ['RIDER'], 'RIDER');
  riderId = (await app.prisma.rider.create({ data: { userId: riderUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } as never })).id;
  const driverUser = await makeUser(phones.driver, ['DRIVER'], 'DRIVER');
  driverId = (await app.prisma.driver.create({ data: {
    userId: driverUser.id, vehicleMake: 'Toyota', vehicleModel: 'Axio', vehicleColor: 'White', vehicleYear: 2015,
    licensePlate: `PCR ${nanoid(4)}`, driverLicenseUrl: 'x', vehicleInsuranceUrl: 'x',
  } as never })).id;

  foodId = (await makeOrder({ customerId: customer.id, vendorId, riderId })).id;
  rideId = (await makeOrder({ customerId: customer.id, driverId, orderType: 'TAXI', status: 'RIDE_IN_PROGRESS' })).id;
  riderlessId = (await makeOrder({ customerId: customer.id, vendorId, status: 'PREPARING' })).id;
});

afterAll(async () => {
  await runWithoutTenant(async () => {
    await purgeAuditLogs(app.prisma, { OR: [{ entityId: { in: orderIds } }, { userId: { in: userIds } }] }, 'test-cleanup:admin-order-contact-reveal');
    // ADM-007 rows are append-only: the test purge door, as every admin suite does.
    await purgeSensitiveReadLogs(app.prisma, { actorUserId: { in: userIds } }, 'test-cleanup:admin-order-contact-reveal').catch(() => 0);
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
    await app.prisma.rider.deleteMany({ where: { id: riderId } });
    await app.prisma.driver.deleteMany({ where: { id: driverId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: vendorOwnerId } });
    await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }, 'test-cleanup:admin-order-contact-reveal');
  await app.close();
});

describe('[O-1] the admin order desk shows phones masked', () => {
  it('the order detail carries no full party number, only a masked one ending in the same 4 digits', async () => {
    const res = await adminGet(`/api/v1/admin/orders/${foodId}`);
    expect(res.statusCode).toBe(200);
    for (const phone of [phones.customer, phones.store, phones.rider]) expect(res.payload).not.toContain(phone);
    const data = res.json().data;
    expect(data.customer.phone).toMatch(new RegExp(`•+${tail(phones.customer)}$`));
    expect(data.vendor.phone).toMatch(new RegExp(`•+${tail(phones.store)}$`));
    expect(data.rider.user.phone).toMatch(new RegExp(`•+${tail(phones.rider)}$`));
    // the rest of the page is unchanged: names still there
    expect(data.customer.firstName).toBe('Contact');
  });

  it('a taxi detail masks the driver', async () => {
    const res = await adminGet(`/api/v1/admin/orders/${rideId}`);
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(phones.driver);
    expect(res.json().data.driver.user.phone).toMatch(new RegExp(`•+${tail(phones.driver)}$`));
  });

  it('the order list carries no full customer number', async () => {
    const res = await adminGet('/api/v1/admin/orders?limit=100');
    expect(res.statusCode).toBe(200);
    expect(res.payload).toContain(foodId);
    expect(res.payload).not.toContain(phones.customer);
  });
});

describe('[O-1] the audited reveal', () => {
  it('is classified (a sensitive read, its own capability)', () => {
    expect(ADMIN_ROUTE_AUTHORITY['GET /orders/:id/party-phone']).toMatchObject({ cls: 'C1', capability: 'order.contact.read' });
  });

  it('refuses without a reason, or with a reason too short to be one, and records nothing', async () => {
    expect((await reveal(foodId, 'customer')).statusCode).toBe(400);
    const short = await reveal(foodId, 'customer', 'need it');
    expect(short.statusCode).toBe(400);
    expect(short.payload).not.toContain(phones.customer);
    expect(await auditRows(foodId)).toHaveLength(0);
  });

  it('refuses a party that is not one of customer / store / mover', async () => {
    const res = await reveal(foodId, 'owner', REASON);
    expect(res.statusCode).toBe(400);
    expect(await auditRows(foodId)).toHaveLength(0);
  });

  it('refuses a non-admin', async () => {
    const res = await reveal(foodId, 'customer', REASON, customerToken);
    expect(res.statusCode).toBe(403);
    expect(res.payload).not.toContain(phones.customer);
  });

  it('returns each party\'s full number, with an audit row naming actor, order, party, person and reason, never the number', async () => {
    for (const [party, phone] of [['customer', phones.customer], ['store', phones.store], ['mover', phones.rider]] as const) {
      const res = await reveal(foodId, party, REASON);
      expect(res.statusCode, party).toBe(200);
      expect(res.json().data).toMatchObject({ party, phone });
      const auditId = res.json().data.auditId as string;
      const row = await app.prisma.auditLog.findUnique({ where: { id: auditId } });
      expect(row).toMatchObject({ action: 'REVEAL_PARTY_PHONE', entity: 'Order', entityId: foodId });
      expect(row!.userId).toBeTruthy();
      expect(row!.changes).toMatchObject({ reason: REASON, party });
      expect(JSON.stringify(row)).not.toContain(phone);
    }
    const rows = await auditRows(foodId);
    expect(rows.map((r) => (r.changes as { party: string }).party)).toEqual(['customer', 'store', 'mover']);
  });

  it('a taxi\'s mover is its driver', async () => {
    const res = await reveal(rideId, 'mover', REASON);
    expect(res.statusCode).toBe(200);
    expect(res.json().data.phone).toBe(phones.driver);
  });

  it('a party the order does not have is a 404, and the ask is recorded', async () => {
    const res = await reveal(riderlessId, 'mover', REASON);
    expect(res.statusCode).toBe(404);
    const rows = await auditRows(riderlessId);
    expect(rows.map((r) => r.action)).toEqual(['REVEAL_PARTY_PHONE_MISS']);
  });

  it('when the audit row cannot be written, the number never leaves', async () => {
    const order = {
      id: 'o1', orderNumber: 'N1', customer: { id: 'u1', phone: phones.customer }, vendor: null, rider: null, driver: null,
    };
    const prisma = {
      order: { findUnique: async () => order },
      auditLog: { create: async () => { throw new Error('audit store down'); } },
    } as never;
    await expect(revealOrderPartyPhone({ prisma }, { orderId: 'o1', party: 'customer', actorId: 'a1', reason: REASON }))
      .rejects.toThrow('audit store down');
  });

  it('the masker keeps every key and never touches the input', () => {
    const input = { customer: { phone: phones.customer, firstName: 'A' }, vendor: { phone: null }, rider: { user: { phone: phones.rider } }, driver: null };
    const out = maskOrderPartyPhones(input);
    expect(input.customer.phone).toBe(phones.customer);
    expect(out.customer.phone).not.toContain(phones.customer);
    expect(out.customer.firstName).toBe('A');
    expect(out.vendor.phone).toBeNull();
    expect(out.rider.user.phone).toMatch(new RegExp(`${tail(phones.rider)}$`));
    expect(out.driver).toBeNull();
  });
});
