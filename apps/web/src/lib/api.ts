// Server-side fetchers against the existing Fastify API — the web app is
// another client on the same backend, never a second source of truth.
import { BROWSER_API_ORIGIN } from '@/lib/browser-api-origin';

// The server-side fetch origin may be overridden (an internal address on the
// same network); the browser side is the one authority, never a fallback.
const API_URL = process.env['API_URL'] ?? BROWSER_API_ORIGIN;

/** One vehicle a mover can register, priced at the rate of the role it
 *  provisions — a taxi Driver, or a delivery/courier Rider on a standard or
 *  heavy vehicle. */
export interface MoverPriceQuote {
  vehicleType: string;
  label: string;
  role: 'RIDER' | 'DRIVER';
  band: 'STANDARD' | 'HEAVY';
  tier: 'courier' | 'courierHeavy' | 'taxi';
  rate: number;
}

/** One catalogue step: from `minItems` active items, `rate` per week. */
export interface CataloguePriceBand {
  minItems: number;
  tier: 'small' | 'large' | 'department';
  rate: number;
}

export interface CountryPricing {
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  isActive: boolean;
  trialDays: number;
  /** Every vehicle, resolved by the same function signup and the weekly
   *  re-tier bill through. Absent from an API that predates the typed list. */
  movers?: MoverPriceQuote[];
  /** Services are flat; catalogue businesses step up by active items. */
  vendors?: { service: number; catalogue: CataloguePriceBand[] };
  /** From `minLocations` stores, every location takes `discountPct` off its
   *  own weekly rate. Null in a market with no franchise pricing. */
  franchise: { minLocations: number; discountPct: number } | null;
  /** @deprecated Conflated numbers kept for older clients — never render them:
   *  one figure here can stand for several kinds of partner at once. */
  weekly?: Record<string, number | null>;
}

/** Public weekly price list — the same numbers the app's signup shows. */
export async function fetchPricing(country?: string): Promise<CountryPricing | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/auth/pricing${country ? `?country=${country}` : ''}`, {
      // Marketing page: revalidate hourly — prices change by config, not by the minute.
      next: { revalidate: 3600 },
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.data ?? null;
  } catch {
    return null;
  }
}

export const LEGAL_URL = (doc: 'terms' | 'privacy') => `${API_URL}/legal/${doc}`;

// ── Public storefronts (SEO surface — ACTIVE + verified stores only) ────────
export interface StorefrontSummary {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  vendorType: 'RESTAURANT' | 'SUPERMARKET' | 'STORE' | 'SERVICE';
  logoUrl: string | null;
  coverImageUrl: string | null;
  city: string;
  region: string;
  cuisineTypes: string[];
  tags: string[];
  // [M-D6] The public star line, from the API's shared rating mapper. null =
  // below the display floor, which the UI must render as "New" rather than as
  // a number — the raw lifetime mean it replaced defaulted to 5.0 for an actor
  // nobody had rated.
  displayRating: number | null;
  ratingBucket: string;
  ratingCount: number;
  topRated: boolean;
  isCurrentlyOpen: boolean;
  acceptingOrders: boolean;
  estimatedPrepTime: number;
  minOrderAmount: number;
  isFeatured: boolean;
}

export interface StorefrontDetail extends StorefrontSummary {
  addressLine1: string;
  operatingHours: Array<{ dayOfWeek: number; openTime: string; closeTime: string; isClosed: boolean }>;
  categories: Array<{
    id: string;
    name: string;
    items: Array<{
      id: string;
      name: string;
      description: string | null;
      basePrice: number;
      imageUrl: string | null;
      unit: string | null;
      isPopular: boolean;
      fulfillment: string;
    }>;
  }>;
}

export async function fetchStorefronts(params: { type?: string; city?: string; q?: string } = {}): Promise<StorefrontSummary[] | null> {
  const q = new URLSearchParams();
  if (params.type) q.set('type', params.type);
  if (params.city) q.set('city', params.city);
  if (params.q) q.set('q', params.q);
  const qs = q.toString();
  try {
    const res = await fetch(`${API_URL}/api/v1/public/storefronts${qs ? `?${qs}` : ''}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json())?.data ?? [];
  } catch {
    return null;
  }
}

export async function fetchStorefront(slug: string): Promise<StorefrontDetail | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/public/storefronts/${encodeURIComponent(slug)}`, {
      // A scanned counter code is a commerce surface: open state and menu
      // availability must be read now, not from a five-minute SEO cache.
      cache: 'no-store',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Public storefront request failed (${res.status})`);
    return (await res.json())?.data ?? null;
  } catch (error) {
    // Network/configuration failures are not "store not found". Let Next's
    // error boundary describe an unavailable service instead of lying with 404.
    throw error instanceof Error ? error : new Error('Public storefront is unavailable.');
  }
}
