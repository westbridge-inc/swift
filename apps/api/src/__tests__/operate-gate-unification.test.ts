import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { subscriptionOperability } from '../modules/subscription/operate-gate';

// G-BILL-03 — canOperate unification (lifecycle/billing spec §14). ONE
// predicate answers "may this subscription state operate?"; the three actor
// gates (driver/rider go-online, vendor work-orders) map its verdict onto
// their historical HTTP codes. Unification FIXED a real divergence: the
// vendor copy was missing the grace-lapse check. The source scan below is
// the CI gate — any future inline copy of the status-triple fails the build.

const DAY = 86_400_000;

describe('subscriptionOperability — the truth table', () => {
  const at = new Date('2026-08-01T12:00:00Z');
  const sub = (status: string, graceOffsetMs?: number) =>
    ({ status, gracePeriodEnd: graceOffsetMs === undefined ? null : new Date(at.getTime() + graceOffsetMs) }) as never;

  it('missing row: caller policy decides', () => {
    expect(subscriptionOperability(null, { missingRow: 'BLOCK' }, at)).toEqual({ operable: false, why: 'MISSING' });
    expect(subscriptionOperability(null, { missingRow: 'GRANDFATHER' }, at)).toEqual({ operable: true });
  });

  it('TRIAL and ACTIVE operate; PAST_DUE only through its grace window', () => {
    expect(subscriptionOperability(sub('TRIAL'), { missingRow: 'BLOCK' }, at).operable).toBe(true);
    expect(subscriptionOperability(sub('ACTIVE'), { missingRow: 'BLOCK' }, at).operable).toBe(true);
    expect(subscriptionOperability(sub('PAST_DUE', +DAY), { missingRow: 'BLOCK' }, at).operable).toBe(true);
    expect(subscriptionOperability(sub('PAST_DUE'), { missingRow: 'BLOCK' }, at).operable).toBe(true); // no deadline set → the sweep owns it
    const lapsed = subscriptionOperability(sub('PAST_DUE', -DAY), { missingRow: 'BLOCK' }, at);
    expect(lapsed).toEqual({ operable: false, why: 'GRACE_LAPSED', status: 'PAST_DUE' });
  });

  it('every non-operating status blocks with the status verdict', () => {
    for (const status of ['PAUSED', 'SUSPENDED', 'CANCELLED', 'CHURNED']) {
      const v = subscriptionOperability(sub(status), { missingRow: 'GRANDFATHER' }, at);
      expect(v).toEqual({ operable: false, why: 'STATUS', status });
    }
  });
});

describe('the CI gate — no route may fork the rule again', () => {
  const SRC = join(__dirname, '..');
  const TRIPLE = /'TRIAL',\s*'ACTIVE',\s*'PAST_DUE'/;

  it("the status-triple literal exists ONLY in operate-gate.ts; all three actor gates call it", () => {
    const offenders: string[] = [];
    for (const entry of readdirSync(SRC, { recursive: true }) as string[]) {
      if (!entry.endsWith('.ts') || entry.includes('__tests__')) continue;
      const path = join(SRC, entry);
      if (TRIPLE.test(readFileSync(path, 'utf8')) && !entry.endsWith(join('subscription', 'operate-gate.ts'))) {
        offenders.push(entry);
      }
    }
    expect(offenders).toEqual([]); // an inline copy of the rule is a build failure

    for (const gate of ['modules/driver/driver.routes.ts', 'modules/rider/rider.routes.ts', 'modules/vendor/vendor.routes.ts']) {
      expect(readFileSync(join(SRC, gate), 'utf8')).toContain('subscriptionOperability');
    }
  });
});

describe('the fixed divergence — a grace-lapsed vendor can no longer work orders', () => {
  let app: FastifyInstance;
  const userIds: string[] = [];
  let vendorToken = '';
  let vendorId = '';
  let subId = '';
  let customerId = '';
  let seq = 0;
  const phoneBase = 592_795_000_000 + Math.floor(Math.random() * 200_000_000);

  async function mkUser(roles: UserRole[], activeRole: UserRole) {
    seq += 1;
    const u = await app.prisma.user.create({
      data: { phone: `+${phoneBase + seq}`, firstName: 'Gate', lastName: `U${seq}`, roles, activeRole, isPhoneVerified: true },
    });
    userIds.push(u.id);
    const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
    await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'og', deviceType: 'test', expiresAt: new Date(Date.now() + DAY) } });
    return { id: u.id, token };
  }

  const mkOrder = async () => {
    const o = await app.prisma.order.create({
      data: {
        orderNumber: `OG-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
        customerId, vendorId, status: 'PENDING',
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500,
        paymentMethod: 'CASH',
      },
    });
    return o.id;
  };

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

    const owner = await mkUser(['VENDOR_OWNER'], 'VENDOR_OWNER');
    vendorToken = owner.token;
    const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
    const vendor = await app.prisma.vendor.create({
      data: { ownerId: vo.id, name: 'Gate Diner', slug: `gate-${nanoid(6).toLowerCase()}`, vendorType: 'RESTAURANT', phone: `+${phoneBase + 900}`, addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true },
    });
    vendorId = vendor.id;
    const sub = await app.prisma.subscription.create({
      data: {
        vendorId, type: 'RESTAURANT', status: 'PAST_DUE', weeklyRate: 20000, billingMethod: 'CASH',
        currentPeriodStart: new Date(Date.now() - 8 * DAY), currentPeriodEnd: new Date(Date.now() - DAY), nextBillingDate: new Date(Date.now() - DAY),
        gracePeriodEnd: new Date(Date.now() - 60_000), // grace LAPSED
      },
    });
    subId = sub.id;
    customerId = (await mkUser(['CUSTOMER'], 'CUSTOMER')).id;
  });

  afterAll(async () => {
    await app.prisma.order.deleteMany({ where: { vendorId } });
    await app.prisma.subscription.deleteMany({ where: { id: subId } });
    await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
    await app.close();
  });

  it('lapsed grace → 403 SUBSCRIPTION_PAST_DUE at accept; back in grace → accepts', async () => {
    const blocked = await app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${await mkOrder()}/accept`, headers: { authorization: `Bearer ${vendorToken}` } });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error?.code ?? blocked.json().code).toBe('SUBSCRIPTION_PAST_DUE');

    await app.prisma.subscription.update({ where: { id: subId }, data: { gracePeriodEnd: new Date(Date.now() + DAY) } });
    const ok = await app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${await mkOrder()}/accept`, headers: { authorization: `Bearer ${vendorToken}` } });
    expect(ok.statusCode).toBe(200);
  });
});
