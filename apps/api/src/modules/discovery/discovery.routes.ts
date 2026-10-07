import type { FastifyInstance } from 'fastify';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { bindBrowseTenant, requireRequestTenant } from '../search/search-scope';
import { customerPoint } from './customer-point';

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

  /** GET /categories?vertical=FOOD|GROCERY|RETAIL|ALL&lat&lng
   *
   *  [Q12-B] The rail is ONE tenant's taxonomy — its categories, its vendors'
   *  memberships — so the request binds a tenant before it reads: a signed-in
   *  customer's own, or for a guest the public catalogue's (the search
   *  binding). With nothing bound, TENANT_UNSCOPED_ACCESS=deny refused the
   *  category read with a 500 the moment the flag was ON, and the Home rail
   *  went dark in production. */
  app.get('/categories', { preHandler: [bindBrowseTenant(app)] }, async (request) => {
    const query = customerPoint(z.object({
      vertical: z.enum(['FOOD', 'GROCERY', 'RETAIL', 'ALL']).default('ALL'),
      lat: z.coerce.number().min(-90).max(90).optional(),
      lng: z.coerce.number().min(-180).max(180).optional(),
    }).parse(request.query ?? {}));

    if (!(await flagEnabled())) return { success: true, data: { enabled: false, categories: [] } };
    const tenantId = request.publicTenantId ?? requireRequestTenant(request);

    // Cache per (tenant, vertical, ~1km geo cell) — 2dp ≈ 1.1 km at the
    // equator. The tenant is part of the key: one operator's rail is never
    // served to another's customers.
    const cell = query.lat != null && query.lng != null
      ? `${query.lat.toFixed(2)}:${query.lng.toFixed(2)}`
      : 'anywhere';
    // [DL-7 · SX397 F3] The caller's MODE is part of the rail: a guest reads
    // only an ACTIVE PRODUCTION operator; a bound customer reads its own active
    // operator, REVIEW/CRAWLER included. The current eligibility is checked on
    // every request — a warm cache never answers for a tenant that has since
    // been switched off or reclassified — and public and bound payloads never
    // share a cache entry.
    const publicMode = Boolean(request.publicTenantId);
    const eligible = await app.prisma.tenant.findFirst({
      where: { id: tenantId, isActive: true, ...(publicMode ? { kind: 'PRODUCTION' as const } : {}) },
      select: { id: true },
    });
    if (!eligible) return { success: true, data: { enabled: true, categories: [] } };
    const key = `${publicMode ? 'public' : 'bound'}:${tenantId}:${query.vertical}:${cell}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CAT_AVAIL_CACHE_S * 1000) {
      return { success: true, data: { enabled: true, categories: hit.payload } };
    }

    // Membership (chosen + derived) joined to the ONE availability truth:
    // ACTIVE + verified + open now (+ within the vendor's own delivery radius
    // when the caller sent a location). Raw SQL is not reached by the tenant
    // extension, so the bound tenant is named here, on both tables.
    const geoJoin = query.lat != null && query.lng != null
      ? Prisma.sql`AND (6371 * acos(least(1, cos(radians(${query.lat})) * cos(radians(v.latitude)) * cos(radians(v.longitude) - radians(${query.lng})) + sin(radians(${query.lat})) * sin(radians(v.latitude))))) <= v."deliveryRadius"`
      : Prisma.sql``;
    const rows = await app.prisma.$queryRaw<Array<{ categoryId: string; n: bigint }>>(
      Prisma.sql`SELECT vc."categoryId", COUNT(DISTINCT vc."vendorId") AS n
       FROM "vendor_discovery_categories" vc
       JOIN "vendors" v ON v.id = vc."vendorId"
         AND v."tenantId" = ${tenantId}
         AND v.status = 'ACTIVE' AND v."isVerified" = true AND v."isCurrentlyOpen" = true
         ${geoJoin}
       JOIN "tenants" t ON t.id = v."tenantId" AND t."isActive" = true
         ${publicMode ? Prisma.sql`AND t.kind = 'PRODUCTION'` : Prisma.empty}
       WHERE vc."tenantId" = ${tenantId}
       GROUP BY vc."categoryId"`,
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
