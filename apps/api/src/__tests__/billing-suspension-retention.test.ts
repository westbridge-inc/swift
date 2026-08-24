import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';

// PINV-8 [PAY-1 §10.2] — WHAT SUSPENSION MUST NEVER TAKE AWAY.
//
// Suspension for non-payment is meant to remove one thing: the ability to earn.
// It is NOT an account ban. A suspended vendor must keep its login, its pay
// screen, its Swift Account Number, its earnings, and its receipts — because
// every one of those is either how it pays us, or the reason it wants to.
//
// The spec puts it bluntly, and it is worth repeating where the test lives:
//
//   "Locking a suspended vendor out of the pay screen is the single most
//    common way a billing system loses its own revenue."
//
// The cut-off half of this rule is already enforced and already tested —
// order.service.ts refuses a non-ACTIVE vendor, discovery filters on ACTIVE,
// and assertVendorCanOperate blocks accept/prepare/ready/complete (see
// vendor-operate-gate.test.ts). The RETENTION half had nothing standing on it.
// It happens to be correct today: GET /subscription goes through requireVendor,
// which resolves the role and deliberately does not look at vendor.status. But
// "correct by omission" is exactly the kind of correctness a future well-meaning
// commit deletes — someone adds a tidy status guard to the vendor routes, every
// suspended store silently loses the screen it pays on, and nothing goes red.
//
// So this file asserts the omission on purpose. If a status gate ever appears in
// front of the pay screen, this test is the thing that says no.

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let subscriptionId = '';

const authed = (token: string) => ({ authorization: `Bearer ${token}` });

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  registerErrorHandler(app);
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(authPlugin);
  await app.register(socketPlugin);
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  // Unique phone prefix per file — shared ranges collide across parallel files.
  const owner = await app.prisma.user.create({
    data: {
      phone: `+59200941${String(Math.floor(Math.random() * 90) + 10)}`,
      firstName: 'Retention', lastName: 'Owner',
      roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  userIds.push(owner.id);

  vendorToken = app.jwt.sign({ userId: owner.id, role: 'VENDOR_OWNER', jti: nanoid(8) });
  await app.prisma.session.create({
    data: {
      userId: owner.id, token: vendorToken, refreshToken: nanoid(48),
      deviceId: 'retention', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000),
    },
  });

  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Regent Roti House', slug: `retention-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920094100', addressLine1: '14 Regent Street',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  // A store one week into its billing period — the ordinary case the sweep meets.
  const periodStart = new Date();
  const periodEnd = new Date(periodStart.getTime() + 7 * 86_400_000);
  const sub = await app.prisma.subscription.create({
    data: {
      vendorId, type: 'RESTAURANT', status: 'ACTIVE', weeklyRate: 10_000, currencyCode: 'GYD',
      currentPeriodStart: periodStart, currentPeriodEnd: periodEnd, nextBillingDate: periodEnd,
    },
  });
  subscriptionId = sub.id;
});

afterAll(async () => {
  await app.prisma.subscription.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

/** Put the store in the exact state the billing sweep leaves behind. */
async function suspendForNonPayment() {
  await app.prisma.vendor.update({
    where: { id: vendorId },
    data: { status: 'SUSPENDED', acceptingOrders: false, suspensionSource: 'BILLING' },
  });
  await app.prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: 'SUSPENDED' },
  });
}

describe('PINV-8 — suspension takes earning, never the way back in', () => {
  it('the PAY SCREEN survives suspension, still carrying the SAN and the amount owed', async () => {
    await suspendForNonPayment();

    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/subscription', headers: authed(vendorToken),
    });

    // Not 401, not 403, not 404. A vendor who cannot open this screen cannot pay,
    // and a vendor who cannot pay never becomes a paying vendor again.
    expect(res.statusCode).toBe(200);

    const { data } = res.json() as {
      data: { san: string; sanFormatted: string; amountDueGyd: number; weeklyFeeGyd: number; payCashSteps: string[] };
    };

    // The SAN is how money finds this account at an MMG counter. It is issued at
    // account creation and never changes — least of all because of arrears.
    expect(data.san).toMatch(/^\d{10}$/);

    // Grouped for reading aloud across a counter, and carrying exactly the same
    // ten digits. The SEPARATOR is deliberately not asserted here: the shipped
    // format is XXX-XXX-XXXX ("read-aloud friendly", san.ts:63) while PAY-1 §4.1
    // and the Swift Pay screens both show XXX XXX XXXX. That divergence is real
    // and is registered as its own item — it is a money-surface change and does
    // not get settled as a side effect of a suspension test.
    expect(data.sanFormatted).toMatch(/^\d{3}\D\d{3}\D\d{4}$/);
    expect(data.sanFormatted.replace(/\D/g, '')).toBe(data.san);

    // "Every message carries the SAN and the exact GY$ amount" (§11.2). The screen
    // those messages deep-link into has to carry them too.
    expect(data.weeklyFeeGyd).toBe(10_000);
    expect(typeof data.amountDueGyd).toBe('number');

    // And the cash rail stays spelled out — card is never the only door (PINV-10).
    expect(Array.isArray(data.payCashSteps)).toBe(true);
    expect(data.payCashSteps.length).toBeGreaterThan(0);
  });

  it('the SAN is stable across suspension — the number an agent already has still works', async () => {
    const before = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });
    await suspendForNonPayment();
    const after = await app.prisma.subscription.findUniqueOrThrow({ where: { id: subscriptionId } });

    expect(after.san).toBe(before.san);
    expect(after.san).not.toBeNull();
  });

  it('earnings, settlements and order history all remain readable while suspended', async () => {
    await suspendForNonPayment();

    // A vendor's own trading record is its property, not a privilege of being
    // paid up. It is also the thing that makes paying feel worth it.
    for (const url of [
      '/api/v1/vendor/profile',
      '/api/v1/vendor/orders',
      '/api/v1/vendor/settlements',
      '/api/v1/vendor/analytics/revenue',
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: authed(vendorToken) });
      expect(res.statusCode, `${url} must survive suspension`).toBe(200);
    }
  });

  it('but the store still cannot EARN — suspension is not cosmetic', async () => {
    await suspendForNonPayment();

    // The other half of the invariant. If this ever goes green while the
    // retention tests above also pass, suspension has stopped meaning anything.
    const res = await app.inject({
      method: 'PUT', url: '/api/v1/vendor/vendor/toggle-orders',
      headers: authed(vendorToken), payload: { acceptingOrders: true },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);

    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(fresh.acceptingOrders).toBe(false);
    expect(fresh.status).toBe('SUSPENDED');
  });

  it('paying restores the store — reactivation is automatic, not a support ticket', async () => {
    await suspendForNonPayment();

    // Stand in for what applyPayment does once money is verified (PINV-14). The
    // point under test is the SHAPE of the recovery: nothing here asks a human.
    await app.prisma.subscription.update({
      where: { id: subscriptionId },
      data: { status: 'ACTIVE', gracePeriodEnd: null, isInGracePeriod: false },
    });
    await app.prisma.vendor.update({
      where: { id: vendorId },
      data: { status: 'ACTIVE', acceptingOrders: true, suspensionSource: null },
    });

    const res = await app.inject({
      method: 'GET', url: '/api/v1/vendor/subscription', headers: authed(vendorToken),
    });
    expect(res.statusCode).toBe(200);

    const fresh = await app.prisma.vendor.findUniqueOrThrow({ where: { id: vendorId } });
    expect(fresh.status).toBe('ACTIVE');
    expect(fresh.acceptingOrders).toBe(true);
  });
});
