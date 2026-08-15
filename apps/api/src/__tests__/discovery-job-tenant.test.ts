import { describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { getTenantId } from '../plugins/tenant-context';
import { runAiClassifierBatch, type CategoryClassifier } from '../modules/discovery/ai-classifier';
import { runCategoryBackfill } from '../modules/discovery/backfill';
import { reconcileAllDerived } from '../modules/discovery/derivation';
import {
  discoveryTenantIdFromJobData,
  requireActiveDiscoveryTenant,
  runForActiveDiscoveryTenants,
} from '../modules/discovery/tenant-boundary';

describe('discovery background-job tenant boundary', () => {
  it('fails closed when a targeted job does not carry one concrete tenant', () => {
    for (const data of [undefined, null, {}, { tenantId: '' }, { tenantId: '   ' }, { tenantId: 42 }]) {
      expect(() => discoveryTenantIdFromJobData(data)).toThrowError(
        expect.objectContaining({ code: 'DISCOVERY_TENANT_REQUIRED' }),
      );
    }
    expect(discoveryTenantIdFromJobData({ tenantId: '  tenant-b  ' })).toBe('tenant-b');
  });

  it('does not let domain entry points revive the old swift-default fallback', async () => {
    const prisma = {} as PrismaClient;
    const classifier: CategoryClassifier = {
      enabled: false,
      classifyCategories: async () => ({}),
    };

    await expect(runCategoryBackfill(prisma, classifier, {} as never))
      .rejects.toMatchObject({ code: 'DISCOVERY_TENANT_REQUIRED' });
    await expect(runAiClassifierBatch(prisma, classifier, {} as never))
      .rejects.toMatchObject({ code: 'DISCOVERY_TENANT_REQUIRED' });
    await expect(reconcileAllDerived(prisma, undefined as never))
      .rejects.toMatchObject({ code: 'DISCOVERY_TENANT_REQUIRED' });
  });

  it('rejects unknown or inactive tenants before any discovery work starts', async () => {
    const findUnique = vi.fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ isActive: false })
      .mockResolvedValueOnce({ isActive: true });
    const prisma = { tenant: { findUnique } } as unknown as PrismaClient;

    await expect(requireActiveDiscoveryTenant(prisma, { tenantId: 'missing' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_TENANT_UNAVAILABLE' });
    await expect(requireActiveDiscoveryTenant(prisma, { tenantId: 'inactive' }))
      .rejects.toMatchObject({ code: 'DISCOVERY_TENANT_UNAVAILABLE' });
    await expect(requireActiveDiscoveryTenant(prisma, { tenantId: 'active' }))
      .resolves.toBe('active');
  });

  it('runs recurring sweeps once per active tenant under that tenant ALS context', async () => {
    const findMany = vi.fn().mockResolvedValue([
      { id: 'tenant-a' },
      { id: 'tenant-b' },
    ]);
    const prisma = { tenant: { findMany } } as unknown as PrismaClient;
    const observed: Array<{ argument: string; context: string | null }> = [];

    const results = await runForActiveDiscoveryTenants(prisma, async (tenantId) => {
      observed.push({ argument: tenantId, context: getTenantId() });
      return `${tenantId}:done`;
    });

    expect(findMany).toHaveBeenCalledWith({
      where: { isActive: true },
      orderBy: { id: 'asc' },
      select: { id: true },
    });
    expect(observed).toEqual([
      { argument: 'tenant-a', context: 'tenant-a' },
      { argument: 'tenant-b', context: 'tenant-b' },
    ]);
    expect(results).toEqual([
      { tenantId: 'tenant-a', result: 'tenant-a:done' },
      { tenantId: 'tenant-b', result: 'tenant-b:done' },
    ]);
    expect(getTenantId()).toBeNull();
  });
});
