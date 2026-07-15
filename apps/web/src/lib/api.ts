// Server-side fetchers against the existing Fastify API — the web app is
// another client on the same backend, never a second source of truth.
const API_URL = process.env['API_URL'] ?? process.env['NEXT_PUBLIC_API_URL'] ?? 'http://localhost:3000';

export interface CountryPricing {
  countryCode: string;
  currencyCode: string;
  currencySymbol: string;
  isActive: boolean;
  trialDays: number;
  weekly: { mover: number; smallVendor: number; largeVendor: number };
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
  averageRating: number;
  totalRatings: number;
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

export async function fetchStorefronts(params: { type?: string; city?: string; q?: string } = {}): Promise<StorefrontSummary[]> {
  const q = new URLSearchParams();
  if (params.type) q.set('type', params.type);
  if (params.city) q.set('city', params.city);
  if (params.q) q.set('q', params.q);
  const qs = q.toString();
  try {
    const res = await fetch(`${API_URL}/api/v1/public/storefronts${qs ? `?${qs}` : ''}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return [];
    return (await res.json())?.data ?? [];
  } catch {
    return [];
  }
}

export async function fetchStorefront(slug: string): Promise<StorefrontDetail | null> {
  try {
    const res = await fetch(`${API_URL}/api/v1/public/storefronts/${encodeURIComponent(slug)}`, {
      next: { revalidate: 300 },
    });
    if (!res.ok) return null;
    return (await res.json())?.data ?? null;
  } catch {
    return null;
  }
}
