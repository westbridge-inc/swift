import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { socketPlugin } from '../plugins/socket';
import { riskScoreFor } from '../modules/cash/risk-score.service';

// ---------------------------------------------------------------------------
// Risk scoring (marketplace §10): existing signals → one deterministic number.
// Throttles inform; bans stay with the explicit strike rules.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
const cleanupOrders: string[] = [];

async function makeUser() {
  const u = await app.prisma.user.create({
    data: {
      phone: `+59257${String(Math.floor(Math.random() * 90000) + 10000)}`,
      firstName: 'Risk', lastName: `T${nanoid(4)}`,
      roles: ['CUSTOMER'] as never[], activeRole: 'CUSTOMER' as never,
      isPhoneVerified: true,
      customer: { create: {} },
    },
  });
  userIds.push(u.id);
  return u;
}

beforeAll(async () => {
  process.env['NODE_ENV'] = 'development';
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test';
  process.env['REDIS_URL'] = process.env['REDIS_URL'] || 'redis://localhost:6382';

  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.register(redisPlugin);
  await app.register(socketPlugin);
  await app.ready();
});

afterAll(async () => {
  if (cleanupOrders.length > 0) await app.prisma.order.deleteMany({ where: { id: { in: cleanupOrders } } });
  if (userIds.length > 0) {
    await app.prisma.strike.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.customer.deleteMany({ where: { userId: { in: userIds } } });
    await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  }
  await app.close();
});

describe('riskScoreFor', () => {
  it('a clean account scores 0 / LOW', async () => {
    const u = await makeUser();
    const r = await riskScoreFor(app.prisma, u.id);
    expect(r.score).toBe(0);
    expect(r.tier).toBe('LOW');
    expect(r.signals).toEqual({ strikes: 0, claims90d: 0, cancels30d: 0, offPlatform30d: 0 });
  });

  it('signals add deterministically and cap at 100', async () => {
    const u = await makeUser();
    // 2 strikes (50) + a self-cancel (5) = 55 → MEDIUM
    await app.prisma.strike.createMany({
      data: [
        { userId: u.id, reason: 'refused_payment' },
        { userId: u.id, reason: 'no_show' },
      ],
    });
    const order = await app.prisma.order.create({
      data: {
        orderNumber: `RISK-${nanoid(8)}`,
        orderType: 'FOOD_DELIVERY' as never,
        customerId: u.id,
        status: 'CANCELLED' as never,
        cancelledBy: u.id,
        // The cancel signal counts LATE cancels only (decision #5, 2026-07-21)
        // — this fixture always meant "a punishable cancel", so it carries the
        // marker the real cancel path now records.
        lateCancelFeeDue: 500,
        fulfillment: 'DELIVERY' as never,
        deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
        subtotalBase: 1000, subtotalMarkup: 0, subtotalCustomer: 1000, deliveryFee: 300, totalAmount: 1300,
        paymentMethod: 'CASH' as never,
      },
    });
    cleanupOrders.push(order.id);

    const r = await riskScoreFor(app.prisma, u.id);
    expect(r.score).toBe(55);
    expect(r.tier).toBe('MEDIUM');
    expect(r.signals.strikes).toBe(2);
    expect(r.signals.cancels30d).toBe(1);

    // Pile on strikes → capped at 100, HIGH.
    await app.prisma.strike.createMany({
      data: Array.from({ length: 4 }, () => ({ userId: u.id, reason: 'no_show' })),
    });
    const capped = await riskScoreFor(app.prisma, u.id);
    expect(capped.score).toBe(100);
    expect(capped.tier).toBe('HIGH');
  });
});
