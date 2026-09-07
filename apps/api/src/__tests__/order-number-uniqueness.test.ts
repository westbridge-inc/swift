/**
 * [OTA-021] AN ORDER NUMBER IS UNIQUE BY CONSTRUCTION, NOT BY LUCK.
 *
 * Checkout used to take the day's sequence from a COUNT executed OUTSIDE its transaction,
 * so every concurrent checkout was handed the same number and uniqueness rested on three
 * random characters over a 30-symbol alphabet — 27,000 possibilities. `orders.orderNumber`
 * is UNIQUE, so a collision does not degrade a label: it aborts a real customer's order.
 * At 200 orders sharing one sequence number the chance of at least one collision is ~0.52.
 *
 * The sequence is now claimed inside the transaction from `order_number_counter` with a
 * single INSERT .. ON CONFLICT DO UPDATE .. RETURNING. These tests exercise that claim
 * under real concurrency against the real database, not a mock.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { prismaPlugin, runWithoutTenant } from '../plugins/prisma';

let app: FastifyInstance;
const DAY = new Date('2031-03-14T00:00:00.000Z'); // a day no fixture uses

const claim = () => runWithoutTenant(() => app.prisma.$queryRaw<Array<{ next: number }>>`
  INSERT INTO "order_number_counter" ("day", "next")
  VALUES (${DAY}::date, 1)
  ON CONFLICT ("day") DO UPDATE SET "next" = "order_number_counter"."next" + 1, "updatedAt" = now()
  RETURNING "next"
`, 'order-number-test');

beforeAll(async () => {
  process.env['NODE_ENV'] = 'test';
  app = Fastify({ logger: false });
  await app.register(prismaPlugin);
  await app.ready();
  await runWithoutTenant(() => app.prisma.$executeRaw`DELETE FROM "order_number_counter" WHERE "day" = ${DAY}::date`, 'order-number-test');
});
afterAll(async () => {
  await runWithoutTenant(() => app.prisma.$executeRaw`DELETE FROM "order_number_counter" WHERE "day" = ${DAY}::date`, 'order-number-test');
  await app.close();
});

describe('[OTA-021] the day sequence is claimed, never counted', () => {
  it('test_concurrent_claims_are_all_distinct: 200 simultaneous claims yield 200 different numbers', async () => {
    // The old path handed all 200 the SAME number. This is the property that made a
    // collision possible at all; with distinct numbers the random suffix is decoration.
    const results = await Promise.all(Array.from({ length: 200 }, () => claim()));
    const numbers = results.map((r) => r[0]!.next);
    expect(numbers).toHaveLength(200);
    expect(new Set(numbers).size, 'every concurrent claim must be unique').toBe(200);
    // and they are a contiguous run — nothing is skipped or reissued
    expect([...numbers].sort((a, b) => a - b)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
  });

  it('the counter is per day, so a new day starts again at 1 without touching yesterday', async () => {
    const other = new Date('2031-03-15T00:00:00.000Z');
    await runWithoutTenant(() => app.prisma.$executeRaw`DELETE FROM "order_number_counter" WHERE "day" = ${other}::date`, 'order-number-test');
    const [row] = await runWithoutTenant(() => app.prisma.$queryRaw<Array<{ next: number }>>`
      INSERT INTO "order_number_counter" ("day", "next") VALUES (${other}::date, 1)
      ON CONFLICT ("day") DO UPDATE SET "next" = "order_number_counter"."next" + 1 RETURNING "next"
    `, 'order-number-test');
    expect(row!.next).toBe(1);
    const yesterday = await runWithoutTenant(() => app.prisma.orderNumberCounter.findUnique({ where: { day: DAY } }), 'order-number-test');
    expect(yesterday!.next, 'a new day must not disturb the previous one').toBe(200);
    await runWithoutTenant(() => app.prisma.$executeRaw`DELETE FROM "order_number_counter" WHERE "day" = ${other}::date`, 'order-number-test');
  });

  it('checkout takes its sequence from the counter, not from a count of today\'s orders', () => {
    // The regression that would reintroduce the defect is textual: a COUNT feeding the
    // sequence. Named here so it cannot come back quietly.
    const src = readFileSync(join(__dirname, '..', 'modules', 'order', 'order.service.ts'), 'utf8');
    expect(src).toContain('INSERT INTO "order_number_counter"');
    expect(src, 'the pre-transaction count must not return').not.toMatch(/const todayCount\s*=/);
  });
});

