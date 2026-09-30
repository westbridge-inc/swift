import { apiFetch } from './auth';

export interface StorePoint { latitude: number; longitude: number }
export interface StorePin extends StorePoint { address: string | null }

export const STORE_MAP_START: StorePoint = { latitude: 6.8013, longitude: -58.1551 };
// Mirror apps/api/src/modules/auth/launch-market.ts. This is the same coarse
// country box (not a border/coastline test); the server remains authoritative.
export const STORE_MARKET_BOUNDS = { south: 1, north: 9, west: -62, east: -56 } as const;
export const STORE_PIN_OUTSIDE = 'That pin is outside Guyana, where Swift works today. Move it to the entrance of your store.';

export function storePinInMarket(point: StorePoint): boolean {
  return Number.isFinite(point.latitude) && Number.isFinite(point.longitude)
    && point.latitude >= STORE_MARKET_BOUNDS.south && point.latitude <= STORE_MARKET_BOUNDS.north
    && point.longitude >= STORE_MARKET_BOUNDS.west && point.longitude <= STORE_MARKET_BOUNDS.east;
}

/** A town-centre fallback must be moved deliberately, as on the phone. */
export function storePinMoved(point: StorePoint): boolean {
  return Math.abs(point.latitude - STORE_MAP_START.latitude) > 1e-4
    || Math.abs(point.longitude - STORE_MAP_START.longitude) > 1e-4;
}

/** Web Mercator pixels, matching the raster tiles at this zoom. */
export function mapPixel(point: StorePoint, zoom: number) {
  const size = 256 * 2 ** zoom;
  const sin = Math.sin(Math.max(-85.05112878, Math.min(85.05112878, point.latitude)) * Math.PI / 180);
  return {
    x: (point.longitude + 180) / 360 * size,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * size,
  };
}

export function pixelPoint(x: number, y: number, zoom: number): StorePoint {
  const size = 256 * 2 ** zoom;
  return {
    latitude: Math.atan(Math.sinh(Math.PI * (1 - 2 * Math.max(0, Math.min(size, y)) / size))) * 180 / Math.PI,
    longitude: ((x / size * 360) % 360 + 360) % 360 - 180,
  };
}

/** Best effort: slow/offline search must never lock the manual map. */
export async function pinLookup<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Address lookup timed out')), 4000);
    })]);
  } finally { clearTimeout(timer); }
}

export async function storePinAddress(point: StorePoint): Promise<string | null> {
  const query = new URLSearchParams({ lat: String(point.latitude), lng: String(point.longitude) });
  const result = await pinLookup(apiFetch(`/api/v1/places/reverse?${query}`));
  const address: unknown = result.data?.address;
  return typeof address === 'string' && address.trim() ? address : null;
}
