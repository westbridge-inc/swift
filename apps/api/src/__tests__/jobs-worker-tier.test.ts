import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import Redis from 'ioredis';
import type { Worker } from 'bullmq';
import { prismaPlugin } from '../plugins/prisma';
import { runWeeklySettlement, createQueues, createWorkers, type JobContext } from '../jobs/queue';
import { probeQueueProducers } from '../jobs/runtime';
import { withTimeout } from '../utils/async-lifecycle';

// ---------------------------------------------------------------------------
// SWIFT-AUD-D7-01 — the weekly settlement snapshot is a money-adjacent write
// with no natural unique key (period bounds are computed from wall-clock at
// run time), so its idempotency must come from an explicit covered-window
// guard: a vendor whose latest settlement already reaches into this run's
// window is skipped. This is what makes a BullMQ retry (mid-loop crash) or an
// operator DLQ-requeue safe. Driven directly, without queue plumbing.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let vendorId: string;
let ownerUserId: string;
let customerUserId: string;

function ctx(): JobContext {
  return {
    prisma: app.prisma,
    redis: undefined,
    io: { to: () => ({ emit: () => {} }) },
    log: app.log,
  } as unknown as JobContext;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();

  const owner = await app.prisma.user.create({
    data: {
      phone: '+5920076201', firstName: 'Settle', lastName: 'Owner',
      roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true,
    },
  });
  ownerUserId = owner.id;
  const vo = await app.prisma.vendorOwner.create({ data: { userId: owner.id } });
  const vendor = await app.prisma.vendor.create({
    data: {
      ownerId: vo.id, name: 'Settle Diner', slug: `settle-diner-${nanoid(6)}`,
      vendorType: 'RESTAURANT', phone: '+5920076201', addressLine1: '1 Test St',
      city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15,
      status: 'ACTIVE', acceptingOrders: true, isVerified: true,
    },
  });
  vendorId = vendor.id;

  const customer = await app.prisma.user.create({
    data: {
      phone: '+5920076202', firstName: 'Settle', lastName: 'Cust',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  customerUserId = customer.id;

  const settled = await app.prisma.order.create({
    data: {
      orderNumber: `STL-${nanoid(10)}`, orderType: 'FOOD_DELIVERY',
      customerId: customer.id, vendorId, status: 'COMPLETED',
      deliveredAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000,
      deliveryFee: 300, totalAmount: 1300, paymentMethod: 'CASH',
    },
  });
  // A real completed order carries a COMPLETED status-log entry — that is what
  // the settlement now windows on [SWIFT-022].
  await app.prisma.orderStatusLog.create({
    data: { orderId: settled.id, status: 'COMPLETED', note: 'test', createdAt: new Date(Date.now() - 24 * 60 * 60 * 1000) },
  });
});

afterAll(async () => {
  await app.prisma.settlement.deleteMany({ where: { vendorId } });
  await app.prisma.order.deleteMany({ where: { vendorId } });
  await app.prisma.vendor.deleteMany({ where: { id: vendorId } });
  await app.prisma.vendorOwner.deleteMany({ where: { userId: ownerUserId } });
  await app.prisma.customer.deleteMany({ where: { userId: customerUserId } });
  await app.prisma.user.deleteMany({ where: { id: { in: [ownerUserId, customerUserId] } } });
  await app.close();
});

describe('runWeeklySettlement — idempotent weekly snapshot [SWIFT-AUD-D7-01]', () => {
  it('creates exactly one settlement for the delivered week', async () => {
    await runWeeklySettlement(ctx());
    const rows = await app.prisma.settlement.findMany({ where: { vendorId } });
    expect(rows.length).toBe(1);
    expect(rows[0]!.totalOrders).toBe(1);
    expect(Number(rows[0]!.totalBase)).toBe(1000);
    expect(rows[0]!.status).toBe('PENDING');
  });

  it('a retry / requeue of the same week creates NOTHING new', async () => {
    await runWeeklySettlement(ctx()); // second delivery of the same job
    const rows = await app.prisma.settlement.findMany({ where: { vendorId } });
    expect(rows.length).toBe(1); // still exactly one — the covered-window guard
  });

  it('SWIFT-022: counts a completed TAKEAWAY order the old deliveredAt window dropped', async () => {
    // Fresh vendor so the covered-window guard doesn't skip it.
    const owner2 = await app.prisma.user.create({ data: { phone: '+5920076299', firstName: 'Take', lastName: 'Away', roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true } });
    const vo2 = await app.prisma.vendorOwner.create({ data: { userId: owner2.id } });
    const vendor2 = await app.prisma.vendor.create({ data: { ownerId: vo2.id, name: 'Takeaway Co', slug: `takeaway-${nanoid(6)}`, vendorType: 'RESTAURANT', phone: '+5920076299', addressLine1: '2 Test St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', acceptingOrders: true, isVerified: true } });
    // A completed TAKEAWAY: fulfillment PICKUP, so deliveredAt is null forever.
    const takeaway = await app.prisma.order.create({
      data: {
        orderNumber: `TKW-${nanoid(10)}`, orderType: 'FOOD_DELIVERY', fulfillment: 'PICKUP',
        customerId: customerUserId, vendorId: vendor2.id, status: 'COMPLETED', deliveredAt: null,
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
        deliveryFee: 0, totalAmount: 2000, paymentMethod: 'CASH',
      },
    });
    await app.prisma.orderStatusLog.create({
      data: { orderId: takeaway.id, status: 'COMPLETED', note: 'test', createdAt: new Date(Date.now() - 12 * 60 * 60 * 1000) },
    });

    await runWeeklySettlement(ctx());
    const rows = await app.prisma.settlement.findMany({ where: { vendorId: vendor2.id } });
    // RED before SWIFT-022: deliveredAt=null → the takeaway was invisible → no row.
    expect(rows.length).toBe(1);
    expect(rows[0]!.totalOrders).toBe(1);
    expect(Number(rows[0]!.totalBase)).toBe(2000);

    await app.prisma.settlement.deleteMany({ where: { vendorId: vendor2.id } });
    await app.prisma.order.deleteMany({ where: { vendorId: vendor2.id } });
    await app.prisma.vendor.deleteMany({ where: { id: vendor2.id } });
    await app.prisma.vendorOwner.deleteMany({ where: { userId: owner2.id } });
    await app.prisma.user.deleteMany({ where: { id: owner2.id } });
  });
});

describe('worker failure-handler completeness [SWIFT-121]', () => {
  it('actively fails readiness after a real BullMQ producer disconnects post-boot', async () => {
    const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6382/15', {
      maxRetriesPerRequest: null,
    });
    const noopLog = { info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return noopLog; } };
    const queues = createQueues(redis, noopLog as never);

    try {
      await Promise.all(Object.values(queues).map((queue) => queue.waitUntilReady()));
      await expect(withTimeout(probeQueueProducers(queues), 500, 'real producer probe'))
        .resolves.toBeUndefined();
      const producerClient = await queues.orderQueue.client;
      producerClient.disconnect();
      await expect(withTimeout(probeQueueProducers(queues), 500, 'disconnected producer probe'))
        .rejects.toThrow(/order-jobs/);
    } finally {
      await Promise.allSettled(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  });

  it('EVERY worker createWorkers builds has a failed + error handler', async () => {
    // A silent worker (no 'failed'/'error' listener) drops job failures with no
    // log and no Sentry event. This is the invariant guard: it catches the whole
    // class — add a new worker and forget its handlers, and this fails.
    const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6382/15', { maxRetriesPerRequest: null });
    const noopLog = { info() {}, warn() {}, error() {}, fatal() {}, debug() {}, trace() {}, child() { return noopLog; } };
    const workerCtx = {
      prisma: app.prisma,
      redis,
      io: { to: () => ({ emit: () => {} }) },
      log: noopLog,
    } as unknown as JobContext;

    const queues = createQueues(redis, noopLog as never);
    const workers = await createWorkers(workerCtx, queues);
    try {
      const built = Object.entries(workers).filter(([, v]) => typeof (v as Worker | undefined)?.on === 'function');
      expect(built.length).toBeGreaterThanOrEqual(7); // one per live queue
      for (const [name, w] of built) {
        expect((w as Worker).listenerCount('failed'), `${name} has no 'failed' handler`).toBeGreaterThanOrEqual(1);
        expect((w as Worker).listenerCount('error'), `${name} has no 'error' handler`).toBeGreaterThanOrEqual(1);
      }
    } finally {
      await workers.cleanup();
      await Promise.all(Object.values(queues).map((queue) => queue.close()));
      await redis.quit();
    }
  });
});
