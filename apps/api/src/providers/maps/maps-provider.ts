import { haversineDistance } from '../../utils/distance';

// ---------------------------------------------------------------------------
// MapsProvider — hard rule 4: swappable interface. A Google/OSRM adapter
// slots in later; dispatch only ever asks for ETAs through this seam.
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

/** Provider selection is config, not code. */
export function getMapsProvider(): MapsProvider {
  const provider = process.env['MAPS_PROVIDER'] ?? 'haversine';
  switch (provider) {
    case 'haversine':
      return new HaversineMapsProvider();
    default:
      throw new Error(`Unknown MAPS_PROVIDER: ${provider}`);
  }
}
