import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';

const mocks = vi.hoisted(() => ({
  bindTenantTransaction: vi.fn(),
}));

vi.mock('../../plugins/prisma', () => ({
  bindTenantTransaction: mocks.bindTenantTransaction,
}));

import { runTenantBoundServiceJobTransaction } from './service-job-transaction';

describe('service-job interactive transaction tenant contract', () => {
  beforeEach(() => {
    mocks.bindTenantTransaction.mockReset();
  });

  it('binds the canonical tenant context before user locks or service-job queries', async () => {
    const events: string[] = [];
    mocks.bindTenantTransaction.mockImplementation(async () => {
      events.push('bind-tenant');
    });
    const raw = {
      $queryRaw: vi.fn(async () => {
        events.push('user-lock');
        return [];
      }),
      serviceJob: {
        updateMany: vi.fn(async () => {
          events.push('service-job-cas');
          return { count: 1 };
        }),
      },
    };
    const tx = raw as unknown as Prisma.TransactionClient;

    await runTenantBoundServiceJobTransaction(tx, async (boundTx) => {
      expect(boundTx).toBe(tx);
      await boundTx.$queryRaw`SELECT "id" FROM "users" FOR UPDATE`;
      await boundTx.serviceJob.updateMany({ where: { id: 'job-1' }, data: { status: 'QUOTED' } });
    });

    expect(mocks.bindTenantTransaction).toHaveBeenCalledOnce();
    expect(mocks.bindTenantTransaction).toHaveBeenCalledWith(tx);
    expect(events).toEqual(['bind-tenant', 'user-lock', 'service-job-cas']);
  });

  it('does not run any lifecycle operation when tenant binding fails', async () => {
    const bindingError = new Error('tenant bind failed');
    mocks.bindTenantTransaction.mockRejectedValue(bindingError);
    const operation = vi.fn();

    await expect(runTenantBoundServiceJobTransaction(
      {} as Prisma.TransactionClient,
      operation,
    )).rejects.toBe(bindingError);
    expect(operation).not.toHaveBeenCalled();
  });
});
