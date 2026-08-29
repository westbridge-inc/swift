import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// [G2] The order line remembers how bulky the item was WHEN IT WAS ORDERED.
//
// #894 added `order_items.bulkUnits` as a snapshot column and wired two readers
// to it — the load-gate shadow, and (via #899) stack-eligibility's size class.
// Nothing wrote it. So every order ever placed weighed "ordinary" to both: a
// 20 kg bag of rice counted as a sachet in the pairing decision, and the shadow
// could never observe the case it exists for. This is the write.
//
// It is a SNAPSHOT, like name and every price on the same row (ADR
// SWIFT-AUD-D5-04): `itemId` is a loose reference with no FK, so a vendor
// re-marking the item next week must not change what THIS order weighed when
// it was dispatched. That is the second assertion below, and the one that
// matters more than the first.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200649';

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];

let seq = 0;
async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`,
      firstName: 'Snap', lastName: `Shot${seq}`,
      roles, activeRole, isPhoneVerified: true,
      selfieCapturedAt: new Date(), avatar: '/uploads/avatars/snap.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48),
      deviceId: 'snap-test', deviceType: 'test', expiresAt: new Date(Date.now() + DAY),
    },
  });
  return { userId: user.id, token };
}

async function makeShop(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Snapshot Mart', slug: `snapshot-mart-${nanoid(6)}`, vendorType: 'SUPERMARKET',
      phone: `${PHONE_PREFIX}98`, addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Staples', sortOrder: 0 } });
  const rice = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Rice 20kg', basePrice: 6500, bulkUnits: 8 } });
  const sachet = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Seasoning', basePrice: 120 } });
  return { vendorId: vendor.id, rice, sachet };
}

function inject(method: 'GET' | 'POST', url: string, payload: unknown, token: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
  });
}

let customer: { userId: string; token: string };
let shop: Awaited<ReturnType<typeof makeShop>>;

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vos.map((v) => v.id);
    await app.prisma.item.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.category.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
    await app.prisma.vendor.deleteMany({ where: { ownerId: { in: voIds } } });
    await app.prisma.vendorOwner.deleteMany({ where: { id: { in: voIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
    await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  }

  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  shop = await makeShop(owner.userId);
  customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({
    data: {
      userId: customer.userId, label: 'Home', addressLine1: '2 Robb Street',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, isDefault: true,
    },
  });
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdVendorIds.length) {
    await app.prisma.item.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.category.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
    await app.prisma.vendor.deleteMany({ where: { id: { in: createdVendorIds } } });
  }
  if (createdUserIds.length) {
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.session.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  }
  await app.close();
});

describe('checkout snapshots the item’s bulk onto the order line', () => {
  let orderId: string;

  it('a very bulky item and an ordinary one arrive on the order with their bulk', async () => {
    // One bag of rice, two sachets: $6,740 — deliberately under the high-value
    // ID gate ($10,450), which is a real rule and not this test's subject.
    for (const [it, quantity] of [[shop.rice, 1], [shop.sachet, 2]] as const) {
      const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: it.id, quantity }, customer.token);
      expect([200, 201], add.body).toContain(add.statusCode);
    }
    // PICKUP: no rider, no dispatch — this is about the row, not the road.
    const res = await inject('POST', '/api/v1/customer/checkout', {
      paymentMethod: 'CASH', fulfillmentSelections: { [shop.vendorId]: 'PICKUP' },
    }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const orders = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    orderId = orders[0]?.id;
    expect(orderId, 'an order was created').toBeTruthy();

    const lines = await app.prisma.orderItem.findMany({ where: { orderId }, select: { itemId: true, bulkUnits: true } });
    const byItem = new Map(lines.map((l) => [l.itemId, l.bulkUnits]));
    expect(byItem.get(shop.rice.id), 'rice carries its bulk').toBe(8);
    expect(byItem.get(shop.sachet.id), 'an ordinary item stays NULL — one spelling of ordinary').toBeNull();
  });

  it('re-marking the item afterwards does NOT change what the order weighed', async () => {
    // THE reason it is a snapshot. The order was dispatched — or will be judged
    // for stacking — on what was true when it was placed.
    await app.prisma.item.update({ where: { id: shop.rice.id }, data: { bulkUnits: null } });
    const line = await app.prisma.orderItem.findFirst({ where: { orderId, itemId: shop.rice.id }, select: { bulkUnits: true } });
    expect(line?.bulkUnits).toBe(8);
    await app.prisma.item.update({ where: { id: shop.rice.id }, data: { bulkUnits: 8 } });
  });

  it('the load gate would now see this order for what it is', async () => {
    // What the shadow reads, computed exactly as it computes it.
    const { requiredPackageSizeForOrder } = await import('../utils/load');
    const order = await app.prisma.order.findUnique({
      where: { id: orderId },
      select: { orderType: true, courierPackageSize: true, items: { select: { quantity: true, bulkUnits: true } } },
    });
    // 1 × rice (8) + 2 × sachet (1) = 10 bulk units → MEDIUM. Before this write
    // the same order summed to 3 units and banded SMALL: a bicycle's job, with
    // a 20 kg bag in it.
    expect(requiredPackageSizeForOrder(order!)).toBe('MEDIUM');
  });
});
