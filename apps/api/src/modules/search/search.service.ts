import { MeiliSearch } from 'meilisearch';
import type { PrismaClient } from '@prisma/client';
import { VISIBLE_VENDOR, VISIBLE_VENDOR_REL } from '../vendor/vendor-visibility';
import { ratingSurfaces } from '../rating/rating-surface';

const VENDOR_INDEX = 'vendors';
const ITEM_INDEX = 'items';

export class SearchService {
  private client: MeiliSearch;

  constructor(
    private prisma: PrismaClient,
    url?: string,
    apiKey?: string,
  ) {
    this.client = new MeiliSearch({
      host: url || process.env['MEILISEARCH_URL'] || 'http://localhost:7700',
      apiKey: apiKey || process.env['MEILISEARCH_KEY'] || '',
      // A hung/slow Meili must not hang the search handler (pre-launch audit
      // M3). 5s ceiling; the route falls back to a DB query on any failure.
      timeout: 5000,
    });
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
      filterableAttributes: ['vendorType', 'status', 'isCurrentlyOpen', 'cuisineTypes', 'averageRating', 'city', 'store_categories', 'derived_categories', 'top_rated'],
      sortableAttributes: ['averageRating', 'totalOrders', 'name', 'display_rating', 'rating_count'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    });

    const itemIndex = this.client.index(ITEM_INDEX);
    await itemIndex.updateSettings({
      searchableAttributes: ['name', 'description', 'vendorName', 'categoryName', 'dietaryTags'],
      filterableAttributes: ['vendorId', 'isAvailable', 'isPopular', 'dietaryTags', 'basePrice', 'categories'],
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
      id: v.id,
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
    return docs.length;
  }

  async syncAllItems(): Promise<number> {
    const items = await this.prisma.item.findMany({
      // [B2] The vendor gate moves INTO the query and carries the full
      // predicate — the old post-fetch `status === 'ACTIVE'` filter let an
      // unverified or dead-tenant operator's dishes into the index.
      where: { isAvailable: true, vendor: VISIBLE_VENDOR_REL },
      include: {
        vendor: { select: { name: true, status: true } },
        category: { select: { name: true } },
      },
    });

    const itemSlugs = await this.itemCategorySlugs(items.map((i) => i.id));
    const docs = items
      .map((i) => ({
        id: i.id,
        name: i.name,
        description: i.description || '',
        vendorId: i.vendorId,
        vendorName: i.vendor.name,
        categoryName: i.category.name,
        basePrice: Number(i.basePrice),
        imageUrl: i.imageUrl,
        isAvailable: i.isAvailable,
        isPopular: i.isPopular,
        dietaryTags: i.dietaryTags,
        allergens: i.allergens,
        totalOrdered: i.totalOrdered,
        categories: itemSlugs.get(i.id) ?? [],
      }));

    await this.client.index(ITEM_INDEX).addDocuments(docs);
    return docs.length;
  }

  async searchVendors(query: string, options?: {
    type?: string;
    cuisine?: string;
    openOnly?: boolean;
    limit?: number;
    offset?: number;
    sort?: string[];
  }) {
    const filter: string[] = [];
    if (options?.type) filter.push(`vendorType = "${options.type}"`);
    if (options?.cuisine) filter.push(`cuisineTypes = "${options.cuisine}"`);
    if (options?.openOnly) filter.push('isCurrentlyOpen = true');

    return this.client.index(VENDOR_INDEX).search(query, {
      filter: filter.length > 0 ? filter : undefined,
      limit: options?.limit || 20,
      offset: options?.offset || 0,
      sort: options?.sort,
    });
  }

  async searchItems(query: string, options?: {
    vendorId?: string;
    dietary?: string;
    maxPrice?: number;
    limit?: number;
    offset?: number;
    sort?: string[];
  }) {
    const filter: string[] = ['isAvailable = true'];
    if (options?.vendorId) filter.push(`vendorId = "${options.vendorId}"`);
    if (options?.dietary) filter.push(`dietaryTags = "${options.dietary}"`);
    if (options?.maxPrice) filter.push(`basePrice <= ${options.maxPrice}`);

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
      include: { categories: true },
    });
    if (!vendor) return;

    if (vendor.status === 'ACTIVE') {
      const discovery = await this.vendorCategorySlugs([vendor.id]);
      const surface = (await ratingSurfaces(this.prisma, 'VENDOR', [vendor.id])).get(vendor.id);
      await this.client.index(VENDOR_INDEX).addDocuments([{
        id: vendor.id,
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
      await this.client.index(VENDOR_INDEX).deleteDocument(vendorId);
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
        vendor: { select: { name: true, status: true } },
        category: { select: { name: true } },
      },
    });

    const live = items.filter((i) => i.isAvailable && i.vendor.status === 'ACTIVE');
    const gone = items.filter((i) => !(i.isAvailable && i.vendor.status === 'ACTIVE'));

    if (live.length > 0) {
      const itemSlugs = await this.itemCategorySlugs(live.map((i) => i.id));
      await this.client.index(ITEM_INDEX).addDocuments(
        live.map((i) => ({
          id: i.id,
          name: i.name,
          description: i.description || '',
          vendorId: i.vendorId,
          vendorName: i.vendor.name,
          categoryName: i.category.name,
          basePrice: Number(i.basePrice),
          imageUrl: i.imageUrl,
          isAvailable: i.isAvailable,
          isPopular: i.isPopular,
          dietaryTags: i.dietaryTags,
          allergens: i.allergens,
          totalOrdered: i.totalOrdered,
          categories: itemSlugs.get(i.id) ?? [],
        })),
      );
    }
    if (gone.length > 0) {
      await this.client.index(ITEM_INDEX).deleteDocuments(gone.map((i) => i.id));
    }
    return live.length;
  }

  /** Remove one item's search doc (the hard-delete route calls this — the
   *  row is gone from the DB, so no sweep could find it later). */
  async removeItemDoc(itemId: string): Promise<void> {
    await this.client.index(ITEM_INDEX).deleteDocument(itemId);
  }
}
