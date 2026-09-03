import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [G7 · P23] order → customer → identity: narrow by design.
//
// The founder's real case: a customer bails, and he starts from the ORDER.
// Nothing navigated order → customer → identity documents; he would read the
// order, extract the customer, then hunt a mixed queue. This is that path —
// and because it is the most sensitive read in the product, every one of its
// four constraints is pinned here:
//
//   metadata only, never a URL · a reason is required and audited ·
//   refuses on a healthy order · one audited door for viewing (unchanged).
// ---------------------------------------------------------------------------

const PHONE_PREFIX = '+59200654';
const DAY = 24 * 60 * 60 * 1000;

let app: FastifyInstance;
let adminToken: string;
let adminId: string;
let customerId: string;
let vendorId: string;
let docIds: string[] = [];

async function purge() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (!ids.length) return;
  await app.prisma.reimbursementClaim.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.verificationDocument.deleteMany({ where: { userId: { in: ids } } });
  const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
  await app.prisma.vendor.deleteMany({ where: { ownerId: { in: vos.map((v) => v.id) } } });
  await app.prisma.vendorOwner.deleteMany({ where: { id: { in: vos.map((v) => v.id) } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
}

async function makeOrder(status: string) {
  return app.prisma.order.create({
    data: {
      orderNumber: `ID-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId, vendorId, status: status as any,
      fulfillment: 'DELIVERY', pickupAddress: 'Store', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'Home', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000, deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH',
    },
  });
}

const lookup = (orderId: string, reason?: string, token = adminToken) =>
  app.inject({
    method: 'GET',
    url: `/api/v1/admin/orders/${orderId}/customer-identity${reason !== undefined ? `?reason=${encodeURIComponent(reason)}` : ''}`,
    headers: { authorization: `Bearer ${token}` },
  });

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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purge();

  const admin = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}01`, firstName: 'Bail', lastName: 'Admin', roles: ['ADMIN'], activeRole: 'ADMIN', isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } } },
  });
  adminId = admin.id;
  adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: admin.id, token: adminToken, refreshToken: nanoid(40), deviceId: 'g7', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });

  const customer = await app.prisma.user.create({
    data: { phone: `${PHONE_PREFIX}02`, firstName: 'Bail', lastName: 'Customer', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  customerId = customer.id;
  const live = await app.prisma.verificationDocument.create({ data: { userId: customerId, role: 'CUSTOMER', docType: 'national_id', fileUrl: `storage://t/${nanoid(6)}.jpg`, status: 'APPROVED', reviewedAt: new Date(), kycRef: 'kyc-ref-secret' } });
  const purged = await app.prisma.verificationDocument.create({ data: { userId: customerId, role: 'CUSTOMER', docType: 'national_id', fileUrl: `storage://t/${nanoid(6)}.jpg`, status: 'APPROVED', purgedAt: new Date() } });
  docIds = [live.id, purged.id];
  // A mover document on the same person must NOT ride along: this door opens
  // customer identity for a bailed ORDER, nothing wider.
  await app.prisma.verificationDocument.create({ data: { userId: customerId, role: 'MOVER', docType: 'police_clearance', fileUrl: `storage://t/${nanoid(6)}.jpg`, status: 'PENDING' } });

  const ownerUser = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}03`, firstName: 'Bail', lastName: 'Owner', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  vendorId = (await app.prisma.vendor.create({
    data: { ownerId: owner.id, name: 'Bail Diner', slug: `bail-diner-${nanoid(5)}`, vendorType: 'RESTAURANT', phone: `${PHONE_PREFIX}04`, addressLine1: '1 Bail St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true },
  })).id;
});

afterAll(async () => {
  await purge();
  await app.close();
});

describe('GET /admin/orders/:id/customer-identity', () => {
  it('a failed order opens the customer’s identity — as metadata, never a URL, never another role’s documents', async () => {
    const order = await makeOrder('FAILED');
    const res = await lookup(order.id, 'order abandoned at the door, rider reimbursed');
    expect(res.statusCode, res.body).toBe(200);
    const data = res.json().data;
    expect(data.order).toEqual({ id: order.id, orderNumber: order.orderNumber, status: 'FAILED' });
    expect(data.customer).toEqual({ id: customerId, firstName: 'Bail', lastName: 'Customer' });
    expect(data.cause).toBe('ORDER_FAILED');
    expect(data.documents.map((d: any) => d.id).sort()).toEqual([...docIds].sort());
    for (const d of data.documents) {
      expect(Object.keys(d).sort()).toEqual(['createdAt', 'docType', 'expiresAt', 'id', 'purged', 'reviewedAt', 'status']);
    }
    expect(data.documents.find((d: any) => d.id === docIds[1]).purged).toBe(true);
    // The whole payload, not just the rows: no storage key, no signed URL, no provider ref.
    for (const secret of ['fileUrl', 'storage://', 'kycRef', 'kyc-ref-secret', '"url"', 'police_clearance']) {
      expect(res.payload, `${secret} leaked`).not.toContain(secret);
    }
  });

  it('the reason is required, must be a sentence, and lands in the audit row with the cause', async () => {
    const order = await makeOrder('CANCELLED');
    expect((await lookup(order.id)).statusCode).toBe(400);
    expect((await lookup(order.id, 'curious')).statusCode).toBe(400);

    const reason = 'customer cancelled after pickup, dispute opened by rider';
    expect((await lookup(order.id, reason)).statusCode).toBe(200);
    const row = await app.prisma.auditLog.findFirst({
      where: { userId: adminId, action: 'LOOKUP_CUSTOMER_IDENTITY', entityId: order.id },
      orderBy: { createdAt: 'desc' },
    });
    expect(row).not.toBeNull();
    const changes = row!.changes as Record<string, unknown>;
    expect(changes['reason']).toBe(reason);
    expect(changes['cause']).toBe('ORDER_CANCELLED');
    expect(changes['customerId']).toBe(customerId);
  });

  it('[P23] refuses on a healthy order — live or completed — and writes NO audit row', async () => {
    for (const status of ['ACCEPTED', 'PICKED_UP', 'DELIVERED', 'COMPLETED']) {
      const order = await makeOrder(status);
      const res = await lookup(order.id, 'I would just like to have a look at this one');
      expect(res.statusCode, status).toBe(409);
      expect(res.json().error?.code ?? res.json().code).toBe('ORDER_NOT_BAILED');
      const row = await app.prisma.auditLog.findFirst({ where: { action: 'LOOKUP_CUSTOMER_IDENTITY', entityId: order.id } });
      expect(row, `${status}: a refused lookup must not look like a lookup`).toBeNull();
    }
  });

  it('a reimbursement claim is a real signal even before the order is terminal', async () => {
    const order = await makeOrder('ARRIVED');
    const rider = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}05`, firstName: 'Bail', lastName: 'Rider', roles: ['RIDER'], activeRole: 'RIDER', isPhoneVerified: true, selfieCapturedAt: new Date() } });
    const riderRow = await app.prisma.rider.create({ data: { userId: rider.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
    const claim = await app.prisma.reimbursementClaim.create({
      data: { orderId: order.id, riderId: riderRow.id, customerId, amount: 2000, reason: 'customer refused at the door', gpsLat: 6.81, gpsLng: -58.16 },
    });
    const res = await lookup(order.id, 'rider filed a reimbursement claim: customer refused the order');
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().data.cause).toBe('REIMBURSEMENT_CLAIM');
    const row = await app.prisma.auditLog.findFirst({ where: { action: 'LOOKUP_CUSTOMER_IDENTITY', entityId: order.id } });
    expect((row!.changes as Record<string, unknown>)['claimId']).toBe(claim.id);
  });

  it('is admin-only, like every door onto identity', async () => {
    const order = await makeOrder('FAILED');
    const outsider = await app.prisma.user.create({ data: { phone: `${PHONE_PREFIX}06`, firstName: 'Bail', lastName: 'Outsider', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } } });
    const token = app.jwt.sign({ userId: outsider.id, role: 'CUSTOMER', jti: nanoid(8) });
    await app.prisma.session.create({ data: { authMethod: 'OTP', userId: outsider.id, token, refreshToken: nanoid(40), deviceId: 'g7o', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    const res = await lookup(order.id, 'a customer asking about another customer', token);
    expect([401, 403]).toContain(res.statusCode);
  });
});
