import { MeiliSearch } from 'meilisearch';
import type { PrismaClient } from '@prisma/client';

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
      filterableAttributes: ['vendorType', 'status', 'isCurrentlyOpen', 'cuisineTypes', 'averageRating', 'city'],
      sortableAttributes: ['averageRating', 'totalOrders', 'name'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    });

    const itemIndex = this.client.index(ITEM_INDEX);
    await itemIndex.updateSettings({
      searchableAttributes: ['name', 'description', 'vendorName', 'categoryName', 'dietaryTags'],
      filterableAttributes: ['vendorId', 'isAvailable', 'isPopular', 'dietaryTags', 'basePrice'],
      sortableAttributes: ['basePrice', 'totalOrdered', 'name'],
      rankingRules: ['words', 'typo', 'proximity', 'attribute', 'sort', 'exactness'],
    });
  }

  async syncAllVendors(): Promise<number> {
    const vendors = await this.prisma.vendor.findMany({
      where: { status: 'ACTIVE' },
      include: { categories: true },
    });

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
    }));

    await this.client.index(VENDOR_INDEX).addDocuments(docs);
    return docs.length;
  }

  async syncAllItems(): Promise<number> {
    const items = await this.prisma.item.findMany({
      where: { isAvailable: true },
      include: {
        vendor: { select: { name: true, status: true } },
        category: { select: { name: true } },
      },
    });

    const docs = items
      .filter((i) => i.vendor.status === 'ACTIVE')
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
      }]);
    } else {
      await this.client.index(VENDOR_INDEX).deleteDocument(vendorId);
    }
  }
}
