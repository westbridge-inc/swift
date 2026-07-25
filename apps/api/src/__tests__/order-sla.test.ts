import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole, OrderStatus } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { adminRoutes } from '../modules/admin/admin.routes';
import { registerErrorHandler } from '../middleware/error-handler';
import { computeOrderSla, type SlaOrderInput, type SlaThresholdsMin } from '../modules/fulfillment/order-sla';

// ---------------------------------------------------------------------------
// FUL-008: order SLA clocks (Part 10B). The pure engine computes per-stage
// dwell + breaches from an order's state timestamps; the admin board surfaces
// the LIVE orders breaching right now. Failure path first: a stuck order is
// found by ops, not by an angry customer.
// ---------------------------------------------------------------------------

const MIN = 60_000;
const THR: SlaThresholdsMin = { accept: 5, prep: 25, pickupWait: 10, delivery: 30 };
const base = new Date('2026-07-24T12:00:00Z');
const ago = (min: number) => new Date(base.getTime() - min * MIN);

function order(o: Partial<SlaOrderInput> & { status: OrderStatus }): SlaOrderInput {
  return {
    id: o.id ?? nanoid(6), status: o.status,
    placedAt: o.placedAt ?? base,
    acceptedAt: o.acceptedAt ?? null, readyAt: o.readyAt ?? null,
    pickedUpAt: o.pickedUpAt ?? null, deliveredAt: o.deliveredAt ?? null, cancelledAt: o.cancelledAt ?? null,
  };
}

describe('computeOrderSla (pure)', () => {
  it('a healthy live order mid-prep is not breaching; the open clock is PREP', () => {
    const sla = computeOrderSla(order({ status: 'PREPARING', placedAt: ago(12), acceptedAt: ago(10) }), base, THR);
    expect(sla.openStage).toBe('PREP');
    expect(sla.breached).toBe(false);
    expect(sla.stages.find((s) => s.stage === 'ACCEPT')?.breached).toBe(false);
  });

  it('an order stuck in PREP past the threshold breaches, with PREP still open', () => {
    const sla = computeOrderSla(order({ status: 'PREPARING', placedAt: ago(90), acceptedAt: ago(88) }), base, THR);
    expect(sla.openStage).toBe('PREP');
    expect(sla.breached).toBe(true);
    const prep = sla.stages.find((s) => s.stage === 'PREP')!;
    expect(prep.breached).toBe(true);
    expect(prep.open).toBe(true);
    expect(sla.worstOverMs).toBeGreaterThan(0);
  });

  it('ready-but-no-rider breaches PICKUP_WAIT (food cooling)', () => {
    const sla = computeOrderSla(order({ status: 'READY_FOR_PICKUP', placedAt: ago(40), acceptedAt: ago(38), readyAt: ago(25) }), base, THR);
    expect(sla.openStage).toBe('PICKUP_WAIT');
    expect(sla.stages.find((s) => s.stage === 'PICKUP_WAIT')?.breached).toBe(true);
  });

  it('never-accepted live order breaches ACCEPT', () => {
    const sla = computeOrderSla(order({ status: 'PENDING', placedAt: ago(20) }), base, THR);
    expect(sla.openStage).toBe('ACCEPT');
    expect(sla.stages).toHaveLength(1);
    expect(sla.breached).toBe(true);
  });

  it('a delivered order within every threshold is not breaching and has no open clock', () => {
    const sla = computeOrderSla(order({
      status: 'DELIVERED', placedAt: ago(50), acceptedAt: ago(48), readyAt: ago(30), pickedUpAt: ago(28), deliveredAt: ago(5),
    }), base, THR);
    expect(sla.openStage).toBeNull();
    expect(sla.breached).toBe(false);
    expect(sla.stages).toHaveLength(4);
    expect(sla.stages.every((s) => s.endedAt !== null)).toBe(true);
  });

  it('a cancelled mid-prep order freezes the PREP clock at cancellation, not at now', () => {
    // accepted 200m ago, cancelled 190m ago — PREP dwell is 10m (< threshold),
    // NOT the 200m it would be if the clock kept running to `now`.
    const sla = computeOrderSla(order({ status: 'CANCELLED', placedAt: ago(202), acceptedAt: ago(200), cancelledAt: ago(190) }), base, THR);
    expect(sla.openStage).toBeNull();
    const prep = sla.stages.find((s) => s.stage === 'PREP')!;
    expect(prep.elapsedMs).toBe(10 * MIN);
    expect(prep.breached).toBe(false);
  });
});

// --- admin board -----------------------------------------------------------
let app: FastifyInstance;
const userIds: string[] = [];
let vendorId = '';
let customerId = '';
let adminToken = '';

async function seedOrder(fields: { status: OrderStatus; placedAt: Date; acceptedAt?: Date; readyAt?: Date; pickedUpAt?: Date; deliveredAt?: Date }) {
  const o = await app.prisma.order.create({
    data: {
      orderNumber: `SLA-${nanoid(8)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'DELIVERY',
      customerId, vendorId, status: fields.status,
      deliveryAddress: '1 SLA Rd', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 500, totalAmount: 1500, paymentMethod: 'CASH',
      placedAt: fields.placedAt, acceptedAt: fields.acceptedAt ?? null, readyAt: fields.readyAt ?? null,
      pickedUpAt: fields.pickedUpAt ?? null, deliveredAt: fields.deliveredAt ?? null,
    },
  });
  return o.id;
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
  await app.register(adminRoutes, { prefix: '/api/v1/admin' });
  await app.ready();

  const admin = await app.prisma.user.create({
    data: { phone: `+59200812${nanoid(4)}`, firstName: 'Sla', lastName: 'Admin', roles: ['ADMIN'] as UserRole[], activeRole: 'ADMIN' as UserRole, isPhoneVerified: true, selfieCapturedAt: new Date(), admin: { create: { permissions: ['*'] } } },
  });
  userIds.push(admin.id);
  adminToken = app.jwt.sign({ userId: admin.id, role: 'ADMIN', jti: nanoid(8) });
  await app.prisma.session.create({ data: { userId: admin.id, token: adminToken, refreshToken: nanoid(48), deviceId: 'sla', deviceType: 'test', expiresAt: new Date(Date.now() + 86_400_000) } });

  const owner = await app.prisma.user.create({ data: { phone: `+59200813${nanoid(4)}`, firstName: 'Sla', lastName: 'Owner', roles: ['VENDOR_OWNER'] as UserRole[], activeRole: 'VENDOR_OWNER' as UserRole, isPhoneVerified: true } });
  userIds.push(owner.id);
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({ data: { ownerId: vo.id, name: 'SLA Diner', slug: `sla-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920081400', addressLine1: '1 St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE' } });
  vendorId = vendor.id;
  const cust = await app.prisma.user.create({ data: { phone: `+59200814${nanoid(4)}`, firstName: 'Sla', lastName: 'Cust', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER' as UserRole, isPhoneVerified: true, customer: { create: {} } } });
  userIds.push(cust.id);
  customerId = cust.id;
});

afterAll(async () => {
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.admin.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('admin SLA-breach board (FUL-008)', () => {
  const H = 60; // minutes in an hour, for backdating well past defaults
  it('lists a live breaching order; excludes the healthy live one and the terminal one', async () => {
    const now = Date.now();
    const stuck = await seedOrder({ status: 'PREPARING', placedAt: new Date(now - 2 * H * MIN), acceptedAt: new Date(now - 2 * H * MIN + MIN) }); // ~2h in PREP
    const healthy = await seedOrder({ status: 'PENDING', placedAt: new Date(now - MIN) }); // just placed
    const doneSlow = await seedOrder({ status: 'DELIVERED', placedAt: new Date(now - 5 * H * MIN), acceptedAt: new Date(now - 5 * H * MIN + MIN), readyAt: new Date(now - 3 * H * MIN), pickedUpAt: new Date(now - 3 * H * MIN), deliveredAt: new Date(now - MIN) }); // historically slow but terminal

    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/orders/sla-breaches', headers: { authorization: `Bearer ${adminToken}` } });
    expect(res.statusCode).toBe(200);
    const ids = res.json().data.map((r: { orderId: string }) => r.orderId);
    expect(ids).toContain(stuck);
    expect(ids).not.toContain(healthy);
    expect(ids).not.toContain(doneSlow);

    const row = res.json().data.find((r: { orderId: string }) => r.orderId === stuck);
    expect(row.openStage).toBe('PREP');
    expect(row.breached).toBe(true);
  });

  it('requires admin auth', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/admin/orders/sla-breaches' });
    expect(res.statusCode).toBe(401);
  });
});
