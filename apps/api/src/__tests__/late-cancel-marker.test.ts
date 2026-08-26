import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { OrderService } from '../modules/order/order.service';
import { isFreeCancellation } from '../modules/order/cancel-policy';
import { riskScoreFor } from '../modules/cash/risk-score.service';

// ---------------------------------------------------------------------------
// Founder decision 2026-07-20 (DECISIONS #5): the announced late-cancel fee is
// RECORDED as a marker (cash-only — never collected) and the risk score's
// cancel signal counts ONLY late cancels, matching the wording its own doc
// always carried ("after the free window").
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let orders: OrderService;
let customerId: string;
let moverUserId: string;
let riderId: string;
const orderIds: string[] = [];

const ioStub = { to: () => ({ emit: () => {} }) } as unknown as Server;

async function makeCancellableOrder(
  minutesAgo: number,
  overrides: Record<string, unknown> = {},
) {
  const placedAt = new Date(Date.now() - minutesAgo * 60_000);
  const order = await app.prisma.order.create({
    data: {
      orderNumber: `LCM-${nanoid(10)}`, orderType: 'COURIER',
      customerId, status: 'PENDING', fulfillment: 'DELIVERY',
      pickupAddress: 'a', pickupLat: 6.8, pickupLng: -58.15,
      deliveryAddress: 'b', deliveryLat: 6.81, deliveryLng: -58.16,
      subtotalBase: 0, subtotalMarkup: 0, subtotalCustomer: 0,
      deliveryFee: 1000, totalAmount: 1000, paymentMethod: 'CASH',
      placedAt,
      ...overrides,
    } as never,
  });
  orderIds.push(order.id);
  return order.id;
}

beforeAll(async () => {
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.ready();
  orders = new OrderService(app.prisma, ioStub);

  // Purge-first: parallel local runs / interrupted prior runs may have left
  // this file's fixture phone behind (house pattern — unique prefix per file
  // + idempotent sweep).
  const stale = await app.prisma.user.findUnique({ where: { phone: '+5920079401' } });
  if (stale) {
    // NB: order_status_logs is append-only (prisma plugin) — order deletion
    // cascades them; never deleteMany the logs directly.
    await app.prisma.order.deleteMany({ where: { customerId: stale.id } });
    await app.prisma.notification.deleteMany({ where: { userId: stale.id } });
    await app.prisma.customer.deleteMany({ where: { userId: stale.id } });
    await app.prisma.user.delete({ where: { id: stale.id } });
  }
  // The fixture mover (claimed-order cases) gets the same idempotent sweep.
  // Customer sweep above already deleted every order that referenced this rider.
  const staleMover = await app.prisma.user.findUnique({ where: { phone: '+5920079402' } });
  if (staleMover) {
    await app.prisma.rider.deleteMany({ where: { userId: staleMover.id } });
    await app.prisma.user.delete({ where: { id: staleMover.id } });
  }

  const user = await app.prisma.user.create({
    data: {
      phone: '+5920079401', firstName: 'Marker', lastName: 'Cust',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  customerId = user.id;

  const moverUser = await app.prisma.user.create({
    data: {
      phone: '+5920079402', firstName: 'Marker', lastName: 'Mover',
      roles: ['MOVER'], activeRole: 'MOVER', isPhoneVerified: true,
      selfieCapturedAt: new Date(),
    },
  });
  moverUserId = moverUser.id;
  const rider = await app.prisma.rider.create({
    data: { userId: moverUser.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE', documentsVerified: true },
  });
  riderId = rider.id;
});

afterAll(async () => {
  if (orderIds.length) {
    // order deletion cascades the append-only status logs (never delete those directly)
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  }
  if (riderId) {
    await app.prisma.rider.deleteMany({ where: { id: riderId } });
  }
  if (moverUserId) {
    await app.prisma.notification.deleteMany({ where: { userId: moverUserId } });
    await app.prisma.user.deleteMany({ where: { id: moverUserId } });
  }
  if (customerId) {
    await app.prisma.notification.deleteMany({ where: { userId: customerId } });
    await app.prisma.customer.deleteMany({ where: { userId: customerId } });
    await app.prisma.user.deleteMany({ where: { id: customerId } });
  }
  await app.close();
});

describe('late-cancel fee marker [decision #5]', () => {
  it('a LATE cancel records the announced fee on the order', async () => {
    const id = await makeCancellableOrder(10); // past the 5-min free window
    const res = await orders.cancelOrder(id, customerId, 'changed my mind');
    expect(res.cancellationFee).toBe(500);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id }, select: { lateCancelFeeDue: true } });
    expect(row.lateCancelFeeDue).toBe(500);
  });

  it('a FREE cancel records 0', async () => {
    const id = await makeCancellableOrder(1); // inside the window
    const res = await orders.cancelOrder(id, customerId, 'typo');
    expect(res.cancellationFee).toBe(0);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id }, select: { lateCancelFeeDue: true } });
    expect(row.lateCancelFeeDue).toBe(0);
  });

  it('the risk score now counts ONLY late cancels — free cancels stop punishing', async () => {
    const risk = await riskScoreFor(app.prisma, customerId);
    expect(risk.signals.cancels30d).toBe(1); // one late, one free from above
    expect(risk.score).toBe(5); // 1 late cancel × 5
  });
});

// ---------------------------------------------------------------------------
// 2026-08-25 NEXT-UP #1: the free window means NOTHING WAS COMMITTED. Two
// verified defects drove this block: (a) a COURIER order is born
// READY_FOR_PICKUP — keying the window on PENDING charged every unclaimed
// parcel the moment its 2-min hold lapsed; (b) neither branch guarded against
// a mover assignment on its own — the status CAS is the only thing standing
// between an en-route mover and a free cancel, and the money boundary must
// not trust a cross-module invariant.
// ---------------------------------------------------------------------------
describe('free window = nothing committed [cancel-policy]', () => {
  it('an unclaimed COURIER inside the window cancels free — it is born READY_FOR_PICKUP and never sees PENDING', async () => {
    const id = await makeCancellableOrder(3, {
      status: 'READY_FOR_PICKUP',
      // prod shape: born held (2-min LIFECYCLE_V2 hold), lapsed by minute 3
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    const res = await orders.cancelOrder(id, customerId, 'wrong address');
    expect(res.cancellationFee).toBe(0);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id }, select: { lateCancelFeeDue: true } });
    expect(row.lateCancelFeeDue).toBe(0);
  });

  it('a mover assignment ends the free window — a claimed courier inside the window still pays', async () => {
    // Status stays READY_FOR_PICKUP on purpose. Every assignment writer CASes
    // riderId and status forward in one update, so RIDER_ASSIGNED would be
    // refused by the STATUS half of the predicate and this test would pass
    // with the assignment guard deleted — grading nothing. Held at the
    // otherwise-free status, the guard is the only thing standing between an
    // en-route mover and a free cancel, which is exactly what must be gated.
    const id = await makeCancellableOrder(3, {
      status: 'READY_FOR_PICKUP',
      riderId,
      holdExpiresAt: new Date(Date.now() - 60_000),
    });
    await app.prisma.rider.update({ where: { id: riderId }, data: { currentOrderId: id, isAvailable: false } });
    const res = await orders.cancelOrder(id, customerId, 'changed my mind');
    expect(res.cancellationFee).toBe(500);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id }, select: { lateCancelFeeDue: true } });
    expect(row.lateCancelFeeDue).toBe(500);
    // and the cancel freed the mover in the same commit
    const freed = await app.prisma.rider.findUniqueOrThrow({
      where: { id: riderId },
      select: { currentOrderId: true, isAvailable: true },
    });
    expect(freed.currentOrderId).toBeNull();
    expect(freed.isAvailable).toBe(true);
  });

  it('the COURIER carve-out does NOT leak to marketplace — vendor-prepped READY_FOR_PICKUP pays', async () => {
    const id = await makeCancellableOrder(3, {
      orderType: 'FOOD_DELIVERY',
      status: 'READY_FOR_PICKUP',
    });
    const res = await orders.cancelOrder(id, customerId, 'no longer hungry');
    expect(res.cancellationFee).toBe(500);
    const row = await app.prisma.order.findUniqueOrThrow({ where: { id }, select: { lateCancelFeeDue: true } });
    expect(row.lateCancelFeeDue).toBe(500);
  });
});

describe('isFreeCancellation — the ONE predicate both the charge path and the preview import', () => {
  const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
  const base = {
    status: 'PENDING', orderType: 'TAXI', placedAt: minutesAgo(3),
    holdExpiresAt: null as Date | null, riderId: null as string | null, driverId: null as string | null,
  };

  it('unassigned PENDING inside the window: free', () => {
    expect(isFreeCancellation({ ...base })).toBe(true);
  });

  it('the assignment belt: PENDING + a driver holding the job is NEVER free (even though no status writer mints this today)', () => {
    expect(isFreeCancellation({ ...base, driverId: 'd1' })).toBe(false);
    expect(isFreeCancellation({ ...base, riderId: 'r1' })).toBe(false);
  });

  it('held + assigned is not free — the hold exemption is for orders nobody committed to', () => {
    expect(isFreeCancellation({ ...base, holdExpiresAt: minutesAgo(-2), riderId: 'r1' })).toBe(false);
  });

  it('held + unassigned is always free, whatever the clock says', () => {
    expect(isFreeCancellation({ ...base, placedAt: minutesAgo(10), holdExpiresAt: minutesAgo(-1) })).toBe(true);
  });

  it('COURIER READY_FOR_PICKUP tracks the window; marketplace READY_FOR_PICKUP never does', () => {
    const courier = { ...base, orderType: 'COURIER', status: 'READY_FOR_PICKUP' };
    expect(isFreeCancellation({ ...courier })).toBe(true);
    expect(isFreeCancellation({ ...courier, placedAt: minutesAgo(6) })).toBe(false);
    expect(isFreeCancellation({ ...courier, orderType: 'FOOD_DELIVERY' })).toBe(false);
  });

  it('window boundary: exactly 5 minutes is free, past it is not', () => {
    const placed = new Date('2026-08-25T12:00:00Z');
    expect(isFreeCancellation({ ...base, placedAt: placed }, new Date('2026-08-25T12:05:00Z'))).toBe(true);
    expect(isFreeCancellation({ ...base, placedAt: placed }, new Date('2026-08-25T12:05:01Z'))).toBe(false);
  });
});
