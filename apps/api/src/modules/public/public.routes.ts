import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { NotFoundError } from '../../utils/errors';

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

export async function publicRoutes(app: FastifyInstance) {
  /** GET /storefronts — the public directory. */
  app.get('/storefronts', async (request) => {
    const query = listQuerySchema.parse(request.query);
    // Empty stores stay out of the public directory (a direct /storefronts/:slug link still resolves).
    const where: Record<string, unknown> = { ...PUBLIC_WHERE, items: { some: { isAvailable: true } } };
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
      where: { slug: request.params.slug, ...PUBLIC_WHERE },
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
