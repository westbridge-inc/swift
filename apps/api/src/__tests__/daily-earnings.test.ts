import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { nanoid } from 'nanoid';
import { prismaPlugin } from '../plugins/prisma';
import { dailyEarnings } from '../modules/order/daily-earnings';

// ---------------------------------------------------------------------------
// DASH-03 — the mover Home 7-day chart grouped earnings client-side from a
// limit-20 list, truncating older days. dailyEarnings aggregates each Guyana
// day server-side over ALL rows, so an oldest day with many entries is never
// silently zeroed.
// ---------------------------------------------------------------------------

let app: FastifyInstance;
let riderId: string;
let userId: string;

beforeAll(async () => {
  process.env['DATABASE_URL'] = process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();

  const user = await app.prisma.user.create({
    data: { phone: '+5920074601', firstName: 'Daily', lastName: 'Rider', roles: ['RIDER'] as never[], activeRole: 'RIDER' as never, isPhoneVerified: true },
  });
  userId = user.id;
  const rider = await app.prisma.rider.create({ data: { userId: user.id, riderType: 'DELIVERY', vehicleType: 'MOTORCYCLE' } });
  riderId = rider.id;

  // 25 earnings on a day 3 days ago (well past the limit-20 the client used,
  // and solidly inside the 7-day window regardless of the Guyana offset), and
  // one today. The old client-grouping would truncate the old day to ~0.
  const threeDaysAgo = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  threeDaysAgo.setUTCHours(12, 0, 0, 0);
  await app.prisma.earning.createMany({
    data: Array.from({ length: 25 }, (_, i) => ({
      riderId, orderId: `de-${nanoid(8)}-${i}`, type: 'DELIVERY_FEE' as never, amount: 100, status: 'PENDING' as never, createdAt: threeDaysAgo,
    })),
  });
  await app.prisma.earning.create({
    data: { riderId, orderId: `de-today-${nanoid(6)}`, type: 'DELIVERY_FEE' as never, amount: 500, status: 'PENDING' as never },
  });
});

afterAll(async () => {
  await app.prisma.earning.deleteMany({ where: { riderId } });
  await app.prisma.rider.deleteMany({ where: { id: riderId } });
  await app.prisma.user.deleteMany({ where: { id: userId } });
  await app.close();
});

describe('dailyEarnings [DASH-03]', () => {
  it('an old day with 25 entries is NOT truncated — every earning is counted', async () => {
    const days = await dailyEarnings(app.prisma, { riderId }, 7);
    expect(days).toHaveLength(7);
    expect(days[days.length - 1]!.isToday).toBe(true);
    expect(days[days.length - 1]!.total).toBe(500); // today

    // The whole point vs the capped-list bug: the full 25×100 old-day total is
    // present in the window (never truncated to ~0), plus today's 500.
    const windowTotal = days.reduce((s, d) => s + d.total, 0);
    expect(windowTotal).toBe(3000); // 2500 + 500 — nothing dropped
    // and the bulk lands on ONE non-today day, not scattered/lost.
    const busiest = Math.max(...days.slice(0, -1).map((d) => d.total));
    expect(busiest).toBe(2500);
  });
});
