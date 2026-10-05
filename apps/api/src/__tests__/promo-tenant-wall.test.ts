import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerRoutes } from '../modules/user/customer.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { promoBelongsToCallerTenant } from '../modules/promo/promo-tenant';
import { runAsSystem } from '../plugins/tenant-context';

// ---------------------------------------------------------------------------
// [L04 · R0 promo finding] A platform-wide promo code (no vendor) is Swift's
// production offer. promo_codes has no tenant, so the code was looked up and
// counted without one: a user in the app-store REVIEW tenant — the demo
// fiction — could validate it and spend one of its production redemptions at
// checkout. A platform code belongs to the production tenant: anyone else gets
// exactly the "no such code" answer, and nothing about the code changes.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60 * 1000;
const RUN = nanoid(6).replace(/[^A-Za-z0-9]/g, 'Q').toLowerCase();
const REVIEW = `review-promo-${RUN}`;
const PLATFORM_CODE = `PLATWALL${RUN.toUpperCase()}`;
const UNKNOWN_CODE = `NOSUCH${RUN.toUpperCase()}`;
const PHONE_PREFIX = '+5920424';

let app: FastifyInstance;
let reviewer: { userId: string; token: string };
let platformPromoId = '';
const userIds: string[] = [];
const vendorIds: string[] = [];

let seq = 0;
async function makeUser(tenantId: string | undefined) {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `${PHONE_PREFIX}${String(seq).padStart(3, '0')}`,
      firstName: 'Promo', lastName: `Wall${seq}`,
      roles: ['CUSTOMER', 'VENDOR_OWNER'], activeRole: 'CUSTOMER',
      isPhoneVerified: true, selfieCapturedAt: new Date(), avatar: '/uploads/avatars/promo.jpg',
      ...(tenantId ? { tenantId } : {}),
      customer: { create: {} },
    },
  });
  userIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'promo-wall', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) },
  });
  return { userId: user.id, token };
}

function inject(method: 'GET' | 'POST', url: string, payload: unknown, token: string) {
  return app.inject({
    method, url,
    ...(payload !== undefined ? { payload: payload as Record<string, unknown> } : {}),
    headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), authorization: `Bearer ${token}` },
  });
}

async function cleanup() {
  const users = await app.prisma.user.findMany({ where: { phone: { startsWith: PHONE_PREFIX } }, select: { id: true } });
  const ids = [...new Set([...userIds, ...users.map((u) => u.id)])];
  await app.prisma.cartItem.deleteMany({ where: { cart: { customerId: { in: ids } } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: ids } } });
  await app.prisma.promoCode.deleteMany({ where: { code: { in: [PLATFORM_CODE] } } });
  await app.prisma.item.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.category.deleteMany({ where: { vendorId: { in: vendorIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: ids } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ids } } });
  await app.prisma.reviewSession.deleteMany({ where: { tenantId: REVIEW } });
  await app.prisma.tenant.deleteMany({ where: { id: REVIEW } });
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(customerRoutes, { prefix: '/api/v1/customer' });
  await app.ready();
  await cleanup();

  await app.prisma.tenant.create({ data: { id: REVIEW, slug: REVIEW, name: 'Promo wall fiction', kind: 'REVIEW', isActive: true } });
  await app.prisma.reviewSession.create({ data: { tenantId: REVIEW, expiresAt: new Date(Date.now() + DAY) } });

  // The demo store and a reviewer, both in the REVIEW tenant.
  reviewer = await makeUser(REVIEW);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: reviewer.userId } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, tenantId: REVIEW, name: 'Demo Diner', slug: `demo-diner-${RUN}`, vendorType: 'RESTAURANT',
      phone: `${PHONE_PREFIX}900`, addressLine1: '1 Demo Street', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.801, longitude: -58.156, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true,
    },
  });
  vendorIds.push(vendor.id);
  const category = await app.prisma.category.create({ data: { vendorId: vendor.id, tenantId: REVIEW, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, tenantId: REVIEW, name: 'Demo Bowl', basePrice: 2000 } });

  // Swift's production offer: a platform-wide code (no vendor).
  platformPromoId = (await app.prisma.promoCode.create({
    data: {
      code: PLATFORM_CODE, description: 'production platform offer', discountType: 'FIXED_AMOUNT', discountValue: 500,
      applicableTo: [], validFrom: new Date(Date.now() - DAY), validUntil: new Date(Date.now() + DAY), maxUses: 100, maxUsesPerUser: 5,
    },
  })).id;

  const added = await inject('POST', '/api/v1/customer/cart/items', { vendorId: vendor.id, itemId: item.id, quantity: 1 }, reviewer.token);
  expect([200, 201], added.body).toContain(added.statusCode);
});

afterAll(async () => {
  await cleanup();
  await app.close();
});

describe('[R0 promo] a platform-wide code is production’s, never the review tenant’s', () => {
  it('validate: a REVIEW-tenant user gets exactly the unknown-code answer, and the code is not attached to their cart', async () => {
    const platform = await inject('POST', '/api/v1/customer/promo/validate', { code: PLATFORM_CODE }, reviewer.token);
    const unknown = await inject('POST', '/api/v1/customer/promo/validate', { code: UNKNOWN_CODE }, reviewer.token);
    expect(unknown.statusCode).toBe(404);
    expect({ status: platform.statusCode, body: platform.body }).toEqual({ status: unknown.statusCode, body: unknown.body });
    const cart = await app.prisma.cart.findUnique({ where: { customerId: reviewer.userId }, select: { promoCodeId: true } });
    expect(cart?.promoCodeId ?? null).toBeNull();
  });

  it('checkout: a REVIEW-tenant user cannot spend a production redemption', async () => {
    const before = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: platformPromoId }, select: { currentUses: true } });
    const res = await inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: PLATFORM_CODE, fulfillmentSelections: { [vendorIds[0]!]: 'PICKUP' } }, reviewer.token);
    // Refused (the demo tenant places no orders at all, and the code is not
    // its own) — whatever the refusal, nothing about the production code moves.
    expect(res.statusCode, res.body).toBeGreaterThanOrEqual(400);
    expect(res.statusCode, res.body).toBeLessThan(500);
    const after = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: platformPromoId }, select: { currentUses: true } });
    expect(after.currentUses).toBe(before.currentUses);
    expect(await app.prisma.order.count({ where: { promoCodeId: platformPromoId } })).toBe(0);
  });
});

describe('[R0 promo] which tenant a code belongs to (the rule both lookups use)', () => {
  it('a platform code is production’s; a store code is its store’s tenant’s', () => runAsSystem('test-promo-tenant-rule', async () => {
    // Outside any request (this suite's earlier requests leave their tenant on
    // the test's own async context, since the bare app has no per-request hook).
    const productionUser = await makeUser(undefined);
    const platform = { vendorId: null };
    const reviewStore = { vendorId: vendorIds[0]! };
    expect(await promoBelongsToCallerTenant(app.prisma, platform, productionUser.userId)).toBe(true);
    expect(await promoBelongsToCallerTenant(app.prisma, platform, reviewer.userId)).toBe(false);
    expect(await promoBelongsToCallerTenant(app.prisma, reviewStore, reviewer.userId)).toBe(true);
    expect(await promoBelongsToCallerTenant(app.prisma, reviewStore, productionUser.userId)).toBe(false);
    expect(await promoBelongsToCallerTenant(app.prisma, platform, 'no-such-user')).toBe(false);
  }));
});
