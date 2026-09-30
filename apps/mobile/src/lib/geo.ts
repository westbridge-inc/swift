/** Great-circle distance (km) between two points. */
export function haversineKm(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  const R = 6371;
  const dLat = ((b.latitude - a.latitude) * Math.PI) / 180;
  const dLng = ((b.longitude - a.longitude) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.latitude * Math.PI) / 180) * Math.cos((b.latitude * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Straight-line → street ETA in whole minutes: 1.3 route-shape factor over
 * ~22 km/h Georgetown urban traffic (same order of magnitude the fare
 * estimator assumes). Honest for a "~X min away" chip, never sub-minute.
 */
export function streetEtaMin(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }): number {
  return Math.max(1, Math.round((haversineKm(a, b) * 1.3) / (22 / 60)));
}

/**
 * THE words for how far away a store is — every store distance in the app is
 * written by this one function.
 *
 * Guyana is metric and so is Swift: the server sends `distanceKm` (already
 * rounded to 100 m) and nothing in the product speaks miles. There used to be
 * two formatters and they disagreed. Home had its own `kmLabel` ("<1 km")
 * while Nearby, Search, the category feed and the store page printed the
 * number as sent ("0.4 km"), so one store could be two distances. And
 * `kmLabel` read `Number(null)` as 0: Home keeps the previous feed on screen
 * while the located one loads, so a feed fetched before the location fix —
 * every `distanceKm` null — told the customer that every store was "<1 km"
 * away.
 *
 * Unknown is silence: null, a non-number or a negative returns undefined and
 * the caller drops the segment. Under 100 m reads "<0.1 km", never "0 km".
 */
export function distanceLabel(km: unknown): string | undefined {
  if (typeof km !== 'number' || !Number.isFinite(km) || km < 0) return undefined;
  const tenths = Math.round(km * 10) / 10;
  return tenths < 0.1 ? '<0.1 km' : `${tenths} km`;
}
