import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerAuthRoutes } from './helpers/auth-routes-harness';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { loginWithOtp } from './helpers/otp';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [Ruling 1 Nov 2026 · REVIEW-M N1 · GUARDRAILS §1] Swift-paid promo codes are OFF.
//
// Swift never holds or moves order money, so a discount Swift pays (funder PLATFORM) on a
// store's order would leave Swift owing money. The admin route still created them. Now:
// no Swift-paid code is created; an existing one cannot be changed except switched off; and an
// old Swift-paid row, even one still marked active, never discounts a quote, is never accepted by
// /promo/validate and is never redeemed at checkout. A store's own code works as before.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200812';
const STORE = { lat: 6.8010, lng: -58.1560 };
const DROP = { lat: 6.8100, lng: -58.1700 };

let app: FastifyInstance;
let adminToken: string;
const createdUserIds: string[] = [];
const createdVendorIds: string[] = [];
const createdPromoIds: string[] = [];
let seq = 0;

async function makeUser(roles: UserRole[], activeRole: UserRole) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Paid', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/t.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'paid', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload: unknown, token: string) {
  return injectWithApproval(app, { method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` } });
}

let vendorId = '';
let dishId = '';

async function shopper() {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '4 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: DROP.lat, longitude: DROP.lng, isDefault: true } });
  const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId: dishId, quantity: 1 }, customer.token);
  expect([200, 201], add.body).toContain(add.statusCode);
  const cart = await app.prisma.cart.findFirstOrThrow({ where: { customerId: customer.userId } });
  return { customer, cart };
}

const code = (tag: string) => `PAIDOFF${tag}${nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;

/** An OLD Swift-paid row, as one made before the switch-off would sit in the table: active, in date. */
async function oldSwiftPaidCode(tag: string, extra: Record<string, unknown> = {}) {
  const promo = await app.prisma.promoCode.create({
    data: { code: code(tag), description: 'old Swift-paid offer', discountType: 'FIXED_AMOUNT', discountValue: 500, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5, funder: 'PLATFORM', ...extra },
  });
  createdPromoIds.push(promo.id);
  return promo;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  delete process.env['SWIFT_PAID_PROMOS']; // the default: off
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await registerAuthRoutes(app);
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'PAIDOFF' } } });
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
  const owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Paid Off Kitchen', slug: `paid-off-kitchen-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}98`, addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, deliveryRadius: 25,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorId = vendor.id;
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId, name: 'Mains', sortOrder: 0 } });
  dishId = (await app.prisma.item.create({ data: { vendorId, categoryId: category.id, name: 'Cook-up', basePrice: 1200 } })).id;
});

afterAll(async () => {
  if (createdUserIds.length) {
    await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: createdUserIds } } } });
    await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
    await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  }
  if (createdPromoIds.length) await app.prisma.promoCode.deleteMany({ where: { id: { in: createdPromoIds } } });
  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'PAIDOFF' } } });
  if (createdVendorIds.length) {
    await app.prisma.promoCode.deleteMany({ where: { vendorId: { in: createdVendorIds } } });
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

describe('the admin console cannot make or revive a Swift-paid code', () => {
  it('creating a promo (always Swift-paid) is refused in plain words, and nothing is written', async () => {
    const c = code('NEW');
    const res = await inject('POST', '/api/v1/admin/promos', {
      code: c, description: 'Swift pays 10%', discountType: 'PERCENTAGE', discountValue: 10,
      validFrom: new Date(Date.now() - DAY).toISOString(), validUntil: new Date(Date.now() + 7 * DAY).toISOString(),
    }, adminToken);
    expect(res.statusCode, res.body).toBe(403);
    expect(res.json().error.code).toBe('SWIFT_PAID_PROMOS_OFF');
    expect(res.json().error.message).toMatch(/Swift-paid promo codes are switched off/);
    expect(res.json().error.message).toMatch(/A store can still make its own promo code/);
    expect(await app.prisma.promoCode.count({ where: { code: c } })).toBe(0);
  });

  it('an old Swift-paid code cannot be changed or restored, only switched off', async () => {
    const promo = await oldSwiftPaidCode('EDIT');
    const edit = await inject('PUT', `/api/v1/admin/promos/${promo.id}`, { discountValue: 900 }, adminToken);
    expect(edit.statusCode, edit.body).toBe(403);
    expect(edit.json().error.code).toBe('SWIFT_PAID_PROMOS_OFF');
    const revive = await inject('PUT', `/api/v1/admin/promos/${promo.id}`, { isActive: true, validUntil: new Date(Date.now() + 30 * DAY).toISOString() }, adminToken);
    expect(revive.statusCode, revive.body).toBe(403);
    const rollback = await inject('POST', `/api/v1/admin/promos/${promo.id}/rollback`, {}, adminToken);
    expect(rollback.statusCode, rollback.body).toBe(403);
    expect(rollback.json().error.code).toBe('SWIFT_PAID_PROMOS_OFF');
    const unchanged = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } });
    expect(Number(unchanged.discountValue)).toBe(500);
    expect(unchanged.termsVersion).toBe(promo.termsVersion);

    const off = await inject('PUT', `/api/v1/admin/promos/${promo.id}`, { isActive: false }, adminToken);
    expect(off.statusCode, off.body).toBe(200);
    expect((await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).isActive).toBe(false);
  });
});

describe('an old Swift-paid row never discounts anything', () => {
  it('/promo/validate refuses it and does not attach it to the cart', async () => {
    const promo = await oldSwiftPaidCode('VAL');
    const { customer, cart } = await shopper();
    const res = await inject('POST', '/api/v1/customer/promo/validate', { code: promo.code }, customer.token);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PROMO');
    expect((await app.prisma.cart.findUniqueOrThrow({ where: { id: cart.id } })).promoCodeId).toBeNull();
  });

  it('a cart that already carries it is quoted with no discount', async () => {
    const promo = await oldSwiftPaidCode('QUOTE');
    const { customer, cart } = await shopper();
    await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id } });
    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    expect(Number(quote.json().data.discount ?? 0)).toBe(0);
  });

  it('checkout refuses it: no order, no redemption, its use count does not move', async () => {
    const promo = await oldSwiftPaidCode('CHK');
    const { customer } = await shopper();
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: promo.code, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, customer.token);
    expect(res.statusCode, res.body).toBe(400);
    expect(res.json().error.code).toBe('INVALID_PROMO');
    expect(await app.prisma.order.count({ where: { customerId: customer.userId } })).toBe(0);
    expect((await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promo.id } })).currentUses).toBe(0);
  });

  it('a store-scoped row that took the PLATFORM default is Swift-paid too, and is not advertised on the storefront', async () => {
    const promo = await oldSwiftPaidCode('STOREDEF', { vendorId });
    const { customer } = await shopper();
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: promo.code, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, customer.token);
    expect(res.statusCode, res.body).toBe(400);
    const store = await inject('GET', `/api/v1/customer/vendors/${vendorId}`, undefined, customer.token);
    expect(store.statusCode, store.body).toBe(200);
    expect(JSON.stringify(store.json().data.activePromos ?? [])).not.toContain(promo.code);
  });
});

describe('a store’s own code is untouched', () => {
  it('a store-funded code validates and discounts the goods at checkout', async () => {
    const promo = await app.prisma.promoCode.create({
      data: { code: code('STORE'), description: 'store pays', discountType: 'FIXED_AMOUNT', discountValue: 200, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5, funder: 'VENDOR', vendorId },
    });
    createdPromoIds.push(promo.id);
    const { customer } = await shopper();
    const ok = await inject('POST', '/api/v1/customer/promo/validate', { code: promo.code }, customer.token);
    expect(ok.statusCode, ok.body).toBe(200);
    const store = await inject('GET', `/api/v1/customer/vendors/${vendorId}`, undefined, customer.token);
    expect(JSON.stringify(store.json().data.activePromos ?? [])).toContain(promo.code);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: promo.code, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { promoRedemption: true } });
    expect(Number(order.discount)).toBe(200);
    expect(order.promoRedemption?.funder).toBe('VENDOR');
  });
});
