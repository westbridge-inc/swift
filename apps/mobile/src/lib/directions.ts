/**
 * [row 363] Directions to a place, in the phone's own maps.
 *
 * The store-pickup "Directions" button opened maps.apple.com on every phone.
 * On Android that is a web page, not the maps app the customer uses. This picks
 * the link by platform:
 *
 *   iOS       Apple Maps (the same link as before). If it will not open (Apple
 *             Maps can be deleted), the Google Maps web map is the fallback.
 *   Android   Google Maps. Google's own directions link opens the Google Maps
 *   (other)   app when it is installed, and the web map when it is not.
 *
 * Pure (no react-native import) so it can be proved without a phone; the opener
 * is lib/openDirections.ts.
 */

export interface DirectionsTarget {
  lat?: unknown;
  lng?: unknown;
  address?: unknown;
}

export interface DirectionsLinks {
  /** Opened first. */
  primary: string;
  /** Opened only when the primary link will not open; null = nothing else to try. */
  fallback: string | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The destination as the maps links take it: exact coordinates when the order
 *  carries them, otherwise the address words. Null when there is neither. */
export function directionsDestination(target: DirectionsTarget): string | null {
  if (finite(target.lat) && finite(target.lng)) return `${target.lat},${target.lng}`;
  if (typeof target.address === 'string' && target.address.trim()) return encodeURIComponent(target.address.trim());
  return null;
}

export const appleMapsDirections = (destination: string) => `https://maps.apple.com/?daddr=${destination}`;
export const googleMapsDirections = (destination: string) => `https://www.google.com/maps/dir/?api=1&destination=${destination}`;

export function directionsLinks(target: DirectionsTarget, os: string): DirectionsLinks | null {
  const destination = directionsDestination(target);
  if (!destination) return null;
  return os === 'ios'
    ? { primary: appleMapsDirections(destination), fallback: googleMapsDirections(destination) }
    : { primary: googleMapsDirections(destination), fallback: null };
}
