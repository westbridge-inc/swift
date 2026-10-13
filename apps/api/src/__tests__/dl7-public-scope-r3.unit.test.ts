import { afterEach, describe, expect, it, vi } from 'vitest';
import { searchRoutes } from '../modules/search/search.routes';
import { marketRoutes } from '../modules/market/market.routes';
import { customerRoutes } from '../modules/user/customer.routes';
import { CountryConfigService } from '../modules/country/country-config.service';
import { runAsSystem, PUBLIC_BROWSE_CAPABILITY, runWithTenant } from '../plugins/tenant-context';
import { hostRoutes, orderStore, prismaDouble, recordingIo, recordingRedis, type Row } from './helpers/service-vertical-doubles';
import { queryRow, type Query } from './helpers/dl7-predicate-double';

vi.mock('../modules/search/search.service', () => ({ SearchService: class { async initialize() { throw new Error('UNIT_INDEX_OFF'); } } }));
vi.mock('../modules/verification/category-gate', () => ({
  hiddenOnlyItemIds: async () => [], listableItemsForVendors: async (_db: unknown, _tenant: string, rows: unknown[]) => rows,
}));
afterEach(() => vi.restoreAllMocks());

function store(id: string, tenant: Row): Row {
  return { id, tenantId: tenant['id'], tenant, status: 'ACTIVE', isVerified: true, subscription: null,
    name: `SENTINEL_${id}`, description: 'SENTINEL_DESCRIPTION', slug: id, vendorType: 'STORE', items: [{ isAvailable: true }],
    isCurrentlyOpen: true, acceptingOrders: true, cuisineTypes: [], tags: [], latitude: 6.8013, longitude: -58.1551,
    addressLine1: 'Fixture business address', logoUrl: null, coverImageUrl: null, city: 'Fixture city',
    estimatedPrepTime: 10, averageRating: 4, totalRatings: 1, minOrderAmount: 0, totalOrders: 1,
    deliveryRadius: 4, distanceKm: null };
}

async function fixture() {
  const tenant: Row = { id: 'scope-fixture', kind: 'PRODUCTION', isActive: true };
  const vendors = [store('seller-fixture', tenant)];
  const items: Row[] = [{ id: 'item-fixture', name: 'SENTINEL_ITEM', description: 'SENTINEL_DESCRIPTION', vendorId: vendors[0]!['id'],
    vendor: vendors[0], isAvailable: true, basePrice: 100, imageUrl: null, createdAt: new Date(), category: { name: 'Fixture category' }, totalOrdered: 1 }];
  let afterRank: (() => void) | undefined;
  const readVendors = vi.fn(async (q: Query) => {
    const rows = vendors.map(v => queryRow(v, q)).filter(v => v !== null);
    if (q.select && Object.hasOwn(q.select, 'isCurrentlyOpen') && Object.hasOwn(q.select, 'averageRating')) afterRank?.();
    return rows;
  });
  const readItems = vi.fn(async (q: Query) => items.map(i => queryRow(i, q)).filter(i => i !== null));
  const prisma = prismaDouble(orderStore([]), {
    vendor: { findMany: readVendors }, item: { findMany: readItems, count: async (q: Query) => (await readItems(q)).length },
    actorRatingStat: { findMany: async () => [] }, platformConfig: { findMany: async () => [] },
  });
  const parts = { prisma, redis: recordingRedis(), io: recordingIo() };
  const search = await hostRoutes(searchRoutes, parts); const market = await hostRoutes(marketRoutes, parts);
  const customer = await hostRoutes(customerRoutes, parts);
  const callSearch = (path: string, publicMode: boolean) => runWithTenant(String(tenant['id']), () => search.call(`get ${path}`, {
    ...(publicMode ? { publicTenantId: tenant['id'] } : { tenantId: tenant['id'] }), query: { q: 'SENTINEL', lat: '6.8013', lng: '-58.1551' },
  }));
  const callMarket = (path: string) => runWithTenant(String(tenant['id']), () => market.call(`get ${path}`, { publicTenantId: tenant['id'] }));
  const ranked = (page = 1) => runAsSystem(PUBLIC_BROWSE_CAPABILITY, () => customer.call('get /vendors', { query: { sort: 'top_rated', page: String(page), limit: '2' } }));
  return { tenant, vendors, items, callSearch, callMarket, ranked, afterRank: (fn: () => void) => { afterRank = fn; } };
}

describe('DL7 public mode survives binding into actual catalogue queries', () => {
  it.each(['/search', '/search/suggestions', '/search/trending', '/search/nearby'])('%s cannot read a newly private sentinel after public binding', async path => {
    const h = await fixture();
    // The resolver admitted this tenant earlier; a privileged change precedes
    // the real handler query. Only the post-change fixture carries this name.
    h.tenant['kind'] = 'REVIEW'; h.vendors[0]!['name'] = 'SENTINEL_NEW_PRIVATE'; h.items[0]!['name'] = 'SENTINEL_NEW_PRIVATE_ITEM';
    expect(JSON.stringify(await h.callSearch(path, true))).not.toContain('SENTINEL');
    expect(JSON.stringify(await h.callSearch(path, false))).toContain('SENTINEL');
  });
  it.each(['/items', '/depth'])('public market %s keeps PRODUCTION on its actual item and count queries', async path => {
    const h = await fixture(); h.tenant['kind'] = 'CRAWLER';
    const result = await h.callMarket(path);
    if (path === '/items') expect(result).toMatchObject({ data: { items: [], meta: { total: 0 } } });
    else expect(result).toMatchObject({ data: { items: 0, vendors: 0 } });
  });
  it('an active public market and search still return their lawful content', async () => {
    const h = await fixture();
    expect(JSON.stringify(await h.callSearch('/search', true))).toContain('SENTINEL');
    expect(JSON.stringify(await h.callMarket('/items'))).toContain('SENTINEL');
  });
  it('a disabled operator remains hidden for public and bound search', async () => {
    const h = await fixture(); h.tenant['isActive'] = false;
    expect(JSON.stringify(await h.callSearch('/search', true))).not.toContain('SENTINEL');
    expect(JSON.stringify(await h.callSearch('/search', false))).not.toContain('SENTINEL');
  });
});

describe('DL7 ranked total describes the initially eligible ranking population', () => {
  it.each(['disabled', 'reclassified'])('a later %s tenant has empty fresh rows and the original full metadata', async change => {
    const h = await fixture();
    vi.spyOn(CountryConfigService.prototype, 'getDeliveryRates').mockResolvedValue({} as never);
    h.afterRank(() => { if (change === 'disabled') h.tenant['isActive'] = false; else h.tenant['kind'] = 'REVIEW'; });
    expect(await h.ranked()).toMatchObject({ data: [], meta: { page: 1, limit: 2, total: 1, totalPages: 1, hasNext: false, hasPrev: false } });
  });
  it('hidden before the initial read contributes zero to total', async () => {
    const h = await fixture(); h.tenant['kind'] = 'REVIEW';
    vi.spyOn(CountryConfigService.prototype, 'getDeliveryRates').mockResolvedValue({} as never);
    expect(await h.ranked()).toMatchObject({ data: [], meta: { page: 1, limit: 2, total: 0, totalPages: 0, hasNext: false, hasPrev: false } });
  });
  it('multiple pages retain the global ranking count and distinct final page rows', async () => {
    const h = await fixture(); h.vendors.push(store('seller-second', h.tenant), store('seller-third', h.tenant));
    vi.spyOn(CountryConfigService.prototype, 'getDeliveryRates').mockResolvedValue({} as never);
    const first = await h.ranked() as { data: Row[]; meta: Row };
    const second = await h.ranked(2) as { data: Row[]; meta: Row };
    expect(first.meta).toEqual({ page: 1, limit: 2, total: 3, totalPages: 2, hasNext: true, hasPrev: false });
    expect(second.meta).toEqual({ page: 2, limit: 2, total: 3, totalPages: 2, hasNext: false, hasPrev: true });
    expect(first.data).toHaveLength(2); expect(second.data).toHaveLength(1);
    expect(new Set([...first.data, ...second.data].map(v => v['id'])).size).toBe(3);
  });
});
