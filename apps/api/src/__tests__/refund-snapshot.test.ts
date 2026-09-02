import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { customerRoutes } from '../modules/user/customer.routes';
import { scanInferredRefunds } from '../modules/order/refund-review';
import { refundsAwaitingReviewGauge } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [M-33] End to end: the allocation is written at checkout, the return
// consumes it, and a legacy order is routed to review.
//
//   FREE_DELIVERY (platform): a full return after delivery refunds every
//   goods dollar and no fee — the store was told to under-refund by the fee
//   before; the snapshot names Swift as the funder.
//   A vendor goods code: the return is net of the store's own discount, and
//   says so.
//   A legacy order (no snapshot): computed by inference, MARKED, and counted
//   by the review scan.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200812';
const STORE = { lat: 6.8010, lng: -58.1560 };
const DROP = { lat: 6.8100, lng: -58.1700 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdPromoIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Snap', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/s.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'snap', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

let shop: { vendorId: string; kettle: { id: string }; fan: { id: string } };

async function makeStore(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Snapshot Store', slug: `snapshot-store-${nanoid(6)}`, vendorType: 'STORE',
      phone: `${PHONE_PREFIX}98`, addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, deliveryRadius: 25,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      mmgPayUrl: 'https://pay.example.com/pay/snapshot-store',
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Home', sortOrder: 0 } });
  const kettle = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Kettle', basePrice: 1200 } });
  const fan = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Fan', basePrice: 3100 } });
  return { vendorId: vendor.id, kettle, fan };
}

function inject(method: 'GET' | 'POST', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

async function shopper() {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '4 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: DROP.lat, longitude: DROP.lng, isDefault: true } });
  for (const item of [shop.kettle, shop.fan]) {
    const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: item.id, quantity: 1 }, customer.token);
    expect([200, 201], add.body).toContain(add.statusCode);
  }
  return customer;
}

async function promo(tag: string, data: Record<string, unknown>) {
  const row = await app.prisma.promoCode.create({
    data: { code: `SNAP${tag}${nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, description: tag, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5, ...data } as never,
  });
  createdPromoIds.push(row.id);
  return row;
}

async function checkout(token: string, body: Record<string, unknown>) {
  const res = await inject('POST', '/api/v1/customer/checkout', body, token);
  expect([200, 201], res.body).toContain(res.statusCode);
  const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
  return app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { items: true, promoRedemption: true } });
}

async function returned(orderId: string, token: string) {
  await app.prisma.order.update({ where: { id: orderId }, data: { status: 'DELIVERED', deliveredAt: new Date() } });
  const res = await inject('POST', `/api/v1/customer/orders/${orderId}/return`, { reason: 'Arrived damaged, all of it' }, token);
  expect(res.statusCode, res.body).toBe(201);
  return res.json().data as { refundAmount: unknown; refundSentence: string; refundBasis: string; refundInferredAmount: unknown; refundFunder: string | null; refundKind: string };
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.example.com';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.returnRequest.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
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
  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'SNAP' } } });
  // The return route's velocity guard buckets by device/IP as well as actor;
  // under app.inject every test shares one IP, so repeated local runs would
  // exhaust the daily bucket and answer 429 instead of the refund.
  const buckets = await app.redis.keys('vel:return.request:*');
  if (buckets.length) await app.redis.del(...buckets);
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  shop = await makeStore(owner.userId);
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.returnRequest.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdPromoIds.length) await app.prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } });
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

describe('[M-33] the allocation is written at checkout', () => {
  it('a platform goods code: each line owns its share, the shares sum exactly to the goods discount, and the refund policy is recorded', async () => {
    const customer = await shopper();
    const code = await promo('G', { discountType: 'FIXED_AMOUNT', discountValue: 430, funder: 'PLATFORM' });
    const order = await checkout(customer.token, { paymentMethod: 'CASH', promoCode: code.code, fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } });
    expect(Number(order.discount)).toBe(430);
    const snap = order.promoRedemption!;
    expect(snap.refundPolicy).toBe('ALG-25/M-33');
    const lines = snap.lineAllocations as Array<{ orderItemId: string; goods: number }>;
    const kettle = order.items.find((i) => i.name === 'Kettle')!;
    const fan = order.items.find((i) => i.name === 'Fan')!;
    expect(lines.find((l) => l.orderItemId === kettle.id)!.goods).toBe(120);
    expect(lines.find((l) => l.orderItemId === fan.id)!.goods).toBe(310);
    expect(lines.reduce((s, l) => s + l.goods, 0)).toBe(Number(snap.goodsDiscount));
  });
});

describe('[M-33] the register’s red test, end to end', () => {
  it('FREE_DELIVERY, delivered, everything returned: the store owes every goods dollar and no fee; Swift is named as the funder; the old inference is recorded as the shadow', async () => {
    const customer = await shopper();
    const code = await promo('F', { discountType: 'FREE_DELIVERY', discountValue: 0, funder: 'PLATFORM' });
    const order = await checkout(customer.token, { paymentMethod: 'MOBILE_MONEY', promoCode: code.code, fulfillmentSelections: { [shop.vendorId]: 'DELIVERY' } });
    const fee = Number(order.deliveryFee);
    expect(fee).toBeGreaterThan(0);
    expect(Number(order.discount)).toBe(fee);
    expect(Number(order.promoRedemption!.deliveryDiscount)).toBe(fee);
    expect(Number(order.promoRedemption!.goodsDiscount)).toBe(0);
    const row = await returned(order.id, customer.token);
    expect(row.refundKind).toBe('MMG_BLOCKED');
    expect(Number(row.refundAmount)).toBe(4300);
    expect(row.refundBasis).toBe('SNAPSHOT');
    expect(row.refundFunder).toBe('PLATFORM');
    expect(row.refundSentence).not.toContain('less');
    // the shadow: the aggregate inference would have under-refunded by the fee
    expect(Number(row.refundInferredAmount)).toBe(4300 - fee);
  });

  it("a vendor goods code: the return is net of the store's own discount, and the sentence says the store funded it", async () => {
    const customer = await shopper();
    const code = await promo('V', { discountType: 'PERCENTAGE', discountValue: 10, vendorId: shop.vendorId, funder: 'VENDOR' });
    const order = await checkout(customer.token, { paymentMethod: 'CASH', promoCode: code.code, fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } });
    expect(Number(order.discount)).toBe(430);
    const row = await returned(order.id, customer.token);
    expect(row.refundKind).toBe('CASH_POST_HANDOVER');
    expect(Number(row.refundAmount)).toBe(3870);
    expect(row.refundBasis).toBe('SNAPSHOT');
    expect(row.refundFunder).toBe('VENDOR');
    expect(row.refundSentence).toContain('less GY$430 of the discount they carried (funded by the store)');
  });

  it('a legacy order with no snapshot: computed by inference, marked, and counted by the review scan', async () => {
    const customer = await shopper();
    const code = await promo('L', { discountType: 'FIXED_AMOUNT', discountValue: 430, funder: 'PLATFORM' });
    const order = await checkout(customer.token, { paymentMethod: 'CASH', promoCode: code.code, fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } });
    await app.prisma.promoRedemption.delete({ where: { orderId: order.id } }); // the legacy shape
    const before = await scanInferredRefunds(app.prisma);
    const row = await returned(order.id, customer.token);
    expect(row.refundBasis).toBe('INFERRED');
    expect(Number(row.refundAmount)).toBe(3870);
    expect(Number(row.refundInferredAmount)).toBe(3870);
    expect(row.refundSentence).toContain('review before settling');
    const after = await scanInferredRefunds(app.prisma);
    expect(after.inferredOpen).toBe(before.inferredOpen + 1);
    const gauge = await refundsAwaitingReviewGauge.get();
    expect(gauge.values[0]!.value).toBe(after.inferredOpen + after.legacyOpen);
  });
});
