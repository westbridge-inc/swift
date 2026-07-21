import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Server } from 'socket.io';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { OrderService } from '../modules/order/order.service';
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
const orderIds: string[] = [];

const ioStub = { to: () => ({ emit: () => {} }) } as unknown as Server;

async function makeCancellableOrder(minutesAgo: number) {
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
    },
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

  const user = await app.prisma.user.create({
    data: {
      phone: '+5920079401', firstName: 'Marker', lastName: 'Cust',
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
      selfieCapturedAt: new Date(), customer: { create: {} },
    },
  });
  customerId = user.id;
});

afterAll(async () => {
  if (orderIds.length) {
    // order deletion cascades the append-only status logs (never delete those directly)
    await app.prisma.order.deleteMany({ where: { id: { in: orderIds } } });
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
