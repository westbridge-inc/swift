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
    vendorStaff: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    rider: { findUnique: vi.fn(async () => ({ id: 'rider-1' })), update: vi.fn(async () => ({})) },
    driver: { findUnique: vi.fn(async () => null) },
    subscription: {
      updateMany: vi.fn(async () => { writes.push('subscription'); return { count: 1 }; }),
    },
  };

  await windDownPartner(prisma as unknown as Prisma.TransactionClient, 'user-1');

  expect(writes).toEqual(['payer', 'sources', 'subscription', 'vendor']);
});
