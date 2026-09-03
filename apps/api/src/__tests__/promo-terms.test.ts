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
import { authRoutes } from '../modules/auth/auth.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { loginWithOtp } from './helpers/otp';
import { allocatePromo, promoCapacity, promoDiscount } from '../utils/order-total';
import { mergedPromoTerms, promoTermsProblems, scanPromoFunding } from '../modules/promo/promo-terms';
import { promoFundingGauge } from '../plugins/observability';
import { TEST_ADMIN_REASON } from './helpers/admin-reason';
import { injectWithApproval } from './helpers/admin-approval';

// ---------------------------------------------------------------------------
// [M-32] Promo update bypasses creation bounds; redeemed value lacks a
// component/funder snapshot.
//
// The register's red tests: the hostile update matrix (200%, a huge fixed
// value, inverted dates, a zero cap read as no cap) must be refused as the
// MERGED record and leave the promo untouched; and a promo exceeding goods
// plus fee on an order with a tip must preserve the fully funded tip and
// identify the sponsor of every discounted dollar. Around them: immutable
// terms versions with rollback pinning a prior one, the database carrying the
// same bounds, and the scan that reports what the law would have caught.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const PHONE_PREFIX = '+59200811';
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
      phone: `${PHONE_PREFIX}${String(seq).padStart(2, '0')}`, firstName: 'Terms', lastName: `User${seq}`,
      roles, activeRole, isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/t.jpg',
      ...(roles.includes('CUSTOMER') && { customer: { create: {} } }),
    },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'terms', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
  return { userId: user.id, token };
}

async function makeShop(ownerUserId: string) {
  const vo = await app.prisma.vendorOwner.create({ data: { userId: ownerUserId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Terms Kitchen', slug: `terms-kitchen-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}98`, addressLine1: '7 Robb Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: STORE.lat, longitude: STORE.lng, deliveryRadius: 25,
      status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
      mmgPayUrl: 'https://pay.example.com/pay/terms-kitchen',
    },
  });
  createdVendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, name: 'Mains', sortOrder: 0 } });
  const dish = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: 'Cook-up', basePrice: 1200 } });
  return { vendorId: vendor.id, dish };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return injectWithApproval(app, { method, url, ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}), headers: { ...(url.includes('/api/v1/admin') ? { 'x-swift-reason': TEST_ADMIN_REASON } : {}), 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

async function shopper() {
  const customer = await makeUser(['CUSTOMER'], 'CUSTOMER');
  await app.prisma.address.create({ data: { userId: customer.userId, label: 'Home', addressLine1: '4 Camp Street', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: DROP.lat, longitude: DROP.lng, isDefault: true } });
  const add = await inject('POST', '/api/v1/customer/cart/items', { vendorId: shop.vendorId, itemId: shop.dish.id, quantity: 1 }, customer.token);
  expect([200, 201], add.body).toContain(add.statusCode);
  const cart = await app.prisma.cart.findFirstOrThrow({ where: { customerId: customer.userId } });
  return { customer, cart };
}

let shop: Awaited<ReturnType<typeof makeShop>>;
let owner: { userId: string; token: string };

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  process.env['MMG_PAY_URL_ALLOWED_HOSTS'] = 'pay.example.com';
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
  await app.prisma.promoCode.deleteMany({ where: { code: { startsWith: 'TERMS' } } });
  const login = await loginWithOtp(app, '+5926001000'); // seeded SUPER_ADMIN
  adminToken = login.json().data.tokens.accessToken;
  owner = await makeUser(['VENDOR_OWNER', 'CUSTOMER'], 'VENDOR_OWNER');
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

const code = (tag: string) => `TERMS${tag}${nanoid(4).toUpperCase().replace(/[^A-Z0-9]/g, 'X')}`;
const window = () => ({ validFrom: new Date(Date.now() - DAY).toISOString(), validUntil: new Date(Date.now() + 7 * DAY).toISOString() });

describe('the law (pure)', () => {
  const valid = { discountType: 'PERCENTAGE', discountValue: 15, validFrom: new Date(0), validUntil: new Date(DAY), maxUsesPerUser: 1 };
  it('names every way the terms are invalid; valid terms have no problems; an explicit zero cap is valid', () => {
    expect(promoTermsProblems(valid)).toEqual([]);
    expect(promoTermsProblems({ ...valid, maxDiscount: 0 })).toEqual([]);
    expect(promoTermsProblems({ ...valid, discountValue: 200 })).toContain('a percentage discount cannot exceed 100');
    expect(promoTermsProblems({ ...valid, discountType: 'FIXED_AMOUNT', discountValue: 1e12 })).toContain('discountValue cannot exceed 10000000');
    expect(promoTermsProblems({ ...valid, validFrom: new Date(DAY), validUntil: new Date(0) })).toContain('validUntil must be after validFrom');
    expect(promoTermsProblems({ ...valid, validFrom: new Date(DAY), validUntil: new Date(DAY) })).toContain('validUntil must be after validFrom');
    expect(promoTermsProblems({ ...valid, maxDiscount: -1 })[0]).toMatch(/maxDiscount/);
    expect(promoTermsProblems({ ...valid, maxUses: 0 })[0]).toMatch(/maxUses must/);
    expect(promoTermsProblems({ ...valid, maxUsesPerUser: 0 })[0]).toMatch(/maxUsesPerUser/);
    expect(promoTermsProblems({ ...valid, discountValue: -5 })).toContain('discountValue must be zero or more');
  });
  it('an update is judged as the MERGED record: a new end before the stored start is invalid, and an untouched field keeps its stored value', () => {
    const existing = { discountType: 'PERCENTAGE', discountValue: 15, minOrderAmount: null, maxDiscount: null, validFrom: new Date(5 * DAY), validUntil: new Date(9 * DAY), maxUses: null, maxUsesPerUser: 2 };
    const merged = mergedPromoTerms(existing, { validUntil: new Date(DAY) });
    expect(merged.validFrom).toEqual(new Date(5 * DAY));
    expect(promoTermsProblems(merged)).toContain('validUntil must be after validFrom');
    expect(mergedPromoTerms(existing, { maxDiscount: 0 }).maxDiscount).toBe(0);
    expect(mergedPromoTerms(existing, {}).maxUsesPerUser).toBe(2);
  });
  it('the promo switch: an explicit zero cap discounts nothing; null means uncapped', () => {
    const basis = { subtotal: 4300, deliveryFee: 500 };
    expect(promoDiscount({ discountType: 'PERCENTAGE', discountValue: 15, maxDiscount: 0 }, basis)).toBe(0);
    expect(promoDiscount({ discountType: 'FIXED_AMOUNT', discountValue: 900, maxDiscount: 0 }, basis)).toBe(0);
    expect(promoDiscount({ discountType: 'PERCENTAGE', discountValue: 15, maxDiscount: null }, basis)).toBe(645);
  });
  it('capacity and allocation by funder: goods, then the fee for a platform code; a vendor code stops at goods; the tip is never touched', () => {
    const basis = { subtotal: 1200, deliveryFee: 500 };
    expect(promoCapacity('PLATFORM', basis)).toBe(1700);
    expect(promoCapacity('VENDOR', basis)).toBe(1200);
    expect(allocatePromo('PLATFORM', 10_000, basis)).toEqual({ goods: 1200, delivery: 500, tip: 0, total: 1700 });
    expect(allocatePromo('VENDOR', 5_000, basis)).toEqual({ goods: 1200, delivery: 0, tip: 0, total: 1200 });
    expect(allocatePromo('PLATFORM', 300, basis)).toEqual({ goods: 300, delivery: 0, tip: 0, total: 300 });
    expect(allocatePromo('PLATFORM', 1400, basis)).toEqual({ goods: 1200, delivery: 200, tip: 0, total: 1400 });
    expect(allocatePromo('PLATFORM', -5, basis).total).toBe(0);
    // a free-delivery code discounts the FEE component only — never goods
    expect(promoCapacity('PLATFORM', basis, 'FREE_DELIVERY')).toBe(500);
    expect(allocatePromo('PLATFORM', 500, basis, 'FREE_DELIVERY')).toEqual({ goods: 0, delivery: 500, tip: 0, total: 500 });
    expect(allocatePromo('VENDOR', 500, basis, 'FREE_DELIVERY').total).toBe(0);
  });
});

describe('the register’s red test: the hostile update matrix', () => {
  let promoId: string;
  it('an admin code is created under the law with version 1 of its terms and a named funder', async () => {
    const res = await inject('POST', '/api/v1/admin/promos', { code: code('A'), description: 'fifteen off', discountType: 'PERCENTAGE', discountValue: 15, ...window(), maxUsesPerUser: 5 }, adminToken);
    expect(res.statusCode, res.body).toBe(200);
    promoId = res.json().data.id; createdPromoIds.push(promoId);
    expect(res.json().data.funder).toBe('PLATFORM');
    expect(res.json().data.termsVersion).toBe(1);
    const terms = await app.prisma.promoTerms.findMany({ where: { promoCodeId: promoId } });
    expect(terms).toHaveLength(1);
    expect(terms[0]!.version).toBe(1);
    expect(Number(terms[0]!.discountValue)).toBe(15);
    // creation itself refuses an inverted window
    const inverted = await inject('POST', '/api/v1/admin/promos', { code: code('B'), description: 'x', discountType: 'FIXED_AMOUNT', discountValue: 100, validFrom: new Date(Date.now() + 7 * DAY).toISOString(), validUntil: new Date(Date.now() - DAY).toISOString() }, adminToken);
    expect(inverted.statusCode).toBe(400);
  });
  it('200 percent, a huge fixed value, inverted dates, a negative cap — each refused, the row untouched, no new version', async () => {
    const before = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promoId } });
    const hostile: Array<[Record<string, unknown>, string | null]> = [
      [{ discountValue: 200 }, 'INVALID_PROMO_TERMS'],
      [{ discountValue: 1e12 }, null],
      [{ validUntil: new Date(before.validFrom.getTime() - DAY).toISOString() }, 'INVALID_PROMO_TERMS'],
      [{ validFrom: new Date(before.validUntil.getTime() + DAY).toISOString() }, 'INVALID_PROMO_TERMS'],
      [{ maxDiscount: -1 }, null],
      [{ maxUsesPerUser: 0 }, null],
    ];
    for (const [patch, codeExpected] of hostile) {
      const res = await inject('PUT', `/api/v1/admin/promos/${promoId}`, patch, adminToken);
      expect(res.statusCode, `${JSON.stringify(patch)} → ${res.body}`).toBe(400);
      if (codeExpected) expect(res.json().error.code).toBe(codeExpected);
    }
    const after = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promoId } });
    expect(after).toEqual(before);
    expect(await app.prisma.promoTerms.count({ where: { promoCodeId: promoId } })).toBe(1);
  });
  it('a valid change of terms writes an immutable new version; a copy change does not; rollback pins the prior version as a NEW one', async () => {
    const zeroCap = await inject('PUT', `/api/v1/admin/promos/${promoId}`, { maxDiscount: 0 }, adminToken);
    expect(zeroCap.statusCode, zeroCap.body).toBe(200);
    expect(zeroCap.json().data.termsVersion).toBe(2);
    expect(Number(zeroCap.json().data.maxDiscount)).toBe(0);
    const reworded = await inject('PUT', `/api/v1/admin/promos/${promoId}`, { description: 'fifteen off, capped at nothing' }, adminToken);
    expect(reworded.statusCode).toBe(200);
    expect(reworded.json().data.termsVersion).toBe(2);
    const v1 = await app.prisma.promoTerms.findUniqueOrThrow({ where: { promoCodeId_version: { promoCodeId: promoId, version: 1 } } });
    const v2 = await app.prisma.promoTerms.findUniqueOrThrow({ where: { promoCodeId_version: { promoCodeId: promoId, version: 2 } } });
    expect(v1.maxDiscount).toBeNull();
    expect(Number(v2.maxDiscount)).toBe(0);

    const back = await inject('POST', `/api/v1/admin/promos/${promoId}/rollback`, {}, adminToken);
    expect(back.statusCode, back.body).toBe(200);
    expect(back.json().data.restoredFrom).toBe(1);
    expect(back.json().data.termsVersion).toBe(3);
    expect(back.json().data.maxDiscount).toBeNull();
    const v3 = await app.prisma.promoTerms.findUniqueOrThrow({ where: { promoCodeId_version: { promoCodeId: promoId, version: 3 } } });
    expect(v3.restoredFrom).toBe(1);
    expect(v3.maxDiscount).toBeNull();
    // history untouched
    expect(await app.prisma.promoTerms.findUniqueOrThrow({ where: { promoCodeId_version: { promoCodeId: promoId, version: 2 } } })).toEqual(v2);
    const nowhere = await inject('POST', `/api/v1/admin/promos/${promoId}/rollback`, { version: 99 }, adminToken);
    expect(nowhere.statusCode).toBe(400);
    expect(nowhere.json().error.code).toBe('NO_SUCH_VERSION');
  });
  it('the database carries the same bounds: a raw write past them is refused', async () => {
    await expect(app.prisma.$executeRaw`UPDATE "promo_codes" SET "discountValue" = 200 WHERE "id" = ${promoId}`).rejects.toThrow(/promo_codes_percentage_check/);
    await expect(app.prisma.$executeRaw`UPDATE "promo_codes" SET "validUntil" = "validFrom" WHERE "id" = ${promoId}`).rejects.toThrow(/promo_codes_window_check/);
    await expect(app.prisma.$executeRaw`UPDATE "promo_codes" SET "maxUsesPerUser" = 0 WHERE "id" = ${promoId}`).rejects.toThrow(/promo_codes_uses_check/);
  });
  it("the vendor's own route obeys the same law: its code is VENDOR-funded with version 1, and an end date before the start is refused as the merged record", async () => {
    const res = await inject('POST', '/api/v1/vendor/promos', { code: code('V'), description: 'ten off', discountType: 'PERCENTAGE', discountValue: 10, validUntil: new Date(Date.now() + 7 * DAY).toISOString() }, owner.token);
    expect(res.statusCode, res.body).toBe(200);
    const vendorPromo = res.json().data; createdPromoIds.push(vendorPromo.id);
    expect(vendorPromo.funder).toBe('VENDOR');
    expect(vendorPromo.termsVersion).toBe(1);
    expect(await app.prisma.promoTerms.count({ where: { promoCodeId: vendorPromo.id } })).toBe(1);
    const bad = await inject('PUT', `/api/v1/vendor/promos/${vendorPromo.id}`, { validUntil: new Date(Date.now() - 2 * DAY).toISOString() }, owner.token);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('INVALID_PROMO_TERMS');
    const ok = await inject('PUT', `/api/v1/vendor/promos/${vendorPromo.id}`, { validUntil: new Date(Date.now() + 14 * DAY).toISOString() }, owner.token);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.termsVersion).toBe(2);
  });
});

describe('the register’s red test: a promo larger than goods plus fee, on an order with a tip', () => {
  async function platformCode(tag: string, discountValue: number, extra: Record<string, unknown> = {}) {
    const promo = await app.prisma.promoCode.create({
      data: { code: code(tag), description: 'big', discountType: 'FIXED_AMOUNT', discountValue, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5, funder: 'PLATFORM', termsVersion: 4, ...extra },
    });
    createdPromoIds.push(promo.id);
    return promo;
  }
  it('platform code: goods and the fee are discounted, the tip is charged and kept in full, and the snapshot names the platform as the sponsor of every dollar', async () => {
    const { customer, cart } = await shopper();
    const promo = await platformCode('P', 10_000);
    await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id, tipAmount: 300 } });
    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode, quote.body).toBe(200);
    const q = quote.json().data;

    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'MOBILE_MONEY', promoCode: promo.code, tipAmount: 300, fulfillmentSelections: { [shop.vendorId]: 'DELIVERY' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { promoRedemption: true } });
    const fee = Number(order.deliveryFee);
    expect(fee).toBeGreaterThan(0);
    expect(Number(order.subtotalCustomer)).toBe(1200);
    // the discount stops at goods + fee — never the tip
    expect(Number(order.discount)).toBe(1200 + fee);
    expect(Number(order.tipAmount)).toBe(300);
    expect(Number(order.totalAmount)).toBe(300);
    // the quote agreed with the charge [ALG-24 parity]
    expect(Number(q.discount), 'quote ↔ charge (discount)').toBe(1200 + fee);
    // the snapshot: which terms, who funds, how much of each component
    const snap = order.promoRedemption!;
    expect(snap.funder).toBe('PLATFORM');
    expect(snap.termsVersion).toBe(4);
    expect(snap.discountType).toBe('FIXED_AMOUNT');
    expect(Number(snap.discountValue)).toBe(10_000);
    expect(Number(snap.goodsDiscount)).toBe(1200);
    expect(Number(snap.deliveryDiscount)).toBe(fee);
    expect(Number(snap.tipDiscount)).toBe(0);
  });
  it("vendor code: a store's promotion stops at the goods — the rider's fee is not the store's to give away — and the snapshot names the vendor", async () => {
    const { customer, cart } = await shopper();
    const promo = await app.prisma.promoCode.create({
      data: { code: code('W'), description: 'store big', vendorId: shop.vendorId, discountType: 'FIXED_AMOUNT', discountValue: 5_000, applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUsesPerUser: 5, funder: 'VENDOR' },
    });
    createdPromoIds.push(promo.id);
    await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id, tipAmount: 300 } });
    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(quote.statusCode).toBe(200);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'MOBILE_MONEY', promoCode: promo.code, tipAmount: 300, fulfillmentSelections: { [shop.vendorId]: 'DELIVERY' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { promoRedemption: true } });
    const fee = Number(order.deliveryFee);
    expect(Number(order.discount)).toBe(1200);
    expect(Number(order.totalAmount)).toBe(fee + 300);
    expect(Number(quote.json().data.discount)).toBe(1200);
    expect(order.promoRedemption!.funder).toBe('VENDOR');
    expect(Number(order.promoRedemption!.goodsDiscount)).toBe(1200);
    expect(Number(order.promoRedemption!.deliveryDiscount)).toBe(0);
    expect(Number(order.promoRedemption!.tipDiscount)).toBe(0);
  });
  it('an explicit zero cap discounts nothing at checkout — and the zero-dollar redemption is still snapshotted', async () => {
    const { customer, cart } = await shopper();
    const promo = await platformCode('Z', 900, { maxDiscount: 0 });
    await app.prisma.cart.update({ where: { id: cart.id }, data: { promoCodeId: promo.id } });
    const quote = await inject('GET', '/api/v1/customer/cart', undefined, customer.token);
    expect(Number(quote.json().data.discount)).toBe(0);
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: promo.code, fulfillmentSelections: { [shop.vendorId]: 'PICKUP' } }, customer.token);
    expect([200, 201], res.body).toContain(res.statusCode);
    const created = res.json().data?.orders ?? [res.json().data?.order ?? res.json().data];
    const order = await app.prisma.order.findUniqueOrThrow({ where: { id: created[0].id }, include: { promoRedemption: true } });
    expect(Number(order.discount)).toBe(0);
    expect(order.promoCodeId).toBe(promo.id);
    expect(order.promoRedemption).not.toBeNull();
    expect(Number(order.promoRedemption!.maxDiscount)).toBe(0);
    expect(Number(order.promoRedemption!.goodsDiscount)).toBe(0);
  });
  it('the snapshot is immutable in the database: no tip discount can ever be written', async () => {
    const snap = await app.prisma.promoRedemption.findFirstOrThrow({ where: { order: { customerId: { in: createdUserIds } } } });
    await expect(app.prisma.$executeRaw`UPDATE "promo_redemptions" SET "tipDiscount" = 1 WHERE "id" = ${snap.id}`).rejects.toThrow(/promo_redemptions_components_check/);
  });
});

describe('the operations clause: the scan reports what the law would have caught', () => {
  it('my orders all carry a funder and no tip gap; a legacy-shaped row (discount past goods + fee, no snapshot) is counted, since enforcement', async () => {
    const clean = await scanPromoFunding(app.prisma);
    const mine = await app.prisma.order.findFirst({ where: { customerId: { in: createdUserIds }, discount: { gt: 0 } }, include: { promoRedemption: true } });
    expect(mine?.promoRedemption).toBeTruthy();
    // Manufacture the legacy shape on one of my orders: the old allocation ate the tip and nothing named a funder.
    await app.prisma.promoRedemption.delete({ where: { orderId: mine!.id } });
    await app.prisma.order.update({ where: { id: mine!.id }, data: { discount: Number(mine!.subtotalCustomer) + Number(mine!.deliveryFee) + 100 } });
    const dirty = await scanPromoFunding(app.prisma);
    expect(dirty.discountWithoutFunder.sinceEnforced).toBe(clean.discountWithoutFunder.sinceEnforced + 1);
    expect(dirty.tipFundingGap.sinceEnforced).toBe(clean.tipFundingGap.sinceEnforced + 1);
    expect(dirty.discountWithoutFunder.total).toBeGreaterThanOrEqual(dirty.discountWithoutFunder.sinceEnforced);
    const gauge = await promoFundingGauge.get();
    const value = (check: string) => gauge.values.find((v) => v.labels['check'] === check)?.value;
    expect(value('discount_without_funder_since_enforced')).toBe(dirty.discountWithoutFunder.sinceEnforced);
    expect(value('tip_funding_gap_since_enforced')).toBe(dirty.tipFundingGap.sinceEnforced);
    expect(value('invalid_terms')).toBe(dirty.invalidTerms);
  });
});


// ---------------------------------------------------------------------------
// [A-22] A DAY THE OPERATOR TYPES IS A DAY IN GUYANA, AND MONEY IS WHOLE.
//
// `z.coerce.date()` reads a bare `YYYY-MM-DD` as UTC midnight. Guyana is UTC−4,
// so a window entered as two dates went live at 8pm the evening BEFORE it was
// meant to, and died at 8pm on its last day — during the hours people order.
// ---------------------------------------------------------------------------
const inGuyana = (d: Date) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'America/Guyana', dateStyle: 'short', timeStyle: 'medium',
}).format(d);

describe('[A-22] a promo window is a window in Guyana', () => {
  it('a date-only window starts at local midnight and ends at local 23:59:59 — not four hours early', async () => {
    const res = await inject('POST', '/api/v1/admin/promos', {
      code: code('TZ'), description: 'guyana window', discountType: 'PERCENTAGE', discountValue: 10,
      validFrom: '2026-09-04', validUntil: '2026-10-04', maxUsesPerUser: 1,
    }, adminToken);
    expect(res.statusCode, res.body).toBe(200);
    createdPromoIds.push(res.json().data.id);
    const row = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: res.json().data.id } });

    // The instants, stated plainly: UTC−4.
    expect(row.validFrom.toISOString()).toBe('2026-09-04T04:00:00.000Z');
    expect(row.validUntil.toISOString()).toBe('2026-10-05T03:59:59.999Z');
    // And what an operator in Georgetown sees.
    expect(inGuyana(row.validFrom)).toBe('04/09/2026, 00:00:00');
    expect(inGuyana(row.validUntil)).toBe('04/10/2026, 23:59:59');
  });

  it('the promo is STILL live at 8pm on its last day — the exact hour it used to die', async () => {
    const res = await inject('POST', '/api/v1/admin/promos', {
      code: code('EVE'), description: 'evening', discountType: 'PERCENTAGE', discountValue: 10,
      validFrom: '2026-09-04', validUntil: '2026-10-04', maxUsesPerUser: 1,
    }, adminToken);
    createdPromoIds.push(res.json().data.id);
    const row = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: res.json().data.id } });

    // 20:00 in Georgetown on the last day = 00:00Z on the 5th.
    const lastEvening = new Date('2026-10-05T00:00:00.000Z');
    expect(inGuyana(lastEvening)).toBe('04/10/2026, 20:00:00');
    // The check every consumer makes: `now > validUntil` means expired.
    expect(lastEvening.getTime() > row.validUntil.getTime()).toBe(false);
  });

  it('an explicit instant is respected as given — saying something precise is not overridden', async () => {
    const exact = '2026-09-04T13:30:00.000Z';
    const res = await inject('POST', '/api/v1/admin/promos', {
      code: code('EXACT'), description: 'exact', discountType: 'PERCENTAGE', discountValue: 10,
      validFrom: exact, validUntil: '2026-10-04T09:15:00.000Z', maxUsesPerUser: 1,
    }, adminToken);
    expect(res.statusCode, res.body).toBe(200);
    createdPromoIds.push(res.json().data.id);
    const row = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: res.json().data.id } });
    expect(row.validFrom.toISOString()).toBe(exact);
    expect(row.validUntil.toISOString()).toBe('2026-10-04T09:15:00.000Z');
  });

  it('a patched end date moves to the END of the day the operator typed', async () => {
    const created = await inject('POST', '/api/v1/admin/promos', {
      code: code('PATCH'), description: 'patch', discountType: 'PERCENTAGE', discountValue: 10,
      ...window(), maxUsesPerUser: 1,
    }, adminToken);
    const id = created.json().data.id; createdPromoIds.push(id);
    const patched = await inject('PUT', `/api/v1/admin/promos/${id}`, { validUntil: '2026-12-31' }, adminToken);
    expect(patched.statusCode, patched.body).toBe(200);
    const row = await app.prisma.promoCode.findUniqueOrThrow({ where: { id } });
    expect(inGuyana(row.validUntil)).toBe('31/12/2026, 23:59:59');
  });
});

describe('[A-22] the type fields are mutually exclusive, and money is whole', () => {
  const base = { description: 'x', maxUsesPerUser: 1, ...window() };

  it('a FREE_DELIVERY promo carrying a discount value is refused; zero is accepted', async () => {
    const conflicting = await inject('POST', '/api/v1/admin/promos', {
      code: code('FD1'), ...base, discountType: 'FREE_DELIVERY', discountValue: 5000,
    }, adminToken);
    expect(conflicting.statusCode).toBe(400);
    expect(conflicting.json().error.code).toBe('INVALID_PROMO_TERMS');

    const clean = await inject('POST', '/api/v1/admin/promos', {
      code: code('FD2'), ...base, discountType: 'FREE_DELIVERY', discountValue: 0,
    }, adminToken);
    expect(clean.statusCode, clean.body).toBe(200);
    createdPromoIds.push(clean.json().data.id);
  });

  it('a fractional FIXED_AMOUNT is refused — but a fractional PERCENTAGE is legitimate', async () => {
    const fractionalMoney = await inject('POST', '/api/v1/admin/promos', {
      code: code('FX1'), ...base, discountType: 'FIXED_AMOUNT', discountValue: 1500.7,
    }, adminToken);
    expect(fractionalMoney.statusCode).toBe(400);

    const halfPercent = await inject('POST', '/api/v1/admin/promos', {
      code: code('FX2'), ...base, discountType: 'PERCENTAGE', discountValue: 12.5,
    }, adminToken);
    expect(halfPercent.statusCode, halfPercent.body).toBe(200);
    createdPromoIds.push(halfPercent.json().data.id);
  });

  it('a fractional threshold or cap is refused — no order total can meet it exactly', async () => {
    for (const patch of [{ minOrderAmount: 999.99 }, { maxDiscount: 250.5 }]) {
      const res = await inject('POST', '/api/v1/admin/promos', {
        code: code('MN'), ...base, discountType: 'PERCENTAGE', discountValue: 10, ...patch,
      }, adminToken);
      expect(res.statusCode, `${JSON.stringify(patch)} → ${res.body}`).toBe(400);
    }
  });
});
