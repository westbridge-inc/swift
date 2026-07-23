import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { registerErrorHandler } from '../middleware/error-handler';
import { registerEmptyJsonBodyParser } from '../plugins/empty-json';
import { authRoutes } from '../modules/auth/auth.routes';
import { adminRoutes } from '../modules/admin/admin.routes';
import { loginWithOtp } from './helpers/otp';

// ---------------------------------------------------------------------------
// DASH-01 — the admin Subscription Revenue breakdown must sum the REAL
// weeklyRate of ACTIVE subscriptions, never count × a hardcoded rate table
// (which undercounted a 30,000 large vendor to 20,000, and counted
// TRIAL/PAST_DUE/CANCELLED as revenue). Reconcile the per-type line + the
// total against the seeded subscriptions.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let adminToken: string;
const vendorIds: string[] = [];
const ownerUserIds: string[] = [];
const subIds: string[] = [];

async function makeVendorSub(weeklyRate: number, status: 'ACTIVE' | 'TRIAL') {
  const owner = await app.prisma.user.create({
    data: {
      phone: `+59200748${String(subIds.length + 1).padStart(2, '0')}`, firstName: 'Rev', lastName: 'Own',
      roles: ['VENDOR_OWNER'] as never[], activeRole: 'VENDOR_OWNER' as never, isPhoneVerified: true,
    },
  });
  ownerUserIds.push(owner.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: `Rev ${nanoid(5)}`, slug: `rev-${nanoid(6)}`, vendorType: 'RESTAURANT',
      phone: '+5920074800', addressLine1: '1 Rev St', city: 'Georgetown', region: 'Demerara-Mahaica',
      latitude: 6.8, longitude: -58.15, status: 'ACTIVE',
    },
  });
  vendorIds.push(vendor.id);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId: vendor.id, type: 'RESTAURANT', status,
      weeklyRate, currentPeriodStart: new Date(), currentPeriodEnd: new Date(Date.now() + 7 * 86400000), nextBillingDate: new Date(Date.now() + 7 * 86400000),
    },
  });
  subIds.push(sub.id);
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerEmptyJsonBodyParser(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(authRoutes, { prefix: '/api/v1/auth' });
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();
  adminToken = (await loginWithOtp(app, '+5926001000')).json().data.tokens.accessToken; // seeded SUPER_ADMIN

  // A small (20,000) and a LARGE (30,000) restaurant, both ACTIVE, plus a
  // TRIAL that must NOT count toward revenue.
  await makeVendorSub(20000, 'ACTIVE');
  await makeVendorSub(30000, 'ACTIVE');
  await makeVendorSub(25000, 'TRIAL');
});

afterAll(async () => {
  await app.prisma.subscription.deleteMany({ where: { id: { in: subIds } } });
  await app.prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: ownerUserIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: ownerUserIds } } });
  await app.close();
});

describe('admin subscription revenue truth [DASH-01]', () => {
  it('per-type RESTAURANT revenue is the SUMMED rate of ACTIVE subs, not count × a fixed rate', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/v1/admin/dashboard/overview',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const breakdown = res.json().data.subscriptionBreakdown as Array<{ type: string; count: number; weeklyRevenue: number }>;
    const restaurant = breakdown.find((b) => b.type === 'RESTAURANT');
    expect(restaurant).toBeTruthy();

    // Our two ACTIVE restaurants contribute 20,000 + 30,000 = 50,000 real
    // revenue. The old bug (count × 20,000) would show 40,000 for these two —
    // undercounting the large vendor. The TRIAL's 25,000 is excluded.
    expect(restaurant!.weeklyRevenue).toBeGreaterThanOrEqual(50000);
    // And each line is a real sum, never a round count × 20,000 multiple that
    // ignores the 30k tier: 50,000 is not divisible into 20,000-only lines.
    expect(restaurant!.weeklyRevenue % 20000).not.toBe(0);
  });
});

describe('overview revenue fields serialize as numbers [SWIFT-119]', () => {
  it('todayDeliveryFees / todayTotal are numbers, not Decimal strings', async () => {
    const cust = await app.prisma.user.create({ data: { phone: '+5920074899', firstName: 'Rev', lastName: 'Cust', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true } });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `REV-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', customerId: cust.id, vendorId: vendorIds[0]!, status: 'DELIVERED',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
        paymentMethod: 'CASH', placedAt: new Date(),
      },
    });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/v1/admin/dashboard/overview', headers: { authorization: `Bearer ${adminToken}` } });
      expect(res.statusCode).toBe(200);
      const rev = res.json().data.revenue;
      // Pre-fix these were raw Prisma Decimals → JSON strings, breaking the admin
      // client's number type (NaN in the UI math).
      expect(typeof rev.todayDeliveryFees).toBe('number');
      expect(typeof rev.todayTotal).toBe('number');
      expect(Number.isFinite(rev.todayDeliveryFees) && Number.isFinite(rev.todayTotal)).toBe(true);
    } finally {
      await app.prisma.order.deleteMany({ where: { id: order.id } });
      await app.prisma.user.deleteMany({ where: { id: cust.id } });
    }
  });
});
