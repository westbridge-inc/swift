import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { promoBelongsToCallerTenant } from '../modules/promo/promo-tenant';
import { runWithTenant } from '../plugins/tenant-context';

afterEach(() => vi.unstubAllEnvs());
describe('foreign and unknown promos perform the same membership reads', () => {
  it('does not skip indexed ownership reads based on whether a code was found', async () => {
    vi.stubEnv('PUBLIC_TENANT_ID', 'public');
    const calls: string[] = [];
    const prisma = {
      tenant: { findUnique: async () => { calls.push('tenant'); return { id: 'public', kind: 'PRODUCTION', isActive: true }; } },
      vendor: { findUnique: async () => { calls.push('vendor'); return { tenantId: 'foreign' }; } },
    } as unknown as PrismaClient;
    const traces: string[][] = [];
    for (const promo of [null, { vendorId: null }, { vendorId: 'foreign-store' }]) {
      calls.length = 0;
      expect(await runWithTenant('review', () => promoBelongsToCallerTenant(prisma, promo, 'caller'))).toBe(false);
      traces.push([...calls]);
    }
    expect(traces).toEqual([['tenant', 'vendor'], ['tenant', 'vendor'], ['tenant', 'vendor']]);
  });
});
