import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';
import { SearchService, type SearchClientLike, type SearchIndexLike } from '../modules/search/search.service';
import { FilterValueRejected, ITEM_INDEX, VENDOR_INDEX, docId } from '../modules/search/search-scope';
import { searchIndexDocsGauge, searchScopeCounter } from '../plugins/observability';

// ---------------------------------------------------------------------------
// [R048-003] The index half, proven WITHOUT a Meilisearch process: a recording
// client stands in for Meili. Two active tenants with one visible vendor and
// one available item each, plus a third tenant that is disabled. Every
// document the full sync writes carries its tenant and a tenant-prefixed id;
// the full sync reconciles — a stale document (the disabled tenant's, a
// deleted row's) is removed in the same sync; every query carries the tenant
// clause first, built by the server; adversarial filter values stay literal
// or are refused; a vanished vendor's document is removed by its entity id.
// ---------------------------------------------------------------------------

class FakeIndex implements SearchIndexLike {
  docs = new Map<string, Record<string, unknown>>();
  searches: Array<{ query: string; options: Record<string, unknown> | undefined }> = [];
  settings: Record<string, unknown> | null = null;
  deleteFilters: Array<string | string[]> = [];
  constructor(readonly uid: string) {}
  async addDocuments(docs: Record<string, unknown>[]) { for (const d of docs) this.docs.set(String(d['id']), d); return { taskUid: 1 }; }
  async deleteDocument(id: string) { this.docs.delete(id); return { taskUid: 1 }; }
  async deleteDocuments(params: string[] | { filter: string | string[] }) {
    if (Array.isArray(params)) { for (const id of params) this.docs.delete(id); return { taskUid: 1 }; }
    this.deleteFilters.push(params.filter);
    // the fake honours exactly the one filter shape the service uses: entityId = "<id>"
    const m = /^entityId = "(.*)"$/.exec(String(params.filter));
    if (m) for (const [id, d] of this.docs) if (d['entityId'] === m[1]) this.docs.delete(id);
    return { taskUid: 1 };
  }
  async getDocuments(params: { fields?: string[]; limit?: number; offset?: number }) {
    const all = [...this.docs.values()];
    const page = all.slice(params.offset ?? 0, (params.offset ?? 0) + (params.limit ?? 20));
    return { results: page.map((d) => ({ id: d['id'] })), total: all.length };
  }
  async search(query: string, options?: Record<string, unknown>) { this.searches.push({ query, options }); return { hits: [], estimatedTotalHits: 0, processingTimeMs: 1 }; }
  async updateSettings(settings: Record<string, unknown>) { this.settings = settings; return { taskUid: 1 }; }
}
class FakeClient implements SearchClientLike {
  indexes = new Map<string, FakeIndex>();
  async createIndex(uid: string) { this.index(uid); return { taskUid: 1 }; }
  index(uid: string): FakeIndex { let i = this.indexes.get(uid); if (!i) { i = new FakeIndex(uid); this.indexes.set(uid, i); } return i; }
}

const prisma = new PrismaClient();
const RUN = nanoid(6).toLowerCase();
const TENANT_A = `tenant-ss-a-${RUN}`;
const TENANT_B = `tenant-ss-b-${RUN}`;
const TENANT_DEAD = `tenant-ss-dead-${RUN}`;
const userIds: string[] = []; const vendorIds: string[] = []; const itemIds: string[] = []; const categoryIds: string[] = [];
let seq = 0;
const phoneBase = 592_750_000_000 + Math.floor(Math.random() * 100_000_000);

async function makeVendorWithItem(tenantId: string, name: string) {
  seq += 1;
  const user = await prisma.user.create({ data: { phone: `+${phoneBase + seq}`, firstName: 'SS', lastName: `O${seq}`, roles: ['VENDOR_OWNER'], activeRole: 'VENDOR_OWNER', isPhoneVerified: true, tenantId } });
  userIds.push(user.id);
  const vo = await prisma.vendorOwner.create({ data: { userId: user.id } });
  const vendor = await prisma.vendor.create({
    data: {
      ownerId: vo.id, name, slug: `ss-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${RUN}-${seq}`, vendorType: 'STORE', phone: `+${phoneBase + 700_000 + seq}`,
      addressLine1: '1 Scope St', city: 'Georgetown', region: 'Demerara-Mahaica', latitude: 6.8, longitude: -58.15, status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true, tenantId,
    },
  });
  vendorIds.push(vendor.id);
  const category = await prisma.category.create({ data: { vendorId: vendor.id, name: 'Shelf', sortOrder: 1 } });
  categoryIds.push(category.id);
  const item = await prisma.item.create({ data: { vendorId: vendor.id, categoryId: category.id, name: `${name} Widget`, basePrice: 1200, isAvailable: true } });
  itemIds.push(item.id);
  return { vendor, item };
}

const count = async (outcome: string) => (await searchScopeCounter.get()).values.find((v) => v.labels['outcome'] === outcome)?.value ?? 0;
const gauge = async (index: string, tenant: string) => (await searchIndexDocsGauge.get()).values.find((v) => v.labels['index'] === index && v.labels['tenant'] === tenant)?.value ?? null;

let a: Awaited<ReturnType<typeof makeVendorWithItem>>;
let b: Awaited<ReturnType<typeof makeVendorWithItem>>;
let dead: Awaited<ReturnType<typeof makeVendorWithItem>>;
let client: FakeClient;
let service: SearchService;

beforeAll(async () => {
  await prisma.$connect();
  for (const [id, isActive] of [[TENANT_A, true], [TENANT_B, true], [TENANT_DEAD, false]] as const) {
    await prisma.tenant.create({ data: { id, name: `Scope ${id}`, slug: id, isActive } });
  }
  a = await makeVendorWithItem(TENANT_A, 'Alpha Store');
  b = await makeVendorWithItem(TENANT_B, 'Bravo Store');
  dead = await makeVendorWithItem(TENANT_DEAD, 'Dead Store');
  client = new FakeClient();
  service = new SearchService(prisma, undefined, undefined, client);
  await service.initialize();
});
afterAll(async () => {
  await prisma.item.deleteMany({ where: { id: { in: itemIds } } }).catch(() => {});
  await prisma.category.deleteMany({ where: { id: { in: categoryIds } } }).catch(() => {});
  await prisma.vendor.deleteMany({ where: { id: { in: vendorIds } } }).catch(() => {});
  await prisma.vendorOwner.deleteMany({ where: { userId: { in: userIds } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => {});
  await prisma.tenant.deleteMany({ where: { id: { in: [TENANT_A, TENANT_B, TENANT_DEAD] } } }).catch(() => {});
  await prisma.$disconnect();
});

describe('[R048-003] every index document carries its tenant, under a tenant-prefixed id', () => {
  it('the indexes are the versioned names and tenantId/entityId are filterable on both', () => {
    expect([...client.indexes.keys()].sort()).toEqual([ITEM_INDEX, VENDOR_INDEX].sort());
    for (const name of [VENDOR_INDEX, ITEM_INDEX]) {
      const attrs = client.index(name).settings?.['filterableAttributes'] as string[];
      expect(attrs).toEqual(expect.arrayContaining(['tenantId', 'entityId']));
    }
  });

  it('a full sync writes each visible vendor and item under <tenant>__<id> with tenantId and entityId; the disabled tenant is never written', async () => {
    await service.syncAllVendors();
    await service.syncAllItems();
    const vendors = client.index(VENDOR_INDEX);
    const items = client.index(ITEM_INDEX);
    expect(vendors.docs.get(docId(TENANT_A, a.vendor.id))).toMatchObject({ entityId: a.vendor.id, tenantId: TENANT_A, name: 'Alpha Store' });
    expect(vendors.docs.get(docId(TENANT_B, b.vendor.id))).toMatchObject({ entityId: b.vendor.id, tenantId: TENANT_B });
    expect(vendors.docs.has(docId(TENANT_DEAD, dead.vendor.id))).toBe(false);
    expect(items.docs.get(docId(TENANT_A, a.item.id))).toMatchObject({ entityId: a.item.id, tenantId: TENANT_A, vendorId: a.vendor.id });
    expect(items.docs.get(docId(TENANT_B, b.item.id))).toMatchObject({ entityId: b.item.id, tenantId: TENANT_B });
    expect(items.docs.has(docId(TENANT_DEAD, dead.item.id))).toBe(false);
    // no document anywhere without a tenant
    for (const d of [...vendors.docs.values(), ...items.docs.values()]) expect(typeof d['tenantId']).toBe('string');
    // parity: document counts by tenant were published
    expect(await gauge(VENDOR_INDEX, TENANT_A)).toBe(1);
    expect(await gauge(ITEM_INDEX, TENANT_B)).toBe(1);
  });

  it('a full sync RECONCILES: a stale document — the disabled tenant’s, a vanished row’s — is removed in the same sync and counted', async () => {
    const vendors = client.index(VENDOR_INDEX);
    // plant what an earlier sync would have left behind: the dead operator, and a vendor that no longer exists
    vendors.docs.set(docId(TENANT_DEAD, dead.vendor.id), { id: docId(TENANT_DEAD, dead.vendor.id), entityId: dead.vendor.id, tenantId: TENANT_DEAD, name: 'Dead Store' });
    vendors.docs.set(`${TENANT_A}__gone-${RUN}`, { id: `${TENANT_A}__gone-${RUN}`, entityId: `gone-${RUN}`, tenantId: TENANT_A, name: 'Gone' });
    const before = await count('stale_docs_removed');
    await service.syncAllVendors();
    expect(vendors.docs.has(docId(TENANT_DEAD, dead.vendor.id))).toBe(false);
    expect(vendors.docs.has(`${TENANT_A}__gone-${RUN}`)).toBe(false);
    expect(vendors.docs.has(docId(TENANT_A, a.vendor.id))).toBe(true);
    expect(vendors.docs.has(docId(TENANT_B, b.vendor.id))).toBe(true);
    expect(await count('stale_docs_removed')).toBe(before + 2);
  });

  it('a per-vendor sync writes the tenant too, and a vanished vendor is removed by its ENTITY id (its tenant is unknown by then)', async () => {
    const vendors = client.index(VENDOR_INDEX);
    await service.syncVendor(b.vendor.id);
    expect(vendors.docs.get(docId(TENANT_B, b.vendor.id))).toMatchObject({ tenantId: TENANT_B, entityId: b.vendor.id });
    // the same vendor, now DELETED from the database
    vendors.docs.set(`${TENANT_B}__phantom-${RUN}`, { id: `${TENANT_B}__phantom-${RUN}`, entityId: `phantom-${RUN}`, tenantId: TENANT_B, name: 'Phantom' });
    await service.syncVendor(`phantom-${RUN}`);
    expect(vendors.docs.has(`${TENANT_B}__phantom-${RUN}`)).toBe(false);
    expect(vendors.deleteFilters.at(-1)).toBe(`entityId = "phantom-${RUN}"`);
    // and an item's removal, the same way
    const items = client.index(ITEM_INDEX);
    items.docs.set(`${TENANT_B}__ghost-${RUN}`, { id: `${TENANT_B}__ghost-${RUN}`, entityId: `ghost-${RUN}`, tenantId: TENANT_B });
    await service.removeItemDoc(`ghost-${RUN}`);
    expect(items.docs.has(`${TENANT_B}__ghost-${RUN}`)).toBe(false);
  });
});

describe('[R048-003] every query carries the tenant clause, built by the server', () => {
  it('searchVendors and searchItems put tenantId first in the filter; the tenant is mandatory', async () => {
    await service.searchVendors(TENANT_A, 'alpha', { type: 'STORE', cuisine: 'creole', openOnly: true, limit: 5 });
    const v = client.index(VENDOR_INDEX).searches.at(-1)!;
    expect(v.options?.['filter']).toEqual([`tenantId = "${TENANT_A}"`, 'vendorType = "STORE"', 'cuisineTypes = "creole"', 'isCurrentlyOpen = true']);
    await service.searchItems(TENANT_B, 'widget', { dietary: 'vegan', maxPrice: 2500, vendorId: b.vendor.id });
    const i = client.index(ITEM_INDEX).searches.at(-1)!;
    expect(i.options?.['filter']).toEqual([`tenantId = "${TENANT_B}"`, 'isAvailable = true', `vendorId = "${b.vendor.id}"`, 'dietaryTags = "vegan"', 'basePrice <= 2500']);
    await expect(service.searchVendors('', 'alpha')).rejects.toBeInstanceOf(FilterValueRejected);
  });

  it('a crafted filter value stays literal inside its quotes, or is refused — never a broadened filter', async () => {
    await service.searchVendors(TENANT_A, 'x', { cuisine: `creole" OR tenantId = "${TENANT_B}` });
    const v = client.index(VENDOR_INDEX).searches.at(-1)!;
    const filter = v.options?.['filter'] as string[];
    expect(filter[0]).toBe(`tenantId = "${TENANT_A}"`);
    expect(filter[1]).toBe(`cuisineTypes = "creole\\" OR tenantId = \\"${TENANT_B}"`);
    expect(filter.join(' AND ')).not.toMatch(new RegExp(`[^\\\\]"\\s*OR\\s*tenantId = "${TENANT_B}"`));
    await expect(service.searchItems(TENANT_A, 'x', { dietary: 'vegan\nOR 1=1' })).rejects.toMatchObject({ code: 'FILTER_VALUE_REJECTED' });
    await expect(service.searchItems(TENANT_A, 'x', { maxPrice: Number.NaN })).rejects.toMatchObject({ code: 'FILTER_VALUE_REJECTED' });
  });
});
