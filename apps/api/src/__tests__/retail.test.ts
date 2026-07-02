import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { guessColumnMapping, applyMapping, toImportCsv } from '../utils/catalogue-map';

// ---------------------------------------------------------------------------
// Retail (spec §4.5): AI/heuristic CSV column-mapping import and the
// returns/dispute flow. (Cross-store search already exists via the search module.)
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;

async function makeUserWithSession(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+59200177${String(seq).padStart(2, '0')}`,
      firstName: 'Retail',
      lastName: `User${seq}`,
      roles,
      activeRole,
      isPhoneVerified: true, selfieCapturedAt: new Date(),
      ...(activeRole === 'ADMIN' && { admin: { create: { permissions: ['*'] } } }),
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: { userId: user.id, token, refreshToken: nanoid(48), deviceId: 'step20', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

async function makeStoreVendor() {
  const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: owner.id,
      name: `Retail Store ${seq}`,
      slug: `retail-store-${seq}-${nanoid(4)}`,
      vendorType: 'STORE',
      phone: `+5920018${String(seq).padStart(3, '0')}`,
      addressLine1: '1 Market Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', isVerified: true,
    },
  });
  return { ...owned, vendorId: vendor.id };
}

async function makeDeliveredOrder(customerId: string, vendorId: string) {
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `R20-${nanoid(10)}`,
      orderType: 'GROCERY_DELIVERY',
      customerId,
      vendorId,
      status: 'DELIVERED',
      deliveryAddress: 'matrix', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 0, totalAmount: 1000, paymentMethod: 'CASH',
    },
  });
  return order;
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, token?: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: {
      ...(payload !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
}

async function purgeFixtures() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: '+59200177' } }, select: { id: true } });
  const userIds = users.map((u) => u.id);
  createdUserIds.length = 0;
  if (userIds.length === 0) return;
  const orders = await app.prisma.order.findMany({ where: { customerId: { in: userIds } }, select: { id: true } });
  const orderIds = orders.map((o) => o.id);
  await app.prisma.returnRequest.deleteMany({ where: { OR: [{ customerId: { in: userIds } }, { orderId: { in: orderIds } }] } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
}

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  await purgeFixtures();
});

afterAll(async () => {
  await purgeFixtures();
  await app.close();
});

describe('Retail — CSV column mapping (deterministic core)', () => {
  it('maps messy headers to Swift fields by synonym, copying values verbatim', () => {
    const headers = ['Product Name', 'Cost (GYD)', 'Dept', 'Qty on Hand', 'Notes'];
    const mapping = guessColumnMapping(headers);
    expect(mapping.name).toBe('Product Name');
    expect(mapping.basePrice).toBe('Cost (GYD)');
    expect(mapping.category).toBe('Dept');
    expect(mapping.stockQuantity).toBe('Qty on Hand');
    expect(mapping.description).toBe('Notes');

    const rows = [{ 'Product Name': 'Rice 5kg', 'Cost (GYD)': '3500', Dept: 'Groceries', 'Qty on Hand': '40', Notes: 'aged' }];
    const normalized = applyMapping(rows, mapping);
    expect(normalized[0]).toMatchObject({ name: 'Rice 5kg', basePrice: '3500', category: 'Groceries', stockQuantity: '40' });

    const csv = toImportCsv(normalized);
    expect(csv.split('\n')[0]).toBe('category,name,description,basePrice,sku,unit,stockQuantity,isAvailable,fulfillment,imageUrl');
  });
});

describe('Retail — automap import + returns', () => {
  it('automaps a messy CSV and the normalized output imports', async () => {
    const store = await makeStoreVendor();
    const messy = ['Product,Price,Dept,Stock', 'Rice 5kg,3500,Groceries,40', 'Cooking Oil,1800,Groceries,25'].join('\n');

    const res = await inject('POST', '/api/v1/vendor/items/import/automap', { csv: messy }, store.token);
    expect(res.statusCode).toBe(200);
    const data = res.json().data;
    expect(data.mapping.name).toBe('Product');
    expect(data.mapping.basePrice).toBe('Price');
    expect(data.rowCount).toBe(2);
    expect(data.preview[0].basePrice).toBe('3500'); // value copied verbatim, never invented

    // The normalized CSV feeds the existing importer.
    const imp = await inject('POST', '/api/v1/vendor/items/import', { csv: data.normalizedCsv }, store.token);
    expect(imp.statusCode).toBe(200);
    expect(imp.json().data.imported).toBe(2);
  });

  it('runs the returns flow: request on a delivered retail order, admin resolves', async () => {
    const store = await makeStoreVendor();
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await makeDeliveredOrder(customer.userId, store.vendorId);

    const req = await inject('POST', `/api/v1/customer/orders/${order.id}/return`, { reason: 'Item arrived damaged' }, customer.token);
    expect(req.statusCode).toBe(201);
    const returnId = req.json().data.id;
    expect(req.json().data.status).toBe('REQUESTED');

    const admin = await makeUserWithSession(['ADMIN'], 'ADMIN');
    const resolved = await inject('PUT', `/api/v1/admin/returns/${returnId}/resolve`, { status: 'APPROVED', note: 'Refund issued' }, admin.token);
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json().data.status).toBe('APPROVED');
  });

  it('rejects a return on a non-retail (food) order', async () => {
    const owned = await makeUserWithSession(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
    const owner = await app.prisma.vendorOwner.create({ data: { userId: owned.userId } });
    const restaurant = await app.prisma.vendor.create({
      data: {
        ownerId: owner.id, name: `Food ${seq}`, slug: `food-${seq}-${nanoid(4)}`,
        vendorType: 'RESTAURANT', phone: `+5920019${String(seq).padStart(3, '0')}`,
        addressLine1: '2 Food Lane', city: 'Georgetown', region: 'Demerara-Mahaica',
        latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true,
      },
    });
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const order = await makeDeliveredOrder(customer.userId, restaurant.id);

    const res = await inject('POST', `/api/v1/customer/orders/${order.id}/return`, { reason: 'Too spicy, want a refund' }, customer.token);
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_RETAIL');
  });
});
