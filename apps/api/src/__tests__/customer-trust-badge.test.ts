import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { redisPlugin } from '../plugins/redis';
import { authPlugin } from '../plugins/auth';
import { socketPlugin } from '../plugins/socket';
import { customerTrustSummaries } from '../modules/cash/cash-rules.service';
import { registerErrorHandler } from '../middleware/error-handler';

// ---------------------------------------------------------------------------
// §4d — the trust badge a mover sees before fronting cash: trust level,
// completed orders, strikes (90-day window). Batch-shaped by contract.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
const userIds: string[] = [];
let seq = 0;
const phoneBase = 592_300_000_000 + Math.floor(Math.random() * 600_000_000);

async function makeCustomer(trustLevel: 'L1' | 'L2' | 'L3' = 'L1') {
  seq += 1;
  const user = await app.prisma.user.create({
    data: {
      phone: `+${phoneBase + seq}`,
      firstName: 'Trust', lastName: `C${seq}`,
      roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true, trustLevel,
      customer: { create: {} },
    },
  });
  userIds.push(user.id);
  return user;
}

async function makeDeliveredOrder(customerId: string) {
  return app.prisma.order.create({
    data: {
      orderNumber: `TRST-${nanoid(8)}`, orderType: 'FOOD_DELIVERY',
      customerId, status: 'DELIVERED', fulfillment: 'DELIVERY',
      deliveryAddress: 'x', deliveryLat: 6.8, deliveryLng: -58.15,
      subtotalBase: 500, subtotalMarkup: 0, subtotalCustomer: 500, deliveryFee: 200, totalAmount: 700,
      paymentMethod: 'CASH',
    },
  });
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
  await app.register(socketPlugin);
  await app.ready();
});

afterAll(async () => {
  await app.prisma.strike.deleteMany({ where: { userId: { in: userIds } } });
  await app.prisma.order.deleteMany({ where: { customerId: { in: userIds } } });
  await app.prisma.user.deleteMany({ where: { id: { in: userIds } } });
  await app.close();
});

describe('customerTrustSummaries', () => {
  it('reports level, completed count, strikes — batched over mixed customers', async () => {
    const clean = await makeCustomer('L2');
    await makeDeliveredOrder(clean.id);
    await makeDeliveredOrder(clean.id);

    const risky = await makeCustomer('L1');
    await app.prisma.strike.create({ data: { userId: risky.id, reason: 'no_show', phone: risky.phone } });

    const fresh = await makeCustomer('L1');

    const map = await customerTrustSummaries(app.prisma, [clean.id, risky.id, fresh.id, clean.id /* dupe */]);

    expect(map.get(clean.id)).toMatchObject({ trustLevel: 'L2', completedOrders: 2, strikes: 0 });
    expect(map.get(risky.id)).toMatchObject({ trustLevel: 'L1', completedOrders: 0, strikes: 1 });
    expect(map.get(fresh.id)).toMatchObject({ trustLevel: 'L1', completedOrders: 0, strikes: 0 });
    expect(map.get(clean.id)!.memberSince).toBeInstanceOf(Date);
  });

  it('ignores strikes older than the 90-day window', async () => {
    const reformed = await makeCustomer('L1');
    await app.prisma.strike.create({
      data: { userId: reformed.id, reason: 'refused', phone: reformed.phone, createdAt: new Date(Date.now() - 120 * 24 * 3_600_000) },
    });
    const map = await customerTrustSummaries(app.prisma, [reformed.id]);
    expect(map.get(reformed.id)!.strikes).toBe(0);
  });

  it('handles the empty case without a query', async () => {
    expect((await customerTrustSummaries(app.prisma, [])).size).toBe(0);
  });
});
