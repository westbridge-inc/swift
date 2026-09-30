import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { expect, it } from 'vitest';
import { createGolden } from './gold-7-helpers';

// [G7-01] Cleanup isolation, not a journey. A concurrent writer can use the
// same admin subject and recipient. Before/after census is not ownership.
// Phone +5920978nnn: source/range-audited; no other fixture uses this prefix.
it('removes only run-owned admin alerts and preserves unrelated rows inserted before and during the run', async () => {
  const other = new PrismaClient();
  const h = createGolden('+5920978', 'gold7-cleanup');
  const recipientId = `gold7-external-${nanoid(12)}`;
  const beforeId = `gold7-before-${nanoid(12)}`;
  const duringId = `gold7-during-${nanoid(12)}`;
  const data = { kind: 'ADMIN_OPS', subjectId: 'vendor_pending', recipientId };
  let closed = false;
  try {
    const before = await other.alertDelivery.create({ data: { ...data, id: beforeId } });
    await h.start();
    await h.actor();
    await h.sys(() => h.app.prisma.alertDelivery.createMany({ data }));
    const own = await other.alertDelivery.findMany({ where: { recipientId, id: { not: beforeId } } });
    expect(own).toHaveLength(1);
    const during = await other.alertDelivery.create({ data: { ...data, id: duringId } });
    await h.close(); closed = true;
    expect(await other.alertDelivery.findUnique({ where: { id: duringId } })).toEqual(during);
    expect(await other.alertDelivery.findUnique({ where: { id: beforeId } })).toEqual(before);
    expect(await other.alertDelivery.count({ where: { id: { in: own.map((row) => row.id) } } })).toBe(0);
  } finally {
    if (!closed && h.app) await h.close();
    await other.alertDelivery.deleteMany({ where: { recipientId } });
    await other.$disconnect();
  }
});
