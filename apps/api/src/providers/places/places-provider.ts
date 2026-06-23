import type { PrismaClient } from '@prisma/client';

// ---------------------------------------------------------------------------
// PlacesProvider — hard rule 4: swappable interface. Destination search (the
// "Where to?" flow) only ever talks to this seam, so a real Places service
// slots in behind it and the API key NEVER leaves the server. Default is the
// key-free LocalPlacesProvider so CI and no-key dev still work.
// ---------------------------------------------------------------------------

export interface PlacePoint {
  lat: number;
  lng: number;
}

export interface PlaceSuggestion {
  placeId: string;
  /** Main line, e.g. "Giftland Mall". */
  primary: string;
  /** Context line, e.g. "Turkeyen, Georgetown". */
  secondary?: string;
}

export interface PlaceDetail {
  placeId: string;
  label: string;
  lat: number;
  lng: number;
}

export interface PlacesQueryContext {
  /** Bias results toward the user (Google) / sort by proximity (Local). */
  near?: PlacePoint;
  /** Lets the Local provider fold in the caller's saved addresses. */
  userId?: string;
}

export interface PlacesProvider {
  autocomplete(query: string, ctx?: PlacesQueryContext): Promise<PlaceSuggestion[]>;
  details(placeId: string): Promise<PlaceDetail | null>;
  reverseGeocode(point: PlacePoint): Promise<string | null>;
}

const MAX_SUGGESTIONS = 6;

// --- helpers ---------------------------------------------------------------

/** Centroid of a GeoJSON Polygon's outer ring — good enough as a zone "place". */
function polygonCentroid(boundary: unknown): PlacePoint | null {
  try {
    const ring = (boundary as { coordinates?: number[][][] })?.coordinates?.[0];
    if (!ring || ring.length === 0) return null;
    let lat = 0;
    let lng = 0;
    for (const [x, y] of ring) {
      lng += x!;
      lat += y!;
    }
    return { lat: lat / ring.length, lng: lng / ring.length };
  } catch {
    return null;
  }
}

function haversineKm(a: PlacePoint, b: PlacePoint): number {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const lat1 = (a.lat * Math.PI) / 180;
  const lat2 = (b.lat * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ---------------------------------------------------------------------------
// LocalPlacesProvider — no API key. Searches the caller's saved addresses and
// the active delivery zones (by name, centroid as the point). Deterministic,
// so it's the default for CI and the test seam.
// ---------------------------------------------------------------------------

export class LocalPlacesProvider implements PlacesProvider {
  constructor(private prisma: PrismaClient) {}

  async autocomplete(query: string, ctx?: PlacesQueryContext): Promise<PlaceSuggestion[]> {
    const q = query.trim().toLowerCase();
    if (q.length === 0) return [];
    const out: PlaceSuggestion[] = [];

    if (ctx?.userId) {
      const addresses = await this.prisma.address.findMany({
        where: {
          userId: ctx.userId,
          OR: [
            { label: { contains: q, mode: 'insensitive' } },
            { addressLine1: { contains: q, mode: 'insensitive' } },
            { city: { contains: q, mode: 'insensitive' } },
          ],
        },
        take: MAX_SUGGESTIONS,
      });
      for (const a of addresses) {
        out.push({
          placeId: `addr:${a.id}`,
          primary: a.label || a.addressLine1,
          secondary: [a.addressLine1, a.city].filter(Boolean).join(', '),
        });
      }
    }

    const zones = await this.prisma.zone.findMany({
      where: { isActive: true, name: { contains: q, mode: 'insensitive' } },
      take: MAX_SUGGESTIONS,
    });
    for (const z of zones) {
      out.push({ placeId: `zone:${z.id}`, primary: z.name, secondary: z.description ?? undefined });
    }

    return out.slice(0, MAX_SUGGESTIONS);
  }

  async details(placeId: string): Promise<PlaceDetail | null> {
    const [kind, id] = placeId.split(':', 2);
    if (kind === 'addr' && id) {
      const a = await this.prisma.address.findUnique({ where: { id } });
      if (!a) return null;
      return {
        placeId,
        label: a.label || a.addressLine1,
        lat: a.latitude,
        lng: a.longitude,
      };
    }
    if (kind === 'zone' && id) {
      const z = await this.prisma.zone.findUnique({ where: { id } });
      if (!z) return null;
      const c = polygonCentroid(z.boundary);
      if (!c) return null;
      return { placeId, label: z.name, lat: c.lat, lng: c.lng };
    }
    return null;
  }

  async reverseGeocode(point: PlacePoint): Promise<string | null> {
    const zones = await this.prisma.zone.findMany({ where: { isActive: true } });
    let best: { name: string; km: number } | null = null;
    for (const z of zones) {
      const c = polygonCentroid(z.boundary);
      if (!c) continue;
      const km = haversineKm(point, c);
      if (!best || km < best.km) best = { name: z.name, km };
    }
    return best ? best.name : null;
  }
}

// ---------------------------------------------------------------------------
// GooglePlacesProvider — Places Autocomplete + Details + Geocoding. Same
// hot-path discipline as the maps seam: never throws, degrades to empty/null
// on any network error, timeout, !ok, or non-OK status. Key is server-only.
// ---------------------------------------------------------------------------

const GOOGLE_TIMEOUT_MS = 4000;
const AUTOCOMPLETE_URL = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';
const DETAILS_URL = 'https://maps.googleapis.com/maps/api/place/details/json';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';

interface GoogleAutocompleteResponse {
  status?: string;
  predictions?: Array<{
    place_id?: string;
    structured_formatting?: { main_text?: string; secondary_text?: string };
    description?: string;
  }>;
}

interface GoogleDetailsResponse {
  status?: string;
  result?: {
    name?: string;
    formatted_address?: string;
    geometry?: { location?: { lat?: number; lng?: number } };
  };
}

interface GoogleGeocodeResponse {
  status?: string;
  results?: Array<{ formatted_address?: string }>;
}

export class GooglePlacesProvider implements PlacesProvider {
  constructor(private apiKey: string) {}

  private async getJson<T>(url: URL): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return null;
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async autocomplete(query: string, ctx?: PlacesQueryContext): Promise<PlaceSuggestion[]> {
    if (query.trim().length === 0) return [];
    const url = new URL(AUTOCOMPLETE_URL);
    url.searchParams.set('input', query);
    url.searchParams.set('key', this.apiKey);
    if (ctx?.near) {
      url.searchParams.set('location', `${ctx.near.lat},${ctx.near.lng}`);
      url.searchParams.set('radius', '50000');
    }
    const data = await this.getJson<GoogleAutocompleteResponse>(url);
    if (!data || data.status !== 'OK') return [];
    return (data.predictions ?? [])
      .filter((p) => p.place_id)
      .slice(0, MAX_SUGGESTIONS)
      .map((p) => ({
        placeId: p.place_id!,
        primary: p.structured_formatting?.main_text ?? p.description ?? '',
        secondary: p.structured_formatting?.secondary_text,
      }));
  }

  async details(placeId: string): Promise<PlaceDetail | null> {
    const url = new URL(DETAILS_URL);
    url.searchParams.set('place_id', placeId);
    url.searchParams.set('fields', 'name,formatted_address,geometry');
    url.searchParams.set('key', this.apiKey);
    const data = await this.getJson<GoogleDetailsResponse>(url);
    const loc = data?.result?.geometry?.location;
    if (!data || data.status !== 'OK' || loc?.lat == null || loc?.lng == null) return null;
    return {
      placeId,
      label: data.result?.name ?? data.result?.formatted_address ?? 'Selected place',
      lat: loc.lat,
      lng: loc.lng,
    };
  }

  async reverseGeocode(point: PlacePoint): Promise<string | null> {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('latlng', `${point.lat},${point.lng}`);
    url.searchParams.set('key', this.apiKey);
    const data = await this.getJson<GoogleGeocodeResponse>(url);
    if (!data || data.status !== 'OK') return null;
    return data.results?.[0]?.formatted_address ?? null;
  }
}

/** Provider selection is config, not code. Defaults to local so CI needs no key. */
export function getPlacesProvider(prisma: PrismaClient): PlacesProvider {
  const provider = process.env['PLACES_PROVIDER'] ?? 'local';
  switch (provider) {
    case 'local':
      return new LocalPlacesProvider(prisma);
    case 'google': {
      const key = process.env['GOOGLE_MAPS_API_KEY_BACKEND'];
      if (!key) throw new Error('GOOGLE_MAPS_API_KEY_BACKEND is required when PLACES_PROVIDER=google');
      return new GooglePlacesProvider(key);
    }
    default:
      throw new Error(`Unknown PLACES_PROVIDER: ${provider}`);
  }
}
