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

// ---------------------------------------------------------------------------
// H11 (pre-launch audit): promo caps were a read-then-check with no lock —
// validatePromoCode ran before the order transaction, so two concurrent
// checkouts of the same code both read the caps as unmet and both redeemed,
// blowing past maxUses. The fix locks the promo row inside the checkout
// transaction and re-checks. This test fires two concurrent checkouts on a
// maxUses:1 global promo and asserts exactly one redemption.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const createdUserIds: string[] = [];
const createdOrderIds: string[] = [];
let seq = 0;
const phoneBase = 592_500_000_000 + Math.floor(Math.random() * 400_000_000);
let vendorId: string;
let itemId: string;
let promoId: string;
const CODE = `RACE${nanoid(5).toUpperCase()}`;

async function makeCustomer() {
  seq += 1;
  const user = await app.prisma.user.create({
    data: { phone: `+${phoneBase + seq}`, firstName: 'Race', lastName: `C${seq}`, roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, selfieCapturedAt: new Date(), customer: { create: {} } },
  });
  createdUserIds.push(user.id);
  const token = app.jwt.sign({ userId: user.id, role: 'CUSTOMER', jti: nanoid(8) });
  await app.prisma.session.create({ data: { authMethod: 'OTP', userId: user.id, token, refreshToken: nanoid(48), deviceId: 'race', deviceType: 'test', expiresAt: new Date(Date.now() + 86400000) } });
  const addr = await app.prisma.address.create({ data: { userId: user.id, label: 'Home', addressLine1: '1 Race', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8018, longitude: -58.1555, isDefault: true } });
  return { userId: user.id, token, addressId: addr.id };
}

function inject(method: 'GET' | 'POST' | 'PUT', url: string, payload: unknown, token: string) {
  return app.inject({ method, url, payload: payload as Record<string, unknown>, headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` } });
}

async function primeCart(c: { token: string; addressId: string }) {
  await inject('POST', '/api/v1/customer/cart/items', { vendorId, itemId, quantity: 1 }, c.token);
  await inject('PUT', '/api/v1/customer/cart/address', { addressId: c.addressId }, c.token);
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

  const ownerUser = await app.prisma.user.create({ data: { phone: `+${phoneBase + 900}`, firstName: 'Race', lastName: 'Vend', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
  createdUserIds.push(ownerUser.id);
  const owner = await app.prisma.vendorOwner.create({ data: { userId: ownerUser.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: owner.id, name: 'Race Diner', slug: `race-${nanoid(8).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 901}`, addressLine1: '1 Race', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8013, longitude: -58.1551, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true } });
  vendorId = vendor.id;
  const cat = await app.prisma.category.create({ data: { vendorId, name: 'Menu', sortOrder: 0 } });
  const item = await app.prisma.item.create({ data: { vendorId, categoryId: cat.id, name: 'Race Plate', basePrice: 2000, isAvailable: true } });
  itemId = item.id;
  const promo = await app.prisma.promoCode.create({
    data: { code: CODE, description: '10% off', discountType: 'PERCENTAGE', discountValue: 10, validFrom: new Date(Date.now() - 3600000), validUntil: new Date(Date.now() + 3600000), maxUses: 1, maxUsesPerUser: 1, isActive: true, currentUses: 0 },
  });
  promoId = promo.id;
});

afterAll(async () => {
  // Orders reference customers + the promo — clear every order these fixtures
  // touched before deleting the users, or the FK blocks the user delete.
  await app.prisma.order.deleteMany({ where: { customerId: { in: createdUserIds } } });
  if (promoId) await app.prisma.promoCode.deleteMany({ where: { id: promoId } });
  await app.prisma.notification.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.address.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.cart.deleteMany({ where: { customerId: { in: createdUserIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: createdUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
  await app.close();
});

describe('promo redemption race', () => {
  it('two concurrent checkouts on a maxUses:1 code redeem exactly once', async () => {
    const a = await makeCustomer();
    const b = await makeCustomer();
    await Promise.all([primeCart(a), primeCart(b)]);

    // Fire both checkouts concurrently — the promo row lock must serialize them.
    const [ra, rb] = await Promise.all([
      // PICKUP: the CASH-delivery promo law [SPS-F-0022] would otherwise 409
      // both racers before the maxUses CAS under test.
      inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: CODE, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, a.token),
      inject('POST', '/api/v1/customer/checkout', { paymentMethod: 'CASH', promoCode: CODE, fulfillmentSelections: { [vendorId]: 'PICKUP' } }, b.token),
    ]);
    for (const r of [ra, rb]) {
      const orders = r.json()?.data?.orders ?? [];
      for (const o of orders) createdOrderIds.push(o.id);
    }

    const statuses = [ra.statusCode, rb.statusCode].sort();
    // Exactly one 200 (redeemed) and one 400 (USED_PROMO) — never two 200s.
    expect(statuses).toEqual([200, 400]);

    const promo = await app.prisma.promoCode.findUniqueOrThrow({ where: { id: promoId } });
    expect(promo.currentUses).toBe(1); // NOT 2

    const redeemedOrders = await app.prisma.order.count({ where: { promoCodeId: promoId } });
    expect(redeemedOrders).toBe(1);
  });
});
