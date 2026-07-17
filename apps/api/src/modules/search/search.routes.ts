import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SearchService } from './search.service';
import { AppError, ForbiddenError } from '../../utils/errors';
import { sortByDistance } from '../../utils/distance';

const searchQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(['RESTAURANT', 'SUPERMARKET']).optional(),
  cuisine: z.string().max(50).optional(),
  lat: z.coerce.number().min(-90).max(90).optional(),
  lng: z.coerce.number().min(-180).max(180).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const suggestionsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
});

const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(50).default(5),
  type: z.enum(['RESTAURANT', 'SUPERMARKET']).optional(),
});

export async function searchRoutes(app: FastifyInstance) {
  let searchService: SearchService | null = null;

  // Warm Meilisearch in the BACKGROUND — server startup must never block on it. avvio's
  // ~10s plugin timeout plus a full re-sync can otherwise take the whole API down on
  // restart. Until the index is ready, the routes below fall back to DB search.
  void (async () => {
    try {
      const svc = new SearchService(app.prisma);
      await svc.initialize();
      await svc.syncAllVendors();
      await svc.syncAllItems();
      searchService = svc;
      app.log.info('Meilisearch initialized and synced');
    } catch (err) {
      app.log.warn({ err }, 'Meilisearch unavailable — falling back to DB search');
    }
  })();

  // Universal search — searches vendors AND items
  app.get('/search', { preHandler: [app.authenticate] }, async (request) => {
    const { q, type, cuisine, lat, lng, limit: parsedLimit } = searchQuerySchema.parse(request.query);

    if (!q || q.length < 2) {
      return { success: true, data: { vendors: [], items: [] } };
    }

    if (searchService) {
      try {
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
      } catch (err) {
        // Meili went down AFTER boot (timeout or error) — don't 500; fall
        // through to the DB query below (pre-launch audit M3).
        app.log.warn({ err }, 'Meilisearch query failed — falling back to DB search');
      }
    }

    // DB fallback (boot-time Meili absence OR a runtime Meili failure)
    const userLat = lat ?? null;
    const userLng = lng ?? null;

    const [vendors, items] = await Promise.all([
      app.prisma.vendor.findMany({
        where: {
          status: 'ACTIVE',
          isVerified: true,
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
            { cuisineTypes: { hasSome: [q] } },
            { tags: { hasSome: [q] } },
          ],
          ...(type && { vendorType: type }),
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
    const { q } = suggestionsQuerySchema.parse(request.query);
    if (!q || q.length < 2) return { success: true, data: [] };

    const [vendors, items] = await Promise.all([
      app.prisma.vendor.findMany({
        where: { status: 'ACTIVE', isVerified: true, name: { contains: q, mode: 'insensitive' } },
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
  app.get('/search/trending', { preHandler: [app.authenticate] }, async (_request) => {
    const items = await app.prisma.item.findMany({
      where: { isAvailable: true, isPopular: true, vendor: { status: 'ACTIVE', isVerified: true, isCurrentlyOpen: true } },
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
    const { lat: userLat, lng: userLng, radius: radiusKm, type } = nearbyQuerySchema.parse(request.query);

    const vendors = await app.prisma.vendor.findMany({
      where: {
        status: 'ACTIVE',
        isVerified: true,
        isCurrentlyOpen: true,
        // Empty stores (no orderable item) stay out of nearby discovery.
        items: { some: { isAvailable: true } },
        ...(type && { vendorType: type }),
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

  // Re-sync search index (admin). Thrown errors get the standard envelope +
  // real status codes from the global handler (a 200-with-error body doesn't).
  app.post('/search/sync', { preHandler: [app.authenticate] }, async (request) => {
    if (request.user.role !== 'SUPER_ADMIN' && request.user.role !== 'ADMIN') {
      throw new ForbiddenError('Admin only');
    }

    if (!searchService) {
      throw new AppError(503, 'UNAVAILABLE', 'Search service not available');
    }

    const [vendorCount, itemCount] = await Promise.all([
      searchService.syncAllVendors(),
      searchService.syncAllItems(),
    ]);

    return { success: true, data: { vendorsSynced: vendorCount, itemsSynced: itemCount } };
  });
}
