import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Prisma } from '@prisma/client';
import { discoveryRoutes, resetDiscoveryCacheForTests } from '../modules/discovery/discovery.routes';
import { runWithTenant } from '../plugins/tenant-context';
import { hostRoutes, orderStore, prismaDouble, recordingIo, recordingRedis, type Row } from './helpers/service-vertical-doubles';
import { queryRow, type Query } from './helpers/dl7-predicate-double';

beforeEach(resetDiscoveryCacheForTests);

// This stand-in interprets only the discovery SQL's tenant admission clauses.
// It exercises the registered handler and cache, but is not SQL/RLS proof.
async function fixture() {
  const tenant: Row = { id: 'discovery-fixture', kind: 'PRODUCTION', isActive: true };
  const category: Row = { id: 'category-fixture', tenantId: tenant['id'], slug: 'fixture', name: 'PUBLIC_CATEGORY',
    emoji: 'F', iconKey: null, kind: 'CUISINE', vertical: 'FOOD', status: 'ACTIVE', sortWeight: 1 };
  let afterEligibility: (() => void) | undefined;
  const raw = vi.fn(async (query: Prisma.Sql) => {
    const sql = query.sql;
    if (!sql.includes('vendor_discovery_categories')) throw new Error('UNMODELLED_DISCOVERY_SQL');
    const values = query.values;
    const tenantScoped = values.includes(tenant['id']);
    const active = !/t\."?isActive"?\s*=\s*true/.test(sql) || tenant['isActive'];
    const kind = !/t\.kind\s*=/.test(sql) || tenant['kind'] === 'PRODUCTION';
    if (!tenantScoped || !active || !kind) return [];
    return [{ categoryId: category['id'], n: 1n, ...category }];
  });
  const prisma = prismaDouble(orderStore([]), {
    platformConfig: { findUnique: async () => ({ value: true }) },
    tenant: { findFirst: async (q: Query) => {
      const row = queryRow(tenant, q); const snapshot = row ? structuredClone(row) : null;
      afterEligibility?.(); afterEligibility = undefined; return snapshot;
    } },
    discoveryCategory: { findMany: async (q: Query) => [queryRow(category, q)].filter(Boolean) },
    $queryRaw: raw,
  });
  const host = await hostRoutes(discoveryRoutes, { prisma, redis: recordingRedis(), io: recordingIo() });
  const read = (mode: 'public' | 'bound' = 'public') => runWithTenant(String(tenant['id']), () => host.call('get /categories', {
    ...(mode === 'public' ? { publicTenantId: tenant['id'] } : { tenantId: tenant['id'] }), query: { vertical: 'FOOD' },
  }));
  return { tenant, category, raw, read, afterEligibility: (fn: () => void) => { afterEligibility = fn; } };
}

describe('DL7 discovery actual caller and cache scope', () => {
  it.each(['REVIEW', 'CRAWLER', 'DISABLED'])('a %s transition after public resolution hides newly private categories', async state => {
    const h = await fixture();
    if (state === 'DISABLED') h.tenant['isActive'] = false; else h.tenant['kind'] = state;
    h.category['name'] = 'NEW_PRIVATE_CATEGORY';
    expect(await h.read()).toMatchObject({ data: { enabled: true, categories: [] } });
  });
  it('a transition after the cache eligibility read is still checked by the actual SQL', async () => {
    const h = await fixture();
    h.afterEligibility(() => { h.tenant['kind'] = 'REVIEW'; h.category['name'] = 'NEW_PRIVATE_CATEGORY'; });
    expect(await h.read()).toMatchObject({ data: { enabled: true, categories: [] } });
    expect(h.raw).toHaveBeenCalledOnce();
  });
  it.each(['REVIEW', 'DISABLED'])('warm public cache cannot bypass a current %s tenant', async state => {
    const h = await fixture();
    expect(JSON.stringify(await h.read())).toContain('PUBLIC_CATEGORY');
    if (state === 'DISABLED') h.tenant['isActive'] = false; else h.tenant['kind'] = state;
    expect(await h.read()).toMatchObject({ data: { categories: [] } });
  });
  it('bound REVIEW cache cannot answer a previously bound public request for the same tenant ID', async () => {
    const h = await fixture(); h.tenant['kind'] = 'REVIEW'; h.category['name'] = 'NEW_PRIVATE_CATEGORY';
    expect(JSON.stringify(await h.read('bound'))).toContain('NEW_PRIVATE_CATEGORY');
    expect(await h.read()).toMatchObject({ data: { categories: [] } });
  });
  it('public and bound cache payloads remain separate across a permitted classification transition', async () => {
    const h = await fixture(); h.tenant['kind'] = 'REVIEW'; h.category['name'] = 'OLD_PRIVATE_CATEGORY';
    expect(JSON.stringify(await h.read('bound'))).toContain('OLD_PRIVATE_CATEGORY');
    h.tenant['kind'] = 'PRODUCTION'; h.category['name'] = 'PUBLIC_CATEGORY';
    const response = JSON.stringify(await h.read());
    expect(response).toContain('PUBLIC_CATEGORY'); expect(response).not.toContain('OLD_PRIVATE_CATEGORY');
  });
  it('active bound REVIEW and CRAWLER callers retain their own rail', async () => {
    for (const kind of ['REVIEW', 'CRAWLER']) {
      resetDiscoveryCacheForTests(); const h = await fixture(); h.tenant['kind'] = kind;
      expect(await h.read('bound')).toMatchObject({ data: { categories: [{ slug: 'fixture', availableVendors: 1 }] } });
    }
  });
});
