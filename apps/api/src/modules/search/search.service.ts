import { MeiliSearch } from 'meilisearch';
import type { PrismaClient } from '@prisma/client';
import { VISIBLE_VENDOR, VISIBLE_VENDOR_REL, VISIBLE_VENDOR_SELECT, isVendorVisible } from '../vendor/vendor-visibility';
import { ratingSurfaces } from '../rating/rating-surface';
import { toItemSearchDoc } from './item-hit';
import { ITEM_INDEX, VENDOR_INDEX, buildScopedFilter, docId, renderClause, type FilterClause } from './search-scope';
import { searchIndexDocsGauge, searchScopeCounter } from '../../plugins/observability';

/** [R048-003] The slice of the Meilisearch client this service uses — so a
 *  test can hand in a recording double and prove every document carries its
 *  tenant and every query carries the tenant filter, without a Meili process. */
export interface SearchIndexLike {
  addDocuments(docs: Record<string, unknown>[]): Promise<unknown>;
  deleteDocument(id: string): Promise<unknown>;
  deleteDocuments(params: string[] | { filter: string | string[] }): Promise<unknown>;
  getDocuments(params: { fields?: string[]; limit?: number; offset?: number }): Promise<{ results: Array<Record<string, unknown>>; total?: number }>;
  search(query: string, options?: Record<string, unknown>): Promise<{ hits: unknown[]; estimatedTotalHits?: number; processingTimeMs: number }>;
  updateSettings(settings: Record<string, unknown>): Promise<unknown>;
}
export interface SearchClientLike {
  createIndex(uid: string, options?: { primaryKey?: string }): Promise<unknown>;
  index(uid: string): SearchIndexLike;
}

/** One reconcile page: Meilisearch's getDocuments cap is 1000 per call. */
const RECONCILE_PAGE = 1000;

export class SearchService {
  private client: SearchClientLike;

  constructor(
    private prisma: PrismaClient,
    url?: string,
    apiKey?: string,
    client?: SearchClientLike,
  ) {
    this.client = client ?? (new MeiliSearch({
      host: url || process.env['MEILISEARCH_URL'] || 'http://localhost:7700',
      apiKey: apiKey || process.env['MEILISEARCH_KEY'] || '',
      // A hung/slow Meili must not hang the search handler (pre-launch audit
      // M3). 5s ceiling; the route falls back to a DB query on any failure.
      timeout: 5000,
    }) as unknown as SearchClientLike);
  }

  async initialize(): Promise<void> {
    // Create indexes with settings
    try {
      await this.client.createIndex(VENDOR_INDEX, { primaryKey: 'id' });
    } catch {
      // Index may already exist
    }
    try {
      await this.client.createIndex(ITEM_INDEX, { primaryKey: 'id' });
    } catch {
      // Index may already exist
    }

    const vendorIndex = this.client.index(VENDOR_INDEX);
    await vendorIndex.updateSettings({
      searchableAttributes: ['name', 'description', 'cuisineTypes', 'tags', 'city'],
      // [R048-003] tenantId is the partition every query names; entityId lets a doc be removed by its own id.
      filterableAttributes: ['tenantId', 'entityId', 'vendorType', 'status', 'isCurrentlyOpen', 'cuisineTypes', 'averageRating', 'city', 'store_categories', 'derived_categories', 'top_rated'],
      sortableAttributes: ['averageRating', 'totalOrders', 'name', 'display_rating', 'rating_count'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    });

    const itemIndex = this.client.index(ITEM_INDEX);
    await itemIndex.updateSettings({
      searchableAttributes: ['name', 'description', 'vendorName', 'categoryName', 'dietaryTags'],
      filterableAttributes: ['tenantId', 'entityId', 'vendorId', 'isAvailable', 'isPopular', 'dietaryTags', 'basePrice', 'categories'],
      sortableAttributes: ['basePrice', 'totalOrdered', 'name'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    });
  }

  /** Discovery facet slugs (#17 6.4) per vendor: chosen vs derived. */
  private async vendorCategorySlugs(vendorIds: string[]): Promise<Map<string, { chosen: string[]; derived: string[] }>> {
    const out = new Map<string, { chosen: string[]; derived: string[] }>();
    if (vendorIds.length === 0) return out;
    const rows = await this.prisma.vendorDiscoveryCategory.findMany({ where: { vendorId: { in: vendorIds } } });
    const cats = await this.prisma.discoveryCategory.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.categoryId))] } },
      select: { id: true, slug: true },
    });
    const slugById = new Map(cats.map((c) => [c.id, c.slug]));
    for (const r of rows) {
      const slug = slugById.get(r.categoryId);
      if (!slug) continue;
      const entry = out.get(r.vendorId) ?? { chosen: [], derived: [] };
      (r.source === 'DERIVED' ? entry.derived : entry.chosen).push(slug);
      out.set(r.vendorId, entry);
    }
    return out;
  }

  /** Discovery facet slugs per item. */
  private async itemCategorySlugs(itemIds: string[]): Promise<Map<string, string[]>> {
    const out = new Map<string, string[]>();
    if (itemIds.length === 0) return out;
    const rows = await this.prisma.itemDiscoveryCategory.findMany({ where: { itemId: { in: itemIds } } });
    const cats = await this.prisma.discoveryCategory.findMany({
      where: { id: { in: [...new Set(rows.map((r) => r.categoryId))] } },
      select: { id: true, slug: true },
    });
    const slugById = new Map(cats.map((c) => [c.id, c.slug]));
    for (const r of rows) {
      const slug = slugById.get(r.categoryId);
      if (!slug) continue;
      out.set(r.itemId, [...(out.get(r.itemId) ?? []), slug]);
    }
    return out;
  }

  async syncAllVendors(): Promise<number> {
    const vendors = await this.prisma.vendor.findMany({
      // [B2] The ONE visibility predicate at the INDEX door: without
      // tenant.isActive, a shut-off operator's whole catalogue stayed
      // searchable until someone happened to re-sync after also suspending
      // the store itself.
      where: VISIBLE_VENDOR,
      include: { categories: true },
    });

    const discovery = await this.vendorCategorySlugs(vendors.map((v) => v.id));
    const surfaces = await ratingSurfaces(this.prisma, 'VENDOR', vendors.map((v) => v.id));
    const docs = vendors.map((v) => ({
      // [R048-003] the partition rides the document: prefixed primary key, the entity id, the tenant
      id: docId(v.tenantId, v.id),
      entityId: v.id,
      tenantId: v.tenantId,
      name: v.name,
      slug: v.slug,
      description: v.description || '',
      vendorType: v.vendorType,
      status: v.status,
      logoUrl: v.logoUrl,
      coverImageUrl: v.coverImageUrl,
      cuisineTypes: v.cuisineTypes,
      tags: v.tags,
      city: v.city,
      latitude: v.latitude,
      longitude: v.longitude,
      averageRating: v.averageRating,
      totalOrders: v.totalOrders,
      totalRatings: v.totalRatings,
      isCurrentlyOpen: v.isCurrentlyOpen,
      estimatedPrepTime: v.estimatedPrepTime,
      minOrderAmount: Number(v.minOrderAmount),
      categoryCount: v.categories.length,
      store_categories: discovery.get(v.id)?.chosen ?? [],
      derived_categories: discovery.get(v.id)?.derived ?? [],
      // R8: the star fields ride the same reindex as the category facets (R0.3).
      display_rating: surfaces.get(v.id)?.displayRating ?? null,
      rating_count: surfaces.get(v.id)?.ratingCount ?? 0,
      top_rated: surfaces.get(v.id)?.topRated ?? false,
    }));

    await this.client.index(VENDOR_INDEX).addDocuments(docs);
    // [R048-003] Full sync is a RECONCILE: a document whose row is no longer visible (a
    // disabled operator, a suspended store, a deleted row) is removed — atomically with
    // respect to this sync — never left for someone to happen to re-index later.
    await this.reconcile(VENDOR_INDEX, new Set(docs.map((d) => d.id)));
    this.publishParity(VENDOR_INDEX, docs.map((d) => d.tenantId));
    return docs.length;
  }

  async syncAllItems(): Promise<number> {
    const items = await this.prisma.item.findMany({
      // [B2] The vendor gate moves INTO the query and carries the full
      // predicate — the old post-fetch `status === 'ACTIVE'` filter let an
      // unverified or dead-tenant operator's dishes into the index.
      where: { isAvailable: true, vendor: VISIBLE_VENDOR_REL },
      include: {
        vendor: { select: { name: true, status: true, tenantId: true } },
        category: { select: { name: true } },
      },
    });

    const itemSlugs = await this.itemCategorySlugs(items.map((i) => i.id));
    const docs = items.map((i) => toItemSearchDoc(i, itemSlugs.get(i.id) ?? []));

    await this.client.index(ITEM_INDEX).addDocuments(docs);
    await this.reconcile(ITEM_INDEX, new Set(docs.map((d) => d.id)));
    this.publishParity(ITEM_INDEX, docs.map((d) => d.tenantId));
    return docs.length;
  }

  /** [R048-003] Remove every document the fresh set does not contain. Pages
   *  through the index by id only; a page that fails leaves the index as it
   *  was (the next full sync reconciles again). Returns how many were removed. */
  private async reconcile(indexName: string, fresh: Set<string>): Promise<number> {
    const index = this.client.index(indexName);
    const stale: string[] = [];
    for (let offset = 0; ; offset += RECONCILE_PAGE) {
      const page = await index.getDocuments({ fields: ['id'], limit: RECONCILE_PAGE, offset });
      for (const doc of page.results) {
        const id = String(doc['id']);
        if (!fresh.has(id)) stale.push(id);
      }
      if (page.results.length < RECONCILE_PAGE) break;
    }
    if (stale.length > 0) {
      await index.deleteDocuments(stale);
      searchScopeCounter.labels('stale_docs_removed').inc(stale.length);
    }
    return stale.length;
  }

  /** [R048-003] Document counts by tenant after a full sync — the DB/index parity
   *  signal. The index was just written from exactly these rows, so the counts
   *  are the database's; a later disagreement is what the gauge is for. */
  private publishParity(indexName: string, tenantIds: string[]): void {
    const byTenant = new Map<string, number>();
    for (const t of tenantIds) byTenant.set(t, (byTenant.get(t) ?? 0) + 1);
    for (const [tenant, n] of byTenant) searchIndexDocsGauge.labels(indexName, tenant).set(n);
  }

  /** [R048-003] Every search is ONE tenant's: the tenant is the first argument,
   *  the filter is built by the scope module (the tenant clause first, every
   *  user-supplied value escaped or refused), never concatenated here. */
  async searchVendors(tenantId: string, query: string, options?: {
    type?: string;
    cuisine?: string;
    openOnly?: boolean;
    limit?: number;
    offset?: number;
    sort?: string[];
  }) {
    const clauses: FilterClause[] = [];
    if (options?.type) clauses.push({ attribute: 'vendorType', op: '=', value: options.type });
    if (options?.cuisine) clauses.push({ attribute: 'cuisineTypes', op: '=', value: options.cuisine });
    if (options?.openOnly) clauses.push({ attribute: 'isCurrentlyOpen', op: '=', value: true });
    const filter = buildScopedFilter(tenantId, clauses);

    return this.client.index(VENDOR_INDEX).search(query, {
      filter,
      limit: options?.limit || 20,
      offset: options?.offset || 0,
      sort: options?.sort,
    });
  }

  async searchItems(tenantId: string, query: string, options?: {
    vendorId?: string;
    dietary?: string;
    maxPrice?: number;
    limit?: number;
    offset?: number;
    sort?: string[];
  }) {
    const clauses: FilterClause[] = [{ attribute: 'isAvailable', op: '=', value: true }];
    if (options?.vendorId) clauses.push({ attribute: 'vendorId', op: '=', value: options.vendorId });
    if (options?.dietary) clauses.push({ attribute: 'dietaryTags', op: '=', value: options.dietary });
    if (options?.maxPrice !== undefined) clauses.push({ attribute: 'basePrice', op: '<=', value: options.maxPrice });
    const filter = buildScopedFilter(tenantId, clauses);

    return this.client.index(ITEM_INDEX).search(query, {
      filter,
      limit: options?.limit || 20,
      offset: options?.offset || 0,
      sort: options?.sort,
    });
  }

  async syncVendor(vendorId: string): Promise<void> {
    const vendor = await this.prisma.vendor.findUnique({
      where: { id: vendorId },
      // [B2] tenant.isActive is why this include exists. The liveness test
      // below used to be `status === 'ACTIVE'` alone, so an unverified store —
      // or one whose OPERATOR had been switched off — was written INTO the
      // index by this path and then served, because searchVendors filters on
      // surface attributes and trusts the index for visibility. The full
      // re-index (syncAllVendors) has always used the shared predicate, so a
      // reconcile removed them and the next incremental sync put them back.
      include: { categories: true, tenant: { select: { isActive: true } } },
    });
    // A vendor that no longer exists must not keep a document either. The
    // previous early return left the doc in the index until someone happened to
    // run a full re-index.
    if (!vendor) {
      // its tenant is unknown now, so the removal is by entity id — a filter, never a guessed document id
      await this.client.index(VENDOR_INDEX).deleteDocuments({ filter: renderClause({ attribute: 'entityId', op: '=', value: vendorId }) });
      return;
    }

    if (isVendorVisible(vendor)) {
      const discovery = await this.vendorCategorySlugs([vendor.id]);
      const surface = (await ratingSurfaces(this.prisma, 'VENDOR', [vendor.id])).get(vendor.id);
      await this.client.index(VENDOR_INDEX).addDocuments([{
        id: docId(vendor.tenantId, vendor.id),
        entityId: vendor.id,
        tenantId: vendor.tenantId,
        name: vendor.name,
        slug: vendor.slug,
        description: vendor.description || '',
        vendorType: vendor.vendorType,
        status: vendor.status,
        logoUrl: vendor.logoUrl,
        coverImageUrl: vendor.coverImageUrl,
        cuisineTypes: vendor.cuisineTypes,
        tags: vendor.tags,
        city: vendor.city,
        latitude: vendor.latitude,
        longitude: vendor.longitude,
        averageRating: vendor.averageRating,
        totalOrders: vendor.totalOrders,
        totalRatings: vendor.totalRatings,
        isCurrentlyOpen: vendor.isCurrentlyOpen,
        estimatedPrepTime: vendor.estimatedPrepTime,
        minOrderAmount: Number(vendor.minOrderAmount),
        categoryCount: vendor.categories.length,
        store_categories: discovery.get(vendor.id)?.chosen ?? [],
        derived_categories: discovery.get(vendor.id)?.derived ?? [],
        display_rating: surface?.displayRating ?? null,
        rating_count: surface?.ratingCount ?? 0,
        top_rated: surface?.topRated ?? false,
      }]);
    } else {
      await this.client.index(VENDOR_INDEX).deleteDocument(docId(vendor.tenantId, vendor.id));
    }
  }

  /** Per-vendor ITEM sync [SWIFT-UG-SRCH-01]: upserts the vendor's live
   *  (available, ACTIVE-vendor) items and explicitly deletes the docs for
   *  items that still exist but are no longer searchable (86'd, vendor
   *  suspended). Hard-DELETED rows can't be enumerated here — the item-delete
   *  route removes its own doc via removeItemDoc, and the boot/admin full
   *  sync remains the reconciler for anything missed. */
  async syncVendorItems(vendorId: string): Promise<number> {
    const items = await this.prisma.item.findMany({
      where: { vendorId },
      include: {
        // [B2] Same fix as syncVendor: the liveness test below was
        // `vendor.status === 'ACTIVE'`, which let an unverified or
        // switched-off operator's DISHES stay searchable — the exact shape of
        // the #790 defect, where a deactivated operator's dish sat above the
        // fold while their store was already hidden.
        vendor: { select: { name: true, tenantId: true, ...VISIBLE_VENDOR_SELECT } },
        category: { select: { name: true } },
      },
    });

    const searchable = (i: (typeof items)[number]) => i.isAvailable && isVendorVisible(i.vendor);
    const live = items.filter(searchable);
    const gone = items.filter((i) => !searchable(i));

    if (live.length > 0) {
      const itemSlugs = await this.itemCategorySlugs(live.map((i) => i.id));
      await this.client.index(ITEM_INDEX).addDocuments(
        live.map((i) => toItemSearchDoc(i, itemSlugs.get(i.id) ?? [])),
      );
    }
    if (gone.length > 0) {
      await this.client.index(ITEM_INDEX).deleteDocuments(gone.map((i) => docId(i.vendor.tenantId, i.id)));
    }
    return live.length;
  }

  /** Remove one item's search doc (the hard-delete route calls this — the
   *  row is gone from the DB, so no sweep could find it later). */
  async removeItemDoc(itemId: string): Promise<void> {
    // the row may already be gone, so its tenant is unknown: remove by entity id
    await this.client.index(ITEM_INDEX).deleteDocuments({ filter: renderClause({ attribute: 'entityId', op: '=', value: itemId }) });
  }
}
