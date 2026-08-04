import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

// ---------------------------------------------------------------------------
// Customer-facing discovery endpoints (#17 Part 8) — the rail's data source.
// Flag-gated by PlatformConfig CATEGORY_DISCOVERY_ENABLED (default false):
// flag off → { enabled:false, categories:[] } and every client renders the
// pre-rail Home, pixel-identical (CAT-G). Law D lives here: only categories
// with availableVendors > 0 return; the client hides the whole rail under
// CAT_RAIL_MIN_CHIPS. One membership query (chosen + derived rows), one
// availability truth (ACTIVE + verified + open + in delivery range), cached
// CAT_AVAIL_CACHE_S per rounded-geo cell — no N+1 anything.
// ---------------------------------------------------------------------------

export const CATEGORY_DISCOVERY_FLAG = 'CATEGORY_DISCOVERY_ENABLED';
const CAT_AVAIL_CACHE_S = Math.max(5, Number(process.env['CAT_AVAIL_CACHE_S'] ?? 60));

interface RailCategory {
  slug: string;
  name: string;
  emoji: string;
  iconKey: string | null;
  kind: string;
  vertical: string;
  availableVendors: number;
}

const cache = new Map<string, { at: number; payload: RailCategory[] }>();

export async function discoveryRoutes(app: FastifyInstance) {
  const flagEnabled = async (): Promise<boolean> => {
    const row = await app.prisma.platformConfig.findUnique({ where: { key: CATEGORY_DISCOVERY_FLAG } });
    return row?.value === true || row?.value === 'true';
  };

  /** GET /categories?vertical=FOOD|GROCERY|RETAIL|ALL&lat&lng */
  app.get('/categories', async (request) => {
    const query = z.object({
      vertical: z.enum(['FOOD', 'GROCERY', 'RETAIL', 'ALL']).default('ALL'),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
    }).parse(request.query ?? {});

    if (!(await flagEnabled())) return { success: true, data: { enabled: false, categories: [] } };

    // Cache per (vertical, ~1km geo cell) — 2dp ≈ 1.1 km at the equator.
    const cell = query.lat != null && query.lng != null
      ? `${query.lat.toFixed(2)}:${query.lng.toFixed(2)}`
      : 'anywhere';
    const key = `${query.vertical}:${cell}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CAT_AVAIL_CACHE_S * 1000) {
      return { success: true, data: { enabled: true, categories: hit.payload } };
    }

    // Membership (chosen + derived) joined to the ONE availability truth:
    // ACTIVE + verified + open now (+ within the vendor's own delivery radius
    // when the caller sent a location).
    const geoJoin = query.lat != null && query.lng != null
      ? `AND (6371 * acos(least(1, cos(radians($1)) * cos(radians(v.latitude)) * cos(radians(v.longitude) - radians($2)) + sin(radians($1)) * sin(radians(v.latitude))))) <= v."deliveryRadius"`
      : '';
    const params: unknown[] = query.lat != null && query.lng != null ? [query.lat, query.lng] : [];
    const rows = await app.prisma.$queryRawUnsafe<Array<{ categoryId: string; n: bigint }>>(
      `SELECT vc."categoryId", COUNT(DISTINCT vc."vendorId") AS n
       FROM "vendor_discovery_categories" vc
       JOIN "vendors" v ON v.id = vc."vendorId"
         AND v.status = 'ACTIVE' AND v."isVerified" = true AND v."isCurrentlyOpen" = true
         ${geoJoin}
       GROUP BY vc."categoryId"`,
      ...params,
    );
    const counts = new Map(rows.map((r) => [r.categoryId, Number(r.n)]));

    const categories = await app.prisma.discoveryCategory.findMany({
      where: {
        status: 'ACTIVE',
        ...(query.vertical !== 'ALL' ? { vertical: query.vertical } : {}),
      },
      orderBy: [{ sortWeight: 'asc' }, { name: 'asc' }],
    });
    const payload: RailCategory[] = categories
      .map((c) => ({
        slug: c.slug,
        name: c.name,
        emoji: c.emoji,
        iconKey: c.iconKey,
        kind: c.kind,
        vertical: c.vertical,
        availableVendors: counts.get(c.id) ?? 0,
      }))
      .filter((c) => c.availableVendors > 0); // law D: no dead taps

    cache.set(key, { at: Date.now(), payload });
    if (cache.size > 200) {
      const oldest = cache.keys().next().value;
      if (oldest) cache.delete(oldest);
    }
    return { success: true, data: { enabled: true, categories: payload } };
  });
}

/** Test seam. */
export function resetDiscoveryCacheForTests(): void {
  cache.clear();
}
