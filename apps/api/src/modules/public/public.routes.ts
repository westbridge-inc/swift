import { sellerVerifiedNow } from '../vendor/seller-verified';
import { servedPhotoAddress } from '../../utils/photo-address';
import { FastifyInstance } from 'fastify';
import { resolvePublicMarketTenant } from '../search/search-scope';
import { enterTenant } from '../../plugins/tenant-context';
import { z } from '../../lib/zod';
import { NotFoundError } from '../../utils/errors';
import { ratingSurfaces } from '../rating/rating-surface';
import { serveEmergencyPolicy } from '../country/emergency-policy';
import { readAppVersionPolicy } from '../ops/app-version';
import { emergencyPolicyCounter } from '../../plugins/observability';
import { notProhibitedStore, PUBLIC_VENDOR_TENANT } from '../vendor/vendor-visibility';
import { adsEnabled } from '../ads/ads-enabled';
import { hiddenAmong, prohibitedStoreIds, storeHiddenFromCustomers } from '../compliance/prohibited-gate';
import { publicStorefrontSeller } from '../verification/storefront-seller';

/**
 * Public storefronts — the ONLY unauthenticated catalog surface.
 *
 * Purpose: SEO/shareable web pages (web-app spec §4B "SSR catalog"). A vendor
 * points customers at swift's site; Google indexes their menu. Everything here
 * is data a customer already sees in the app after a free OTP signup, MINUS
 * anything operational or personal: no phone/email, no stock counts, no SKUs,
 * no exact coordinates — city/region only. Only ACTIVE + verified businesses
 * exist here at all (a suspended or unreviewed store simply 404s).
 */

const listQuerySchema = z.object({
  type: z.enum(['RESTAURANT', 'SUPERMARKET', 'STORE', 'SERVICE']).optional(),
  city: z.string().trim().max(80).optional(),
  q: z.string().trim().max(80).optional(),
});

const PUBLIC_VENDOR_SELECT = {
  id: true,
  slug: true,
  name: true,
  description: true,
  vendorType: true,
  logoUrl: true,
  coverImageUrl: true,
  city: true,
  region: true,
  cuisineTypes: true,
  tags: true,
  // [M-D6] NOT averageRating/totalRatings. The raw lifetime mean carries a 5.0
  // sentinel for an actor nobody has rated, so this crawlable page rendered
  // "5.0" for 21 never-rated vendors and "1.0" for four with a single unhappy
  // rating — on the one surface a stranger and Google see first. The public
  // star line comes from rating-surface like every other surface; removing the
  // field here makes any consumer that still reaches for it a type error.
  //
  // totalRatings is gone for the same reason: it is the legacy counter, and on
  // this machine six vendors carry one (421 and 209 among them) while only 57
  // rating rows exist in total — seeded numbers with nothing behind them. The
  // honest count is ratingCount/ratingBucket from the same mapper as the stars.
  isCurrentlyOpen: true,
  acceptingOrders: true,
  estimatedPrepTime: true,
  minOrderAmount: true,
  isFeatured: true,
} as const;

/** Public visibility rule in one place: live commerce only. */
const PUBLIC_WHERE = { status: 'ACTIVE' as const, isVerified: true };

/**
 * [F-226 / F-026-10] These are the only tenant-owned queries in the codebase
 * that run with NO tenant context: a guest has not authenticated, so the
 * Prisma tenant-scope extension leaves them unscoped. With one live tenant
 * that is invisible; the moment a second exists, one tenant's stores would
 * surface in another's public directory and in its SEO pages — silently, and
 * indexed.
 *
 * Whether the public catalog is ONE global Swift directory or per-tenant is a
 * product decision that is still open (registered as F-226). This does not
 * decide it. It only makes the undecided state fail CLOSED: resolve which
 * tenant a public request speaks for, and scope the query to it.
 *
 *   1. PUBLIC_TENANT_ID, when the deployment states it outright.
 *   2. Otherwise the single active tenant — today's behaviour, byte-identical.
 *   3. Two or more active tenants and no rule: refuse loudly. That combination
 *      is exactly the state that must never quietly serve everything.
 *
 * Cached briefly because it is per-request on a hot public path; a new tenant
 * becomes visible within the TTL.
 */
/**
 * [F-027-13] Two corrections to the first version of this, both of which the
 * cache caused.
 *
 * 1. PUBLIC_TENANT_ID was trusted on sight. Public visibility is decided by
 *    the VENDOR's status alone, so an explicitly configured tenant that had
 *    since been DEACTIVATED kept its still-ACTIVE vendors publicly listable
 *    and orderable — deactivating an operator did not take their storefront
 *    off the internet. And an id pointing at nothing produced a silent empty
 *    directory rather than naming the broken deployment. It is now verified
 *    against the database like any other input, and both failures are loud.
 *
 * 2. THE CACHE IS GONE, not tuned. It stored a TOPOLOGY CONCLUSION for 60
 *    seconds, so: a second tenant activating kept serving the first instead
 *    of refusing; a deactivated tenant kept serving; a corrected deployment
 *    stayed broken for a minute after the fix; and concurrent misses were not
 *    coalesced, so an older one-tenant answer could overwrite a newer
 *    two-tenant one. Every one of those is the cache, not the rule.
 *
 *    What it bought was one indexed `SELECT id FROM tenants WHERE isActive
 *    LIMIT 2` per public request — next to nothing beside the vendor query
 *    these routes already run. On a tenant boundary, correctness outranks
 *    that. If profiling ever says otherwise the answer is invalidation on
 *    tenant writes, not a TTL guess.
 */
/** One rule for every guest surface: the public catalogue's tenant is
 *  resolved by search-scope.ts (PUBLIC_TENANT_ID, else the single ACTIVE
 *  PRODUCTION tenant; a fiction never). This was a second copy of it. */
const resolvePublicTenantId = resolvePublicMarketTenant;

export async function publicRoutes(app: FastifyInstance) {
  // Guests need the same server truth as authenticated clients. Never cache
  // an opt-in at the HTTP layer after an operator switches advertising off.
  app.get('/capabilities', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { success: true, data: { adsEnabled: adsEnabled() } };
  });
  /**
   * [Row 3 · force update] The oldest phone build Swift still serves, per platform
   * (ops/app-version.ts). Phones from build 12 on read it on open and on return to
   * the screen; builds 9–11 never ask, and no route refuses a request for its app
   * version. Unauthenticated (an outdated phone may hold no session) and uncached,
   * so an ops change applies at the next open.
   */
  app.get('/app-version', async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { success: true, data: await readAppVersionPolicy(app.prisma) };
  });
  /** GET /storefronts — the public directory. */
  /**
   * [MOB-018] The market emergency policy — verified local emergency numbers,
   * per service, signed by the API's keyring and cacheable. The phone dials
   * only a VERIFIED number automatically; an unverified candidate is offered
   * with a confirm; a market with no policy answers `numbers: null` and the
   * app falls back to its bundled table. A malformed stored policy is never
   * served as a policy. Unauthenticated: an emergency has no login step.
   * [AUD-G7-023] A served policy also carries `envelope`: the same numbers
   * signed with Ed25519 under a key the app pins (build 12+ trusts nothing
   * else). The v1 fields stay byte-for-byte as before for builds 9-11.
   */
  app.get('/emergency-policy', async (request, reply) => {
    const { country } = z.object({ country: z.string().trim().length(2) }).parse(request.query ?? {});
    const served = await serveEmergencyPolicy(app.prisma, country.toUpperCase());
    emergencyPolicyCounter.labels(served.status).inc();
    if (served.status === 'unknown-market') throw new NotFoundError('CountryConfig', country.toUpperCase());
    reply.header('Cache-Control', 'public, max-age=3600, stale-while-revalidate=86400');
    if (served.status === 'served') {
      if (served.envelopeProblem) request.log.error({ country: served.signed.country, problem: served.envelopeProblem }, '[AUD-G7-023] emergency policy served WITHOUT its Ed25519 envelope — build 12+ phones keep their last verified or bundled numbers');
      return { success: true, data: served.envelope ? { ...served.signed, envelope: served.envelope } : served.signed };
    }
    if (served.status === 'invalid') request.log.error({ country: served.country, problem: served.problem }, '[MOB-018] stored emergency policy is malformed — not served');
    return { success: true, data: { version: 1, country: served.country, numbers: null, reason: served.status === 'invalid' ? 'INVALID_POLICY' : 'NO_POLICY' } };
  });

  // [STA-1 4.1] Resolving the public tenant is not binding it: under `deny` an
  // unbound vendor query is refused. Bind what was resolved, as the market does.
  const bindPublicTenant = async (): Promise<string> => {
    const tenantId = await resolvePublicTenantId(app);
    enterTenant(tenantId);
    return tenantId;
  };

  app.get('/storefronts', async (request) => {
    const query = listQuerySchema.parse(request.query);
    // Empty stores stay out of the public directory (a direct /storefronts/:slug link still resolves).
    const tenantId = await bindPublicTenant();
    const where: Record<string, unknown> = {
      ...PUBLIC_WHERE,
      tenantId,
      // [GUARDRAILS §8 · #54] A store filed under a banned category is not in the directory.
      ...notProhibitedStore(await prohibitedStoreIds(app.prisma, tenantId)),
      items: { some: { isAvailable: true } },
    };
    if (query.type) where['vendorType'] = query.type;
    if (query.city) where['city'] = { equals: query.city, mode: 'insensitive' };
    if (query.q) where['name'] = { contains: query.q, mode: 'insensitive' };

    // [F-028-07] The tenant-activity check above and this fetch were two
    // queries — a deactivation between them served one more response, and the
    // web's 300s fetch cache stretched that race into a real stale window.
    // The relational predicate makes liveness part of the SAME read.
    const vendors = await app.prisma.vendor.findMany({
      where: { ...where, ...PUBLIC_VENDOR_TENANT },
      select: PUBLIC_VENDOR_SELECT,
      orderBy: [{ isFeatured: 'desc' }, { averageRating: 'desc' }, { totalRatings: 'desc' }],
      take: 200,
    });

    // One batched read for the whole page, then the SAME mapper every other
    // surface uses — so the storefront directory, the app and search cannot
    // disagree about what a vendor's stars say.
    const surfaces = await ratingSurfaces(app.prisma, 'VENDOR', vendors.map((v) => v.id));

    return {
      success: true,
      data: vendors.map((v) => ({
        ...v,
        minOrderAmount: Number(v.minOrderAmount),
        ...(surfaces.get(v.id) ?? { displayRating: null, ratingBucket: '(0)', ratingCount: 0, topRated: false }),
      })),
    };
  });

  /** GET /storefronts/:slug — one store's public page: profile + hours + menu. */
  app.get<{ Params: { slug: string } }>('/storefronts/:slug', async (request) => {
    const tenantId = await bindPublicTenant();
    // [GUARDRAILS §8 · #54] Nor has a public page, by its slug or an old one.
    const prohibitedStores = notProhibitedStore(await prohibitedStoreIds(app.prisma, tenantId));
    // [09-07] A printed QR code outlives a rename. `SlugRedirect` was built for exactly
    // that — table, tenant scope, RLS policy, unique index — and then read by nothing, so
    // the promise in `qr/qr-codes.ts` was decorative. One lookup makes it real: an old slug
    // resolves to the store it names, and the response carries the canonical slug so a
    // client can correct its URL. The write side arrives with the rename feature; until
    // then this costs one indexed miss on a 404 that was already a 404.
    const bySlug = (slug: string) => app.prisma.vendor.findFirst({
      where: { slug, ...PUBLIC_WHERE, tenantId, ...PUBLIC_VENDOR_TENANT, ...prohibitedStores },
      select: {
        ...PUBLIC_VENDOR_SELECT,
        // [P35] Read only to compute isVerified below; never sent (stripped before the spread).
        activationValidUntil: true,
        // The app already shows guests the street address (pickup needs it);
        // the detail page gets it, the crawlable directory list stays city-level.
        addressLine1: true,
        operatingHours: {
          orderBy: { dayOfWeek: 'asc' },
          select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true },
        },
        categories: {
          where: { archivedAt: null },
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
            // [IMAGES-E2E PR5] The section's own photo shows on the store page (only a kept one is handed out).
            imageUrl: true,
            items: {
              // The public menu shows what a customer could order right now.
              where: { isAvailable: true },
              orderBy: { sortOrder: 'asc' },
              select: {
                id: true,
                name: true,
                description: true,
                basePrice: true,
                imageUrl: true,
                unit: true,
                isPopular: true,
                fulfillment: true,
              },
            },
          },
        },
      },
    });
    let vendor = await bySlug(request.params.slug);
    if (!vendor) {
      const redirect = await app.prisma.slugRedirect.findUnique({
        where: { tenantId_entityType_oldSlug: { tenantId, entityType: 'VENDOR', oldSlug: request.params.slug } },
        select: { entityId: true },
      });
      if (redirect) {
        const current = await app.prisma.vendor.findFirst({
          where: { id: redirect.entityId, ...PUBLIC_WHERE, tenantId, ...PUBLIC_VENDOR_TENANT },
          select: { slug: true },
        });
        if (current) vendor = await bySlug(current.slug);
      }
    }
    if (!vendor) throw new NotFoundError('Storefront');
    // [GUARDRAILS §8 · #54 · store names] Judged exactly too: the list above may be a minute old.
    if (await storeHiddenFromCustomers(app.prisma, vendor.id)) throw new NotFoundError('Storefront');

    // [M-D6] Same mapper as the directory list, so a store's own page and its
    // card in the list can never show different stars.
    const surface = (await ratingSurfaces(app.prisma, 'VENDOR', [vendor.id])).get(vendor.id);
    // [GUARDRAILS §8] The website's menu leaves prohibited items out (banned, or held for a check).
    const hidden = await hiddenAmong(app.prisma, vendor.categories.flatMap((c) => c.items.map((i) => i.id)));

    // [R3 · CAA s.70] The same seller block the app's store screen shows: who sells, how payment
    // works, the store's refund rule and the statutory-rights sentence.
    const seller = await publicStorefrontSeller(app.prisma, vendor.id);

    // [P35 · board 4b] "Verified seller" on the website: PUBLIC_WHERE already requires isVerified, and the
    // documents' wall-clock bound must still hold (seller-verified.ts). The bound itself is not published.
    const { activationValidUntil, ...publicVendor } = vendor;
    return {
      success: true,
      data: {
        ...publicVendor,
        isVerified: sellerVerifiedNow({ isVerified: true, activationValidUntil }),
        seller,
        // Present when the request arrived on a retired slug, so the caller can correct its URL.
        ...(vendor.slug === request.params.slug ? {} : { canonicalSlug: vendor.slug }),
        ...(surface ?? { displayRating: null, ratingBucket: '(0)', ratingCount: 0, topRated: false }),
        minOrderAmount: Number(vendor.minOrderAmount),
        categories: vendor.categories
          .map((c) => ({
            ...c,
            imageUrl: servedPhotoAddress(c.imageUrl),
            items: c.items.filter((i) => !hidden.has(i.id)).map((i) => ({ ...i, basePrice: Number(i.basePrice), imageUrl: servedPhotoAddress(i.imageUrl) })),
          }))
          // An empty category is vendor housekeeping, not a public menu section.
          .filter((c) => c.items.length > 0),
      },
    };
  });
}
