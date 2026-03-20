import type { FastifyInstance } from 'fastify';
import { SearchService } from './search.service';
import { sortByDistance } from '../../utils/distance';

export async function searchRoutes(app: FastifyInstance) {
  let searchService: SearchService | null = null;

  try {
    searchService = new SearchService(app.prisma);
    await searchService.initialize();
    await searchService.syncAllVendors();
    await searchService.syncAllItems();
    app.log.info('Meilisearch initialized and synced');
  } catch (err) {
    app.log.warn({ err }, 'Meilisearch unavailable — falling back to DB search');
  }

  // Universal search — searches vendors AND items
  app.get('/search', { preHandler: [app.authenticate] }, async (request) => {
    const { q, type, cuisine, lat, lng, limit = '10' } = request.query as Record<string, string>;

    if (!q || q.trim().length < 2) {
      return { success: true, data: { vendors: [], items: [] } };
    }

    const parsedLimit = parseInt(limit, 10);

    if (searchService) {
      const [vendorResults, itemResults] = await Promise.all([
        searchService.searchVendors(q, { type, cuisine, openOnly: true, limit: parsedLimit }),
        searchService.searchItems(q, { limit: parsedLimit }),
      ]);

      return {
        success: true,
        data: {
          vendors: vendorResults.hits,
          items: itemResults.hits,
          meta: {
            vendorCount: vendorResults.estimatedTotalHits,
            itemCount: itemResults.estimatedTotalHits,
            processingTimeMs: vendorResults.processingTimeMs + itemResults.processingTimeMs,
          },
        },
      };
    }

    // DB fallback
    const searchTerm = `%${q.toLowerCase()}%`;
    const userLat = lat ? parseFloat(lat) : null;
    const userLng = lng ? parseFloat(lng) : null;

    const [vendors, items] = await Promise.all([
      app.prisma.vendor.findMany({
        where: {
          status: 'ACTIVE',
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { cuisineTypes: { hasSome: [q] } },
            { tags: { hasSome: [q] } },
          ],
          ...(type && { vendorType: type as 'RESTAURANT' | 'SUPERMARKET' }),
        },
        select: {
          id: true,
          name: true,
          slug: true,
          vendorType: true,
          logoUrl: true,
          coverImageUrl: true,
          cuisineTypes: true,
          averageRating: true,
          totalRatings: true,
          isCurrentlyOpen: true,
          estimatedPrepTime: true,
          latitude: true,
          longitude: true,
          city: true,
        },
        take: parsedLimit,
        orderBy: { averageRating: 'desc' },
      }),
      app.prisma.item.findMany({
        where: {
          isAvailable: true,
          vendor: { status: 'ACTIVE' },
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        },
        select: {
          id: true,
          name: true,
          basePrice: true,
          imageUrl: true,
          vendorId: true,
          vendor: { select: { name: true } },
          category: { select: { name: true } },
          isPopular: true,
          dietaryTags: true,
        },
        take: parsedLimit,
        orderBy: { totalOrdered: 'desc' },
      }),
    ]);

    // Sort vendors by distance if lat/lng provided
    const sortedVendors = userLat && userLng
      ? sortByDistance(vendors, userLat, userLng)
      : vendors;

    return {
      success: true,
      data: {
        vendors: sortedVendors,
        items: items.map((i) => ({ ...i, basePrice: Number(i.basePrice) })),
        meta: { vendorCount: vendors.length, itemCount: items.length },
      },
    };
  });

  // Suggestions / autocomplete
  app.get('/search/suggestions', { preHandler: [app.authenticate] }, async (request) => {
    const { q } = request.query as { q?: string };
    if (!q || q.length < 2) return { success: true, data: [] };

    const [vendors, items] = await Promise.all([
      app.prisma.vendor.findMany({
        where: { status: 'ACTIVE', name: { contains: q, mode: 'insensitive' } },
        select: { name: true, vendorType: true },
        take: 5,
      }),
      app.prisma.item.findMany({
        where: { isAvailable: true, name: { contains: q, mode: 'insensitive' } },
        select: { name: true },
        take: 5,
      }),
    ]);

    const suggestions = [
      ...vendors.map((v) => ({ text: v.name, type: 'vendor' as const })),
      ...items.map((i) => ({ text: i.name, type: 'item' as const })),
    ];

    return { success: true, data: suggestions };
  });

  // Trending / popular items
  app.get('/search/trending', { preHandler: [app.authenticate] }, async (request) => {
    const items = await app.prisma.item.findMany({
      where: { isAvailable: true, isPopular: true, vendor: { status: 'ACTIVE', isCurrentlyOpen: true } },
      include: { vendor: { select: { name: true, slug: true } } },
      orderBy: { totalOrdered: 'desc' },
      take: 20,
    });

    return {
      success: true,
      data: items.map((i) => ({
        id: i.id,
        name: i.name,
        basePrice: Number(i.basePrice),
        imageUrl: i.imageUrl,
        vendorId: i.vendorId,
        vendorName: i.vendor.name,
        totalOrdered: i.totalOrdered,
      })),
    };
  });

  // Nearby vendors (location-based)
  app.get('/search/nearby', { preHandler: [app.authenticate] }, async (request) => {
    const { lat, lng, radius = '5', type } = request.query as Record<string, string>;
    if (!lat || !lng) return { success: false, error: { code: 'MISSING_LOCATION', message: 'lat and lng are required' } };

    const userLat = parseFloat(lat);
    const userLng = parseFloat(lng);
    const radiusKm = parseFloat(radius);

    const vendors = await app.prisma.vendor.findMany({
      where: {
        status: 'ACTIVE',
        isCurrentlyOpen: true,
        ...(type && { vendorType: type as 'RESTAURANT' | 'SUPERMARKET' }),
      },
      select: {
        id: true,
        name: true,
        slug: true,
        vendorType: true,
        logoUrl: true,
        coverImageUrl: true,
        cuisineTypes: true,
        averageRating: true,
        totalRatings: true,
        estimatedPrepTime: true,
        latitude: true,
        longitude: true,
        city: true,
        addressLine1: true,
      },
    });

    const nearby = sortByDistance(vendors, userLat, userLng)
      .filter((v) => v.distance <= radiusKm)
      .map((v) => ({
        ...v,
        distance: Math.round(v.distance * 10) / 10,
        estimatedDelivery: Math.ceil(((v.distance * 1.3) / 25) * 60) + 5 + (v.estimatedPrepTime || 30),
      }));

    return { success: true, data: nearby };
  });

  // Re-sync search index (admin)
  app.post('/search/sync', { preHandler: [app.authenticate] }, async (request) => {
    if (request.user.role !== 'SUPER_ADMIN' && request.user.role !== 'ADMIN') {
      return { success: false, error: { code: 'FORBIDDEN', message: 'Admin only' } };
    }

    if (!searchService) {
      return { success: false, error: { code: 'UNAVAILABLE', message: 'Search service not available' } };
    }

    const [vendorCount, itemCount] = await Promise.all([
      searchService.syncAllVendors(),
      searchService.syncAllItems(),
    ]);

    return { success: true, data: { vendorsSynced: vendorCount, itemsSynced: itemCount } };
  });
}
