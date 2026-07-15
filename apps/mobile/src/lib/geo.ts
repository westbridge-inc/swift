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
