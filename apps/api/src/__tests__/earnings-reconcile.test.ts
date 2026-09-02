import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import type { UserRole } from '@prisma/client';
import { prismaPlugin } from '../plugins/prisma';
import { socketPlugin } from '../plugins/socket';
import { OrderService, reconcileMissingEarnings } from '../modules/order/order.service';
import { NotificationService } from '../modules/notification/notification.service';
import { earningsMissingTuplesGauge, earningsRepairsCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [F-0028 / G-002] A mover must never go unpaid for a delivery they completed.
//
// Four routes used to do `updateStatus(DELIVERED)` and then `createEarnings(id)`
// as two separate statements. A crash in between lost the rider's fee and tip
// permanently, and the withIdempotency retry could NOT heal it: re-running the
// closure hits INVALID_TRANSITION (the order has left the allowed source state)
// and never reaches the earnings call. Nothing swept for it, so the only person
// who would ever find out was the mover — and they would experience it as
// "Swift shorted me".
//
// Two defences, both pinned here:
//   1. ROOT CAUSE — earnings now have one owner: the DELIVERED transition pays.
//   2. NET — a reconciler heals any order that still slips through, because the
//      window can never be closed to zero and paths exist that bypass
//      updateStatus entirely (the courier proof route runs its own CAS).
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let orders: OrderService;
const userIds: string[] = [];
const orderIds: string[] = [];
let customerId = '';
let riderId = '';

async function makeDeliveredOrder(opts: { withRider?: boolean; deliveredMinutesAgo?: number } = {}) {
  const { withRider = true, deliveredMinutesAgo = 60 } = opts;
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `ERC-${nanoid(10)}`,
      orderType: 'FOOD_DELIVERY',
      fulfillment: 'DELIVERY',
      customerId,
      ...(withRider && { riderId }),
      status: 'DELIVERED',
      deliveredAt: new Date(Date.now() - deliveredMinutesAgo * 60_000),
      deliveryAddress: '9 Main St',
      deliveryLat: 6.81,
      deliveryLng: -58.16,
      subtotalBase: 3000,
      subtotalMarkup: 0,
      subtotalCustomer: 3000,
      deliveryFee: 800,
      tipAmount: 200,
      totalAmount: 4000,
      paymentMethod: 'CASH',
    },
  });
  orderIds.push(order.id);
  return order;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(socketPlugin);
  await app.ready();
  orders = new OrderService(app.prisma, app.io);

  const base = 592_150_000_000 + Math.floor(Math.random() * 500_000_000);

  const cu = await app.prisma.user.create({
    data: { phone: `+${base + 1}`, firstName: 'Erc', lastName: 'Customer', roles: ['CUSTOMER'] as UserRole[], activeRole: 'CUSTOMER', isPhoneVerified: true, customer: { create: {} } },
  });
  userIds.push(cu.id);
  customerId = cu.id;

  const ru = await app.prisma.user.create({
    data: { phone: `+${base + 2}`, firstName: 'Erc', lastName: 'Rider', roles: ['MOVER', 'CUSTOMER'] as UserRole[], activeRole: 'MOVER', isPhoneVerified: true, selfieCapturedAt: new Date() },
  });
  userIds.push(ru.id);
  const rider = await app.prisma.rider.create({ data: { userId: ru.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderId = rider.id;
});

afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { orderId: { in: orderIds } } });
  await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('[F-0028] the DELIVERED transition pays the mover — earnings have one owner', () => {
  it('rolls back status, float, mover, earnings, and audit when the terminal transaction aborts', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `ERCF-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        fulfillment: 'DELIVERY',
        customerId,
        riderId,
        status: 'ARRIVED',
        deliveryAddress: '9 Main St',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 3000,
        subtotalMarkup: 0,
        subtotalCustomer: 3000,
        deliveryFee: 800,
        tipAmount: 200,
        totalAmount: 4000,
        paymentMethod: 'CASH',
      },
    });
    orderIds.push(order.id);
    const beforeRider = await app.prisma.rider.update({
      where: { id: riderId },
      data: { isAvailable: false, currentOrderId: order.id, committedFloat: 3000 },
      select: { totalDeliveries: true },
    });

    const originalStage = OrderService.prototype.stageCanonicalOrderTransition;
    const stageSpy = vi
      .spyOn(OrderService.prototype, 'stageCanonicalOrderTransition')
      .mockImplementationOnce(async function (this: OrderService, tx, input) {
        // Fail only after DELIVERED, float/mover release, both earnings rows,
        // and the immutable status log have all been written inside the tx.
        await originalStage.call(this, tx, input);
        throw new Error('forced terminal pre-commit abort');
      });
    try {
      await expect(orders.updateStatus(order.id, 'DELIVERED', 'test', 'Delivered'))
        .rejects.toThrow('forced terminal pre-commit abort');
    } finally {
      stageSpy.mockRestore();
    }

    const [afterOrder, afterRider, earnings, auditCount] = await Promise.all([
      app.prisma.order.findUniqueOrThrow({
        where: { id: order.id },
        select: { status: true, deliveredAt: true },
      }),
      app.prisma.rider.findUniqueOrThrow({
        where: { id: riderId },
        select: { isAvailable: true, currentOrderId: true, committedFloat: true, totalDeliveries: true },
      }),
      app.prisma.earning.count({ where: { orderId: order.id } }),
      app.prisma.orderStatusLog.count({ where: { orderId: order.id, status: 'DELIVERED' } }),
    ]);
    expect(afterOrder).toEqual({ status: 'ARRIVED', deliveredAt: null });
    expect(afterRider.isAvailable).toBe(false);
    expect(afterRider.currentOrderId).toBe(order.id);
    expect(Number(afterRider.committedFloat)).toBe(3000);
    expect(afterRider.totalDeliveries).toBe(beforeRider.totalDeliveries);
    expect(earnings).toBe(0);
    expect(auditCount).toBe(0);

    await app.prisma.rider.update({
      where: { id: riderId },
      data: { isAvailable: true, currentOrderId: null, committedFloat: 0 },
    });
  });

  it('moving an order to DELIVERED creates its earnings, with no separate call', async () => {
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `ERCT-${nanoid(10)}`,
        orderType: 'FOOD_DELIVERY',
        fulfillment: 'DELIVERY',
        customerId,
        riderId,
        status: 'ARRIVED', // a legal source for DELIVERED
        deliveryAddress: '9 Main St',
        deliveryLat: 6.81,
        deliveryLng: -58.16,
        subtotalBase: 3000,
        subtotalMarkup: 0,
        subtotalCustomer: 3000,
        deliveryFee: 800,
        tipAmount: 200,
        totalAmount: 4000,
        paymentMethod: 'CASH',
      },
    });
    orderIds.push(order.id);

    // No createEarnings call — the transition alone must pay.
    await orders.updateStatus(order.id, 'DELIVERED', 'test', 'Delivered');

    const earned = await app.prisma.earning.findMany({ where: { orderId: order.id } });
    const types = earned.map((e) => e.type).sort();
    expect(types).toEqual(['DELIVERY_FEE', 'TIP']);
    expect(earned.every((e) => e.riderId === riderId)).toBe(true);
  });
});

describe('[G-002] the reconciler catches a mover who would otherwise go unpaid', () => {
  it('heals a delivered order that has no earnings', async () => {
    const order = await makeDeliveredOrder();
    // Simulates the crash window: the order is DELIVERED, nothing was paid.
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(0);

    const { healed } = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(healed).toContain(order.id);

    const earned = await app.prisma.earning.findMany({ where: { orderId: order.id } });
    expect(earned.map((e) => e.type).sort()).toEqual(['DELIVERY_FEE', 'TIP']);
    expect(Number(earned.find((e) => e.type === 'DELIVERY_FEE')!.amount)).toBe(800);
    expect(Number(earned.find((e) => e.type === 'TIP')!.amount)).toBe(200);
  });

  it('is idempotent — a second sweep pays nothing again', async () => {
    const order = await makeDeliveredOrder();
    await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    const afterFirst = await app.prisma.earning.count({ where: { orderId: order.id } });

    const second = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(second.healed).not.toContain(order.id);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(afterFirst);
  });

  it('respects the grace window — an order delivered seconds ago is left alone', async () => {
    // It may legitimately be mid-flight between its transition and its insert.
    const fresh = await makeDeliveredOrder({ deliveredMinutesAgo: 0 });

    const { healed } = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(healed).not.toContain(fresh.id);
    expect(await app.prisma.earning.count({ where: { orderId: fresh.id } })).toBe(0);
  });

  it('ignores orders with no mover — a pickup order earns nobody anything', async () => {
    const noMover = await makeDeliveredOrder({ withRider: false });

    const { healed } = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(healed).not.toContain(noMover.id);
    expect(await app.prisma.earning.count({ where: { orderId: noMover.id } })).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// [M-10] The reconciler and the earnings writer work on EXACT tuples.
// Before: any earning on an order made the sweep treat it as complete, so a
// fee row with a missing tip row was never healed; and a partial insert made
// the writer announce every expected row, not the rows it inserted.
// ---------------------------------------------------------------------------
describe('[M-10] exact tuples: only the missing row is healed, only the inserted row is announced', () => {
  it('a delivered order with the fee row but no tip row: the sweep inserts TIP only and announces TIP only', async () => {
    const order = await makeDeliveredOrder(); // deliveryFee 800, tip 200
    await app.prisma.earning.create({ data: { riderId, orderId: order.id, type: 'DELIVERY_FEE', amount: 800, status: 'AVAILABLE' } });
    const announced: Array<{ type: string; amount: number }> = [];
    const spy = vi.spyOn(NotificationService.prototype, 'earningAvailable').mockImplementation(async (_userId: string, amount: number, type: string) => { announced.push({ type, amount }); });
    try {
      const { healed } = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
      expect(healed).toContain(order.id);
      const rows = await app.prisma.earning.findMany({ where: { orderId: order.id }, orderBy: { type: 'asc' } });
      expect(rows.map((r) => [r.type, Number(r.amount)])).toEqual([['DELIVERY_FEE', 800], ['TIP', 200]]);
      expect(announced).toEqual([{ type: 'TIP', amount: 200 }]); // never a second "you earned 800"
    } finally {
      spy.mockRestore();
    }
  });

  it('a complete order is not a candidate at all — paid history cannot occupy the sweep', async () => {
    const order = await makeDeliveredOrder();
    await app.prisma.earning.createMany({ data: [
      { riderId, orderId: order.id, type: 'DELIVERY_FEE', amount: 800, status: 'AVAILABLE' },
      { riderId, orderId: order.id, type: 'TIP', amount: 200, status: 'AVAILABLE' },
    ] });
    const { healed } = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(healed).not.toContain(order.id);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('the writer on a partially paid order returns only the notice for the row it inserted', async () => {
    const order = await makeDeliveredOrder();
    await app.prisma.earning.create({ data: { riderId, orderId: order.id, type: 'DELIVERY_FEE', amount: 800, status: 'AVAILABLE' } });
    const notices = await orders.createEarnings(order.id, app.prisma, false);
    expect(notices.map((n) => [n.type, n.amount])).toEqual([['TIP', 200]]);
    expect(await orders.createEarnings(order.id, app.prisma, false)).toEqual([]);
  });

  it('[operations] dry run: the sweep reports the discrepancy and writes nothing — then the live sweep heals it', async () => {
    const order = await makeDeliveredOrder();
    await app.prisma.earning.create({ data: { riderId, orderId: order.id, type: 'DELIVERY_FEE', amount: 800, status: 'AVAILABLE' } });
    const dry = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10, dryRun: true });
    expect(dry.dryRun).toBe(true);
    expect(dry.scanned).toBeGreaterThanOrEqual(1);
    expect(dry.healed).toEqual([]);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(1);
    // The environment switch is the rollback lever, and it is actually wired.
    process.env['EARNINGS_RECONCILE_DRY_RUN'] = '1';
    try {
      const viaEnv = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
      expect(viaEnv.dryRun).toBe(true);
      expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(1);
    } finally {
      delete process.env['EARNINGS_RECONCILE_DRY_RUN'];
    }
    const live = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(live.dryRun).toBe(false);
    expect(live.healed).toContain(order.id);
    expect(await app.prisma.earning.count({ where: { orderId: order.id } })).toBe(2);
  });

  it('[operations] the sweep publishes what it found, what it left, and the oldest gap; repairs are counted by type', async () => {
    const order = await makeDeliveredOrder({ deliveredMinutesAgo: 90 });
    await app.prisma.earning.create({ data: { riderId, orderId: order.id, type: 'DELIVERY_FEE', amount: 800, status: 'AVAILABLE' } });
    const tipRepairs = async () => (await earningsRepairsCounter.get()).values.find((v) => v.labels['type'] === 'TIP')?.value ?? 0;
    const before = await tipRepairs();
    const result = await reconcileMissingEarnings(app.prisma, orders, { graceMinutes: 10 });
    expect(result.healed).toContain(order.id);
    expect(result.oldestGapMinutes).toBeGreaterThanOrEqual(90);
    const gauge = await earningsMissingTuplesGauge.get();
    const measure = (m: string) => gauge.values.find((v) => v.labels['measure'] === m)?.value;
    expect(measure('found')).toBeGreaterThanOrEqual(1);
    expect(measure('oldest_gap_minutes')).toBeGreaterThanOrEqual(90);
    expect(measure('unhealed')).toBe((measure('found') ?? 0) - result.healed.length);
    expect((await tipRepairs()) - before).toBeGreaterThanOrEqual(1);
  });
});
