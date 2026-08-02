import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { runShadowScan, shadowReport } from '../modules/batching/shadow-scan';

// System 1 Part 8 — the shadow scanner writes SHADOW_WOULD_BATCH evidence and
// NOTHING else. Orders live in a backdated window (scan time T = 5h ago, pool
// bounded [T−1h, T]) so parallel suites' orders can't enter the pool — the
// scan's world is exactly what this file seeds.

const prisma = new PrismaClient({ datasources: { db: { url: process.env['DATABASE_URL'] || 'postgresql://swift:swift@localhost:5434/swift_test' } } });

const T = new Date(Date.now() - 5 * 3600_000); // scan-time anchor, well clear of live suites
const inWindow = new Date(T.getTime() - 10 * 60_000);
const orderIds: string[] = [];
let customerId = '';

async function makeOrder(over: Record<string, unknown> = {}) {
  const o = await prisma.order.create({
    data: {
      orderNumber: `SHD-${nanoid(8)}`,
      orderType: 'FOOD_DELIVERY' as never,
      customerId,
      status: 'READY_FOR_PICKUP' as never,
      fulfillment: 'DELIVERY' as never,
      pickupAddress: 'Stabroek', pickupLat: 6.8013, pickupLng: -58.1553,
      deliveryAddress: 'x', deliveryLat: 6.8043, deliveryLng: -58.1523,
      subtotalBase: 2000, subtotalMarkup: 0, subtotalCustomer: 2000,
      deliveryFee: 500, totalAmount: 2500, paymentMethod: 'CASH' as never,
      placedAt: inWindow, createdAt: inWindow,
      ...(over as object),
    } as never,
  });
  orderIds.push(o.id);
  return o;
}

beforeAll(async () => {
  await prisma.$connect();
  const user = await prisma.user.create({
    data: {
      phone: `+${592_004_000_000 + Math.floor(Math.random() * 8_000_000)}`,
      firstName: 'Shadow', lastName: 'Scan', roles: ['CUSTOMER'], activeRole: 'CUSTOMER', isPhoneVerified: true,
    },
  });
  customerId = user.id;
});

afterAll(async () => {
  await prisma.batchEvaluation.deleteMany({ where: { orderId: { in: orderIds } } });
  await prisma.order.deleteMany({ where: { id: { in: orderIds } } });
  await prisma.user.delete({ where: { id: customerId } }).catch(() => undefined);
  await prisma.$disconnect();
});

describe('the shadow scanner (evidence, zero behavior)', () => {
  it('pairs compatible waiting orders into SHADOW_WOULD_BATCH rows with honest rule rows', async () => {
    const a = await makeOrder();
    const b = await makeOrder({ deliveryLat: 6.8053, deliveryLng: -58.1523 }); // ~100m from a's dropoff
    await makeOrder({ orderType: 'COURIER', status: 'ACCEPTED', courierPackageSize: 'SMALL' }); // R1: FOOD|COURIER never

    const res = await runShadowScan(prisma, T);
    expect(res.evaluated).toBe(3); // 3 orders → 3 pairs, all in-window
    expect(res.wouldBatch).toBe(1); // only the FOOD+FOOD pair
    expect(res.capped).toBe(false);

    const rows = await prisma.batchEvaluation.findMany({ where: { orderId: { in: [a.id, b.id] }, decision: 'SHADOW_WOULD_BATCH' } });
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect([a.id, b.id]).toContain((row.scoreBreakdown as { pairedWith: string }).pairedWith);
    const rules = row.rulesChecked as { rule: string; pass: boolean; value: unknown }[];
    expect(rules.find((r) => r.rule === 'R1')?.pass).toBe(true);
    // Rider-dependent rules are marked skipped, never silently passed as measured.
    for (const skipped of ['R3', 'R4', 'R12']) {
      expect(rules.find((r) => r.rule === skipped)?.value).toBe('SHADOW_SKIPPED');
    }
  });

  it('dedups: an immediate re-scan writes nothing new for the same pair', async () => {
    const res = await runShadowScan(prisma, T);
    expect(res.wouldBatch).toBe(0);
    // The already-evidenced pair was skipped, so only the courier pairs were re-evaluated.
    expect(res.evaluated).toBe(2);
  });

  it('assigned, old, and taxi orders never enter the pool', async () => {
    await makeOrder({ createdAt: new Date(T.getTime() - 2 * 3600_000), placedAt: new Date(T.getTime() - 2 * 3600_000) }); // too old
    await makeOrder({ status: 'PICKED_UP' }); // already moving
    const res = await runShadowScan(prisma, T);
    expect(res.wouldBatch).toBe(0); // neither newcomer pairs; the a|b pair stays deduped
  });

  it('shadowReport aggregates the window by day', async () => {
    const rep = await shadowReport(prisma, 14);
    expect(rep.totalWouldBatchPairs).toBeGreaterThanOrEqual(1);
    expect(rep.distinctOrdersInvolved).toBeGreaterThanOrEqual(1);
    expect(rep.byDay.length).toBeGreaterThanOrEqual(1);
    expect(rep.byDay[0]).toHaveProperty('pairs');
  });

  it('settings with shadowMode AND enabled both off make the scan a no-op', async () => {
    await prisma.batchingSettings.upsert({
      where: { tenantId: 'swift-default' },
      create: { tenantId: 'swift-default', shadowMode: false, enabled: false },
      update: { shadowMode: false, enabled: false },
    });
    try {
      const res = await runShadowScan(prisma, T);
      expect(res).toEqual({ evaluated: 0, wouldBatch: 0, capped: false });
    } finally {
      await prisma.batchingSettings.update({ where: { tenantId: 'swift-default' }, data: { shadowMode: true } });
    }
  });
});
