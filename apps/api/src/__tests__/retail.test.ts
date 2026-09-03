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
    data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'step20', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
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

// ---------------------------------------------------------------------------
// [A-13] S0 money. A return could go from REQUESTED to a TERMINAL "REFUNDED" in
// one click with only an optional note. The customer and operations both then
// saw a finished refund while the money was still owed, and nothing recorded
// who was going to send it, how much, or whether it ever arrived.
//
// REFUND_DUE is the obligation. Deciding to refund records that money is OWED;
// only reconciled evidence — a unique transfer reference and the amount
// actually sent — closes it.
// ---------------------------------------------------------------------------

describe('[A-13] a refund is owed before it is paid', () => {
  async function admin() {
    const a = await makeUserWithSession(['ADMIN'], 'ADMIN');
    return a.token;
  }
  // A real order in the tenant: the admin client scopes returns through their
  // order and customer, so a synthetic orderId is correctly invisible to it.
  async function pendingReturn(refundAmount = 4500) {
    const customer = await makeUserWithSession(['CUSTOMER'], 'CUSTOMER');
    const store = await makeStoreVendor();
    const order = await makeDeliveredOrder(customer.userId, store.vendorId);
    return app.prisma.returnRequest.create({
      data: {
        orderId: order.id,
        customerId: customer.userId,
        reason: 'damaged',
        status: 'REQUESTED',
        refundAmount,
      },
    });
  }

  it('the console cannot mark a return REFUNDED directly any more', async () => {
    const token = await admin();
    const r = await pendingReturn();
    const res = await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUNDED' }, token);
    expect(res.statusCode).toBe(400); // not an accepted status
    expect((await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('REQUESTED');
  });

  it('deciding to refund records an OBLIGATION, not a payment', async () => {
    const token = await admin();
    const r = await pendingReturn();
    const res = await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUND_DUE' }, token);
    expect(res.statusCode).toBe(200);
    const row = await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('REFUND_DUE');
    expect(row.refundRef).toBeNull();
    expect(row.refundPaidAt).toBeNull();
  });

  it('only evidence closes it — reference and the amount actually sent', async () => {
    const token = await admin();
    const r = await pendingReturn(4500);
    await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUND_DUE' }, token);

    const ok = await inject('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: 'bank-a13-1', amount: '4500.00' }, token);
    expect(ok.statusCode).toBe(200);
    const row = await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('REFUNDED');
    expect(row.refundRef).toBe('BANK-A13-1');           // normalised
    expect(Number(row.refundPaidAmount)).toBe(4500);
    expect(row.refundPaidById).not.toBeNull();
    expect(row.refundPaidAt).not.toBeNull();
  });

  it('one transfer settles ONE return', async () => {
    const token = await admin();
    const a = await pendingReturn(4500);
    const b = await pendingReturn(4500);
    for (const r of [a, b]) await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUND_DUE' }, token);
    expect((await inject('PUT', `/api/v1/admin/returns/${a.id}/refund-settled`, { reference: 'BANK-A13-DUP', amount: 4500 }, token)).statusCode).toBe(200);
    const dup = await inject('PUT', `/api/v1/admin/returns/${b.id}/refund-settled`, { reference: 'bank-a13-dup', amount: 4500 }, token);
    expect(dup.statusCode).toBe(409);
    expect((await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: b.id } })).status).toBe('REFUND_DUE');
  });

  it('the stated amount must be the amount owed', async () => {
    const token = await admin();
    const r = await pendingReturn(4500);
    await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUND_DUE' }, token);
    for (const wrong of [450, 4501, 4499.99, '450.00']) {
      const res = await inject('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: 'BANK-A13-W1', amount: wrong }, token);
      expect(res.statusCode, String(wrong)).toBe(409);
    }
    // and a non-numeric amount is refused rather than coerced to zero
    for (const bad of ['', 'four thousand', 'GY$4500', '4.5e3']) {
      const res = await inject('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: 'BANK-A13-W2', amount: bad }, token);
      expect([400, 409], String(bad)).toContain(res.statusCode);
    }
    expect((await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: r.id } })).status).toBe('REFUND_DUE');
  });

  it('two settlers at once: exactly one closes it, and only one transfer is recorded', async () => {
    // The state check above catches the SEQUENTIAL case. This is the RACE, and
    // it is why the write is a compare-and-set on REFUND_DUE rather than a
    // plain update: two operators (or a double-click and a retry) both reading
    // REFUND_DUE and both writing REFUNDED would record two refunds for one
    // debt. Deliberately DIFFERENT references, so the unique index cannot be
    // what decides the winner — only the CAS can.
    const token = await admin();
    const r = await pendingReturn(4500);
    await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUND_DUE' }, token);

    const [a, b] = await Promise.all([
      inject('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: 'BANK-RACE-A', amount: 4500 }, token),
      inject('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: 'BANK-RACE-B', amount: 4500 }, token),
    ]);
    // Exactly one wins. The loser is refused, and WHICH refusal it gets is a
    // timing detail — 400 if its state re-read already saw REFUNDED, 409 if it
    // reached the compare-and-set. Pinning one of those would grade the race's
    // scheduling rather than the invariant, so the invariant is what is graded:
    // one success, one refusal, never two payouts.
    const ok = [a, b].filter((r) => r.statusCode === 200);
    const refused = [a, b].filter((r) => r.statusCode >= 400);
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);

    const row = await app.prisma.returnRequest.findUniqueOrThrow({ where: { id: r.id } });
    expect(row.status).toBe('REFUNDED');
    // exactly one of the two references is on the row, never both, never neither
    expect(['BANK-RACE-A', 'BANK-RACE-B']).toContain(row.refundRef);
  });

  it('a malformed reference is refused, and a return not awaiting payment cannot be settled', async () => {
    const token = await admin();
    const r = await pendingReturn(4500);
    await inject('PUT', `/api/v1/admin/returns/${r.id}/resolve`, { status: 'REFUND_DUE' }, token);
    for (const bad of ['', '  ', 'x', '!!!!']) {
      expect((await inject('PUT', `/api/v1/admin/returns/${r.id}/refund-settled`, { reference: bad, amount: 4500 }, token)).statusCode, bad).toBe(400);
    }
    // a REQUESTED return has no obligation to settle
    const fresh = await pendingReturn(4500);
    const early = await inject('PUT', `/api/v1/admin/returns/${fresh.id}/refund-settled`, { reference: 'BANK-A13-EARLY', amount: 4500 }, token);
    expect(early.statusCode).toBe(400);
    expect(early.json().error.code).toBe('NOT_REFUND_DUE');
  });
});
