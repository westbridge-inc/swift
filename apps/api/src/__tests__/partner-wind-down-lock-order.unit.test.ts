import { expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { windDownPartner } from '../modules/user/partner-wind-down';

it('locks payer and sorted sources before winding down subscriptions and vendor rows', async () => {
  const writes: string[] = [];
  const prisma = {
    $queryRaw: vi.fn(async (sql: TemplateStringsArray) => {
      const text = sql.join('?');
      if (text.includes('FROM users')) writes.push('payer');
      else { expect(text).toContain('ORDER BY s.id FOR UPDATE OF s'); writes.push('sources'); }
      return [];
    }),
    vendorOwner: { findUnique: vi.fn(async () => ({ id: 'owner-1' })) },
    vendor: {
      findMany: vi.fn(async () => [{ id: 'vendor-1' }]),
      updateMany: vi.fn(async () => { writes.push('vendor'); return { count: 1 }; }),
    },
    item: { updateMany: vi.fn(async () => ({ count: 1 })) },
    // [RETIER · REVIEW-M #2259 S4-1] the listings go off sale in plain SQL (Swift's write leaves items."updatedAt" alone)
    $executeRaw: vi.fn(async () => 1),
    vendorStaff: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    rider: { findUnique: vi.fn(async () => ({ id: 'rider-1' })), update: vi.fn(async () => ({})) },
    driver: { findUnique: vi.fn(async () => null) },
    // [BILL-PRO] The person is also an independent pro: their own weekly fee winds down too.
    serviceProvider: { findUnique: vi.fn(async () => ({ id: 'pro-1' })) },
    subscription: {
      updateMany: vi.fn(async () => { writes.push('subscription'); return { count: 1 }; }),
    },
    // [#1848 follow-up] staged MMG link/number changes close with the cleared destinations, after the vendor rows.
    moneySurfaceCommand: {
      updateMany: vi.fn(async () => { writes.push('mmg-stages'); return { count: 0 }; }),
    },
  };

  await windDownPartner(prisma as unknown as Prisma.TransactionClient, 'user-1');

  expect(writes).toEqual(['payer', 'sources', 'subscription', 'vendor', 'mmg-stages']);
  expect(prisma.item.updateMany).not.toHaveBeenCalled();
  const [hide] = prisma.$executeRaw.mock.calls as unknown as Array<[TemplateStringsArray, ...unknown[]]>;
  expect(hide![0].join('?')).toContain('UPDATE "items" SET "isAvailable" = false WHERE "vendorId" IN');
  expect(hide![0].join('?')).not.toContain('updatedAt');
  const where = (prisma.subscription.updateMany.mock.calls[0] as unknown as [{ where: { OR: unknown[] } }])[0].where;
  expect(where.OR).toEqual([{ riderId: 'rider-1' }, { serviceProviderId: 'pro-1' }, { vendorId: { in: ['vendor-1'] } }]);
});
