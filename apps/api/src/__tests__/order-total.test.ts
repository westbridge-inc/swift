import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { computeOrderTotal, lineTotal, orderTotal, promoDiscount, subtotalOf } from '../utils/order-total';

// ---------------------------------------------------------------------------
// [ALG-24 · ALG-INV-1] Order-total determinism.
//
// The cart quote and checkout each carried their own copy of the total —
// line totals, the promo switch and its cap, the tip, the clamp — and a
// third copy priced the "apply promo" estimate. Three places where one
// formula lived is how a quote and a charge drift with nobody changing
// either on purpose. Now there is one calculator; this file is its law:
// declared rounding, the same answer on every recompute, and the replay —
// the quote, the charge and a fresh recompute from the stored inputs agree.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200657';
const STORE = { lat: 6.8010, lng: -58.1560 };

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdPromoIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Total', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/t.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'total', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function makeShop(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Total Kitchen', slug: `total-kitchen-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}98`, addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, deliveryRadius: 25,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } });
  const dish = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Cook-up', basePrice: 1200 } });
  const side = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Plantain', basePrice: 350 } });
  return { vendorId: vendor.id, dish, side };
}

function inject(method: 'GET' | 'POST', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

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
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();

  const orphans = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  if (orphans.length) {
    const ids = orphans.map((u) => u.id);
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: ids } } });
    const vos = await app.prisma.vendorOwner.findMany({ where: { userId: { in: ids } }, select: { id: true } });
    const voIds = vos.map((v) => v.id);
    await app.prisma.promoCode.deleteMany({ where: { vendor: { ownerId: { in: voIds } } } });
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
});

afterAll(async () => {
  if (createdUserIds.length) {
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

describe('the declared arithmetic', () => {
  it('a line is unit price × quantity; the subtotal is the sum of lines', () => {
    expect(lineTotal(1200, 3)).toBe(3600);
    expect(subtotalOf([{ unitPrice: 1200, quantity: 3 }, { unitPrice: 350, quantity: 2 }])).toBe(4300);
    expect(subtotalOf([])).toBe(0);
  });

  it('the promo switch: percentage rounds UP, fixed is stated, free delivery is the fee, every shape is capped', () => {
    const basis = { subtotal: 4300, deliveryFee: 500 };
    expect(promoDiscount({ discountType: 'PERCENTAGE', discountValue: '15' }, basis)).toBe(645);
    expect(promoDiscount({ discountType: 'PERCENTAGE', discountValue: 12.5 }, basis)).toBe(538); // 537.5 → up, never truncated against the customer
    expect(promoDiscount({ discountType: 'PERCENTAGE', discountValue: 15, maxDiscount: 300 }, basis)).toBe(300);
    expect(promoDiscount({ discountType: 'FIXED_AMOUNT', discountValue: '250' }, basis)).toBe(250);
    expect(promoDiscount({ discountType: 'FIXED_AMOUNT', discountValue: 900, maxDiscount: 400 }, basis)).toBe(400);
    expect(promoDiscount({ discountType: 'FREE_DELIVERY', discountValue: 0 }, basis)).toBe(500);
    expect(promoDiscount({ discountType: 'SOMETHING_NEW', discountValue: 99 }, basis)).toBe(0);
  });

  it('the total never goes below zero', () => {
    expect(orderTotal({ subtotal: 4300, deliveryFee: 500, tip: 200, discount: 645 })).toBe(4355);
    expect(orderTotal({ subtotal: 100, deliveryFee: 0, tip: 0, discount: 900 })).toBe(0);
    expect(orderTotal({ subtotal: 100, deliveryFee: 0, tip: 0, discount: 0, serviceFee: 0, tax: 0 })).toBe(100);
  });

  it('the composed calculation, and the same inputs give the same output on every call', () => {
    const input = { lines: [{ unitPrice: 1200, quantity: 3 }, { unitPrice: 350, quantity: 2 }], deliveryFee: 500, tip: 200, promo: { discountType: 'PERCENTAGE', discountValue: 15, maxDiscount: 300 } };
    const a = computeOrderTotal(input);
    expect(a).toEqual({ subtotal: 4300, deliveryFee: 500, discount: 300, tip: 200, serviceFee: 0, tax: 0, total: 4700 });
    for (let i = 0; i < 25; i++) expect(computeOrderTotal(input)).toEqual(a);
  });
});

describe('[ALG-INV-1] the quote, the charge and a recompute agree', () => {
  // Promo codes are refused on CASH delivery orders by policy
  // (PROMO_UNAVAILABLE_CASH_DELIVERY), so the discount path is replayed on a
  // pickup and the fee + tip path on a delivery. Between them every
  // component of the total crosses the quote, the charge and a recompute.
  const linesOf = (items: Array<{ totalCustomer: unknown; quantity: number }>) =>
    items.map((i) => ({ unitPrice: Number(i.totalCustomer) / i.quantity, quantity: i.quantity }));

  async function shopper(drop: { lat: number; lng: number }) {
    const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
    await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '4 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: drop.lat, longitude: drop.lng, isDefault: true } });
    for (const [it, quantity] of [[shop.dish, 3], [shop.side, 2]] as const) {
      const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: it.id, quantity }, customer.token);
      expect([200, 201], add.body).toContain(add.statusCode);
    }
    const cart = await app.prisma.cart.findFirstOrThrow({ where: { customerId: customer.userId } });
    return { customer, cart };
  }

  it('a pickup with a capped percentage promo: discount and total agree three ways', async () => {
    const { customer, cart } = await shopper({ lat: 6.81, lng: -58.17 });
    const promo = await app.prisma.promoCode.create({
      data: {
        code: `TOTAL${nanoid(5).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`, description: 'fifteen off, capped', vendorId: shop.vendorId,
        discountType: 'PERCENTAGE', discountValue: 15, maxDiscount: 300, applicableTo: ['FOOD_DELIVERY'],
        validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), isActive: true, maxUsesPerUser: 5,
      },
    });
    createdPromoIds.push(promo.id);
    await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id } });

    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;
    expect(Number(q.subtotalCustomer)).toBe(4300);
    expect(Number(q.discount)).toBe(300);

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: promo.code, fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { items: true } });
    expect(Number(order.discount), 'quote ↔ charge (discount)').toBe(Number(q.discount));
    expect(Number(order.totalAmount)).toBe(4000);

    const again = computeOrderTotal({
      lines: linesOf(order.items), deliveryFee: Number(order.deliveryFee), tip: Number(order.tipAmount),
      promo: { discountType: promo.discountType, discountValue: promo.discountValue, maxDiscount: promo.maxDiscount },
    });
    expect(again.total, 'recompute ↔ charge').toBe(Number(order.totalAmount));
    expect(again.discount).toBe(Number(order.discount));
  });

  it('a delivery with a tip: fee, tip and total agree three ways', async () => {
    const { customer, cart } = await shopper({ lat: 6.8100, lng: -58.1700 });
    await app.prisma.cart.update({ where: { id: cart.id }, data: { tipAmount: 200 } });

    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', tipAmount: 200, fulfillmentSelections: { [shop.vendorId]: 'DELIVERY' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { items: true } });
    expect(Number(order.deliveryFee), 'quote ↔ charge (fee)').toBe(Number(q.deliveryFee));
    expect(Number(order.totalAmount), 'quote ↔ charge (total)').toBe(Number(q.totalAmount));
    expect(Number(order.tipAmount)).toBe(200);

    const again = computeOrderTotal({ lines: linesOf(order.items), deliveryFee: Number(order.deliveryFee), tip: Number(order.tipAmount) });
    expect(again.total, 'recompute ↔ charge').toBe(Number(order.totalAmount));
    expect(again.subtotal).toBe(4300);
  });
});

describe('one home for the formula (source pins)', () => {
  const src = (rel: string) => readFileSync(path.join(__dirname, '..', rel), 'utf8');
  it('the promo maths lives in utils/order-total.ts and nowhere else', () => {
    for (const rel of ['modules/user/customer.routes.ts', 'modules/order/order.service.ts']) {
      expect(src(rel), `${rel} grew its own percentage maths`).not.toMatch(/Math\.ceil\(\w+ \* \(Number\(promo\.discountValue\) \/ 100\)\)/);
      expect(src(rel), `${rel} caps a discount on its own`).not.toMatch(/Math\.min\(\w+, Number\(promo\.maxDiscount\)\)/);
    }
  });
  it('the total is summed in one place — the old inline sums are gone', () => {
    expect(src('modules/user/customer.routes.ts')).not.toContain('Math.max(0, subtotalCustomer + deliveryFee + tip - discount)');
    expect(src('modules/order/order.service.ts')).not.toContain('Math.max(0, plan.subtotal + plan.deliveryFee + planTip - planDiscount)');
    expect(src('modules/user/customer.routes.ts')).toContain('orderTotal({ subtotal: subtotalCustomer, deliveryFee, tip, discount })');
    expect(src('modules/order/order.service.ts')).toContain('orderTotal({ subtotal: plan.subtotal, deliveryFee: plan.deliveryFee, tip: planTip, discount: planDiscount })');
  });
});
