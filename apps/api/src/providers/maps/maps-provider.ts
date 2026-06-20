import { haversineDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// MapsProvider — hard rule 4: swappable interface. Dispatch only ever asks for
// ETAs through this seam, so a real routing service slots in behind it.
// ---------------------------------------------------------------------------

export interface LatLng {
  lat: number;
  lng: number;
}

export interface MapsProvider {
  /** Estimated riding minutes from origin to each destination, same order. */
  etaMinutes(origin: LatLng, destinations: LatLng[]): Promise<number[]>;
}

/** Straight-line estimate at urban moped speed — deterministic for tests. */
export class HaversineMapsProvider implements MapsProvider {
  private static SPEED_KMH = 25;
  private static ROAD_WIGGLE = 1.3; // streets are never straight lines

  async etaMinutes(origin: LatLng, destinations: LatLng[]): Promise<number[]> {
    return destinations.map((dest) => {
      const km = haversineDistance(origin.lat, origin.lng, dest.lat, dest.lng) * HaversineMapsProvider.ROAD_WIGGLE;
      return (km / HaversineMapsProvider.SPEED_KMH) * 60;
    });
  }
}

// Google Distance Matrix: one origin -> many destinations -> driving durations.
const DISTANCE_MATRIX_URL = 'https://maps.googleapis.com/maps/api/distancematrix/json';
const GOOGLE_TIMEOUT_MS = 4000;
const MAX_DESTINATIONS = 25; // Distance Matrix caps destinations per request

interface DistanceMatrixResponse {
  status?: string;
  rows?: Array<{ elements?: Array<{ status?: string; duration?: { value?: number } }> }>;
}

/**
 * Real driving ETAs via the Google Distance Matrix API.
 *
 * Dispatch scoring calls this on the hot path, so it MUST NOT throw or block.
 * It always computes the haversine estimate first and overlays Google's
 * durations only where they come back cleanly. Any failure — network error,
 * timeout, !ok response, top-level non-OK status, or a per-destination
 * ZERO_RESULTS — degrades to the straight-line value for those destinations.
 */
export class GoogleMapsProvider implements MapsProvider {
  private fallback = new HaversineMapsProvider();

  constructor(private apiKey: string) {}

  async etaMinutes(origin: LatLng, destinations: LatLng[]): Promise<number[]> {
    if (destinations.length === 0) return [];
    const out: number[] = [];
    for (let i = 0; i < destinations.length; i += MAX_DESTINATIONS) {
      out.push(...(await this.etaChunk(origin, destinations.slice(i, i + MAX_DESTINATIONS))));
    }
    return out;
  }

  private async etaChunk(origin: LatLng, chunk: LatLng[]): Promise<number[]> {
    // Deterministic baseline; Google values overlay it where available.
    const fallback = await this.fallback.etaMinutes(origin, chunk);

    const url = new URL(DISTANCE_MATRIX_URL);
    url.searchParams.set('origins', `${origin.lat},${origin.lng}`);
    url.searchParams.set('destinations', chunk.map((d) => `${d.lat},${d.lng}`).join('|'));
    url.searchParams.set('mode', 'driving');
    url.searchParams.set('key', this.apiKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GOOGLE_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return fallback;
      const data = (await res.json()) as DistanceMatrixResponse;
      if (data.status !== 'OK') return fallback;
      const elements = data.rows?.[0]?.elements ?? [];
      return chunk.map((_, i) => {
        const el = elements[i];
        const seconds = el?.status === 'OK' ? el.duration?.value : undefined;
        return seconds != null ? seconds / 60 : fallback[i]!;
      });
    } catch {
      return fallback; // down, slow, or blocked — dispatch carries on
    } finally {
      clearTimeout(timer);
    }
  }
}

// OSRM `table` service: self-hostable routing, no per-call cost (the spec's engine).
const OSRM_TIMEOUT_MS = 4000;

interface OsrmTableResponse {
  code?: string;
  durations?: Array<Array<number | null>>;
}

/**
 * Real driving ETAs via an OSRM `table` service — self-hostable and free per call
 * (the routing engine the business spec calls for). Same hot-path discipline as
 * Google: never throws; overlays OSRM durations on the haversine baseline only
 * where they return cleanly. NOTE: OSRM takes lng,lat coordinates.
 */
export class OsrmMapsProvider implements MapsProvider {
  private fallback = new HaversineMapsProvider();

  constructor(private baseUrl: string) {}

  async etaMinutes(origin: LatLng, destinations: LatLng[]): Promise<number[]> {
    if (destinations.length === 0) return [];
    const fallback = await this.fallback.etaMinutes(origin, destinations);

    const coords = [origin, ...destinations].map((p) => `${p.lng},${p.lat}`).join(';');
    const url = `${this.baseUrl.replace(/\/$/, '')}/table/v1/driving/${coords}?sources=0&annotations=duration`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), OSRM_TIMEOUT_MS);
    try {
      const res = await fetch(url, { signal: controller.signal });
      if (!res.ok) return fallback;
      const data = (await res.json()) as OsrmTableResponse;
      // durations is a 1×N row: [origin->origin (self), origin->dest1, ...] in seconds.
      const row = data.code === 'Ok' ? data.durations?.[0] : undefined;
      if (!row) return fallback;
      return destinations.map((_, i) => {
        const seconds = row[i + 1]; // skip the self entry
        return seconds != null ? seconds / 60 : fallback[i]!;
      });
    } catch {
      return fallback; // down, slow, or blocked — dispatch carries on
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Provider selection is config, not code. */
export function getMapsProvider(): MapsProvider {
  const provider = process.env['MAPS_PROVIDER'] ?? 'haversine';
  switch (provider) {
    case 'haversine':
      return new HaversineMapsProvider();
    case 'google': {
      const key = process.env['GOOGLE_MAPS_API_KEY_BACKEND'];
      if (!key) throw new Error('GOOGLE_MAPS_API_KEY_BACKEND is required when MAPS_PROVIDER=google');
      return new GoogleMapsProvider(key);
    }
    case 'osrm': {
      const baseUrl = process.env['OSRM_URL'];
      if (!baseUrl) throw new Error('OSRM_URL is required when MAPS_PROVIDER=osrm');
      return new OsrmMapsProvider(baseUrl);
    }
    default:
      throw new Error(`Unknown MAPS_PROVIDER: ${provider}`);
  }
}
