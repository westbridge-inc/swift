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
