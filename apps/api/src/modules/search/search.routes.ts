import { readFeePause } from '../billing/mmg-pause';
import { launchMarketAt } from '../auth/launch-market';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { SearchService } from './search.service';
import { AppError, ForbiddenError } from '../../utils/errors';
import { EARTH_RADIUS_KM, sortByDistance } from '../../utils/distance';
import { bindBrowseTenant, requireRequestTenant } from './search-scope';
import { runAsSystem } from '../../plugins/tenant-context';
import { customerPoint } from '../discovery/customer-point';
import { catalogueVendorInTenant } from '../vendor/vendor-visibility';
import { hiddenOnlyItemIds, listableItemsForVendors } from '../verification/category-gate';
import { hiddenItemIds, withoutHidden } from '../compliance/prohibited-gate';
import { ratingSurfaces } from '../rating/rating-surface';
import { ITEM_HIT_SELECT, itemHitFromSearchDoc, toItemHit, type ItemHit } from './item-hit';
import { fillFromTiers, nameMatcher, searchTiers, type Tier } from './forgiving-text';
import { SEARCH_DB_BUDGET_MS, boundedRead, isOutOfTime } from './search-budget';

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

/**
 * [S2-2] How many visible vendors inside the bounding box /search/nearby reads
 * before the exact radius filter. The box is a square and the radius a circle
 * inscribed in it, so a window of `limit` ordered by rating could still be
 * taken by a better-rated vendor in a box corner, outside the circle, and the
 * circle came back empty. The window is the whole box, bounded; a breach is
 * LOGGED, never silently truncated (the CATEGORY_ITEM_CAP stance).
 */
export const NEARBY_CANDIDATE_CAP = 200;

const nearbyQuerySchema = z.object({
  lat: z.coerce.number().min(-90).max(90),
  lng: z.coerce.number().min(-180).max(180),
  radius: z.coerce.number().positive().max(50).default(5),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  type: z.enum(['RESTAURANT', 'SUPERMARKET']).optional(),
});

/** Judge the committed pin, never a stale index coordinate. THE one market
 *  gate for every search rail: /search, suggestions, trending and nearby. */
function inLaunchMarket(pin: { latitude?: number | null; longitude?: number | null } | null): boolean {
  return pin != null && typeof pin.latitude === 'number' && typeof pin.longitude === 'number'
    && launchMarketAt(pin.latitude, pin.longitude) !== null;
}

/** The ItemHit select plus the committed pin of the item's store, for the gate. */
const ITEM_HIT_PIN_SELECT = {
  ...ITEM_HIT_SELECT,
  vendor: { select: { ...ITEM_HIT_SELECT.vendor.select, latitude: true, longitude: true } },
} as const;

/**
 * How many index hits /search asks for per hit it will return. The live gates
 * (still visible, inside the launch market) run AFTER the index answers, so
 * asking for exactly `limit` left the page short — or empty — whenever
 * out-of-market or no-longer-visible hits filled the window ahead of a live
 * one. (Closed stores are kept and listed after the open ones, owner 13 Oct.)
 */
export const ENGINE_OVERFETCH = 3;
/** The most index hits one /search reads, whatever the limit. */
export const ENGINE_MAX_HITS = 150;
/** How long after a failed index start-up the next search may try again. */
export const SEARCH_WARM_RETRY_MS = 60_000;
/** The audited system capability the index warm-up runs under. */
export const SEARCH_WARM_CAPABILITY = 'search-index-warm';

/** The catalogue columns each database search reads (forgiving-text.ts).
 *  A slip is forgiven in names only; descriptions match as typed. */
const VENDOR_COLUMNS = { text: ['name', 'description'], typoText: ['name'], lists: ['cuisineTypes', 'tags'] } as const;
const ITEM_COLUMNS = { text: ['name', 'description'], typoText: ['name'] } as const;
const NAME_COLUMNS = { text: ['name'], typoText: ['name'] } as const;

/**
 * [Review S2-1] The database top-up of a short INDEX answer runs the
 * exact-spelling tiers only. Its purpose is what the index cannot do — a part
 * inside a word ("doori" -> "Tandoori") and a listing the index has not caught
 * up with — while slips are the index's own job (typo tolerance). The slip
 * tiers are the expensive ones, and a top-up runs on most specific searches.
 */
export const TOP_UP_TIERS = { slips: false } as const;

/** The tiers a database search runs: all of them, or (slips false) the exact-spelling ones. */
function tiersFor(q: string, columns: Parameters<typeof searchTiers>[1], slips = true) {
  const tiers = searchTiers(q, columns);
  return slips ? tiers : tiers.filter((t) => !t.tier.typos);
}

/** Name matches first inside one fetched window; the window's own order
 *  (rating, popularity) breaks ties. Array.sort is stable. */
function nameFirst(q: string) {
  return <T extends { name: string }>(rows: T[], tier: Tier): T[] => {
    const inName = nameMatcher(q, tier.typos);
    return [...rows].sort((a, b) => Number(inName(b.name)) - Number(inName(a.name)));
  };
}

/**
 * [Owner ruling 13 Oct] Search SHOWS closed stores — and the dishes of closed
 * stores — marked closed: a customer who searches a store by name after hours
 * finds it, can open it to see the menu and hours, and cannot order until it
 * opens (checkout refuses VENDOR_CLOSED, unchanged). They are listed AFTER
 * every open match, so a closed store never pushes an open one down the page;
 * each group keeps the search's own order.
 */
export function openFirst<T>(rows: readonly T[], isOpen: (row: T) => boolean): T[] {
  return [...rows.filter(isOpen), ...rows.filter((r) => !isOpen(r))];
}
const storeOpen = (v: { isCurrentlyOpen: boolean }) => v.isCurrentlyOpen;
const itemStoreOpen = (i: { vendorIsCurrentlyOpen: boolean }) => i.vendorIsCurrentlyOpen;

export async function searchRoutes(app: FastifyInstance) {
  let searchService: SearchService | null = null;
  let warming = false;
  let lastWarmAttempt = 0;

  // Warm Meilisearch in the BACKGROUND — server startup must never block on it. avvio's
  // ~10s plugin timeout plus a full re-sync can otherwise take the whole API down on
  // restart. Until the index is ready, the routes below fall back to DB search.
  // An index that was unreachable at start-up is tried again (at most once per
  // SEARCH_WARM_RETRY_MS, from a search request, never blocking it): before,
  // one failed start left every search on the database until the next restart.
  //
  // The warm-up is platform-wide work — it reads every operator's catalogue
  // and reconciles the shared index — so it runs as NAMED system work, never
  // in whatever context happens to be current: at boot that was an unbound
  // composition root, which TENANT_UNSCOPED_ACCESS=deny refuses (the index
  // would never fill and every search would stay on the database), and a retry
  // started from a search request must not inherit that caller's tenant (a
  // one-tenant sync, then served as if it were the whole index). The job
  // workers' syncs already run this way (jobs/queue.ts, runAsSystem).
  const warm = (): void => {
    if (searchService || warming) return;
    if (lastWarmAttempt !== 0 && Date.now() - lastWarmAttempt < SEARCH_WARM_RETRY_MS) return;
    warming = true;
    lastWarmAttempt = Date.now();
    void runAsSystem(SEARCH_WARM_CAPABILITY, async () => {
      try {
        const svc = new SearchService(app.prisma);
        await svc.initialize();
        await svc.syncAllVendors();
        await svc.syncAllItems();
        searchService = svc;
        app.log.info('Meilisearch initialized and synced');
      } catch (err) {
        app.log.warn({ err }, 'Meilisearch unavailable — falling back to DB search');
      } finally {
        warming = false;
      }
    });
  };
  warm();

  // Credential-bearing requests keep the strict session path (cookie sessions
  // and invalid/expired credential refusals included); guests bind the public
  // catalogue's tenant — the one browse binding, shared with the Home rail.
  const browseSearch = bindBrowseTenant(app);

  // [Review S2-1 · time bound] Every forgiving database read is bounded in
  // time (search-budget.ts): the database stops a read at the fill's deadline
  // and the door answers with what the stricter tiers found. Logged without
  // the query text.
  const timed = (door: string) => ({
    budgetMs: SEARCH_DB_BUDGET_MS,
    outOfTime: isOutOfTime,
    onOutOfTime: () => app.log.warn({ door }, 'search read ran out of time; answered with what the stricter tiers found'),
  });

  /** The database search of stores: the tiers of forgiving-text.ts, strictest
   *  first, every live gate applied before a row counts toward the page. */
  async function dbVendors(ctx: {
    q: string; tenantId: string; publicMode: boolean;
    type?: 'RESTAURANT' | 'SUPERMARKET'; cuisine?: string; limit: number; exclude?: Iterable<string>;
    near?: { lat: number; lng: number };
    /** false: the exact-spelling tiers only (see TOP_UP_TIERS). */
    slips?: boolean;
  }): Promise<VendorHit[]> {
    const base = {
      // [B2] The ONE visibility predicate — this fallback previously
      // dropped tenant.isActive, so a shut-off operator's store surfaced
      // whenever Meilisearch was down.
      ...catalogueVendorInTenant(ctx.tenantId, ctx.publicMode, await readFeePause(app.prisma)),
      // Empty stores stay out; CLOSED ones are found, marked closed (owner, 13 Oct).
      ...(ctx.publicMode && { items: { some: { isAvailable: true } } }),
      ...(ctx.type && { vendorType: ctx.type }),
      ...(ctx.cuisine && { cuisineTypes: { has: ctx.cuisine } }),
    };
    const byName = nameFirst(ctx.q);
    const rows = await fillFromTiers({
      tiers: tiersFor(ctx.q, VENDOR_COLUMNS, ctx.slips),
      ...timed('search.vendors'),
      fetch: (where, take, deadline) => boundedRead(app.prisma, deadline, (db) => db.vendor.findMany({
        where: { AND: [base, where] },
        select: {
          id: true, name: true, slug: true, vendorType: true, logoUrl: true, coverImageUrl: true,
          cuisineTypes: true, isCurrentlyOpen: true, estimatedPrepTime: true, latitude: true, longitude: true, city: true,
        },
        take,
        // open stores enter the window first, so a closed one never takes an open one's place on the page
        orderBy: [{ isCurrentlyOpen: 'desc' }, { averageRating: 'desc' }, { id: 'asc' }],
      })),
      // [DS982] A store whose committed pin lies outside the launch market is never found.
      keep: (found) => found.filter(inLaunchMarket),
      // With the customer's point, the nearest first inside each tier's window
      // (a hit with no committed coordinates sorts after the ones that can
      // claim a distance, never with an invented position); without it, the
      // stores whose NAME matches first.
      rank: (found, tier) => {
        if (!ctx.near) return openFirst(byName(found, tier), storeOpen);
        const locatable = found.filter((v): v is typeof v & { latitude: number; longitude: number } => v.latitude != null && v.longitude != null);
        const unlocatable = found.filter((v) => v.latitude == null || v.longitude == null);
        const order = sortByDistance(locatable, ctx.near.lat, ctx.near.lng).map((v) => v.id);
        const byId = new Map(locatable.map((v) => [v.id, v]));
        return openFirst([...order.map((id) => byId.get(id)!), ...unlocatable], storeOpen);
      },
      limit: ctx.limit,
      exclude: ctx.exclude,
    });
    // R8: the star surface rides the ONE mapper on this path too, so both
    // engines speak the same displayRating/topRated contract.
    const surfaces = await ratingSurfaces(app.prisma, 'VENDOR', rows.map((v) => v.id));
    return openFirst(rows, storeOpen).map((v) => ({
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
  }

  /** The database search of dishes and products, same tiers and gates. */
  async function dbItems(ctx: {
    q: string; tenantId: string; publicMode: boolean; hiddenOnly: string[];
    limit: number; exclude?: Iterable<string>;
    /** false: the exact-spelling tiers only (see TOP_UP_TIERS). */
    slips?: boolean;
  }): Promise<ItemHit[]> {
    // [S2-1] Every surface excludes hidden-only items IN the query, before
    // the window is capped; the listing gate below stays a defensive pass.
    // [GUARDRAILS §8] Prohibited items (banned, or held for a check): every
    // caller, on every path that reads here — the DB search, the top-up of a
    // short index answer — so a held row never takes a place on the page.
    const excluded = [...ctx.hiddenOnly, ...(await hiddenItemIds(app.prisma, ctx.tenantId))];
    const base = {
      isAvailable: true,
      // [B2] Same predicate through the relation — `status: 'ACTIVE'` alone
      // let an unverified or shut-off operator's dishes answer searches. The
      // relation filter is not reached by the tenant-scoping extension: the
      // tenant is named here.
      // A closed store's dishes are found too, marked by its closed state (owner, 13 Oct).
      vendor: catalogueVendorInTenant(ctx.tenantId, ctx.publicMode, await readFeePause(app.prisma)),
      ...(excluded.length > 0 ? { id: { notIn: excluded } } : {}),
    };
    const byName = nameFirst(ctx.q);
    const rows = await fillFromTiers({
      tiers: tiersFor(ctx.q, ITEM_COLUMNS, ctx.slips),
      ...timed('search.items'),
      fetch: (where, take, deadline) => boundedRead(app.prisma, deadline, (db) => db.item.findMany({
        where: { AND: [base, where] },
        // The shared select, so this path cannot quietly serve fewer fields
        // than the index path and make the engine visible to the client.
        select: ITEM_HIT_PIN_SELECT,
        take,
        orderBy: [{ vendor: { isCurrentlyOpen: 'desc' } }, { totalOrdered: 'desc' }, { id: 'asc' }],
      })),
      keep: async (found) => {
        const marketItems = found.filter((item) => inLaunchMarket(item.vendor));
        // [§8 · review S2-PRE] the shared listing gate, for EVERY caller (it was guests only)
        // [GUARDRAILS §8] The exact last pass, before a row counts toward the
        // page: a prohibited row is never returned, whatever the cached list said.
        return withoutHidden(app.prisma, await listableItemsForVendors(app.prisma, ctx.tenantId, marketItems));
      },
      rank: (found, tier) => openFirst(byName(found, tier), (i) => i.vendor.isCurrentlyOpen),
      limit: ctx.limit,
      exclude: ctx.exclude,
    });
    return openFirst(rows.map(toItemHit), itemStoreOpen);
  }

  // Universal search — searches vendors AND items
  app.get('/search', { preHandler: [browseSearch] }, async (request) => {
    const { q, type, cuisine, lat, lng, limit: parsedLimit } = customerPoint(searchQuerySchema.parse(request.query));
    // [R048-003] ONE tenant per request — the caller's, as auth bound it. Carried into the
    // index filter (server-built) and into every DB query below.
    const tenantId = request.publicTenantId ?? requireRequestTenant(request);
    const publicMode = Boolean(request.publicTenantId);

    if (!q || q.length < 2) {
      return { success: true, data: { vendors: [], items: [] } };
    }

    // [S2-1] Hidden-only items never occupy the window: excluded in the query,
    // for every caller (§8 · review S2-PRE: this was guests only).
    const hiddenOnly = await hiddenOnlyItemIds(app.prisma, tenantId);

    // Public discovery reads live browse eligibility. An index hit alone is
    // not authority to publish a listing whose visibility may have changed.
    // Authenticated search retains index ranking, with live visibility checked below.
    if (!searchService) warm();
    if (searchService && !publicMode) {
      try {
        const want = Math.min(parsedLimit * ENGINE_OVERFETCH, ENGINE_MAX_HITS);
        const [vendorResults, itemResults] = await Promise.all([
          // No `openOnly` here: closed stores are shown (owner, 13 Oct), and the
          // index's open flag is only the copy from its last sync — the live
          // gate below reads open-now from the database.
          searchService.searchVendors(tenantId, q, { type, cuisine, limit: want }),
          searchService.searchItems(tenantId, q, { limit: want }),
        ]);

        const vendorHits: VendorHit[] = (vendorResults.hits as Record<string, unknown>[]).map((h) => ({
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
        const itemHits: ItemHit[] = (itemResults.hits as Record<string, unknown>[]).map(
          itemHitFromSearchDoc,
        );

        // Index ranking is not authority to publish a vendor after its
        // subscription stops operating. Every hit passes the live gate — read
        // for ALL the hits fetched, never a `take` of them before the gate.
        // [GUARDRAILS §8] Nor to publish a prohibited item (banned, or held for a check).
        const prohibited = await hiddenItemIds(app.prisma, tenantId);
        const [liveVendors, liveItems] = await Promise.all([
          app.prisma.vendor.findMany({
            where: { ...catalogueVendorInTenant(tenantId, false, await readFeePause(app.prisma)), id: { in: vendorHits.map((v) => v.id) } },
            select: { id: true, latitude: true, longitude: true, isCurrentlyOpen: true },
          }),
          app.prisma.item.findMany({
            where: { id: { in: itemHits.map((i) => i.id), ...(prohibited.length > 0 ? { notIn: prohibited } : {}) }, isAvailable: true, vendor: catalogueVendorInTenant(tenantId, false, await readFeePause(app.prisma)) },
            select: { id: true, vendorId: true, vendor: { select: { latitude: true, longitude: true, isCurrentlyOpen: true } } },
          }),
        ]);
        // [§8 · review S2-PRE] the index holds what the listing gate refuses (hidden-only
        // tags, a lapsed licence): the same shared gate the Market feed and guests get
        const listedLive = await listableItemsForVendors(app.prisma, tenantId, liveItems.filter((i) => inLaunchMarket(i.vendor)));
        // open-now as the DATABASE says, for stores and for each dish's store —
        // the hit's copy may predate an opening or a closing
        const vendorOpen = new Map(liveVendors.filter(inLaunchMarket).map((v) => [v.id, v.isCurrentlyOpen]));
        const itemStoreOpenNow = new Map(listedLive.map((i) => [i.id, i.vendor.isCurrentlyOpen]));
        const visibleVendors = openFirst(
          vendorHits.filter((v) => vendorOpen.has(v.id)).map((v) => ({ ...v, isCurrentlyOpen: vendorOpen.get(v.id)! })),
          storeOpen,
        ).slice(0, parsedLimit);
        // [GUARDRAILS §8] The exact last pass on index hits too, before the page is cut.
        const visibleItems = openFirst(
          (await withoutHidden(app.prisma, itemHits.filter((i) => itemStoreOpenNow.has(i.id)))).map((i) => ({ ...i, vendorIsCurrentlyOpen: itemStoreOpenNow.get(i.id)! })),
          itemStoreOpen,
        ).slice(0, parsedLimit);

        // A short index answer is topped up from the database, below the
        // index's own ranking: the index matches whole words and word starts,
        // the database also finds a part inside a word ("doori" -> "Tandoori"),
        // and a listing the index has not caught up with yet.
        const [moreVendors, moreItems] = await Promise.all([
          visibleVendors.length < parsedLimit
            ? dbVendors({ q, tenantId, publicMode: false, type, cuisine, limit: parsedLimit - visibleVendors.length, exclude: vendorHits.map((v) => v.id), slips: TOP_UP_TIERS.slips })
            : Promise.resolve([]),
          visibleItems.length < parsedLimit
            ? dbItems({ q, tenantId, publicMode: false, hiddenOnly, limit: parsedLimit - visibleItems.length, exclude: itemHits.map((i) => i.id), slips: TOP_UP_TIERS.slips })
            : Promise.resolve([]),
        ]);
        const vendors = openFirst([...visibleVendors, ...moreVendors], storeOpen);
        const items = openFirst([...visibleItems, ...moreItems], itemStoreOpen);
        return {
          success: true,
          data: {
            vendors,
            items,
            meta: {
              vendorCount: vendors.length,
              itemCount: items.length,
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

    // DB path (every guest; a signed-in caller while the index is absent or failing)
    const [vendors, items] = await Promise.all([
      dbVendors({
        q, tenantId, publicMode, type, cuisine, limit: parsedLimit,
        near: lat != null && lng != null ? { lat, lng } : undefined,
      }),
      dbItems({ q, tenantId, publicMode, hiddenOnly, limit: parsedLimit }),
    ]);

    return {
      success: true,
      data: {
        vendors,
        items,
        meta: { vendorCount: vendors.length, itemCount: items.length },
      },
    };
  });

  // Suggestions / autocomplete — the same forgiving tiers over NAMES, the same
  // gates, five of each, filled from live matches before the cut.
  app.get('/search/suggestions', { preHandler: [browseSearch] }, async (request) => {
    const { q } = suggestionsQuerySchema.parse(request.query);
    if (!q || q.length < 2) return { success: true, data: [] };
    const tenantId = request.publicTenantId ?? requireRequestTenant(request);
    const publicMode = Boolean(request.publicTenantId);
    // [S2-1] Hidden-only items never occupy the fixed five-item window: they
    // are excluded here, before the take, not after it — for every caller.
    const hiddenOnly = [
      ...(await hiddenOnlyItemIds(app.prisma, tenantId)),
      // [GUARDRAILS §8] Prohibited items: every caller.
      ...(await hiddenItemIds(app.prisma, tenantId)),
    ];
    const tiers = searchTiers(q, NAME_COLUMNS);
    // Closed stores and their dishes are suggested too, marked closed (owner, 13 Oct).
    const vendorBase = { ...catalogueVendorInTenant(tenantId, publicMode, await readFeePause(app.prisma)), ...(publicMode && { items: { some: { isAvailable: true } } }) };
    const itemBase = {
      isAvailable: true,
      // [B2] This query had NO vendor predicate at all — a banned store's
      // dish names kept autocompleting for every customer who typed.
      vendor: catalogueVendorInTenant(tenantId, publicMode, await readFeePause(app.prisma)),
      ...(hiddenOnly.length > 0 ? { id: { notIn: hiddenOnly } } : {}),
    };

    const [vendors, items] = await Promise.all([
      fillFromTiers({
        tiers,
        ...timed('suggestions.vendors'),
        fetch: (where, take, deadline) => boundedRead(app.prisma, deadline, (db) => db.vendor.findMany({
          where: { AND: [vendorBase, where] },
          select: { id: true, name: true, vendorType: true, latitude: true, longitude: true, isCurrentlyOpen: true },
          orderBy: [{ isCurrentlyOpen: 'desc' }, { averageRating: 'desc' }, { id: 'asc' }],
          take,
        })),
        // [DS982] A store outside the launch market never autocompletes, nor do its dishes.
        keep: (found) => found.filter(inLaunchMarket),
        limit: 5,
      }),
      fillFromTiers({
        tiers,
        ...timed('suggestions.items'),
        fetch: (where, take, deadline) => boundedRead(app.prisma, deadline, (db) => db.item.findMany({
          where: { AND: [itemBase, where] },
          select: { id: true, vendorId: true, name: true, vendor: { select: { latitude: true, longitude: true, isCurrentlyOpen: true } } },
          // [DS233 F8] A stable window: open stores' dishes, then the most-ordered
          // matches first, never whatever order the heap scan happens to return.
          orderBy: [{ vendor: { isCurrentlyOpen: 'desc' } }, { totalOrdered: 'desc' }, { id: 'asc' }],
          take,
        })),
        keep: async (found) => {
          const marketItems = found.filter((i) => inLaunchMarket(i.vendor));
          // [GUARDRAILS §8] The exact last pass, before a row counts toward the five:
          // a prohibited row is never returned, whatever the cached list said.
          return withoutHidden(app.prisma, await listableItemsForVendors(app.prisma, tenantId, marketItems));
        },
        limit: 5,
      }),
    ]);

    // `isCurrentlyOpen` (additive): the suggested store's — or the dish's store's — open state now.
    const suggestions = [
      ...openFirst(vendors, storeOpen).map((v) => ({ text: v.name, type: 'vendor' as const, isCurrentlyOpen: v.isCurrentlyOpen })),
      ...openFirst(items, (i) => i.vendor.isCurrentlyOpen).map((i) => ({ text: i.name, type: 'item' as const, isCurrentlyOpen: i.vendor.isCurrentlyOpen })),
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
  app.get('/search/trending', { preHandler: [browseSearch] }, async (request) => {
    const tenantId = request.publicTenantId ?? requireRequestTenant(request);
    // [S2-1] Same rule, before the fixed take — a hidden-only tag must not
    // crowd a trending row out of the rail's window. Every caller (§8).
    const hiddenOnly = [
      ...(await hiddenOnlyItemIds(app.prisma, tenantId)),
      // [GUARDRAILS §8] Prohibited items: every caller.
      ...(await hiddenItemIds(app.prisma, tenantId)),
    ];
    const items = await app.prisma.item.findMany({
      where: {
        isAvailable: true,
        vendor: { ...catalogueVendorInTenant(tenantId, Boolean(request.publicTenantId), await readFeePause(app.prisma)), isCurrentlyOpen: true },
        ...(hiddenOnly.length > 0 ? { id: { notIn: hiddenOnly } } : {}),
      },
      // The shared select again. Trending is the Market tab's fallback rail, so
      // its cards land in the SAME component as the feed's; the fifth hand-built
      // copy of this shape lived here and served an item with no `isNew` and no
      // `categoryName` beside feed items that had both.
      select: { ...ITEM_HIT_PIN_SELECT, totalOrdered: true },
      orderBy: { totalOrdered: 'desc' },
      take: 20,
    });

    // [DS982] A dish from a store outside the launch market never trends.
    const marketItems = items.filter((i) => inLaunchMarket(i.vendor));
    // [§8 · review S2-PRE] the shared listing gate for every caller, as the Market feed
    // [GUARDRAILS §8] The exact last pass: a prohibited row is never returned, whatever the cached list said.
    const listable = await withoutHidden(app.prisma, await listableItemsForVendors(app.prisma, tenantId, marketItems));
    return {
      success: true,
      // ItemHit plus the one field that makes it *trending* — a superset, never
      // a different shape.
      data: listable.map((i) => request.publicTenantId ? toItemHit(i) : ({ ...toItemHit(i), totalOrdered: i.totalOrdered })),
    };
  });

  // Nearby vendors (location-based)
  app.get('/search/nearby', { preHandler: [browseSearch] }, async (request) => {
    // [DS982] The caller's point passes the ONE discovery door: a point in no
    // launch market reads as no location, and nothing is near no location.
    const { lat, lng, radius: radiusKm, type, limit } = customerPoint(nearbyQuerySchema.parse(request.query));
    const tenantId = request.publicTenantId ?? requireRequestTenant(request);
    if (lat === undefined || lng === undefined) return { success: true, data: [] };
    const userLat = lat;
    const userLng = lng;

    // [S2-2] The rating-first cap used to run BEFORE any radius predicate: a
    // five-star vendor outside the radius crowded a four-star vendor at the
    // caller's coordinates out of the take window, and the post-filter then
    // returned nothing. The bounding box moves the spatial eligibility INTO
    // the query; the box is a conservative superset of the radius circle, so
    // it can never drop an in-radius vendor. It is still a square: the window
    // reads the whole box (NEARBY_CANDIDATE_CAP), and the exact haversine
    // filter, distance ordering and `limit` apply after it.
    // [DS233 F1/F2] The box is the exact bounding box of the spherical cap
    // the haversine filter below draws (same Earth radius), so it is a true
    // superset: the latitude half-width is the cap's angle; the longitude
    // half-width is asin(sin(angle) / cos(lat)). Where the cap reaches a pole
    // every meridian is inside it, and where the box would cross the
    // antimeridian a single range cannot hold it — longitude is left unbounded
    // in both cases, and the exact filter (behind the cap) still applies.
    const angle = radiusKm / EARTH_RADIUS_KM;
    const latDelta = (angle * 180) / Math.PI;
    const capReachesPole = userLat + latDelta >= 90 || userLat - latDelta <= -90;
    const lngHalf = capReachesPole
      ? null
      : (Math.asin(Math.sin(angle) / Math.cos((userLat * Math.PI) / 180)) * 180) / Math.PI;
    const lngDelta = lngHalf !== null && userLng - lngHalf >= -180 && userLng + lngHalf <= 180 ? lngHalf : null;

    const vendors = await app.prisma.vendor.findMany({
      where: {
        ...catalogueVendorInTenant(tenantId, Boolean(request.publicTenantId), await readFeePause(app.prisma)),
        isCurrentlyOpen: true,
        // Empty stores (no orderable item) stay out of nearby discovery.
        items: { some: { isAvailable: true } },
        latitude: { gte: userLat - latDelta, lte: userLat + latDelta },
        ...(lngDelta !== null ? { longitude: { gte: userLng - lngDelta, lte: userLng + lngDelta } } : {}),
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
      // Distance work is bounded even for anonymous callers: the box, then
      // the cap. The response is bounded by `limit` below.
      take: NEARBY_CANDIDATE_CAP,
      orderBy: [{ averageRating: 'desc' }, { id: 'asc' }],
    });
    if (vendors.length === NEARBY_CANDIDATE_CAP) {
      request.log.warn(
        { tenantId, radiusKm, cap: NEARBY_CANDIDATE_CAP },
        'search: nearby candidate cap reached inside the box — the rating-first window decides who is seen',
      );
    }

    // [DS982] A store whose committed pin lies outside the launch market is never nearby.
    const nearby = sortByDistance(vendors.filter(inLaunchMarket), userLat, userLng)
      .filter((v) => v.distance <= radiusKm)
      .slice(0, limit)
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
