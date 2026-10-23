import { assertPlacesConfig } from './places-config';
import { classifyGeocodeStatus, classifyGoogleApiFailure, PlacesProviderError } from './places-failure';
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

/**
 * [PLACES-LOUD] Each method answers "no matches" with [] / null. A provider that
 * could not answer rejects with a PlacesProviderError (places-failure.ts) rather
 * than disguising the failure as an empty answer: GooglePlacesProvider (production)
 * does. The OSM stack, by design, folds a failed Photon / Nominatim call into the
 * local suggestions (zones and saved addresses), so its answers stay real ones.
 */
export interface PlacesProvider {
  autocomplete(query: string, ctx?: PlacesQueryContext): Promise<PlaceSuggestion[]>;
  // ctx carries the caller's identity: resolving an `addr:` placeId (a saved
  // address) MUST be scoped to its owner, or it's an IDOR.
  details(placeId: string, ctx?: PlacesQueryContext): Promise<PlaceDetail | null>;
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

  async details(placeId: string, ctx?: PlacesQueryContext): Promise<PlaceDetail | null> {
    const [kind, id] = placeId.split(':', 2);
    if (kind === 'addr' && id) {
      // A saved address is private — only its owner may resolve it. Without the
      // userId scope this is an IDOR: any authenticated caller could turn an
      // address id into someone else's home label + coordinates. Refuse outright
      // when the caller is anonymous (findFirst with userId:undefined would
      // silently drop the predicate and re-open the hole).
      if (!ctx?.userId) return null;
      const a = await this.prisma.address.findFirst({ where: { id, userId: ctx.userId } });
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
// GooglePlacesProvider — Places API (New) Autocomplete + Place Details, and the
// Geocoding API for reverse lookups. The owner's Google project offers only
// Places API (New); the legacy Places endpoints cannot be enabled there.
// [PLACES-LOUD 22 Oct 2026] "No matches" and FAILURE are different answers:
// Google answering with nothing is [] / null, exactly as before; every failure
// (a non-2xx, an auth / quota / permission error body, a timeout, a network
// error, an unreadable body) is a PlacesProviderError with its class and
// Google's status words (places-failure.ts). It used to degrade to [] / null,
// which the apps showed as "No matches": a refused key was invisible. The
// route makes the failure an honest 503, a log line, a metric and a page. The
// key is server-only: Places (New) carries it in the X-Goog-Api-Key header,
// never in a URL; the Geocoding URL that carries it is never logged, and no
// error or failure record holds it.
// ---------------------------------------------------------------------------

const GOOGLE_TIMEOUT_MS = 4000;
const AUTOCOMPLETE_URL = 'https://places.googleapis.com/v1/places:autocomplete';
const PLACE_DETAILS_URL = 'https://places.googleapis.com/v1/places/';
const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
// Places (New) bills by the fields asked for: ask only for what we map.
const AUTOCOMPLETE_FIELD_MASK =
  'suggestions.placePrediction.placeId,suggestions.placePrediction.text,suggestions.placePrediction.structuredFormat';
const DETAILS_FIELD_MASK = 'id,displayName,formattedAddress,location';
const AUTOCOMPLETE_REGION_CODES = ['gy'];
const LOCATION_BIAS_RADIUS_M = 50000;
// A Google place id is a URL-safe token. The id comes from the client and
// becomes a URL path segment here, so anything else (a `/`, `..`, `?`, or one
// of our own `addr:`/`zone:` ids) is refused before a request is made.
const GOOGLE_PLACE_ID = /^[A-Za-z0-9_-]+$/;

interface GoogleAutocompleteResponse {
  suggestions?: unknown;
}

interface GoogleAutocompleteSuggestion {
  placePrediction?: {
    placeId?: string;
    text?: { text?: string };
    structuredFormat?: { mainText?: { text?: string }; secondaryText?: { text?: string } };
  };
}

interface GooglePlaceResponse {
  displayName?: { text?: string };
  formattedAddress?: string;
  location?: { latitude?: unknown; longitude?: unknown };
}

interface GoogleGeocodeResponse {
  status?: unknown;
  results?: Array<{ formatted_address?: string }>;
}

/** One Google answer: the HTTP status and the parsed JSON body (undefined when it was not JSON). */
interface GoogleAnswer {
  ok: boolean;
  status: number;
  body: unknown;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

export class GooglePlacesProvider implements PlacesProvider {
  constructor(private apiKey: string) {}

  /** Fetch with the timeout. Throws PlacesProviderError for no answer (timeout / network); otherwise
   *  returns the status and the body, which each caller judges (a 404 is an answer for details). */
  private async request(url: string | URL, init: NonNullable<Parameters<typeof fetch>[1]> = {}): Promise<GoogleAnswer> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
    try {
      let res: Response;
      try {
        res = await fetch(url, { ...init, signal: controller.signal });
      } catch {
        // The thrown error is dropped on purpose: its text can quote the URL (the
        // Geocoding URL carries the key). Only the class survives.
        throw new PlacesProviderError({ reason: controller.signal.aborted ? 'timeout' : 'network' });
      }
      let body: unknown;
      try {
        body = await res.json();
      } catch {
        if (controller.signal.aborted) throw new PlacesProviderError({ reason: 'timeout' });
        body = undefined;
      }
      return { ok: res.ok, status: res.status, body };
    } finally {
      clearTimeout(timer);
    }
  }

  /** A Places (New) answer that must be a JSON object: anything else is a classified failure. */
  private placesBody(answer: GoogleAnswer): Record<string, unknown> {
    if (!answer.ok || (isObject(answer.body) && 'error' in answer.body)) {
      throw new PlacesProviderError(classifyGoogleApiFailure(answer.status, answer.body));
    }
    if (!isObject(answer.body)) throw new PlacesProviderError({ reason: 'bad_response', httpStatus: answer.status });
    return answer.body;
  }

  private placesHeaders(fieldMask: string): Record<string, string> {
    return { 'X-Goog-Api-Key': this.apiKey, 'X-Goog-FieldMask': fieldMask };
  }

  async autocomplete(query: string, ctx?: PlacesQueryContext): Promise<PlaceSuggestion[]> {
    if (query.trim().length === 0) return [];
    const body: Record<string, unknown> = { input: query, includedRegionCodes: AUTOCOMPLETE_REGION_CODES };
    if (ctx?.near) {
      body['locationBias'] = {
        circle: { center: { latitude: ctx.near.lat, longitude: ctx.near.lng }, radius: LOCATION_BIAS_RADIUS_M },
      };
    }
    const answer = await this.request(AUTOCOMPLETE_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.placesHeaders(AUTOCOMPLETE_FIELD_MASK) },
      body: JSON.stringify(body),
    });
    const data = this.placesBody(answer) as GoogleAutocompleteResponse;
    // Google answers {} when nothing matches: that is "no matches", not a failure.
    if (data.suggestions === undefined) return [];
    if (!Array.isArray(data.suggestions)) throw new PlacesProviderError({ reason: 'bad_response', httpStatus: answer.status });
    const out: PlaceSuggestion[] = [];
    for (const s of data.suggestions as GoogleAutocompleteSuggestion[]) {
      const p = s?.placePrediction;
      if (!p?.placeId) continue;
      out.push({
        placeId: p.placeId,
        primary: p.structuredFormat?.mainText?.text ?? p.text?.text ?? '',
        secondary: p.structuredFormat?.secondaryText?.text,
      });
      if (out.length >= MAX_SUGGESTIONS) break;
    }
    return out;
  }

  async details(placeId: string, _ctx?: PlacesQueryContext): Promise<PlaceDetail | null> {
    if (!GOOGLE_PLACE_ID.test(placeId)) return null;
    const answer = await this.request(`${PLACE_DETAILS_URL}${encodeURIComponent(placeId)}`, {
      headers: this.placesHeaders(DETAILS_FIELD_MASK),
    });
    // Google saying it does not know this id (its own NOT_FOUND status, not any 404 page) is
    // an answer: there is no such place. Everything else that is not a place is a failure.
    if (answer.status === 404 && classifyGoogleApiFailure(answer.status, answer.body).googleStatus === 'NOT_FOUND') return null;
    const data = this.placesBody(answer) as GooglePlaceResponse;
    const lat = data.location?.latitude;
    const lng = data.location?.longitude;
    if (typeof lat !== 'number' || typeof lng !== 'number') return null;
    return {
      placeId,
      label: data.displayName?.text ?? data.formattedAddress ?? 'Selected place',
      lat,
      lng,
    };
  }

  async reverseGeocode(point: PlacePoint): Promise<string | null> {
    const url = new URL(GEOCODE_URL);
    url.searchParams.set('latlng', `${point.lat},${point.lng}`);
    url.searchParams.set('key', this.apiKey);
    const answer = await this.request(url);
    if (!answer.ok) throw new PlacesProviderError(classifyGoogleApiFailure(answer.status, answer.body));
    if (!isObject(answer.body)) throw new PlacesProviderError({ reason: 'bad_response', httpStatus: answer.status });
    const data = answer.body as GoogleGeocodeResponse;
    // ZERO_RESULTS: Google answered, there is no address for this point.
    if (data.status === 'ZERO_RESULTS') return null;
    if (data.status !== 'OK') throw new PlacesProviderError(classifyGeocodeStatus(answer.status, data.status));
    return data.results?.[0]?.formatted_address ?? null;
  }
}

// --- OSM stack: Photon (autocomplete) + Nominatim (reverse) -----------------
// Self-hosted, no per-call cost (the build kit's discovery engines). Guyana's
// OSM coverage is thin, so failures and empty results fall back to the
// LocalPlacesProvider (zones + the user's saved addresses) — never a dead end;
// the app additionally keeps its map-pin-drop path.
const OSM_TIMEOUT_MS = 4000;

interface PhotonResponse {
  features?: Array<{
    properties?: { name?: string; street?: string; housenumber?: string; city?: string; district?: string; state?: string };
    geometry?: { coordinates?: [number, number] };
  }>;
}

interface NominatimReverseResponse {
  display_name?: string;
}

export class OsmPlacesProvider implements PlacesProvider {
  private fallback: LocalPlacesProvider;

  constructor(
    prisma: PrismaClient,
    private photonUrl: string,
    private nominatimUrl?: string,
  ) {
    this.fallback = new LocalPlacesProvider(prisma);
  }

  private async getJson<T>(url: URL, headers?: Record<string, string>): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal, headers });
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
    const url = new URL(`${this.photonUrl.replace(/\/$/, '')}/api`);
    url.searchParams.set('q', query);
    url.searchParams.set('limit', String(MAX_SUGGESTIONS));
    if (ctx?.near) {
      url.searchParams.set('lat', String(ctx.near.lat));
      url.searchParams.set('lon', String(ctx.near.lng));
    }
    const data = await this.getJson<PhotonResponse>(url);
    const features = data?.features ?? [];
    const suggestions: PlaceSuggestion[] = [];
    for (const f of features) {
      const [lng, lat] = f.geometry?.coordinates ?? [];
      const p = f.properties ?? {};
      const primary = p.name ?? [p.housenumber, p.street].filter(Boolean).join(' ');
      if (lat == null || lng == null || !primary) continue;
      const secondary = [p.district, p.city, p.state].filter(Boolean).join(', ') || undefined;
      // The coordinate + label travel INSIDE the placeId, so details() needs
      // no second round-trip (Photon has no details endpoint).
      const label = [primary, secondary].filter(Boolean).join(', ');
      suggestions.push({
        placeId: `osm:${lat},${lng}:${Buffer.from(label).toString('base64url')}`,
        primary,
        secondary,
      });
    }
    // Thin OSM coverage → fold in the local suggestions when OSM finds little.
    if (suggestions.length < 3) {
      const local = await this.fallback.autocomplete(query, ctx);
      for (const l of local) {
        if (suggestions.length >= MAX_SUGGESTIONS) break;
        suggestions.push(l);
      }
    }
    return suggestions.slice(0, MAX_SUGGESTIONS);
  }

  async details(placeId: string, ctx?: PlacesQueryContext): Promise<PlaceDetail | null> {
    // addr:/zone: ids are resolved by the local provider — forward the caller
    // identity so the saved-address scope holds through the OSM config too.
    if (!placeId.startsWith('osm:')) return this.fallback.details(placeId, ctx);
    const [, coords, encoded] = placeId.split(':');
    const [lat, lng] = (coords ?? '').split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    let label = 'Selected place';
    try {
      label = Buffer.from(encoded ?? '', 'base64url').toString('utf8') || label;
    } catch {
      // keep the default label
    }
    return { placeId, label, lat: lat!, lng: lng! };
  }

  async reverseGeocode(point: PlacePoint): Promise<string | null> {
    if (!this.nominatimUrl) return this.fallback.reverseGeocode(point);
    const url = new URL(`${this.nominatimUrl.replace(/\/$/, '')}/reverse`);
    url.searchParams.set('lat', String(point.lat));
    url.searchParams.set('lon', String(point.lng));
    url.searchParams.set('format', 'jsonv2');
    const data = await this.getJson<NominatimReverseResponse>(url, { 'user-agent': 'swift-gy/1.0' });
    return data?.display_name ?? this.fallback.reverseGeocode(point);
  }
}

/** Provider selection is config, not code. Defaults to local so CI needs no key. */
export function getPlacesProvider(prisma: PrismaClient): PlacesProvider {
  assertPlacesConfig();
  const provider = process.env['PLACES_PROVIDER'] ?? 'local';
  switch (provider) {
    case 'local':
      return new LocalPlacesProvider(prisma);
    case 'google': {
      const key = process.env['GOOGLE_MAPS_API_KEY_BACKEND'];
      if (!key) throw new Error('GOOGLE_MAPS_API_KEY_BACKEND is required when PLACES_PROVIDER=google');
      return new GooglePlacesProvider(key);
    }
    case 'osm': {
      const photonUrl = process.env['PHOTON_URL'];
      if (!photonUrl) throw new Error('PHOTON_URL is required when PLACES_PROVIDER=osm');
      return new OsmPlacesProvider(prisma, photonUrl, process.env['NOMINATIM_URL']);
    }
    default:
      throw new Error(`Unknown PLACES_PROVIDER: ${provider}`);
  }
}
