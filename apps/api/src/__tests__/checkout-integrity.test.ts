import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { expressDeliveryFee } from '../utils/markup';

// ---------------------------------------------------------------------------
// Pre-launch audit gaps: (1) checkout money math was only asserted "> 0" —
// a rounding/percentage regression could ship green; here we pin exact
// discount + express arithmetic. (2) IDOR was proven live but not guarded by
// an automated wrong-owner test in CI — one here so a refactor that drops an
// ownership predicate goes red.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
let seq = 0;
const phoneBase = 592_600_000_000 + Math.floor(Math.random() * 300_000_000);
let vendorId: string;
let itemId: string;
const ITEM_PRICE = 2000;
const PROMO = `INTG${nanoid(5).toUpperCase()}`;
let promoId: string;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Intg', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'intg', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  // Address very close to the vendor so the delivery fee is the deterministic minimum.
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Intg', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8014, longitude: -58.1552, isDefault: true } });
  return { userId: user.id, token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

async function cartAndCheckout(c: { token: string; addressId: string }, body: Record<string, unknown>) {
  await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
  await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
  return inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', ...body }, c.token);
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
  await app.ready();

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Intg', lastName: 'Vend', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Intg Diner', slug: `intg-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 901}`, addressLine1: '1 Intg', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Intg Plate', basePrice: ITEM_PRICE, isAvailable: true } });
  itemId = item.id;
  const promo = await app.prisma.promoCode.create({ data: { code: PROMO, description: '10% off', discountType: 'PERCENTAGE', discountValue: 10, validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() + 3600000), maxUses: 100, maxUsesPerUser: 5, isActive: true } });
  promoId = promo.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  if (promoId) await app.prisma.promoCode.deleteMany({ where: { id: promoId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('checkout money math', () => {
  it('applies an exact 10% discount on the subtotal', async () => {
    const c = await makeCustomer();
    // PICKUP: CASH-delivery promos fail closed by law [SPS-F-0022] — the
    // discount math itself is rail-independent and proven here on pickup.
    const res = await cartAndCheckout(c, { promoCode: PROMO, fulfillmentSelections: { [vendorId]: 'PICKUP' } });
    expect(res.statusCode).toBe(200);
    const order = res.json().data.orders[0];
    // 10% of 2000 = 200 (ceil). total = subtotal + fee - discount.
    expect(order.discount).toBe(200);
    expect(order.total).toBe(order.subtotal + order.deliveryFee - 200);
  });

  it('express multiplies the delivery fee by exactly 1.5', async () => {
    const std = await makeCustomer();
    const stdRes = await cartAndCheckout(std, {});
    const stdFee = stdRes.json().data.orders[0].deliveryFee;

    const exp = await makeCustomer();
    const expRes = await cartAndCheckout(exp, { express: true });
    const expOrder = expRes.json().data.orders[0];
    expect(expOrder.isExpress).toBe(true);
    expect(expOrder.deliveryFee).toBe(Math.round(stdFee * 1.5));
  });

  it('passes the tip through untouched into the total', async () => {
    const c = await makeCustomer();
    const res = await cartAndCheckout(c, { tipAmount: 500 });
    const order = res.json().data.orders[0];
    expect(order.tip).toBe(500);
    expect(order.total).toBe(order.subtotal + order.deliveryFee + 500 - (order.discount ?? 0));
  });

  it('an explicit tipAmount 0 overrides a persisted cart tip — nothing hidden rides the order or the MMG amount [REPORT-012 F-012-01]', async () => {
    process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.mmg.gy';
    await app.prisma.vendor.update({ where: { id: vendorId }, data: { mmgPayUrl: 'https://pay.mmg.gy/intg-diner' } });
    const c = await makeCustomer();
    await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
    // Another surface/session persisted a positive tip on the cart…
    const tipSet = await inject('PUT', '/api/v1/customer/cart/tip', { amount: 500 }, c.token);
    expect(tipSet.statusCode).toBe(200);
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
    // …then checkout displays 0 and SUBMITS 0. Truthiness (`||`) used to
    // resurrect the 500 into the order, the MMG instruction, and totalSpent.
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'MOBILE_MONEY', tipAmount: 0 }, c.token);
    expect(res.statusCode).toBe(200);
    const order = res.json().data.orders[0];
    expect(order.tip).toBe(0);
    expect(order.total).toBe(order.subtotal + order.deliveryFee);
    // The MMG payment instruction charges exactly what checkout displayed.
    const action = res.json().data.paymentAction;
    expect(action).not.toBeNull();
    expect(action.amount).toBe(order.total);
    // The accounting evidence carries no phantom either.
    const cust = await app.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect(Number(cust.totalSpent)).toBe(order.total);
  });

  it('a persisted cart tip on a PICKUP basket never inflates the ID-gate total or totalSpent [REPORT-012 F-012-01]', async () => {
    const c = await makeCustomer();
    await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
    const tipSet = await inject('PUT', '/api/v1/customer/cart/tip', { amount: 500 }, c.token);
    expect(tipSet.statusCode).toBe(200);
    // tipAmount OMITTED: the cart tip is inherited — but a pickup has no
    // rider, so no order carries it AND it must not inflate grandTotal (the
    // ID gate) or customer.totalSpent. Before the fix the phantom rode both.
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
    expect(res.statusCode).toBe(200);
    const order = res.json().data.orders[0];
    expect(order.tip).toBe(0);
    const cust = await app.prisma.customer.findUniqueOrThrow({ where: { userId: c.userId } });
    expect(Number(cust.totalSpent)).toBe(order.total); // no +500 phantom in the evidence
  });

  it('FREE_DELIVERY on a CASH delivery is refused (rider-financed promo — 409 PROMO_UNAVAILABLE_CASH_DELIVERY)', async () => {
    const code = `FREEDEL${nanoid(5).toUpperCase()}`;
    const promo = await app.prisma.promoCode.create({
      data: { code, description: 'free delivery', discountType: 'FREE_DELIVERY', discountValue: 0, validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() + 3600000), maxUses: 100, maxUsesPerUser: 5, isActive: true },
    });
    try {
      const c = await makeCustomer();
      // [SPS-F-0022] FREE_DELIVERY on a CASH platform-delivery was the sharpest
      // rider-financed promo: the rider fronted full goods value, collected a
      // total missing the fee, and their "fee earning" was funded by nobody.
      // The law now refuses this combination at checkout. (The waiver math
      // remains live for MMG deliveries, where the store absorbs its promo.)
      const res = await cartAndCheckout(c, { promoCode: code });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('PROMO_UNAVAILABLE_CASH_DELIVERY');
    } finally {
      await app.prisma.promoCode.delete({ where: { id: promo.id } });
    }
  });
});

describe('availability guardrail — a 86ed item never gets charged', () => {
  it('rejects checkout with ITEM_UNAVAILABLE when a cart item was marked unavailable', async () => {
    const c = await makeCustomer();
    await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
    // Vendor 86's the dish between add-to-cart and checkout (untracked stock).
    await app.prisma.item.update({ where: { id: itemId }, data: { isAvailable: false } });
    try {
      const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH' }, c.token);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('ITEM_UNAVAILABLE');
    } finally {
      await app.prisma.item.update({ where: { id: itemId }, data: { isAvailable: true } });
    }
  });
});

describe('cash-only guardrail — orders never carry an in-app payment method', () => {
  it('rejects CARD as an order payment method', async () => {
    const c = await makeCustomer();
    const res = await cartAndCheckout(c, { paymentMethod: 'CARD' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('rejects BANK_TRANSFER as an order payment method', async () => {
    const c = await makeCustomer();
    const res = await cartAndCheckout(c, { paymentMethod: 'BANK_TRANSFER' });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('accepts CASH (the default cash-only path)', async () => {
    const c = await makeCustomer();
    const res = await cartAndCheckout(c, { paymentMethod: 'CASH' });
    expect(res.statusCode).toBe(200);
  });
});

describe('IDOR — wrong owner (CI guard for the live-proven protection)', () => {
  it('a customer cannot read or cancel another customer’s order', async () => {
    const victim = await makeCustomer();
    const attacker = await makeCustomer();
    const placed = await cartAndCheckout(victim, {});
    const orderId = placed.json().data.orders[0].id;

    const read = await inject('GET', `/api/v1/customer/orders/${orderId}`, undefined, attacker.token);
    expect(read.statusCode).toBe(404);
    const cancel = await inject('POST', `/api/v1/customer/orders/${orderId}/cancel`, { reason: 'hijack' }, attacker.token);
    expect(cancel.statusCode).toBeGreaterThanOrEqual(400);

    // the victim still can
    const ok = await inject('GET', `/api/v1/customer/orders/${orderId}`, undefined, victim.token);
    expect(ok.statusCode).toBe(200);
  });
});

describe('high-value promo gate [SWIFT-162]', () => {
  // A pricey item + a huge FIXED discount: the discount clears the ID-gate while
  // the NET total stays far below it — so the order-TOTAL gate cannot fire, and
  // a 403 here can only be the promo-value gate.
  async function bigPromoSetup(label: string) {
    const cat = await app.prisma.category.create({ data: { vendorId, name: label, sortOrder: 9 } });
    const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: `${label} Plate`, basePrice: 100500, isAvailable: true } });
    const code = `BIG${nanoid(6).toUpperCase()}`;
    const promo = await app.prisma.promoCode.create({ data: { code, description: 'big', discountType: 'FIXED_AMOUNT', discountValue: 100000, validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() + 3600000), maxUses: 100, maxUsesPerUser: 5, isActive: true } });
    return { cat, item, code, promo };
  }
  async function cleanup(s: { cat: { id: string }; item: { id: string }; promo: { id: string } }) {
    await app.prisma.order.deleteMany({ where: { promoCodeId: s.promo.id } }); // cascades order items
    await app.prisma.promoCode.delete({ where: { id: s.promo.id } }).catch(() => {});
    await app.prisma.item.delete({ where: { id: s.item.id } }).catch(() => {}); // itemId is a loose ref — safe
    await app.prisma.category.delete({ where: { id: s.cat.id } }).catch(() => {});
  }

  it('an L1 account cannot redeem a high-value promo without ID verification', async () => {
    const s = await bigPromoSetup('L1Big');
    try {
      const c = await makeCustomer(); // trustLevel L1 by default
      await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: s.item.id, quantity: 1 }, c.token);
      await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
      // PICKUP: the CASH-delivery promo law [SPS-F-0022] would otherwise 409
      // before this test's subject (the SWIFT-162 promo-value ID gate).
      const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: s.code, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, c.token);
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('ID_VERIFICATION_REQUIRED');
      expect(res.json().error.message).toMatch(/promo/i); // the promo-value gate, not the order-total gate
    } finally {
      await cleanup(s);
    }
  });

  it('an ID-verified (L2) account redeems the same high-value promo fine', async () => {
    const s = await bigPromoSetup('L2Big');
    try {
      seq += 1;
      const user = await app.prisma.user.create({
        data: {
          phone: `+${phoneBase + 700000 + seq}`, firstName: 'Intg', lastName: `L2${seq}`,
          roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true,
          selfieCapturedAt: new Date(), trustLevel: 'L2', customer: { create: {} },
        },
      });
      createdUserIds.push(user.id);
      const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
      await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'intg', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
      const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Intg', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8014, longitude: -58.1552, isDefault: true } });
      await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: s.item.id, quantity: 1 }, token);
      await inject('PUT', '/api/v1/customer/cart/address', { addressId: addr.id }, token);
      const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: s.code, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, token);
      expect(res.statusCode).toBe(200); // L2 is verified — the gate does not apply
    } finally {
      await cleanup(s);
    }
  });
});

describe('express surcharge is server-owned [SWIFT-070]', () => {
  it('the cart quotes the express surcharge, and checkout charges exactly that', async () => {
    const c = await makeCustomer();
    await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
    await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);

    const cart = (await inject('GET', '/api/v1/customer/cart', undefined, c.token)).json().data;
    // The surcharge is DERIVED ON THE SERVER from the standard fee — the client
    // renders it, never recomputes it (rule 17).
    expect(cart.expressSurcharge).toBe(expressDeliveryFee(cart.deliveryFee) - cart.deliveryFee);
    expect(cart.expressTotal).toBe(cart.totalAmount + cart.expressSurcharge);

    // Checkout with express charges the base fee + EXACTLY the quoted surcharge —
    // the preview and the charge are the same number, from the same helper.
    const placed = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', express: true }, c.token);
    expect(placed.statusCode).toBe(200);
    const order = placed.json().data.orders[0];
    expect(order.deliveryFee).toBe(cart.deliveryFee + cart.expressSurcharge);
  });
});
