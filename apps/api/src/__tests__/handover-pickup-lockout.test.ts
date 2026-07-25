import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { vendorRoutes } from '../modules/vendor/vendor.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { handoverAttemptState, MAX_HANDOVER_ATTEMPTS } from '../modules/handover/handover-security';

// ---------------------------------------------------------------------------
// HND-001 (engagement #7): brute-force lockout on the pickup handover code.
// A 6-digit code the vendor enters to close a takeaway is ~10^6 — safe only if
// guessing is rate-limited (the taxi ride PIN already locks out; the pickup
// code did not). Failure path first: after MAX wrong tries the code locks, and
// stays locked even when the RIGHT code is finally entered.
// ---------------------------------------------------------------------------

describe('handoverAttemptState (pure)', () => {
  it('locks once attempts reach the max; reports tries left after this one', () => {
    expect(handoverAttemptState(0)).toEqual({ locked: false, remaining: MAX_HANDOVER_ATTEMPTS - 1 });
    expect(handoverAttemptState(MAX_HANDOVER_ATTEMPTS - 1)).toEqual({ locked: false, remaining: 0 });
    expect(handoverAttemptState(MAX_HANDOVER_ATTEMPTS)).toEqual({ locked: true, remaining: 0 });
    expect(handoverAttemptState(MAX_HANDOVER_ATTEMPTS + 3)).toEqual({ locked: true, remaining: 0 });
  });
  it('honors a custom max', () => {
    expect(handoverAttemptState(1, 3)).toEqual({ locked: false, remaining: 1 });
    expect(handoverAttemptState(3, 3)).toEqual({ locked: true, remaining: 0 });
  });
});

let app: FastifyInstance;
const userIds: string[] = [];
let vendorToken = '';
let vendorId = '';
let customerId = '';

async function mkUser(roles: UserRole[], activeRole: UserRole) {
  const u = await app.prisma.user.create({
    data: { phone: `+59200917${String(userIds.length).padStart(2, '0')}`, firstName: 'Hnd', lastName: 'Over', roles, activeRole, isPhoneVerified: true },
  });
  userIds.push(u.id);
  const token = app.jwt.sign({ userId: u.id, role: activeRole, jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: u.id, token, refreshToken: nanoid(48), deviceId: 'hnd', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });
  return { id: u.id, token };
}

async function mkPickupOrder(code: string) {
  const o = await app.prisma.order.create({
    data: {
      orderNumber: `HND-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP',
      customerId, vendorId, status: 'READY_FOR_PICKUP',
      deliveryAddress: 'pickup', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 0, totalAmount: 1000,
      paymentMethod: 'CASH', pickupCode: code,
    },
  });
  return o.id;
}

const completePickup = (id: string, code: string) =>
  app.inject({ method: 'PUT', url: `/api/v1/vendor/orders/${id}/complete-pickup`, headers: { authorization: `Bearer ${vendorToken}`, 'content-type': 'application/json' }, payload: { code } });

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
  await app.register(vendorRoutes, { prefix: '/api/v1/vendor' });
  await app.ready();

  const owner = await mkUser(['VENDOR_OWNER', 'CUSTOMER'] as UserRole[], 'VENDOR_OWNER' as UserRole);
  vendorToken = owner.token;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: { ownerId: vo.id, name: 'Handover Diner', slug: `hnd-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920091700', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isCurrentlyOpen: true, isVerified: true },
  });
  vendorId = vendor.id;
  customerId = (await mkUser(['CUSTOMER'] as UserRole[], 'CUSTOMER' as UserRole)).id;
});

afterEach(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('pickup-code lockout (HND-001)', () => {
  it('the correct code hands the order over', async () => {
    const id = await mkPickupOrder('123456');
    const res = await completePickup(id, '123456');
    expect(res.statusCode).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('COMPLETED');
  });

  it('locks after MAX wrong tries — and stays locked even for the correct code', async () => {
    const id = await mkPickupOrder('123456');
    // Burn the whole attempt budget with wrong codes.
    for (let i = 0; i < MAX_HANDOVER_ATTEMPTS; i++) {
      const r = await completePickup(id, '000000');
      expect(r.statusCode).toBe(400);
      expect(r.json().error.code).toBe('WRONG_PICKUP_CODE');
    }
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id } })).pickupCodeAttempts).toBe(MAX_HANDOVER_ATTEMPTS);

    // Now even the RIGHT code is refused — the budget is spent.
    const locked = await completePickup(id, '123456');
    expect(locked.statusCode).toBe(400);
    expect(locked.json().error.code).toBe('MAX_ATTEMPTS');
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id } })).status).toBe('READY_FOR_PICKUP');
  });

  it('a wrong try burns an attempt but the next correct try still works (under the limit)', async () => {
    const id = await mkPickupOrder('654321');
    expect((await completePickup(id, '111111')).statusCode).toBe(400);
    const ok = await completePickup(id, '654321');
    expect(ok.statusCode).toBe(200);
    expect((await app.prisma.order.findUniqueOrThrow({ where: { id } })).pickupCodeAttempts).toBe(2);
  });
});

describe('verifier-never-sees-code (HND-003)', () => {
  const getDetail = (id: string) =>
    app.inject({ method: 'GET', url: `/api/v1/vendor/orders/${id}`, headers: { authorization: `Bearer ${vendorToken}` } });
  const listOrders = () =>
    app.inject({ method: 'GET', url: '/api/v1/vendor/orders', headers: { authorization: `Bearer ${vendorToken}` } });

  it('the vendor order DETAIL never exposes the pickup code (the vendor is the verifier)', async () => {
    const id = await mkPickupOrder('246810');
    const res = await getDetail(id);
    expect(res.statusCode).toBe(200);
    const order = res.json().data;
    expect(order.id).toBe(id); // it's really the order...
    expect(order.pickupCode).toBeUndefined(); // ...but the code is stripped
    expect(order.pickupCodeAttempts).toBeUndefined();
    expect(order.ridePin).toBeUndefined();
  });

  it('the vendor order BOARD (list) never exposes the pickup code', async () => {
    const id = await mkPickupOrder('135790');
    const res = await listOrders();
    expect(res.statusCode).toBe(200);
    const mine = res.json().data.find((o: { id: string }) => o.id === id);
    expect(mine).toBeTruthy();
    expect(mine.pickupCode).toBeUndefined();
    expect(mine.ridePin).toBeUndefined();
  });

  it('stripping the code did NOT break verification — the handover still enforces it', async () => {
    const id = await mkPickupOrder('112233');
    expect((await completePickup(id, '999999')).statusCode).toBe(400); // wrong still rejected
    expect((await completePickup(id, '112233')).statusCode).toBe(200); // right still works
  });
});
