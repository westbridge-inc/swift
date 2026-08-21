import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError, AppError } from '../../utils/errors';

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
  averageRating: true,
  totalRatings: true,
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
const TENANT_RESOLVE_TTL_MS = 60_000;
let tenantCache: { id: string | null; at: number; count: number } | null = null;

async function resolvePublicTenantId(app: FastifyInstance): Promise<string> {
  const explicit = process.env['PUBLIC_TENANT_ID'];
  if (explicit) return explicit;

  const now = Date.now();
  if (!tenantCache || now - tenantCache.at > TENANT_RESOLVE_TTL_MS) {
    const active = await app.prisma.tenant.findMany({
      where: { isActive: true },
      select: { id: true },
      take: 2, // two is all it takes to know the rule is needed
    });
    tenantCache = { id: active[0]?.id ?? null, at: now, count: active.length };
  }
  if (tenantCache.count === 1 && tenantCache.id) return tenantCache.id;
  if (tenantCache.count === 0) throw new NotFoundError('Storefront');
  throw new AppError(
    503,
    'PUBLIC_TENANT_UNRESOLVED',
    'The public catalog is not configured for a multi-tenant deployment — set PUBLIC_TENANT_ID.',
  );
}

export async function publicRoutes(app: FastifyInstance) {
  /** GET /storefronts — the public directory. */
  app.get('/storefronts', async (request) => {
    const query = listQuerySchema.parse(request.query);
    // Empty stores stay out of the public directory (a direct /storefronts/:slug link still resolves).
    const where: Record<string, unknown> = {
      ...PUBLIC_WHERE,
      tenantId: await resolvePublicTenantId(app),
      items: { some: { isAvailable: true } },
    };
    if (query.type) where['vendorType'] = query.type;
    if (query.city) where['city'] = { equals: query.city, mode: 'insensitive' };
    if (query.q) where['name'] = { contains: query.q, mode: 'insensitive' };

    const vendors = await app.prisma.vendor.findMany({
      where,
      select: PUBLIC_VENDOR_SELECT,
      orderBy: [{ isFeatured: 'desc' }, { averageRating: 'desc' }, { totalRatings: 'desc' }],
      take: 200,
    });

    return {
      success: true,
      data: vendors.map((v) => ({ ...v, minOrderAmount: Number(v.minOrderAmount) })),
    };
  });

  /** GET /storefronts/:slug — one store's public page: profile + hours + menu. */
  app.get<{ Params: { slug: string } }>('/storefronts/:slug', async (request) => {
    const vendor = await app.prisma.vendor.findFirst({
      where: { slug: request.params.slug, ...PUBLIC_WHERE, tenantId: await resolvePublicTenantId(app) },
      select: {
        ...PUBLIC_VENDOR_SELECT,
        // The app already shows guests the street address (pickup needs it);
        // the detail page gets it, the crawlable directory list stays city-level.
        addressLine1: true,
        operatingHours: {
          orderBy: { dayOfWeek: 'asc' },
          select: { dayOfWeek: true, openTime: true, closeTime: true, isClosed: true },
        },
        categories: {
          orderBy: { sortOrder: 'asc' },
          select: {
            id: true,
            name: true,
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
    if (!vendor) throw new NotFoundError('Storefront');

    return {
      success: true,
      data: {
        ...vendor,
        minOrderAmount: Number(vendor.minOrderAmount),
        categories: vendor.categories
          .map((c) => ({
            ...c,
            items: c.items.map((i) => ({ ...i, basePrice: Number(i.basePrice) })),
          }))
          // An empty category is vendor housekeeping, not a public menu section.
          .filter((c) => c.items.length > 0),
      },
    };
  });
}
