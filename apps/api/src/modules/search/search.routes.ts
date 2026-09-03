import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SearchService } from './search.service';
import { AppError, ForbiddenError } from '../../utils/errors';
import { sortByDistance } from '../../utils/distance';
import { requireRequestTenant } from './search-scope';
import { visibleVendorInTenant } from '../vendor/vendor-visibility';
import { ratingSurfaces } from '../rating/rating-surface';
import { ITEM_HIT_SELECT, itemHitFromSearchDoc, toItemHit, type ItemHit } from './item-hit';

// [B2] ONE wire contract whichever engine answered. The route used to hand
// clients raw Meilisearch hits on the fast path and raw Prisma rows on the
// fallback — different field names (display_rating vs averageRating), so a
// client bound to one shape silently broke when the engine flipped. The
// client must never know which engine answered.
type VendorHit = {
  id: string; name: string; slug: string | null; vendorType: string;
  logoUrl: string | null; coverImageUrl: string | null; cuisineTypes: string[];
  city: string | null; latitude: number | null; longitude: number | null;
  estimatedPrepTime: number | null; isCurrentlyOpen: boolean;
  displayRating: number | null; ratingCount: number; topRated: boolean;
};
// The item half of that contract is not declared here. It lives in
// `./item-hit`, which the Market feed also imports — one shape, one mapper per
// engine. This file used to carry its own `type ItemHit` and build it by hand
// on both paths, which is how `isNew` could have shipped on the market card and
// silently not on the search card for the same item.

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
    // [R048-003] ONE tenant per request — the caller's, as auth bound it. Carried into the
    // index filter (server-built) and into every DB fallback query below.
    const tenantId = requireRequestTenant(request);

    if (!q || q.length < 2) {
      return { success: true, data: { vendors: [], items: [] } };
    }

    if (searchService) {
      try {
        const [vendorResults, itemResults] = await Promise.all([
          searchService.searchVendors(tenantId, q, { type, cuisine, openOnly: true, limit: parsedLimit }),
          searchService.searchItems(tenantId, q, { limit: parsedLimit }),
        ]);

        const vendors: VendorHit[] = (vendorResults.hits as Record<string, unknown>[]).map((h) => ({
          // the entity id, never the tenant-prefixed document id
          id: String(h['entityId'] ?? h['id']),
          name: String(h['name']),
          slug: (h['slug'] as string | null) ?? null,
          vendorType: String(h['vendorType']),
          logoUrl: (h['logoUrl'] as string | null) ?? null,
          coverImageUrl: (h['coverImageUrl'] as string | null) ?? null,
          cuisineTypes: (h['cuisineTypes'] as string[]) ?? [],
          city: (h['city'] as string | null) ?? null,
          latitude: (h['latitude'] as number | null) ?? null,
          longitude: (h['longitude'] as number | null) ?? null,
          estimatedPrepTime: (h['estimatedPrepTime'] as number | null) ?? null,
          isCurrentlyOpen: Boolean(h['isCurrentlyOpen']),
          // R8 star fields ride the index (synced with the facets) — snake in
          // the doc, one camel shape on the wire.
          displayRating: (h['display_rating'] as number | null) ?? null,
          ratingCount: (h['rating_count'] as number | null) ?? 0,
          topRated: Boolean(h['top_rated']),
        }));
        const items: ItemHit[] = (itemResults.hits as Record<string, unknown>[]).map(
          itemHitFromSearchDoc,
        );

        return {
          success: true,
          data: {
            vendors,
            items,
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
        // [B2] The ONE visibility predicate — this fallback previously
        // dropped tenant.isActive, so a shut-off operator's store surfaced
        // whenever Meilisearch was down.
        where: {
          ...visibleVendorInTenant(tenantId),
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
        // [B2] Same predicate through the relation — `status: 'ACTIVE'` alone
        // let an unverified or shut-off operator's dishes answer searches.
        where: {
          isAvailable: true,
          // the relation filter is not reached by the tenant-scoping extension: the tenant is named here
          vendor: visibleVendorInTenant(tenantId),
          OR: [
            { name: { contains: q, mode: 'insensitive' } },
            { description: { contains: q, mode: 'insensitive' } },
          ],
        },
        // The shared select, so the fallback cannot quietly serve fewer fields
        // than the fast path and make the engine visible to the client.
        select: ITEM_HIT_SELECT,
        take: parsedLimit,
        orderBy: { totalOrdered: 'desc' },
      }),
    ]);

    // R8: the star surface rides the ONE mapper on the fallback path too, so
    // both engines speak the same displayRating/topRated contract.
    const surfaces = await ratingSurfaces(app.prisma, 'VENDOR', vendors.map((v) => v.id));

    const shapedVendors: VendorHit[] = vendors.map((v) => ({
      id: v.id,
      name: v.name,
      slug: v.slug,
      vendorType: v.vendorType,
      logoUrl: v.logoUrl,
      coverImageUrl: v.coverImageUrl,
      cuisineTypes: v.cuisineTypes,
      city: v.city,
      latitude: v.latitude,
      longitude: v.longitude,
      estimatedPrepTime: v.estimatedPrepTime,
      isCurrentlyOpen: v.isCurrentlyOpen,
      displayRating: surfaces.get(v.id)?.displayRating ?? null,
      ratingCount: surfaces.get(v.id)?.ratingCount ?? 0,
      topRated: surfaces.get(v.id)?.topRated ?? false,
    }));

    // Sort vendors by distance if lat/lng provided. A hit with no committed
    // coordinates can't claim a distance — it sorts after the ones that can,
    // never with an invented position.
    let sortedVendors: VendorHit[] = shapedVendors;
    if (userLat && userLng) {
      const locatable = shapedVendors.filter(
        (v): v is VendorHit & { latitude: number; longitude: number } => v.latitude != null && v.longitude != null,
      );
      const unlocatable = shapedVendors.filter((v) => v.latitude == null || v.longitude == null);
      sortedVendors = [...sortByDistance(locatable, userLat, userLng), ...unlocatable];
    }

    const shapedItems: ItemHit[] = items.map(toItemHit);

    return {
      success: true,
      data: {
        vendors: sortedVendors,
        items: shapedItems,
        meta: { vendorCount: vendors.length, itemCount: items.length },
      },
    };
  });

  // Suggestions / autocomplete
  app.get('/search/suggestions', { preHandler: [app.authenticate] }, async (request) => {
    const { q } = suggestionsQuerySchema.parse(request.query);
    if (!q || q.length < 2) return { success: true, data: [] };
    const tenantId = requireRequestTenant(request);

    const [vendors, items] = await Promise.all([
      app.prisma.vendor.findMany({
        where: { ...visibleVendorInTenant(tenantId), name: { contains: q, mode: 'insensitive' } },
        select: { name: true, vendorType: true },
        take: 5,
      }),
      app.prisma.item.findMany({
        // [B2] This query had NO vendor predicate at all — a banned store's
        // dish names kept autocompleting for every customer who typed.
        where: { isAvailable: true, vendor: visibleVendorInTenant(tenantId), name: { contains: q, mode: 'insensitive' } },
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

  // Trending — most-ordered dishes across OPEN stores.
  // [B2 · the trap an earlier analysis fell into] `isPopular` is a VENDOR-SET
  // checkbox, not a ranking: gating "trending" on it let any store self-
  // promote by ticking a box, and hid genuinely demanded dishes whose vendor
  // never found the toggle. Trending must be EARNED, so it ranks on
  // totalOrdered alone. isCurrentlyOpen stays: this feeds discovery moments
  // ("worth trying right now"), and a closed store isn't tryable right now.
  app.get('/search/trending', { preHandler: [app.authenticate] }, async (request) => {
    const tenantId = requireRequestTenant(request);
    const items = await app.prisma.item.findMany({
      where: { isAvailable: true, vendor: { ...visibleVendorInTenant(tenantId), isCurrentlyOpen: true } },
      // The shared select again. Trending is the Market tab's fallback rail, so
      // its cards land in the SAME component as the feed's; the fifth hand-built
      // copy of this shape lived here and served an item with no `isNew` and no
      // `categoryName` beside feed items that had both.
      select: { ...ITEM_HIT_SELECT, totalOrdered: true },
      orderBy: { totalOrdered: 'desc' },
      take: 20,
    });

    return {
      success: true,
      // ItemHit plus the one field that makes it *trending* — a superset, never
      // a different shape.
      data: items.map((i) => ({ ...toItemHit(i), totalOrdered: i.totalOrdered })),
    };
  });

  // Nearby vendors (location-based)
  app.get('/search/nearby', { preHandler: [app.authenticate] }, async (request) => {
    const { lat: userLat, lng: userLng, radius: radiusKm, type } = nearbyQuerySchema.parse(request.query);
    const tenantId = requireRequestTenant(request);

    const vendors = await app.prisma.vendor.findMany({
      where: {
        ...visibleVendorInTenant(tenantId),
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
